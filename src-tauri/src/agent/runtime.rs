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
use std::sync::atomic::{AtomicBool, Ordering};
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

/// 历史消息保留轮次（滑动窗口）。
const MAX_HISTORY_TURNS: usize = 24;
/// 工具返回结果物理截断阈值（字符）。防止超大输出撑爆上下文、无谓消耗 Token。
const MAX_TOOL_OUTPUT_LENGTH: usize = 15000;

/// 运行时共享状态（托管于 Tauri State，供命令访问）。
#[derive(Clone)]
pub struct AgentRuntime {
    pub approval: Arc<ApprovalManager>,
    pub native: Arc<Mutex<ToolRegistry>>,
    /// 任务取消标志（用户点击「停止」时由 `cancel_agent_task` 置 true）。
    /// 以 `Arc<AtomicBool>` 形式在命令与后台任务间共享，无需额外句柄即可感知取消。
    pub cancel_flag: Arc<AtomicBool>,
}

impl AgentRuntime {
    pub fn new() -> Self {
        Self {
            approval: Arc::new(ApprovalManager::new()),
            native: Arc::new(Mutex::new(ToolRegistry::new())),
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 启动一轮任务（被 `run_agent_task` 命令调用，后台 spawn）。
    #[allow(unreachable_code)]
    pub async fn run_task(&self, app: &AppHandle, cfg: AgentRuntimeConfig, prompt: String) {
        // 0) 新一轮任务开始：清除上一轮可能残留的取消标志（cancel_agent_task 已无副作用），
        //    同时保证"上一次取消未生效就立刻发起新任务"不会误杀新任务。
        self.cancel_flag.store(false, Ordering::SeqCst);

        // 0.1) 动态重算并回写 tools_tokens：按当前已解析的 MCP/Skill 工具数覆盖写入会话表，
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
        // 沙箱模式下不注册 execute_command（宿主 shell），能力层与提示层保持一致
        native::register_native_tools(&mut base, app, cfg.allow_sandbox);
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

        // ────────────────────────────────────────────────────────────────────
        // 三层流水线调度（新架构）：意图分流 → DAG 规划 → 微 ReAct 流水线执行。
        // 下方旧的全局大 ReAct 循环已废弃（if false 留档，验证后删除）。
        // ────────────────────────────────────────────────────────────────────

        // 阶段一：意图分流（规则短路优先，灰色地带走轻量 LLM 分类）。
        let intent = crate::agent::intent::classify_intent(&cfg, &prompt).await;
        println!(
            "[agent] run_task: 意图判定 = {} reason={}",
            intent.intent_type,
            clip(&intent.reason, 200),
        );

        // 分支 A：简单对话 → 单次流式输出，0 工具介入，终态即结束。
        if intent.is_simple_chat() {
            self.run_simple_chat(app, &cfg, &prompt, &self.cancel_flag).await;
            return;
        }

        // 分支 B：复合任务 → 阶段二任务拆解规划。
        events::emit_status(app, "正在规划任务步骤…");
        let (plan, plan_usage) =
            crate::agent::planner::build_plan(&cfg, &prompt, cfg.workspace.as_deref()).await;

        // 规划期间用户可能已点击取消：规划完成后立即检查，避免拉起无意义的流水线。
        if self.cancel_flag.load(Ordering::SeqCst) {
            println!("[agent] run_task: 规划完成后检测到取消信号，终止任务");
            events::emit_status(app, "⛔ 任务已被用户取消");
            events::emit_task_done(app, plan_usage.0, plan_usage.1);
            return;
        }
        events::emit_plan_generated(app, &plan);

        // 阶段三：流水线隔离执行（子任务独立上下文、产物管道、失败重试 3 次）。
        let result = crate::agent::pipeline::run_pipeline(
            app,
            &cfg,
            &registry,
            &ctx,
            &self.approval,
            &plan,
            &self.cancel_flag,
        )
        .await;

        // 用户中途取消：跳过正常收尾（不持久化半成品 round），仅做取消提示并收尾。
        if result.cancelled {
            println!("[agent] run_task: 流水线检测到取消信号，已提前收尾");
            let task_usage = (plan_usage.0 + result.usage.0, plan_usage.1 + result.usage.1);
            events::emit_status(app, "⛔ 任务已被用户取消");
            events::emit_task_done(app, task_usage.0, task_usage.1);
            return;
        }

        // 阶段四：合并全局执行视图，一次性推送终态文本（前端打字机渲染）。
        events::emit_text_chunk(app, &result.final_text, false);
        events::emit_text_chunk(app, "", true);

        // token 用量 = 规划 + 各子任务累计，写回会话表并随事件带出。
        let task_usage = (plan_usage.0 + result.usage.0, plan_usage.1 + result.usage.1);
        events::emit_task_done(app, task_usage.0, task_usage.1);
        if let Some(sid) = &cfg.session_id {
            crate::agent::round_compactor::persist_session_tokens(app, sid, task_usage.0, task_usage.1).await;
        }

        // 持久化精简协议日志（宏观意图 + 步骤规划 + 最终交付），入库前自检防孤儿消息。
        if let Some(round_id) = &cfg.round_id {
            let mut compact_round = vec![
                json!({ "role": "user", "content": prompt.clone() }),
                json!({
                    "role": "assistant",
                    "content": format!(
                        "[任务规划：{}（{} 步）]\n{}",
                        plan.goal_summary,
                        plan.tasks.len(),
                        plan.tasks.iter().map(|t| format!("步骤{}：{}", t.step, t.title)).collect::<Vec<_>>().join("；")
                    )
                }),
                json!({ "role": "assistant", "content": result.final_text.clone() }),
            ];
            sanitize_message_sequence(&mut compact_round);
            match serde_json::to_string(&compact_round) {
                Ok(raw_json) => {
                    println!(
                        "[agent] run_task: 回填精简 raw_messages_json（round={} 大小={}字符）",
                        round_id,
                        raw_json.chars().count(),
                    );
                    crate::agent::round_compactor::persist_round_raw(app, round_id, &raw_json).await;
                }
                Err(e) => println!("[agent] run_task: 序列化精简 raw_messages_json 失败：{e}"),
            }
            if let Some(sid) = &cfg.session_id {
                crate::agent::round_compactor::bump_session_turns(app, sid).await;
                crate::agent::round_compactor::trigger_background_compaction(app, &cfg, sid).await;
            }
        } else {
            println!("[agent] run_task: 无 round_id，跳过精简 raw_messages_json 回填");
        }
        return;

    }

    /// 分支 A（SIMPLE_CHAT）：单次流式输出，0 工具介入，毫秒级终态推送。
    /// 简单对话需要延续会话上下文（含历史轮次与滚动摘要），因此走 build_context_messages；
    /// 但 tools 传空，模型只能直出文本，不会产生工具调用。
    async fn run_simple_chat(
        &self,
        app: &AppHandle,
        cfg: &AgentRuntimeConfig,
        prompt: &str,
        cancel: &Arc<AtomicBool>,
    ) {
        let mut messages = match crate::agent::context::build_context_messages(app, cfg, prompt).await {
            Ok(m) => m,
            Err(e) => {
                println!("[agent] run_simple_chat: 上下文组装失败：{e}");
                events::emit_task_error(app, &format!("上下文组装失败：{e}"));
                return;
            }
        };
        let round_base = messages.len().saturating_sub(1);
        let mut task_usage: (u64, u64) = (0, 0);

        // 裁剪 + 配对自检（历史轮次可能很长）。
        let mut trimmed = trim_history(&messages);
        sanitize_message_sequence(&mut trimmed);

        println!(
            "[agent] run_simple_chat: 单次流式调用（上下文={}条消息[裁剪前{}条]）",
            trimmed.len(),
            messages.len(),
        );
        match call_llm_stream(app, cfg, &trimmed, &[], cancel).await {
            Ok(outcome) => {
                task_usage.0 += outcome.usage.0;
                task_usage.1 += outcome.usage.1;
                // 流式过程中用户可能已点击取消：生成内容作废，仅做取消提示。
                if cancel.load(Ordering::SeqCst) {
                    println!("[agent] run_simple_chat: 流式返回后检测到取消信号，终止任务");
                    events::emit_status(app, "⛔ 任务已被用户取消");
                    events::emit_task_done(app, task_usage.0, task_usage.1);
                    return;
                }
                let content = outcome.content;
                println!(
                    "[agent] run_simple_chat: 终态文本 {} 字符：{}",
                    content.chars().count(),
                    clip(content.trim(), 200),
                );
                if !content.is_empty() {
                    events::emit_text_chunk(app, &content, false);
                }
                events::emit_text_chunk(app, "", true);
                messages.push(json!({ "role": "assistant", "content": content }));
            }
            Err(e) => {
                println!("[agent] run_simple_chat: LLM 调用失败：{e}");
                events::emit_task_error(app, &format!("LLM 调用失败：{e}"));
                return;
            }
        }

        events::emit_task_done(app, task_usage.0, task_usage.1);
        if let Some(sid) = &cfg.session_id {
            crate::agent::round_compactor::persist_session_tokens(app, sid, task_usage.0, task_usage.1).await;
        }
        if let Some(round_id) = &cfg.round_id {
            let round_messages = &messages[round_base..];
            match serde_json::to_string(round_messages) {
                Ok(raw_json) => {
                    crate::agent::round_compactor::persist_round_raw(app, round_id, &raw_json).await;
                }
                Err(e) => println!("[agent] run_simple_chat: 序列化 raw_messages_json 失败：{e}"),
            }
            if let Some(sid) = &cfg.session_id {
                crate::agent::round_compactor::bump_session_turns(app, sid).await;
                crate::agent::round_compactor::trigger_background_compaction(app, cfg, sid).await;
            }
        }
    }
}

/// 单轮工具执行结果统计（供连续错误熔断判定）。
pub(crate) struct ToolRoundStats {
    pub had_success: bool,
    pub had_error: bool,
}

/// 执行一轮 LLM 返回的全部 tool_calls：把 assistant 消息与所有工具结果按序压入 messages。
/// `run_task`（遗留全局循环）与 `pipeline`（微 ReAct 子任务）共用，避免两份逻辑漂移。
///
/// 固定环节：参数 JSON 自愈回灌（ParseError）→ 注册表查找 → 敏感工具审批挂起
/// → 执行 → `truncate_tool_output(15000)` 物理截断 → 推送 tool_started/finished 事件。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_tool_calls_round(
    app: &AppHandle,
    registry: &ToolRegistry,
    ctx: &ToolContext,
    approval: &ApprovalManager,
    cfg: &AgentRuntimeConfig,
    messages: &mut Vec<Value>,
    outcome: &StreamOutcome,
) -> ToolRoundStats {
    messages.push(json!({
        "role": "assistant",
        "content": outcome.content,
        "tool_calls": outcome.tool_calls.clone()
    }));

    let mut iter_had_error = false;
    let mut iter_had_success = false;

    for tc in &outcome.tool_calls {
        let (call_id, tool_name, args) = match parse_tool_call(tc) {
            ParseOutcome::Ready { call_id, name, args } => (call_id, name, args),
            ParseOutcome::ParseError { call_id, name, error } => {
                // 幻觉自愈：把 JSON 解析错误作为 ToolResult 回传，强制模型下一轮纠错。
                println!(
                    "[agent] tool_round: 工具参数 JSON 解析失败 name={} err={}",
                    name,
                    clip(&error, 300),
                );
                iter_had_error = true;
                events::emit_error(app, &format!("工具参数 JSON 解析失败：{name}"));
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": format!("JSON parse error: {error}. Please strictly check your escape characters and output valid JSON arguments.")
                }));
                continue;
            }
            ParseOutcome::Skip => {
                println!(
                    "[agent] tool_round: 工具调用字段缺失，跳过 raw_tool_call={}",
                    clip(&tc.to_string(), 500),
                );
                events::emit_error(app, "工具调用字段缺失，跳过");
                continue;
            }
        };

        let tool = match registry.get(&tool_name) {
            Some(t) => t,
            None => {
                println!("[agent] tool_round: 注册表找不到模型请求的工具 name={}", tool_name);
                events::emit_error(app, &format!("未知工具：{tool_name}"));
                continue;
            }
        };

        println!(
            "[agent] tool_round: 执行工具 {} (call_id={}) 参数={}",
            tool_name,
            call_id,
            clip(&serde_json::to_string(&args).unwrap_or_default(), 300),
        );

        let step_id = call_id.clone();
        let sensitive = tool.check_permission(&args) == PermissionLevel::RequireApproval;
        events::emit_tool_started(app, &ToolStep {
            call_id: step_id.clone(),
            tool_name: tool_name.clone(),
            status: "running".into(),
            sensitive,
            args: Some(serde_json::to_string(&args).unwrap_or_default()),
            result: None,
            duration_ms: None,
            created_at: now_ms(),
        });

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
            let rx = approval.suspend(req).await;
            let approval_outcome: ApprovalOutcome = match rx.await {
                Ok(o) => o,
                Err(_) => {
                    approval.cancel(&approval_id).await;
                    ApprovalOutcome {
                        approved: false,
                        reason: Some("审批超时，已自动拒绝".into()),
                    }
                }
            };
            println!(
                "[agent] tool_round: 审批完成 approval_id={} approved={} reason={}",
                approval_id,
                approval_outcome.approved,
                approval_outcome.reason.as_deref().unwrap_or("<无>"),
            );
            if !approval_outcome.approved {
                let reason = approval_outcome.reason.unwrap_or_else(|| "用户拒绝".into());
                events::emit_tool_finished(app, &ToolStep {
                    call_id: step_id.clone(),
                    tool_name: tool_name.clone(),
                    status: "failed".into(),
                    sensitive,
                    args: Some(serde_json::to_string(&args).unwrap_or_default()),
                    result: Some(format!("已拒绝：{reason}")),
                    duration_ms: None,
                    created_at: now_ms(),
                });
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
        let result = tool.execute(args.clone(), ctx).await;
        let (status, result_text) = match &result {
            Ok(s) => {
                iter_had_success = true;
                ("success".into(), truncate_tool_output(s.as_str()))
            }
            Err(ToolError::InvalidArgs(m)) => {
                // InvalidArgs 计入连续错误序列（死循环高风险）。
                iter_had_error = true;
                ("failed".into(), truncate_tool_output(m.as_str()))
            }
            Err(ToolError::ExecutionFailed(m)) | Err(ToolError::PermissionDenied(m)) => {
                ("failed".into(), truncate_tool_output(m.as_str()))
            }
        };
        events::emit_tool_finished(app, &ToolStep {
            call_id: step_id.clone(),
            tool_name: tool_name.clone(),
            status,
            sensitive,
            args: Some(serde_json::to_string(&args).unwrap_or_default()),
            result: Some(result_text.clone()),
            duration_ms: Some(t0.elapsed().as_millis() as u64),
            created_at: now_ms(),
        });
        println!(
            "[agent] tool_round: 工具 {} 执行完成 ok={} 耗时={}ms 结果={}",
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

    ToolRoundStats {
        had_success: iter_had_success,
        had_error: iter_had_error,
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
        clip(&body_preview, 1000)
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
pub(crate) async fn call_llm_stream(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    messages: &[Value],
    tools: &[Value],
    cancel: &Arc<AtomicBool>,
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
        clip(&body_preview, 1000)
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
        // 用户中途取消：立即终止拉流（连接随函数返回被丢弃），让本轮回合在
        // 调用方处检测到取消标志后提前结束。这是"停止按钮即时生效"的核心断流点。
        if cancel.load(Ordering::SeqCst) {
            println!(
                "[agent] call_llm_stream: 检测到取消信号，立即断流（已耗时={}ms）",
                request_started.elapsed().as_millis()
            );
            break;
        }
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

/// 工具调用解析结果。
enum ParseOutcome {
    /// 字段缺失（无 id / 无 function / 无 name）：无法回传 ToolResult，直接跳过。
    Skip,
    /// 字段齐全但 `arguments` 不是合法 JSON：把解析错误作为 ToolResult 回传，强制模型自我纠错。
    ParseError {
        call_id: String,
        name: String,
        error: String,
    },
    /// 正常解析。
    Ready {
        call_id: String,
        name: String,
        args: Value,
    },
}

fn parse_tool_call(tc: &Value) -> ParseOutcome {
    let id = match tc.get("id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return ParseOutcome::Skip,
    };
    let func = match tc.get("function") {
        Some(f) => f,
        None => return ParseOutcome::Skip,
    };
    let name = match func.get("name").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return ParseOutcome::Skip,
    };
    let args_str = func.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
    match serde_json::from_str::<Value>(args_str) {
        Ok(args) => ParseOutcome::Ready {
            call_id: id,
            name,
            args,
        },
        Err(e) => ParseOutcome::ParseError {
            call_id: id,
            name,
            error: e.to_string(),
        },
    }
}

/// 工具返回结果物理硬截断：超出 `MAX_TOOL_OUTPUT_LENGTH` 字符时截断并追加系统后缀，
/// 防止超大输出撑爆上下文、无谓消耗 Token。
fn truncate_tool_output(s: &str) -> String {
    if s.chars().count() <= MAX_TOOL_OUTPUT_LENGTH {
        return s.to_string();
    }
    let mut t: String = s.chars().take(MAX_TOOL_OUTPUT_LENGTH).collect();
    t.push_str(
        "...[Output Truncated: Exceeded 15000 characters. Please use tools like 'grep' or 'head' to filter specific information]",
    );
    t
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

/// 裁剪历史（滑动窗口）：保留 system + 最近若干条消息。
///
/// **关键不变量**：绝不允许切开 `tool_calls ↔ tool result` 的配对。
/// 一旦被保留的 assistant(tool_calls) 丢失了它的任一 tool 结果（或保留了
/// tool 结果却丢掉发出它的 assistant），网关会直接拒绝整个请求：
/// `invalid params, tool result's tool id(...) not found`（HTTP 400 / code 2013）。
/// 因此切点必须从"按条数算出的理想位置"逐条向前（更早）推进，
/// 直到落在一个配对安全的边界上——宁可多丢一点历史，也不能产生半截配对。
/// 消息序列自检 + 自愈：确保发给 LLM（以及落库）的 messages 满足工具配对不变量。
///
/// 覆盖：
/// - I2：每个含 `tool_calls` 的 assistant，其**全部** `tool_call.id` 都必须有对应 tool 结果；
/// - I3：每条 tool 消息的 `tool_call_id` 必须能追溯到发起它的 assistant（否则为孤儿，直接丢弃）；
/// - I5：序列末尾不得是悬空的 assistant(tool_calls)。
///
/// 为什么必须在发送前做：并行工具调用会产生「1 条 assistant + N 条 tool 结果」，
/// 只要其中任意一条结果缺失（被裁剪切掉、工具被跳过、任务取消、熔断 break），
/// 网关就会拒绝整个请求：
/// `invalid params, tool result's tool id(...) not found`（HTTP 400 / code 2013）。
/// 补一条占位结果远优于让整个任务崩溃——模型读到占位后会自行改道，而不是反复重试。
pub(crate) fn sanitize_message_sequence(messages: &mut Vec<Value>) {
    // ① 收集每个 assistant 声明的 tool_call id
    let mut declared: Vec<(usize, Vec<String>)> = Vec::new();
    let mut all_declared: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (i, m) in messages.iter().enumerate() {
        if m.get("role").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        if let Some(calls) = m.get("tool_calls").and_then(|v| v.as_array()) {
            let ids: Vec<String> = calls
                .iter()
                .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect();
            for id in &ids {
                all_declared.insert(id.clone());
            }
            if !ids.is_empty() {
                declared.push((i, ids));
            }
        }
    }

    // ② 已存在结果的 tool_call_id
    let mut answered: std::collections::HashSet<String> = std::collections::HashSet::new();
    for m in messages.iter() {
        if m.get("role").and_then(|v| v.as_str()) == Some("tool") {
            if let Some(id) = m.get("tool_call_id").and_then(|v| v.as_str()) {
                answered.insert(id.to_string());
            }
        }
    }

    // ③ 为缺失结果的 tool_call 补占位（紧随其 assistant 之后）
    let mut patches: Vec<(usize, Value)> = Vec::new();
    for (ai, ids) in &declared {
        let mut offset = 1usize;
        for id in ids {
            if !answered.contains(id) {
                patches.push((
                    ai + offset,
                    json!({
                        "role": "tool",
                        "tool_call_id": id,
                        "content": "[Tool result missing] This tool call has no recorded result \
(it may have been interrupted, cancelled, or dropped while trimming history). \
Do NOT blindly retry the same call — re-evaluate your plan and either try a different \
approach or report the situation to the user."
                    }),
                ));
                offset += 1;
            }
        }
    }
    // 倒序插入，避免下标偏移
    patches.sort_by(|a, b| b.0.cmp(&a.0));
    let patched = patches.len();
    for (pos, msg) in patches {
        let at = pos.min(messages.len());
        messages.insert(at, msg);
    }
    if patched > 0 {
        println!(
            "[agent] sanitize_message_sequence: 补齐 {} 条缺失的 tool 结果占位（防止 tool_call 悬空触发 HTTP 400）",
            patched
        );
    }

    // ④ 丢弃孤儿 tool 消息（找不到发起它的 assistant）
    let before = messages.len();
    messages.retain(|m| {
        if m.get("role").and_then(|v| v.as_str()) != Some("tool") {
            return true;
        }
        match m.get("tool_call_id").and_then(|v| v.as_str()) {
            Some(id) => all_declared.contains(id),
            None => false, // 连 id 都没有的 tool 消息必然是脏数据
        }
    });
    let dropped = before - messages.len();
    if dropped > 0 {
        println!(
            "[agent] sanitize_message_sequence: 丢弃 {} 条孤儿 tool 结果（其发起者 assistant 已不在上下文中）",
            dropped
        );
    }
}

fn trim_history(messages: &[Value]) -> Vec<Value> {
    let budget = MAX_HISTORY_TURNS * 2; // 不含 system 的保留额度
    if messages.len() <= budget + 1 {
        return messages.to_vec();
    }
    let system = messages.first().cloned();
    let rest = &messages[1..];

    // 理想起点（纯按条数），随后向前推进直到配对安全
    let mut start = rest.len().saturating_sub(budget);
    while start < rest.len() {
        if is_safe_start(rest, start) && !has_orphan_tool_result(&rest[start..]) {
            break;
        }
        start += 1;
    }
    // 兜底：极端情况下所有候选切点都不安全（例如历史几乎全是被打断的破碎配对），
    // 绝不能退化成「只剩 system、一条 user/tool 都不剩」——那会让本次调用失去用户输入。
    // 此时回退到「最后一条非 tool 消息」作为起点：宁可超出预算，也要保证上下文可用。
    if start >= rest.len() {
        start = rest
            .iter()
            .rposition(|m| m.get("role").and_then(|v| v.as_str()) != Some("tool"))
            .unwrap_or(0);
        println!(
            "[agent] trim_history: 所有候选切点均不安全，退化保留最后一条非 tool 消息（start={}）",
            start
        );
    }

    let mut out = Vec::new();
    if let Some(s) = system {
        out.push(s);
    }
    out.extend_from_slice(&rest[start..]);
    out
}

/// 切点自身不得破坏配对：
/// ① 切点不能是 tool 结果本身（否则发出它的 assistant 被留在了前一段）；
/// ② 切点若是带 tool_calls 的 assistant，则它**全部** tool_call 的结果都必须落在本段内
///    （并行工具调用时一轮会产生多条 tool 结果，只留一半必然 400）。
fn is_safe_start(rest: &[Value], start: usize) -> bool {
    let Some(first) = rest.get(start) else {
        return true;
    };
    let role = first.get("role").and_then(|v| v.as_str()).unwrap_or("");
    if role == "tool" {
        return false;
    }
    if role == "assistant" {
        if let Some(calls) = first.get("tool_calls").and_then(|v| v.as_array()) {
            for c in calls {
                let Some(id) = c.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let result_in_segment = rest[start + 1..].iter().any(|m| {
                    m.get("role").and_then(|v| v.as_str()) == Some("tool")
                        && m.get("tool_call_id").and_then(|v| v.as_str()) == Some(id)
                });
                if !result_in_segment {
                    return false;
                }
            }
        }
    }
    true
}

/// 段内不得存在"孤儿 tool 结果"：某条 tool 消息的 tool_call_id，
/// 在本段内找不到任何发出它的 assistant。
fn has_orphan_tool_result(seg: &[Value]) -> bool {
    seg.iter().any(|m| {
        if m.get("role").and_then(|v| v.as_str()) != Some("tool") {
            return false;
        }
        let Some(id) = m.get("tool_call_id").and_then(|v| v.as_str()) else {
            return true;
        };
        !seg.iter().any(|a| {
            a.get("role").and_then(|v| v.as_str()) == Some("assistant")
                && a.get("tool_calls")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .any(|c| c.get("id").and_then(|v| v.as_str()) == Some(id))
                    })
                    .unwrap_or(false)
        })
    })
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

