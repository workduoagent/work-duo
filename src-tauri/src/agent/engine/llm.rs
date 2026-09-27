//! LLM 网关调用层（S1 拆分自 runtime.rs，台账 §2.1）。
//!
//! 非流式 call_llm / 流式 call_llm_stream（SSE 增量回调 + 熔断守护）/ 限流节流
//! （WD_LLM_RPM）/ 调用级与流式双层超时（筑基支柱① 终态铁律）/ 取消竞争（P0-4）。
//! 调用方经 `runtime::{call_llm, call_llm_stream}` re-export 路径访问，无感迁移。

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;
use futures_util::StreamExt;
use tokio::time::timeout;

use crate::agent::events;
use crate::agent::types::AgentRuntimeConfig;
use super::runtime::{clip, describe_value_shape, extract_message_text, sanitize_for_log};

/// 非流式 LLM 调用超时上限（筑基支柱① 终态铁律）。
///
/// 背景（2026-09-22 定位）：`call_llm` 原**无任何超时**——模型/网关不返回时 future 永不 resolve，
/// 导致 `run_task` 永不结束、`RunningGuard` 永不 drop、**运行锁永占**。这正是历史「3 run 永久挂死」
/// 的机制性根因（经实测复核：并非 COMPOSITE 逻辑缺陷，而是单纯缺少兜底）。
/// 上层 `planner.rs:148` / `pipeline.rs:1306` 的 Err 分支本已正确容错（降级 / 标记步骤失败），
/// 却因无限等待而永远触发不到——本超时让**既有容错真正生效**，属最小精准修复。
///
/// 默认超时秒数：实测最坏单次静默 105s（本地部署模型资源紧张时），留约 1.7x 余量。
/// 判据按「无产出静默时长」而非总耗时（慢 ≠ 死，见筑基清单超时阈值铁律）。
const DEFAULT_LLM_TIMEOUT_SECS: u64 = 180;
/// 默认打点间隔秒数。
const DEFAULT_LLM_TICK_SECS: u64 = 30;

