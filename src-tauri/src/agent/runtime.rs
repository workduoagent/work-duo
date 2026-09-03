//! ReAct 运行时调度引擎（对应方案步骤 3）。
//!
//! 职责（单轮任务）：
//!  1. 由 `AgentRuntimeConfig` 组装 system prompt 与 tools（经 `ExtensionHub::assemble_registry`）；
//!  2. 调云端 OpenAI 兼容 LLM（reqwest 直连，base_url 来自模型配置；客户端不做本地重推理）；
//!  3. 解析 `tool_calls`：按 name 派发到注册表工具，敏感工具经 `ApprovalManager` 挂起等审批；
//!  4. 工具结果回填进 messages，循环直至模型输出纯文本（终态）或达最大轮次；
//!  5. 全程经 `events` 推送 `tool_started/finished`、`text_chunk`、`status` 等，驱动前端 UI。
//!
//! 约束：
//!  - Token 滑动窗口裁剪：messages 超长时裁剪早期历史（保留 system + 最近 N 轮）；
//!  - 熔断保护：单轮工具调用次数上限，防模型死循环；
//!  - 客户端一律走云端 API（与项目架构定调一致）。

use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::agent::approval::ApprovalManager;
use crate::agent::approval::ApprovalOutcome;
use crate::agent::events;
use crate::agent::native;
use crate::agent::tools::PermissionLevel;
use crate::agent::tools::ToolContext;
use crate::agent::tools::ToolError;
use crate::agent::tools::ToolRegistry;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::ApprovalRequest;
use crate::agent::types::ToolStep;

/// 单轮任务最大工具调用次数（熔断）。
const MAX_TOOL_ITERATIONS: usize = 16;
/// 历史消息保留轮次（滑动窗口）。
const MAX_HISTORY_TURNS: usize = 24;

/// 运行时共享状态（托管于 Tauri State，供命令访问）。
#[derive(Clone)]
pub struct AgentRuntime {
    pub approval: Arc<ApprovalManager>,
    pub native: Arc<Mutex<ToolRegistry>>,
}

impl AgentRuntime {
    pub fn new() -> Self {
        Self {
            approval: Arc::new(ApprovalManager::new()),
            native: Arc::new(Mutex::new(ToolRegistry::new())),
        }
    }