/// 实际超时上限：可用环境变量 `WD_LLM_TIMEOUT_SECS` 覆盖（>0 生效）。
/// 用途：① 本地部署的慢模型（如 ollama 资源紧张）可调大；② 自测故障注入时调小（如 5s）以快速验证超时分支。
fn llm_call_timeout() -> Duration {
    std::env::var("WD_LLM_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_LLM_TIMEOUT_SECS))
}

/// 实际打点间隔：可用环境变量 `WD_LLM_TICK_SECS` 覆盖（>0 生效）。自测时调小以便快速观测。
fn llm_wait_tick() -> Duration {
    std::env::var("WD_LLM_TICK_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_LLM_TICK_SECS))
}

/// 流式调用默认总墙钟上限（10 分钟）：生成超长内容时总时长也必须有上限，防止失控。
const DEFAULT_LLM_STREAM_TOTAL_SECS: u64 = 600;
/// 流式调用默认单 chunk 静默上限（120s）：SSE 流中途这么久没有任何新数据即判定断流。
/// 需大于本地大模型的 prefill（长 prompt 预填充）耗时，否则会误杀正常调用。
const DEFAULT_LLM_CHUNK_TIMEOUT_SECS: u64 = 120;

/// 流式总墙钟上限：可用环境变量 `WD_LLM_STREAM_TOTAL_SECS` 覆盖（>0 生效）。
fn llm_stream_total_timeout() -> Duration {
    std::env::var("WD_LLM_STREAM_TOTAL_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_LLM_STREAM_TOTAL_SECS))
}

/// 流式单 chunk 静默上限：可用环境变量 `WD_LLM_CHUNK_TIMEOUT_SECS` 覆盖（>0 生效）。
/// 2026-09-22 实测暴露：本地模型大生成量任务下，SSE 在收到 HTTP 200 后**流静默 226s+ 无任何 chunk**，
/// 而原 `stream.next().await` 裸等待 → run 永不终止、锁永占。本超时是其兜底。
fn llm_stream_chunk_timeout() -> Duration {
    std::env::var("WD_LLM_CHUNK_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_LLM_CHUNK_TIMEOUT_SECS))
}


/// 心跳停止守卫：函数任意出口（正常返回 / Err / `?` 提前返回）自动终止打点协程，不留悬挂任务。
struct HeartbeatGuard(Arc<AtomicBool>);
impl Drop for HeartbeatGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// LLM 调用限流（D' 限流，2026-09-24）：`WD_LLM_RPM` 设每分钟请求上限（按模型名分别
/// 计数；0/未设置 = 不限流）。实现为最小调用间隔节流：调用前等待至距上次同模型调用
/// ≥ 60/RPM 秒。锁不跨 await（等待在锁外 sleep）。桌面单用户场景足够。
static LLM_RATE_LIMIT: std::sync::Mutex<Option<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::Mutex::new(None);

async fn llm_rate_limit_wait(model: &str) {
    let rpm: u64 = std::env::var("WD_LLM_RPM")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if rpm == 0 {
        return;
    }
    let min_interval = std::time::Duration::from_millis(60_000 / rpm.max(1));
    loop {
        let wait = {
            let mut guard = LLM_RATE_LIMIT.lock().unwrap_or_else(|e| e.into_inner());
            let map = guard.get_or_insert_with(std::collections::HashMap::new);
            let now = std::time::Instant::now();
            let earliest = match map.get(model) {
                Some(t) => *t + min_interval,
                None => now,
            };
            if earliest <= now {
                map.insert(model.to_string(), now);
                None
            } else {
                Some(earliest.duration_since(now))
            }
        };
        match wait {
            Some(d) => {
                tracing::info!("[agent] LLM 限流：model={} 距下次调用还需 {:?}（WD_LLM_RPM={rpm}）", model, d);
                tokio::time::sleep(d).await;
            }
            None => return,
        }
    }
}

/// 用户取消哨兵错误（P0-4 洞一）：与流式侧 `call_llm_stream_once` 同串（含「取消」），
/// 上层重试逻辑 `e.contains("取消")` 可识别为不可重试、直接透传。
fn user_cancelled_err() -> String {
    "任务已被用户取消".to_string()
}

/// 与取消标志竞争执行 future（P0-4 洞一）：取消置位即短路返回，不再等待底层 I/O。
/// 轮询粒度 200ms——LLM 调用为秒级时长，粒度足够且开销可忽略；`None` 语义直接 await（零开销），
/// 兼容无取消语义的调用方（squad / 后台提炼）。
async fn race_cancel<F, T>(cancel: Option<&Arc<AtomicBool>>, fut: F) -> Result<T, ()>
where
    F: Future<Output = T>,
{
    match cancel {
        None => Ok(fut.await),
        Some(flag) => {
            tokio::pin!(fut);
            loop {
                if flag.load(Ordering::SeqCst) {
                    return Err(());
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(200)) => continue,
                    out = &mut fut => return Ok(out),
                }
            }
        }
    }
}

pub(crate) async fn call_llm(
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(Value, (u64, u64)), String> {
    if cfg.llm_base_url.is_empty() || cfg.llm_model_name.is_empty() {
        return Err("智能体未绑定有效的 LLM（base_url / model_name 为空）".into());
    }
    // 限流等待可取消：限流窗最长 60s/rpm，取消时立即短路（此前白等且占用等待窗）。
    race_cancel(cancel, llm_rate_limit_wait(&cfg.llm_model_name))
        .await
        .map_err(|_| {
            tracing::info!("[agent] call_llm: 用户取消（限流等待中）——立即终止");
            user_cancelled_err()
        })?;

    tracing::info!(
        "[agent] call_llm: 请求 URL={} model={} 是否带 Key={}",
        normalize_chat_url(&cfg.llm_base_url),
        cfg.llm_model_name,
        !cfg.llm_api_key.is_empty()
    );

    let request_started = Instant::now();
    let client = crate::net::apply_proxy(reqwest::Client::builder(), &cfg.network_proxy)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = normalize_chat_url(&cfg.llm_base_url);

    // 观测打点（支柱③）：等待期间每 LLM_WAIT_TICK 输出一条「仍在进行中」。
    // 非流式调用在等待期间原是零输出，长静默会被误判为挂死——打点后慢与死在日志上可区分。
    // `_hb_guard` 借 Drop 在任意出口终止协程（含 `?` 提前返回），不留悬挂任务。
    let call_timeout = llm_call_timeout();
    let wait_tick = llm_wait_tick();
    let hb_stop = Arc::new(AtomicBool::new(false));
    let _hb_guard = {
        let flag = hb_stop.clone();
        let hb_model = cfg.llm_model_name.clone();
        let hb_url = url.clone();
        tokio::spawn(async move {
            let mut waited = 0u64;
            loop {
                tokio::time::sleep(wait_tick).await;
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                waited += wait_tick.as_secs();
                tracing::info!(
                    "[agent] call_llm: 等待响应已 {}s（model={} url={}）——仍在进行中，非挂死",
                    waited,
                    hb_model,
                    hb_url
                );
            }
        });
        HeartbeatGuard(hb_stop)
    };

    let mut body = json!({
        "model": cfg.llm_model_name,
        "messages": messages,
        "stream": false,
    });
    // 注入智能体私有参数副本（temperature / max_tokens ...）
    if let Some(obj) = cfg.llm_config.as_object() {
        for (k, v) in obj {
            if k != "model" && k != "messages" && k != "stream" {
                body[k] = v.clone();
            }
        }
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }

    // 兼容多后端网关（如 gmi-serving）：部分网关的 OpenAI Chat 模型要求
    // `reasoning` 为字典而非布尔。用户在前端把 reasoning 配成 true/false 时，
    // 这里归一化为网关可接受的形态（true→{} 开启默认推理；false→移除该字段）。
    if let Some(obj) = body.as_object_mut() {
        let action = match obj.get("reasoning") {
            Some(v) if v.is_boolean() => Some(v.as_bool() == Some(true)),
            _ => None,
        };
        if let Some(enabled) = action {
            if enabled {
                obj.insert("reasoning".into(), json!({}));
                tracing::info!("[agent] call_llm: reasoning=true 归一化为 {{}}（网关要求字典）");
            } else {
                obj.remove("reasoning");
                tracing::info!("[agent] call_llm: reasoning=false 已移除");
            }
        }
    }

    let body_preview = serde_json::to_string(&sanitize_for_log(&body)).unwrap_or_default();
    tracing::info!(
        "[agent] call_llm: 请求体预览（已脱敏/截断）={} ",
        clip(&body_preview, 1000)
    );

    let mut req = client.post(&url).json(&body);
    if !cfg.llm_api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.llm_api_key));
    }

    // 超时兜底（支柱① 终态铁律）：模型/网关不返回时强制结束等待。
    // 无此超时时 future 永不 resolve → run_task 永不结束 → RunningGuard 永不 drop → 运行锁永占。
    // 加超时后返回 Err，上层 planner.rs / pipeline.rs 的既有 Err 容错（降级 / 标记失败）得以真正生效。
    let resp = race_cancel(cancel, timeout(call_timeout, req.send()))
        .await
        .map_err(|_| {
            tracing::info!("[agent] call_llm: 用户取消——终止等待响应（不产生计费尾单）");
            user_cancelled_err()
        })?
        .map_err(|_| {
            tracing::warn!(
                "[agent] call_llm: 等待响应超时（{}s，model={}）——终止等待，防止任务永不结束",
                call_timeout.as_secs(),
                cfg.llm_model_name
            );
            format!(
                "LLM 调用超时：{}s 内未收到响应（model={}）",
                call_timeout.as_secs(),
                cfg.llm_model_name
            )
        })?
        .map_err(|e| {
            tracing::info!(
                "[agent] call_llm: 请求失败（耗时={}ms）：{}",
                request_started.elapsed().as_millis(),
                e
            );
            format!("请求失败：{e}")
        })?;
    // send 完成后立即复查取消（竞态窗口）：响应已到但未读 body，取消则丢弃（不再产生读取计费）。
    if let Some(f) = cancel {
        if f.load(Ordering::SeqCst) {
            tracing::info!("[agent] call_llm: 用户取消（响应已到、body 未读）——丢弃响应");
            return Err(user_cancelled_err());
        }
    }
    let status = resp.status();
    tracing::info!(
        "[agent] call_llm: 收到 HTTP {}（耗时={}ms）",
        status,
        request_started.elapsed().as_millis()
    );
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let safe_text = clip(&sanitize_for_log(&Value::String(text.clone())).to_string(), 5000);
        tracing::info!("[agent] call_llm: HTTP {} 错误体（已脱敏/截断）={}", status, safe_text);
        return Err(format!("HTTP {}：{}", status, clip(&text, 2000)));
    }
    // 响应体读取同样需要超时：大响应或网关慢速吐流时，读 body 阶段也可能长时间挂起。
    let data: Value = race_cancel(cancel, timeout(call_timeout, resp.json()))
        .await
        .map_err(|_| {
            tracing::info!("[agent] call_llm: 用户取消（读取响应体中）——终止");
            user_cancelled_err()
        })?
        .map_err(|_| {
            tracing::warn!(
                "[agent] call_llm: 响应体读取超时（{}s，model={}）",
                call_timeout.as_secs(),
                cfg.llm_model_name
            );
            format!(
                "LLM 响应读取超时：{}s 内未读完响应体（model={}）",
                call_timeout.as_secs(),
                cfg.llm_model_name
            )
        })?
        .map_err(|e| format!("响应解析失败：{e}"))?;
    tracing::info!(
        "[agent] call_llm: 非流式响应 JSON 大小={}字符 choices={} ",
        data.to_string().chars().count(),
        data.get("choices").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0)
    );
    // 提取真实 token 用量（prompt / completion），供会话累计展示，替代前端估算。
    let usage = data
        .get("usage")
        .and_then(|u| u.as_object())
        .and_then(|u| {
            let p = u.get("prompt_tokens").and_then(|v| v.as_u64());
            let c = u.get("completion_tokens").and_then(|v| v.as_u64());
            match (p, c) {
                (Some(p), Some(c)) => Some((p, c)),
                _ => None,
            }
        })
        .unwrap_or((0, 0));
    tracing::info!(
        "[agent] call_llm: 非流式 usage prompt={} completion={}",
        usage.0, usage.1
    );
    // 注：非流式通道（规划/提炼）不推送窗口占用——无 app 句柄且 input 量小（~1.4K），
    // 窗口压力指标以执行期流式调用为准（agent-llm-usage）。
    let mut message = data
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .cloned()
        .ok_or_else(|| "LLM 响应缺少 choices[0].message".to_string())?;

    // reasoning 模型返空兼容（gemma4 等）：非流式响应可能把实际内容放非标准位置——
    // content 为多模态数组（[{type:"text",text:...}]）、或全落 `reasoning`/`reasoning_content`
    // 字段（字符串或对象）。统一回退：规范化提取文本，content 空时逐级回填（打 WARN 便于观察）。
    {
        let content_text = extract_message_text(message.get("content"));
        if content_text.trim().is_empty() {
            // 诊断：打印 message 字段名与 reasoning 字段形态，一次性揭示网关真实结构。
            let keys: Vec<String> = message
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            let reason_ty = message.get("reasoning").map(describe_value_shape);
            let reason_c_ty = message.get("reasoning_content").map(describe_value_shape);
            tracing::warn!(
                "[agent] call_llm: content 规范化提取为空，message 字段={:?} reasoning形态={:?} reasoning_content形态={:?} message原始（截断）={}",
                keys,
                reason_ty,
                reason_c_ty,
                clip(&message.to_string(), 800)
            );
            let alt = extract_message_text(message.get("reasoning_content"))
                .trim()
                .to_string();
            let alt = if alt.is_empty() {
                extract_message_text(message.get("reasoning")).trim().to_string()
            } else {
                alt
            };
            if !alt.is_empty() {
                tracing::warn!(
                    "[agent] call_llm: 回退用 reasoning 文本作为响应内容（{}字符，reasoning 模型返空兼容）",
                    alt.chars().count()
                );
                if let Some(obj) = message.as_object_mut() {
                    obj.insert("content".into(), json!(alt));
                }
            }
        } else {
            // content 为数组等非字符串形态：规范化为字符串，避免下游 as_str() 解析为空。
            let raw = message.get("content").map(|v| v.to_string()).unwrap_or_default();
            if raw != format!("\"{}\"", content_text) {
                if let Some(obj) = message.as_object_mut() {
                    obj.insert("content".into(), json!(content_text));
                }
            }
        }
    }

    Ok((message, usage))
}

/// 流式调用的聚合结果（一轮 ReAct 的 LLM 输出）。
pub(crate) struct StreamOutcome {
    /// 模型输出正文（终态轮为回答；工具轮多为规划/分析短文，可空）。
    pub(crate) content: String,
    /// 模型推理字段（DeepSeek 风格 `reasoning` / `reasoning_content`）。
    pub(crate) reasoning: String,
    /// 标准 OpenAI 格式的 tool_calls（流式增量已按 index 归并完整）。
    pub(crate) tool_calls: Vec<Value>,
    /// 本轮 LLM 真实 token 用量（prompt / completion），取自 OpenAI 响应的 `usage`。
    /// 跨所有 ReAct 轮累计即为整轮任务的真实消耗，替代前端基于「仅首尾文本」的估算
    /// （旧估算会把 system prompt / 工具定义 / 中间工具往返全部漏掉，导致 token 严重低估）。
    pub(crate) usage: (u64, u64),
}

/// 流式调用 LLM（SSE）：聚合本轮的正文、推理与 tool_calls，返回给 ReAct 循环决策。
///
/// 每轮仅这一次 HTTP 调用（替代旧架构「非流式判断 + 流式输出」的双调用）：
///  - 正文 / 推理先缓冲，不边收边 emit —— 因为此时还不确定本轮是「终态回答」
///    还是「工具轮规划」，二者去向不同（回答气泡 vs 思考面板），由调用方决定；
///  - `delta.tool_calls` 是增量格式（首 chunk 带 id/name，后续仅带 arguments 片段），
///    按 `index` 归并为完整的标准 tool_calls；
///  - 调用方拿到空响应（正文与 tool_calls 皆空）时应回退非流式 `call_llm` 兜底。
#[tracing::instrument(skip_all)]
pub(crate) async fn call_llm_stream(
    _app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
    cancel: &Arc<AtomicBool>,
    on_text: Option<&(dyn Fn(&str) + Send + Sync)>,
    on_reasoning: Option<&(dyn Fn(&str) + Send + Sync)>,
) -> Result<StreamOutcome, String> {
    const MAX_RETRY: usize = 1;
    llm_rate_limit_wait(cfg.llm_model_name.as_str()).await;
    let mut last: Option<Result<StreamOutcome, String>> = None;
    for attempt in 0..=MAX_RETRY {
        let outcome =
            call_llm_stream_once(_app, cfg, messages, tools, cancel, on_text, on_reasoning).await;
        match outcome {
            // 用户主动取消：绝不重试，直接透传错误（「停止 / 接管」路径依赖此行为）。
            Err(e) if e.contains("取消") => return Err(e),
            // 网络 / HTTP 错误：重试一次，到上限则透传。
            Err(e) => {
                tracing::info!(
                    "[agent] call_llm_stream: 第{}次请求失败，{}",
                    attempt + 1,
                    if attempt < MAX_RETRY { "重试一次" } else { "已达上限" }
                );
                last = Some(Err(e));
                if attempt < MAX_RETRY {
                    continue;
                }
                return last.unwrap();
            }
            Ok(o) => {
                // 单次请求的真实窗口占用（2026-09-18 修正口径）：每次 LLM 请求完成即推送
                // 该次的 prompt/completion——前端「窗口占用」环据此展示（此前误用任务级
                // 累计，5 步任务的 91 万被显示成 713% 窗口）。
                if o.usage.0 > 0 {
                    events::emit_llm_usage(_app, o.usage.0, o.usage.1);
                }
                // 零输出（正文与 tool_calls 皆空）且非取消：疑似网关流式断流，
                // 重试一次避免浪费已喂的 prompt 却拿不到任何 token。
                let is_empty = o.content.trim().is_empty() && o.tool_calls.is_empty();
                if is_empty {
                    tracing::warn!(
                        "[agent] call_llm_stream: 第{}次流式返回空响应（疑似网关断流），{}",
                        attempt + 1,
                        if attempt < MAX_RETRY { "重试一次" } else { "已达上限，按空响应返回" }
                    );
                    last = Some(Ok(o));
                    if attempt < MAX_RETRY {
                        continue;
                    }
                    return last.unwrap();
                }
                return Ok(o);
            }
        }
    }
    last.unwrap_or(Err("流式调用失败".into()))
}