    /// 启动一轮任务（被 `run_agent_task` 命令调用，后台 spawn）。
    pub async fn run_task(&self, app: &AppHandle, cfg: AgentRuntimeConfig, prompt: String) {
        // 0) 动态重算并回写 tools_tokens：按当前已解析的 MCP/Skill 工具数覆盖写入会话表，
        //    中途移除 Skill / 停用（解绑）MCP 后，下一轮会自动下调；重新绑定则上调。
        if let Some(sid) = &cfg.session_id {
            crate::agent::round_compactor::persist_tools_tokens(
                app,
                sid,
                cfg.mcp_tools.len(),
                cfg.skill_tools.len(),
            )
            .await;
        }

        // 1) 组装工具注册表（基础原生 + 绑定的 Skill/MCP 工具）
        let mut base = self.native.lock().await.clone();
        native::register_native_tools(&mut base, app);
        // 技能：直接注册进本轮本地注册表（AgentTool 只读包装，真实执行待接入业务核心）
        crate::agent::skill_adapter::register_skills_into(&mut base, cfg.skill_tools.clone());
        // MCP：按 mcp_id 分组，逐 server 注册（复用现有 mcp::call_mcp_tool 透传）
        let mut by_server: std::collections::BTreeMap<String, Vec<crate::agent::mcp_adapter::MountedMcpTool>> =
            Default::default();
        for t in &cfg.mcp_tools {
            by_server.entry(t.mcp_id.clone()).or_default().push(t.clone());
        }
        for (server, tools) in by_server {
            crate::agent::mcp_adapter::register_mcp_into(&mut base, &server, tools);
        }
        // 工具已全部直接注册进 base（原生 + Skill + MCP），base 即完整注册表。
        let registry = base;
        println!(
            "[agent] run_task: 工具注册完成，共 {} 个工具（原生 + Skill + MCP）",
            registry.get_tools_for_llm().len()
        );

        // 2) 工作空间上下文
        let ws = cfg.workspace.as_ref().map(std::path::PathBuf::from);
        let ctx = ToolContext {
            workspace: ws,
            sandbox_enabled: cfg.allow_sandbox,
        };

        // 3) 组装发送给 LLM 的 messages（含滑动窗口压缩 / 历史摘要）。
        //    上下文封装抽离在 `context` 模块：system + 压缩摘要 + 最近 N 轮 verbatim + 当前 prompt；
        //    工具定义不经此注入（由 ReAct 循环作为顶层 tools 参数传入，保 prompt-cache 命中）。
        let mut messages = match crate::agent::context::build_context_messages(app, &cfg, &prompt).await {
            Ok(m) => m,
            Err(e) => {
                println!("[agent] run_task: 上下文组装失败：{e}");
                events::emit_task_error(app, &format!("上下文组装失败：{e}"));
                return;
            }
        };

        // 记录当前轮提问在 messages 中的下标；ReAct 循环结束后据此截取
        // 「本轮产生的完整消息序列」用于 raw_messages_json 回填（协议视图，无损）。
        let round_base = messages.len().saturating_sub(1);

        // 4) ReAct 循环
        let mut iteration = 0;
        // 整轮任务真实 token 用量累计（跨所有 ReAct 轮，每轮 LLM 调用的 prompt+completion）。
        let mut task_usage: (u64, u64) = (0, 0);
        loop {
            if iteration >= MAX_TOOL_ITERATIONS {
                println!(
                    "[agent] run_task: 触发最大工具循环熔断 iteration={} max={} messages={}，任务终止",
                    iteration,
                    MAX_TOOL_ITERATIONS,
                    messages.len(),
                );
                // 熔断时仍推送一条终态文本，避免前端因无正文而长期显示「思考中…」。
                let msg = format!(
                    "已达到最大工具调用轮次上限（{} 轮），为防死循环已提前终止本次任务。\n任务可能尚未完成——建议：① 将目标拆分为更小的步骤；② 检查是否陷入重复调用同一工具；③ 如确需更多轮次，可联系开发者调高 MAX_TOOL_ITERATIONS 后重试。",
                    MAX_TOOL_ITERATIONS
                );
                events::emit_error(app, &msg);
                events::emit_text_chunk(app, &msg, false);
                events::emit_text_chunk(app, "", true);
                messages.push(json!({ "role": "assistant", "content": msg }));
                break;
            }
            iteration += 1;

            // 裁剪历史（滑动窗口）
            let trimmed = trim_history(&messages);

            // 每轮仅调用一次 LLM（流式）：在 SSE 增量中同时聚合正文与 tool_calls。
            // 旧架构是「非流式 call_llm 判断 + 流式 call_llm_stream 输出」两次调用同一 messages，
            // 既浪费 token / 延迟，又因模型非确定性可能出现「第一次判终态、第二次却返回
            // tool_calls（被流式解析忽略）」导致最终回答为空——历史回显「思考中」即源于此。
            let tools = registry.get_tools_for_llm();
            println!(
                "[agent] run_task: 第 {} 轮，流式调用 LLM（模型={} 工具数={} 上下文={}条消息[裁剪前{}条]）",
                iteration,
                if cfg.llm_model_name.is_empty() {
                    "<无>"
                } else {
                    cfg.llm_model_name.as_str()
                },
                tools.len(),
                trimmed.len(),
                messages.len(),
            );
            let mut outcome = match call_llm_stream(app, &cfg, &trimmed, &tools).await {
                Ok(o) => o,
                Err(e) => {
                    println!("[agent] run_task: LLM 调用失败：{e}");
                    events::emit_task_error(app, &format!("LLM 调用失败：{e}"));
                    return;
                }
            };
            // 本轮 LLM 真实用量（流式路径已写入 outcome.usage；兜底非流式会覆盖此值）。
            let mut round_usage = outcome.usage;

            // 兜底：流式空响应（正文与 tool_calls 皆空）。个别网关不支持流式 tool_calls
            // （模型想调工具但 delta 里不下发），此时回退一次非流式调用拿真实决策。
            if outcome.content.trim().is_empty() && outcome.tool_calls.is_empty() {
                println!("[agent] run_task: 流式空响应，回退非流式调用兜底");
                match call_llm(&cfg, &trimmed, &tools).await {
                    Ok((choice, usage)) => {
                        outcome = StreamOutcome {
                            content: choice
                                .get("content")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            reasoning: choice
                                .get("reasoning")
                                .and_then(|v| v.as_str())
                                .or_else(|| choice.get("reasoning_content").and_then(|v| v.as_str()))
                                .unwrap_or("")
                                .to_string(),
                            tool_calls: choice
                                .get("tool_calls")
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default(),
                            usage,
                        };
                        round_usage = usage;
                    }
                    Err(e) => {
                        println!("[agent] run_task: LLM 兜底调用失败：{e}");
                        events::emit_task_error(app, &format!("LLM 调用失败：{e}"));
                        return;
                    }
                }
            }

            // 累计本轮真实 token 用量（流式或兜底非流式取其一，已用 round_usage 取值）。
            task_usage.0 += round_usage.0;
            task_usage.1 += round_usage.1;

            // LLM 本轮返回摘要（排错核心信息：模型到底决定了什么）
            println!(
                "[agent] run_task: 第 {} 轮 LLM 返回 | 正文={}字符 推理={}字符 tool_calls={}个{}",
                iteration,
                outcome.content.chars().count(),
                outcome.reasoning.chars().count(),
                outcome.tool_calls.len(),
                if outcome.tool_calls.is_empty() {
                    "（终态）".to_string()
                } else {
                    format!(
                        "：[{}]",
                        outcome
                            .tool_calls
                            .iter()
                            .filter_map(|tc| tc.get("function"))
                            .filter_map(|f| f.get("name"))
                            .filter_map(|n| n.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                },
            );

            // 没有工具调用 → 终态：正文一次性推送（前端 useTypewriter 负责打字机呈现）
            if outcome.tool_calls.is_empty() {
                println!(
                    "[agent] run_task: 第 {} 轮无工具调用，输出终态文本（{} 字符）：{}",
                    iteration,
                    outcome.content.chars().count(),
                    clip(outcome.content.trim(), 200),
                );
                if !outcome.content.is_empty() {
                    events::emit_text_chunk(app, &outcome.content, false);
                }
                events::emit_text_chunk(app, "", true);
                messages.push(json!({ "role": "assistant", "content": outcome.content }));
                break;
            }

            // 有工具调用：把模型在决定调用工具之前的「真实推理/思考」推送给前端
            // （content 多为模型的规划/分析文本；reasoning 为 DeepSeek 等风格的独立思考字段）。
            let reasoning_trim = outcome.reasoning.trim().to_string();
            if !reasoning_trim.is_empty() {
                events::emit_status(app, &reasoning_trim);
            }
            let content_trim = outcome.content.trim().to_string();
            if !content_trim.is_empty() {
                events::emit_status(app, &content_trim);
            }

            // 有工具调用：逐条执行
            messages.push(json!({
                "role": "assistant",
                "content": outcome.content,
                "tool_calls": outcome.tool_calls.clone()
            }));

            for tc in &outcome.tool_calls {
                let (call_id, tool_name, args) = match parse_tool_call(tc) {
                    Some(x) => x,
                    None => {
                        println!(
                            "[agent] run_task: 工具调用格式无法解析，跳过 raw_tool_call={}",
                            clip(&tc.to_string(), 500),
                        );
                        events::emit_error(app, "工具调用格式无法解析，跳过");
                        continue;
                    }
                };

                let tool = match registry.get(&tool_name) {
                    Some(t) => t,
                    None => {
                        println!("[agent] run_task: 注册表找不到模型请求的工具 name={}", tool_name);
                        events::emit_error(app, &format!("未知工具：{tool_name}"));
                        continue;
                    }
                };

                println!(
                    "[agent] run_task: 执行工具 {} (call_id={}) 参数={}",
                    tool_name,
                    call_id,
                    clip(&serde_json::to_string(&args).unwrap_or_default(), 300),
                );

                // 构造步骤快照（running）
                let step_id = call_id.clone();
                let sensitive = tool.check_permission(&args) == PermissionLevel::RequireApproval;
                let started = ToolStep {
                    call_id: step_id.clone(),
                    tool_name: tool_name.clone(),
                    status: "running".into(),
                    sensitive,
                    args: Some(serde_json::to_string(&args).unwrap_or_default()),
                    result: None,
                    duration_ms: None,
                    created_at: now_ms(),
                };
                events::emit_tool_started(app, &started);

                // 敏感工具：审批挂起（auto_tool_exec_mode 时跳过逐次确认）
                if sensitive && !cfg.auto_tool_exec_mode {
                    let approval_id = format!("ap-{}-{}", cfg.agent_id, step_id);
                    let req = ApprovalRequest {
                        approval_id: approval_id.clone(),
                        tool_name: tool_name.clone(),
                        description: format!("智能体请求执行敏感操作：{}", tool_name),
                        args: serde_json::to_string(&args).unwrap_or_default(),
                        kind: detect_kind(&tool_name, &args),
                        hint: Some("请在弹窗中允许或拒绝（拒绝可填写原因引导纠偏）".into()),
                    };
                    events::emit_awaiting_approval(app, &req);
                    let rx = self.approval.suspend(req).await;
                    let approval_outcome: ApprovalOutcome = match rx.await {
                        Ok(o) => o,
                        Err(_) => {
                            // 通道关闭（前端未响应 / 超时）：默认拒绝
                            self.approval.cancel(&approval_id).await;
                            ApprovalOutcome {
                                approved: false,
                                reason: Some("审批超时，已自动拒绝".into()),
                            }
                        }
                    };
                    println!(
                        "[agent] run_task: 审批完成 approval_id={} approved={} reason={}",
                        approval_id,
                        approval_outcome.approved,
                        approval_outcome.reason.as_deref().unwrap_or("<无>"),
                    );
                    if !approval_outcome.approved {
                        let reason = approval_outcome.reason.unwrap_or_else(|| "用户拒绝".into());
                        let finished = ToolStep {
                            call_id: step_id.clone(),
                            tool_name: tool_name.clone(),
                            status: "failed".into(),
                            sensitive,
                            args: Some(serde_json::to_string(&args).unwrap_or_default()),
                            result: Some(format!("已拒绝：{reason}")),
                            duration_ms: None,
                            created_at: now_ms(),
                        };
                        events::emit_tool_finished(app, &finished);
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": format!("用户拒绝执行：{reason}")
                        }));
                        continue;
                    }
                }

                // 执行工具
                let t0 = Instant::now();
                let result = tool.execute(args.clone(), &ctx).await;
                let (status, result_text) = match &result {
                    Ok(s) => ("success".into(), s.clone()),
                    Err(ToolError::InvalidArgs(m))
                    | Err(ToolError::ExecutionFailed(m))
                    | Err(ToolError::PermissionDenied(m)) => ("failed".into(), m.clone()),
                };
                let finished = ToolStep {
                    call_id: step_id.clone(),
                    tool_name: tool_name.clone(),
                    status,
                    sensitive,
                    args: Some(serde_json::to_string(&args).unwrap_or_default()),
                    result: Some(result_text.clone()),
                    duration_ms: Some(t0.elapsed().as_millis() as u64),
                    created_at: now_ms(),
                };
                events::emit_tool_finished(app, &finished);
                println!(
                    "[agent] run_task: 工具 {} 执行完成 ok={} 耗时={}ms 结果={}",
                    tool_name,
                    result.is_ok(),
                    t0.elapsed().as_millis(),
                    clip(&result_text, 400),
                );
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": result_text
                }));
            }
        }

        events::emit_task_done(app, task_usage.0, task_usage.1);

        // 真实 token 用量累计写回会话表（prompt + completion；tools_tokens 由 persist_tools_tokens 单独维护）。
        if let Some(sid) = &cfg.session_id {
            crate::agent::round_compactor::persist_session_tokens(app, sid, task_usage.0, task_usage.1).await;
        }

        // 第 N 轮结束后：回填本轮 raw_messages_json（协议视图），累计轮次，
        // 并派发后台滚动压缩（Tokio 异步、非阻塞，用户下一轮提问零前置等待）。
        if let Some(round_id) = &cfg.round_id {
            let round_messages = &messages[round_base..];
            match serde_json::to_string(round_messages) {
                Ok(raw_json) => {
                    println!(
                        "[agent] run_task: 回填 raw_messages_json（round={} 消息={}条 大小={}字符）",
                        round_id,
                        round_messages.len(),
                        raw_json.chars().count(),
                    );
                    crate::agent::round_compactor::persist_round_raw(app, round_id, &raw_json).await;
                }
                Err(e) => {
                    println!("[agent] run_task: 序列化 raw_messages_json 失败：{e}");
                }
            }
            if let Some(sid) = &cfg.session_id {
                crate::agent::round_compactor::bump_session_turns(app, sid).await;
                crate::agent::round_compactor::trigger_background_compaction(app, &cfg, sid).await;
            }
        } else {
            println!("[agent] run_task: 无 round_id，跳过 raw_messages_json 回填与压缩触发");
        }
    }
}

/* ----------------------------- LLM 调用 ----------------------------- */

pub(crate) async fn call_llm(
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
) -> Result<(Value, (u64, u64)), String> {
    if cfg.llm_base_url.is_empty() || cfg.llm_model_name.is_empty() {
        return Err("智能体未绑定有效的 LLM（base_url / model_name 为空）".into());
    }

    println!(
        "[agent] call_llm: 请求 URL={} model={} 是否带 Key={}",
        normalize_chat_url(&cfg.llm_base_url),
        cfg.llm_model_name,
        !cfg.llm_api_key.is_empty()
    );

    let request_started = Instant::now();
    let client = reqwest::Client::new();
    let url = normalize_chat_url(&cfg.llm_base_url);

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
                println!("[agent] call_llm: reasoning=true 归一化为 {{}}（网关要求字典）");
            } else {
                obj.remove("reasoning");
                println!("[agent] call_llm: reasoning=false 已移除");
            }
        }
    }

    let body_preview = serde_json::to_string(&sanitize_for_log(&body)).unwrap_or_default();
    println!(
        "[agent] call_llm: 请求体预览（已脱敏/截断）={} ",
        clip(&body_preview, 5000)
    );

    let mut req = client.post(&url).json(&body);
    if !cfg.llm_api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.llm_api_key));
    }

    let resp = req.send().await.map_err(|e| {
        println!(
            "[agent] call_llm: 请求失败（耗时={}ms）：{}",
            request_started.elapsed().as_millis(),
            e
        );
        format!("请求失败：{e}")
    })?;
    let status = resp.status();
    println!(
        "[agent] call_llm: 收到 HTTP {}（耗时={}ms）",
        status,
        request_started.elapsed().as_millis()
    );
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let safe_text = clip(&sanitize_for_log(&Value::String(text.clone())).to_string(), 5000);
        println!("[agent] call_llm: HTTP {} 错误体（已脱敏/截断）={}", status, safe_text);
        return Err(format!("HTTP {}：{}", status, clip(&text, 2000)));
    }
    let data: Value = resp.json().await.map_err(|e| format!("响应解析失败：{e}"))?;
    println!(
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
    println!(
        "[agent] call_llm: 非流式 usage prompt={} completion={}",
        usage.0, usage.1
    );
    let message = data
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .cloned()
        .ok_or_else(|| "LLM 响应缺少 choices[0].message".to_string())?;
    Ok((message, usage))
}