/// 单次流式请求 + SSE 聚合（不含重试）。空响应以 `Ok(空 StreamOutcome)` 返回，
/// 由 `call_llm_stream` 判断是否需要重试；用户取消以 `Err("任务已被用户取消")`
/// 返回，保证重试包装层不会对其重试。
#[tracing::instrument(skip_all)]
async fn call_llm_stream_once(
    _app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
    cancel: &Arc<AtomicBool>,
    on_text: Option<&(dyn Fn(&str) + Send + Sync)>,
    on_reasoning: Option<&(dyn Fn(&str) + Send + Sync)>,
) -> Result<StreamOutcome, String> {
    let _ = _app; // 事件推送已上移到 ReAct 循环，本函数只做拉流聚合
    if cfg.llm_base_url.is_empty() || cfg.llm_model_name.is_empty() {
        return Err("智能体未绑定有效的 LLM（base_url / model_name 为空）".into());
    }

    tracing::info!(
        "[agent] call_llm_stream: 请求 URL={} model={} 是否带 Key={}",
        normalize_chat_url(&cfg.llm_base_url),
        cfg.llm_model_name,
        !cfg.llm_api_key.is_empty()
    );

    let request_started = Instant::now();
    let client = crate::net::apply_proxy(reqwest::Client::builder(), &cfg.network_proxy)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = normalize_chat_url(&cfg.llm_base_url);

    let mut body = json!({
        "model": cfg.llm_model_name,
        "messages": messages,
        "stream": true,
        // 显式要求网关在流的最后一个 chunk 返回 usage（OpenAI 风格），
        // 否则部分网关默认不下发，导致前端拿不到真实 token 用量。
        "stream_options": { "include_usage": true },
    });
    // 注入智能体私有参数副本
    if let Some(obj) = cfg.llm_config.as_object() {
        for (k, v) in obj {
            if k != "model" && k != "messages" && k != "stream" {
                body[k] = v.clone();
            }
        }
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }

    // reasoning 归一化（同 call_llm）
    if let Some(obj) = body.as_object_mut() {
        let action = match obj.get("reasoning") {
            Some(v) if v.is_boolean() => Some(v.as_bool() == Some(true)),
            _ => None,
        };
        if let Some(enabled) = action {
            if enabled {
                obj.insert("reasoning".into(), json!({}));
                tracing::info!("[agent] call_llm_stream: reasoning=true 归一化为 {{}}");
            } else {
                obj.remove("reasoning");
                tracing::info!("[agent] call_llm_stream: reasoning=false 已移除");
            }
        }
    }

    let body_preview = serde_json::to_string(&sanitize_for_log(&body)).unwrap_or_default();
    tracing::info!(
        "[agent] call_llm_stream: 请求体预览（已脱敏/截断）={} ",
        clip(&body_preview, 1000)
    );

    let mut req = client.post(&url).json(&body);
    if !cfg.llm_api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.llm_api_key));
    }
    // 部分网关需要显式声明 Accept: text/event-stream
    req = req.header("Accept", "text/event-stream");

    // 取消优先（请求级兜底）：若已收到取消信号，绝不发起本次 HTTP 请求——
    // 否则会把整段 prompt 发给网关计费后立刻作废。轮次级取消检查见 run_subtask 主循环。
    if cancel.load(Ordering::SeqCst) {
        tracing::info!("[agent] call_llm_stream: 取消信号已置位，跳过 HTTP 请求（不重复计费）");
        return Err("任务已被用户取消".into());
    }

    let resp = req.send().await.map_err(|e| {
        tracing::info!(
            "[agent] call_llm_stream: 请求失败（耗时={}ms）：{}",
            request_started.elapsed().as_millis(),
            e
        );
        format!("请求失败：{e}")
    })?;
    let status = resp.status();
    tracing::info!(
        "[agent] call_llm_stream: 收到 HTTP {}（耗时={}ms）",
        status,
        request_started.elapsed().as_millis()
    );
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let safe_text = clip(&sanitize_for_log(&Value::String(text.clone())).to_string(), 5000);
        tracing::info!(
            "[agent] call_llm_stream: HTTP {} 错误体（已脱敏/截断）={}",
            status, safe_text
        );
        return Err(format!("HTTP {}：{}", status, clip(&text, 2000)));
    }

    let mut stream = resp.bytes_stream();
    // 跨 chunk 字节缓冲：SSE 的 `data:` 行可能被 TCP 分片切到不同 chunk，
    // 这里累积原始字节，仅处理以 `\n` 结尾的完整行；多字节 UTF-8 字符也只在整行
    // 转换时解析，避免被分片截断成乱码（如中文 content 被切坏）。
    let mut buf: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut reasoning = String::new();
    // reasoning 增量节流（#20260918011）：reasoning delta 很碎且量大（reasoning 模型单轮
    // 可烧 18K 思考 tokens），逐 delta emit 会造成 Tauri 事件风暴卡 UI。按「累计 ≥80 字符
    // 或距上次推送 ≥150ms」合并推送；流结束时 flush 余量。
    let mut r_throttle_buf = String::new();
    let mut r_last_flush = Instant::now();
    let mut chunk_count = 0usize;
    let mut line_count = 0usize;
    let mut parse_error_count = 0usize;
    // tool_calls 增量归并：index -> (id, name, arguments 片段拼接)
    let mut tc_acc: std::collections::BTreeMap<u64, (String, String, String)> = Default::default();
    // 真实 token 用量累计（OpenAI 把 usage 放在最后一个 chunk 之前；不同网关位置略有差异，每片都取最新非空值）。
    let mut usage: (u64, u64) = (0, 0);
    // 流式两道超时（支柱① 终态铁律）：
    // ① 整体墙钟（stream_total）——生成超长内容时总时长也必须有上限；
    // ② 单 chunk 静默（chunk_timeout）——SSE 流中途长时间无任何数据即判定断流。
    // 判据用「无产出静默时长」而非总耗时（慢 ≠ 死，但静默够久就是死）。
    let stream_total = llm_stream_total_timeout();
    let chunk_timeout = llm_stream_chunk_timeout();
    loop {
        // ① 整体墙钟兜底
        if request_started.elapsed() > stream_total {
            tracing::warn!(
                "[agent] call_llm_stream_once: 流式总时长超时（{}s，model={}）——终止，防止任务永不结束",
                stream_total.as_secs(),
                cfg.llm_model_name
            );
            return Err(format!(
                "流式响应总时长超时：{}s（model={}）",
                stream_total.as_secs(),
                cfg.llm_model_name
            ));
        }
        // 用户中途取消：立即终止拉流（连接随函数返回被丢弃），让本轮回合在
        // 调用方处检测到取消标志后提前结束。这是"停止按钮即时生效"的核心断流点。
        if cancel.load(Ordering::SeqCst) {
            tracing::info!(
                "[agent] call_llm_stream_once: 检测到取消信号，立即断流（已耗时={}ms）",
                request_started.elapsed().as_millis()
            );
            return Err("任务已被用户取消".into());
        }
        // ② 单 chunk 静默超时 + 取消并发检查。
        //
        // 取消必须**与拉流并发**检查：原实现把取消检查放在 `stream.next().await` 之前，
        // 流一旦静默（无 chunk 推送），取消信号要等满 chunk_timeout 才轮到检查 →
        // 「停止按钮」最长延迟 = chunk_timeout。2026-09-23 套件实测证实：快模型 5/5 秒响应，
        // 慢模型 5/5 在 90s 内未终态且**锁未释放**（流静默 → 取消迟迟不被检查）。
        // 改为 select 并发等待后，取消信号在 ~100ms 内生效。
        let cancel_wait = async {
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        };
        let next_opt: Option<Result<Vec<u8>, String>> = tokio::select! {
            _ = cancel_wait => {
                tracing::info!(
                    "[agent] call_llm_stream_once: 拉取下一片时检测到取消信号，立即断流（已耗时={}ms）",
                    request_started.elapsed().as_millis()
                );
                return Err("任务已被用户取消".into());
            }
            r = timeout(chunk_timeout, stream.next()) => match r {
                Ok(Some(res)) => Some(res.map(|b| b.to_vec()).map_err(|e| format!("流读取失败：{e}"))),
                Ok(None) => None, // 流正常结束
                Err(_) => {
                    tracing::warn!(
                        "[agent] call_llm_stream_once: SSE 静默超时（{}s 内无新数据，已耗时={}ms，model={}）——判定断流",
                        chunk_timeout.as_secs(),
                        request_started.elapsed().as_millis(),
                        cfg.llm_model_name
                    );
                    return Err(format!(
                        "流式响应静默超时：{}s 内未收到新数据（model={}）——判定为网关/模型断流",
                        chunk_timeout.as_secs(),
                        cfg.llm_model_name
                    ));
                }
            },
        };
        let chunk = match next_opt {
            Some(Ok(b)) => b,
            Some(Err(msg)) => {
                tracing::info!("[agent] call_llm_stream: SSE 流读取失败（已耗时={}ms）：{}", request_started.elapsed().as_millis(), msg);
                return Err(msg);
            }
            None => break, // 流正常结束
        };
        chunk_count += 1;
        buf.extend_from_slice(&chunk);
        // 处理缓冲区中所有以 \n 结尾的完整行
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let mut line_bytes = buf[..pos].to_vec();
            buf.drain(..=pos); // 移除该行及换行符
            if line_bytes.last() == Some(&b'\r') {
                line_bytes.pop(); // 去掉可能的 \r
            }
            line_count += 1;
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let data = line.trim_start_matches("data:").trim();
            if data == "[DONE]" {
                continue;
            }
            match serde_json::from_str::<Value>(data) {
                Ok(json) => {
                    let (content_delta, reasoning_piece) =
                        absorb_stream_delta(&json, &mut content, &mut reasoning, &mut tc_acc);
                    // 增量推流：每收到一片正文 delta 立即经回调向前端 emit 一个 text_chunk，
                    // 实现 SIMPLE_CHAT 等路径的逐字流式输出；ReAct 内部请求传 None 关闭。
                    if let Some(cb) = on_text {
                        if !content_delta.is_empty() {
                            cb(&content_delta);
                        }
                    }
                    // reasoning 增量（#20260918011）：累积节流后推送（见 r_throttle_buf 注释）。
                    if let Some(cb) = on_reasoning {
                        if !reasoning_piece.is_empty() {
                            r_throttle_buf.push_str(&reasoning_piece);
                            if r_throttle_buf.chars().count() >= 80
                                || r_last_flush.elapsed().as_millis() >= 150
                            {
                                cb(&r_throttle_buf);
                                r_throttle_buf.clear();
                                r_last_flush = Instant::now();
                            }
                        }
                    }
                    // 累计真实 token 用量（prompt / completion）
                    if let Some(u) = json.get("usage").and_then(|v| v.as_object()) {
                        if let (Some(p), Some(c)) = (
                            u.get("prompt_tokens").and_then(|v| v.as_u64()),
                            u.get("completion_tokens").and_then(|v| v.as_u64()),
                        ) {
                            usage = (p, c);
                        }
                    }
                }
                Err(e) => {
                    parse_error_count += 1;
                    // 整行已缓冲完整，正常不应再出现半截 JSON；若仍出现仅记录，不中断流。
                    tracing::info!(
                        "[agent] call_llm_stream: SSE JSON 解析失败 #{}：{}，data={}",
                        parse_error_count,
                        e,
                        clip(data, 500),
                    );
                }
            }
        }
    }
    // 处理流结束时缓冲区残留的尾行（极少数服务端不以换行结尾）
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim();
        if line.starts_with("data:") {
            let data = line.trim_start_matches("data:").trim();
            if data != "[DONE]" {
                if let Ok(json) = serde_json::from_str::<Value>(data) {
                    let (content_delta, reasoning_piece) =
                        absorb_stream_delta(&json, &mut content, &mut reasoning, &mut tc_acc);
                    if let Some(cb) = on_text {
                        if !content_delta.is_empty() {
                            cb(&content_delta);
                        }
                    }
                    // reasoning 增量只入节流缓冲，flush 交给下方流结束的统一兜底（此处不再单独推送）。
                    if !reasoning_piece.is_empty() {
                        r_throttle_buf.push_str(&reasoning_piece);
                    }
                    if let Some(u) = json.get("usage").and_then(|v| v.as_object()) {
                        if let (Some(p), Some(c)) = (
                            u.get("prompt_tokens").and_then(|v| v.as_u64()),
                            u.get("completion_tokens").and_then(|v| v.as_u64()),
                        ) {
                            usage = (p, c);
                        }
                    }
                }
            }
        }
    }

    // 流结束：flush reasoning 节流余量（#20260918011）。
    if let Some(cb) = on_reasoning {
        if !r_throttle_buf.is_empty() {
            cb(&r_throttle_buf);
            r_throttle_buf.clear();
        }
    }

    // 归并后的增量 tool_calls → 标准 OpenAI 格式（与 parse_tool_call 期望一致）
    let tool_calls: Vec<Value> = tc_acc
        .into_iter()
        .map(|(idx, (id, name, args))| {
            json!({
                "id": if id.is_empty() { format!("call_stream_{idx}") } else { id },
                "type": "function",
                "function": { "name": name, "arguments": args }
            })
        })
        .collect();

    tracing::info!(
        "[agent] call_llm_stream: SSE 聚合完成 chunks={} lines={} parse_errors={} content={}字符 reasoning={}字符 tool_calls={} 总耗时={}ms",
        chunk_count,
        line_count,
        parse_error_count,
        content.chars().count(),
        reasoning.chars().count(),
        tool_calls.len(),
        request_started.elapsed().as_millis(),
    );
    Ok(StreamOutcome {
        content,
        reasoning,
        tool_calls,
        usage,
    })
}