/// 流式调用的聚合结果（一轮 ReAct 的 LLM 输出）。
struct StreamOutcome {
    /// 模型输出正文（终态轮为回答；工具轮多为规划/分析短文，可空）。
    content: String,
    /// 模型推理字段（DeepSeek 风格 `reasoning` / `reasoning_content`）。
    reasoning: String,
    /// 标准 OpenAI 格式的 tool_calls（流式增量已按 index 归并完整）。
    tool_calls: Vec<Value>,
    /// 本轮 LLM 真实 token 用量（prompt / completion），取自 OpenAI 响应的 `usage`。
    /// 跨所有 ReAct 轮累计即为整轮任务的真实消耗，替代前端基于「仅首尾文本」的估算
    /// （旧估算会把 system prompt / 工具定义 / 中间工具往返全部漏掉，导致 token 严重低估）。
    usage: (u64, u64),
}

/// 流式调用 LLM（SSE）：聚合本轮的正文、推理与 tool_calls，返回给 ReAct 循环决策。
///
/// 每轮仅这一次 HTTP 调用（替代旧架构「非流式判断 + 流式输出」的双调用）：
///  - 正文 / 推理先缓冲，不边收边 emit —— 因为此时还不确定本轮是「终态回答」
///    还是「工具轮规划」，二者去向不同（回答气泡 vs 思考面板），由调用方决定；
///  - `delta.tool_calls` 是增量格式（首 chunk 带 id/name，后续仅带 arguments 片段），
///    按 `index` 归并为完整的标准 tool_calls；
///  - 调用方拿到空响应（正文与 tool_calls 皆空）时应回退非流式 `call_llm` 兜底。
async fn call_llm_stream(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
) -> Result<StreamOutcome, String> {
    let _ = app; // 事件推送已上移到 ReAct 循环，本函数只做拉流聚合
    if cfg.llm_base_url.is_empty() || cfg.llm_model_name.is_empty() {
        return Err("智能体未绑定有效的 LLM（base_url / model_name 为空）".into());
    }

    println!(
        "[agent] call_llm_stream: 请求 URL={} model={} 是否带 Key={}",
        normalize_chat_url(&cfg.llm_base_url),
        cfg.llm_model_name,
        !cfg.llm_api_key.is_empty()
    );

    let request_started = Instant::now();
    let client = reqwest::Client::new();
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
                println!("[agent] call_llm_stream: reasoning=true 归一化为 {{}}");
            } else {
                obj.remove("reasoning");
                println!("[agent] call_llm_stream: reasoning=false 已移除");
            }
        }
    }

    let body_preview = serde_json::to_string(&sanitize_for_log(&body)).unwrap_or_default();
    println!(
        "[agent] call_llm_stream: 请求体预览（已脱敏/截断）={} ",
        clip(&body_preview, 5000)
    );

    let mut req = client.post(&url).json(&body);
    if !cfg.llm_api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.llm_api_key));
    }
    // 部分网关需要显式声明 Accept: text/event-stream
    req = req.header("Accept", "text/event-stream");

    let resp = req.send().await.map_err(|e| {
        println!(
            "[agent] call_llm_stream: 请求失败（耗时={}ms）：{}",
            request_started.elapsed().as_millis(),
            e
        );
        format!("请求失败：{e}")
    })?;
    let status = resp.status();
    println!(
        "[agent] call_llm_stream: 收到 HTTP {}（耗时={}ms）",
        status,
        request_started.elapsed().as_millis()
    );
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let safe_text = clip(&sanitize_for_log(&Value::String(text.clone())).to_string(), 5000);
        println!(
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
    let mut chunk_count = 0usize;
    let mut line_count = 0usize;
    let mut parse_error_count = 0usize;
    // tool_calls 增量归并：index -> (id, name, arguments 片段拼接)
    let mut tc_acc: std::collections::BTreeMap<u64, (String, String, String)> = Default::default();
    // 真实 token 用量累计（OpenAI 把 usage 放在最后一个 chunk 之前；不同网关位置略有差异，每片都取最新非空值）。
    let mut usage: (u64, u64) = (0, 0);
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| {
            println!("[agent] call_llm_stream: SSE 流读取失败（已耗时={}ms）：{}", request_started.elapsed().as_millis(), e);
            format!("流读取失败：{e}")
        })?;
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
                    absorb_stream_delta(&json, &mut content, &mut reasoning, &mut tc_acc);
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
                    println!(
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
                    absorb_stream_delta(&json, &mut content, &mut reasoning, &mut tc_acc);
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

    println!(
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
) {
    let delta = json
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("delta"));
    let Some(delta) = delta else { return };

    if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
        content.push_str(c);
    }
    // DeepSeek 等风格的推理字段（两种命名兼容）
    for key in ["reasoning", "reasoning_content"] {
        if let Some(r) = delta.get(key).and_then(|v| v.as_str()) {
            reasoning.push_str(r);
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

/* ----------------------------- 工具辅助 ----------------------------- */

fn parse_tool_call(tc: &Value) -> Option<(String, String, Value)> {
    let id = tc.get("id").and_then(|v| v.as_str())?.to_string();
    let func = tc.get("function")?;
    let name = func.get("name").and_then(|v| v.as_str())?.to_string();
    let args_str = func.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
    let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
    Some((id, name, args))
}

fn detect_kind(tool_name: &str, args: &Value) -> String {
    if tool_name.contains("edit_file") {
        "edit_file".into()
    } else if tool_name.contains("execute_command") {
        "execute_command".into()
    } else {
        // 把 path/command 等字段透传给前端做友好展示
        let _ = args;
        "other".into()
    }
}

fn trim_history(messages: &[Value]) -> Vec<Value> {
    // 保留 system，裁剪早期 user/assistant/tool 轮次至最近 N 轮
    if messages.len() <= MAX_HISTORY_TURNS * 2 + 1 {
        return messages.to_vec();
    }
    let system = messages.first().cloned();
    let rest = &messages[1..];
    let keep = rest.len().saturating_sub(MAX_HISTORY_TURNS * 2);
    let mut out = Vec::new();
    if let Some(s) = system {
        out.push(s);
    }
    out.extend_from_slice(&rest[keep..]);
    out
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 递归生成安全日志视图：保留请求结构，但不输出密钥、鉴权信息或图片 base64。
fn sanitize_for_log(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace('-', "_");
                let sensitive = matches!(
                    normalized.as_str(),
                    "api_key"
                        | "apikey"
                        | "api_secret"
                        | "apisecret"
                        | "access_token"
                        | "accesstoken"
                        | "authorization"
                        | "cookie"
                        | "client_secret"
                        | "clientsecret"
                ) || normalized == "token"
                    || normalized.ends_with("_secret")
                    || normalized.ends_with("_token")
                    || normalized == "data_url"
                    || normalized == "dataurl"
                    || normalized == "image_url"
                    || child
                        .as_str()
                        .map(|s| s.starts_with("data:image/") || s.len() > 20000)
                        .unwrap_or(false);
                if sensitive {
                    let size = child
                        .as_str()
                        .map(|s| s.chars().count())
                        .unwrap_or_else(|| child.to_string().chars().count());
                    out.insert(key.clone(), json!(format!("<已脱敏，原长度{}字符>", size)));
                } else {
                    out.insert(key.clone(), sanitize_for_log(child));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize_for_log).collect()),
        other => other.clone(),
    }
}

/// 日志截断：超长内容截取前 `max` 个字符并附原始长度（避免大段工具结果刷屏）。
pub(crate) fn clip(s: &str, max: usize) -> String {
    let total = s.chars().count();
    if total <= max {
        s.to_string()
    } else {
        format!("{}…(共{}字符)", s.chars().take(max).collect::<String>(), total)
    }
}