/// 吸收一个 SSE `chat.completion.chunk`：聚合 `delta.content`、`delta.reasoning`（含
/// `reasoning_content` 别名）与 `delta.tool_calls` 增量（按 index 归并 id/name/arguments）。
fn absorb_stream_delta(
    json: &Value,
    content: &mut String,
    reasoning: &mut String,
    tc_acc: &mut std::collections::BTreeMap<u64, (String, String, String)>,
) -> (String, String) {
    let mut content_delta = String::new();
    let mut reasoning_delta = String::new();
    let delta = json
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("delta"));
    let Some(delta) = delta else {
        return (content_delta, reasoning_delta);
    };

    if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
        content.push_str(c);
        content_delta.push_str(c);
    }
    // DeepSeek 等风格的推理字段（两种命名兼容）
    for key in ["reasoning", "reasoning_content"] {
        if let Some(r) = delta.get(key).and_then(|v| v.as_str()) {
            reasoning.push_str(r);
            reasoning_delta.push_str(r);
        }
    }
    if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tcs {
            let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
            let entry = tc_acc.entry(idx).or_default();
            if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                entry.0 = id.to_string();
            }
            if let Some(f) = tc.get("function") {
                if let Some(n) = f.get("name").and_then(|v| v.as_str()) {
                    entry.1.push_str(n);
                }
                if let Some(a) = f.get("arguments").and_then(|v| v.as_str()) {
                    entry.2.push_str(a);
                }
            }
        }
    }
    (content_delta, reasoning_delta)
}

/// 把 base_url 规整为 `/chat/completions` 端点（兼容用户填 `/v1` 或完整地址）。
fn normalize_chat_url(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else if trimmed.ends_with("/v1/") {
        format!("{trimmed}chat/completions")
    } else {
        format!("{trimmed}/chat/completions")
    }
}

/// 从 LLM 响应中提取助手文本内容（信封形状兼容层）。
///
/// `runtime::call_llm` 返回的是**归一化后的 `choices[0].message` 层**（顶层即 `content` 字符串），
/// 但历史上多处调用方（squad_orchestrator 等）误把它当完整响应信封继续往下钻
/// `choices[0].message.content` —— 永远取空（台账 G10：squad leader 委派/汇总空输出根因）。
/// 本函数是唯一事实源：先取归一化层 `content`，兜底兼容完整信封形状。
pub(crate) fn extract_llm_content(resp: &Value) -> String {
    if let Some(s) = resp.get("content").and_then(|c| c.as_str()) {
        return s.trim().to_string();
    }
    resp.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;


    /// P0-4 洞一：race_cancel 三态——None 直通 / Some 未取消放行 / Some 已取消短路。
    #[tokio::test]
    async fn race_cancel_semantics() {
        // None：直通 await，不做取消检查
        let out = race_cancel(None, async { 42 }).await;
        assert!(out.is_ok());

        // Some + 未取消：正常放行
        let flag = Arc::new(AtomicBool::new(false));
        let out = race_cancel(Some(&flag), async { 7 }).await;
        assert_eq!(out.unwrap(), 7);

        // Some + 已预先取消：立即 Err（不等待 future）
        let flag = Arc::new(AtomicBool::new(true));
        let started = std::time::Instant::now();
        let out = race_cancel(
            Some(&flag),
            async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                1
            },
        )
        .await;
        assert!(out.is_err());
        assert!(started.elapsed().as_millis() < 3000, "已取消时不得等待 future");
    }

    /// P0-4 洞一：future 在途时取消置位，轮询应在短窗内发现并短路。
    #[tokio::test]
    async fn race_cancel_short_circuits_mid_flight() {
        let flag = Arc::new(AtomicBool::new(false));
        let f2 = flag.clone();
        // 300ms 后置位取消（模拟用户点停止）
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            f2.store(true, Ordering::SeqCst);
        });
        let started = std::time::Instant::now();
        let out = race_cancel(
            Some(&flag),
            async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                1
            },
        )
        .await;
        assert!(out.is_err());
        // 300ms 置位 + 最多一轮 200ms 轮询 → 远小于 30s 的 future 时长
        assert!(
            started.elapsed().as_millis() < 5000,
            "取消置位后应在轮询粒度级延迟内短路"
        );
    }
}

