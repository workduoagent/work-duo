//! 简单对话路径（S1 拆分自 runtime.rs，台账 §2.1）。
//!
//! SIMPLE_CHAT 意图的单次/多轮流式执行：上下文装配 → call_llm_stream（ReadSafe 工具面）→
//! 撞线兜底（强制总结）→ 轮次 raw/answer 回填。run_simple_chat 由 runtime.rs 调用。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::agent::events;
use crate::agent::engine::llm::call_llm_stream;
use crate::agent::engine::protocol::{sanitize_message_sequence, trim_history};
use crate::agent::engine::runtime::clip;
use crate::agent::engine::tools::ToolRegistry;
use crate::agent::types::AgentRuntimeConfig;

    /// 简单对话路径：执行一轮 tool_calls（审批外事件推送 + 结果回灌 llm_messages）。
    /// 主循环与「轮次上限撞线兜底」共用（S1 回归修复：撞线时也要把这批工具执行完——
    /// 协议上 assistant.tool_calls 后必须跟对应 tool 消息；且数据已请求、丢弃可惜）。
    #[allow(clippy::too_many_arguments)]
    async fn exec_simple_tool_round(
        app: &AppHandle,
        cfg: &AgentRuntimeConfig,
        simple_tools: &[(String, std::sync::Arc<dyn crate::agent::engine::tools::AgentTool>)],
        llm_messages: &mut Vec<Value>,
        tool_calls: &[Value],
        assistant_content: &str,
    ) -> bool {
        llm_messages.push(json!({
            "role": "assistant",
            "content": assistant_content,
            "tool_calls": tool_calls.to_vec(),
        }));
        let mut all_ok = true;
        for tc in tool_calls {
            let call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let args_str = tc.pointer("/function/arguments").and_then(|v| v.as_str()).unwrap_or("{}").to_string();
            let args: Value = serde_json::from_str(&args_str).unwrap_or_else(|_| json!({}));
            let started_at = std::time::Instant::now();
            let tool = simple_tools.iter().find(|(n, _)| *n == name).map(|(_, t)| t.clone());
            let op = tool.as_ref().map(|t| t.behavior().op.map(String::from)).flatten();
            let mk_step = |status: &str, result: Option<String>, dur: Option<u64>| crate::agent::types::ToolStep {
                call_id: call_id.clone(),
                tool_name: name.clone(),
                status: status.into(),
                sensitive: false,
                args: Some(args_str.clone()),
                result,
                duration_ms: dur,
                created_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
                step: Some(1),
                op: op.clone(),
                path: None,
                lines_added: None,
                lines_removed: None,
            };
            events::emit_tool_started(app, &mk_step("running", None, None));
            let result = match &tool {
                Some(t) => {
                    let ctx = crate::agent::engine::tools::ToolContext {
                        agent_id: cfg.agent_id.clone(),
                        session_id: cfg.session_id.clone(),
                        workspace: cfg.workspace.as_ref().map(std::path::PathBuf::from),
                        http_allowed_hosts: cfg.http_allowed_hosts.clone(),
                        call_id: Some(call_id.clone()),
                        ..Default::default()
                    };
                    match crate::agent::engine::tools::AgentTool::execute(t.as_ref(), args, &ctx).await {
                        Ok(r) => r,
                        Err(e) => format!("{} 执行失败：{:?}", name, e),
                    }
                }
                None => format!(
                    "当前简单对话路径未挂载工具 {name}；请基于已有信息直接作答，或建议用户以完整任务方式重新提问。"
                ),
            };
            let ok = !result.starts_with(&format!("{name} 执行失败"));
            if !ok {
                all_ok = false;
            }
            events::emit_tool_finished(app, &mk_step(
                if ok { "success" } else { "failed" },
                Some(clip(&result, 2000)),
                Some(started_at.elapsed().as_millis() as u64),
            ));
            llm_messages.push(json!({ "role": "tool", "tool_call_id": call_id, "content": result }));
        }
        all_ok
    }

    /// 分支 A（SIMPLE_CHAT）：单次流式输出 + 可选知识库检索，毫秒级终态推送。
    /// 简单对话需要延续会话上下文（含历史轮次与滚动摘要），因此走 build_context_messages；
    /// 20260922 #1：KB 绑定时携带 native__kb_search（ReadSafe 免审批），纯问答走
    /// 「检索→综合」快路径（有界 2 轮工具循环，跳过规划），kb 未绑定时工具集仍为空、行为不变。
    /// S1 回归修复：工具面扩到 MCP 后链路变长（能力发现→检索→澄清补搜 ≥3 轮），
    /// 上限提升至 4 轮，且撞线时执行完在途调用并强制总结一轮——绝不用空正文终态。
pub(crate) async fn run_simple_chat(
        app: &AppHandle,
        cfg: &AgentRuntimeConfig,
        prompt: &str,
        cancel: &Arc<AtomicBool>,
        simple_tools: &[(String, std::sync::Arc<dyn crate::agent::engine::tools::AgentTool>)],
    ) {
        let mut messages = match crate::agent::engine::context::build_context_messages(app, cfg, prompt).await {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("[agent] run_simple_chat: 上下文组装失败：{e}");
                events::emit_task_error(app, &format!("上下文组装失败：{e}"));
                return;
            }
        };
        let round_base = messages.len().saturating_sub(1);
        let mut task_usage: (u64, u64) = (0, 0);

        // 裁剪 + 配对自检（历史轮次可能很长）。
        let mut trimmed = trim_history(&messages);
        sanitize_message_sequence(&mut trimmed);

        let tool_defs: Vec<serde_json::Value> =
            simple_tools.iter().map(|(_, t)| t.tool_definition()).collect();
        tracing::info!(
            "[agent] run_simple_chat: 单次流式调用（上下文={}条消息[裁剪前{}条]，ReadSafe 工具={}个）",
            trimmed.len(),
            messages.len(),
            tool_defs.len(),
        );
        // 有界工具轮上限：MCP 链路（能力发现 → 检索 → 澄清补搜）2 轮起步，4 轮封顶
        // （S1 回归修复：旧值 2 时模型第 3 轮想补充搜索即撞线，空正文被当终态）。
        const SIMPLE_CHAT_MAX_TOOL_ROUNDS: usize = 4;

        // 终态正文留存：循环以带值 break 退出（Err 臂直接 return）。
        let mut llm_messages = trimmed.clone();
        let mut tool_rounds = 0usize;
        let simple_final_text: String = 'chat: loop {
            let outcome = match call_llm_stream(
                app,
                cfg,
                &llm_messages,
                &tool_defs,
                cancel,
                // 增量推流：每个 SSE 正文 delta 立即作为 text_chunk 下发，前端逐字渲染为流式回复。
                Some(&|delta: &str| {
                    if !delta.is_empty() {
                        events::emit_text_chunk(app, delta, false);
                    }
                }),
                // reasoning 思考流式（#20260918011）：chat 层逐批推送（节流在 call_llm_stream 内）。
                Some(&|delta: &str| {
                    if !delta.is_empty() {
                        events::emit_thinking_chunk(app, delta, false, "chat");
                    }
                }),
            )
            .await
            {
                Ok(outcome) => {
                    task_usage.0 += outcome.usage.0;
                    task_usage.1 += outcome.usage.1;
                    // 流式过程中用户可能已点击取消：已推送片段保留，仅补取消提示并收尾。
                    if cancel.load(Ordering::SeqCst) {
                        tracing::info!("[agent] run_simple_chat: 流式返回后检测到取消信号，终止任务");
                        events::emit_status(app, "⛔ 任务已被用户取消");
                        events::emit_task_done(app, task_usage.0, task_usage.1);
                        return;
                    }
                    outcome
                }
                Err(e) => {
                    tracing::error!("[agent] run_simple_chat: LLM 调用失败：{e}");
                    events::emit_task_error(app, &format!("LLM 调用失败：{e}"));
                    return;
                }
            };
            // 撞线兜底（S1 回归修复）：达到上限仍返回 tool_calls → 先执行完本轮在途调用
            // （协议上 assistant.tool_calls 必须跟 tool 消息，且数据已请求、丢弃可惜），
            // 再注入强制总结指令、以空 tools 追加一轮——「有界」与「终态必有正文」两全。
            // 旧逻辑此处直接把空正文当终态，用户看到「（智能体未返回文本内容）」。
            // （不自增 tool_rounds：本分支必以 break/return 收尾，计数器不再被读。）
            if !outcome.tool_calls.is_empty() && tool_rounds >= SIMPLE_CHAT_MAX_TOOL_ROUNDS {
                exec_simple_tool_round(
                    app,
                    cfg,
                    simple_tools,
                    &mut llm_messages,
                    &outcome.tool_calls,
                    &outcome.content,
                )
                .await;
                llm_messages.push(json!({
                    "role": "user",
                    "content": "工具调用轮次已达上限。请基于以上已获取的工具结果直接给出最终回答；信息不足时明确说明还缺什么，不要再调用工具。",
                }));
                match call_llm_stream(
                    app,
                    cfg,
                    &llm_messages,
                    &[],
                    cancel,
                    Some(&|delta: &str| {
                        if !delta.is_empty() {
                            events::emit_text_chunk(app, delta, false);
                        }
                    }),
                    Some(&|delta: &str| {
                        if !delta.is_empty() {
                            events::emit_thinking_chunk(app, delta, false, "chat");
                        }
                    }),
                )
                .await
                {
                    Ok(summary) => {
                        task_usage.0 += summary.usage.0;
                        task_usage.1 += summary.usage.1;
                        let mut content = summary.content;
                        if content.trim().is_empty() {
                            content = "已完成工具检索，但生成最终回答失败；请重试或改用完整任务方式提问。".to_string();
                        }
                        tracing::info!(
                            "[agent] run_simple_chat: 撞线兜底总结 {} 字符：{}",
                            content.chars().count(),
                            clip(content.trim(), 200),
                        );
                        events::emit_text_chunk(app, "", true);
                        messages.push(json!({ "role": "assistant", "content": content }));
                        break 'chat content;
                    }
                    Err(e) => {
                        tracing::error!("[agent] run_simple_chat: 强制总结轮 LLM 调用失败：{e}");
                        events::emit_task_error(app, &format!("LLM 调用失败：{e}"));
                        return;
                    }
                }
            }
            // 正常终态：模型收敛（无工具调用）或无可用工具。
            if outcome.tool_calls.is_empty() || simple_tools.is_empty() {
                let content = outcome.content;
                tracing::info!(
                    "[agent] run_simple_chat: 终态文本 {} 字符：{}",
                    content.chars().count(),
                    clip(content.trim(), 200),
                );
                // 增量推流已在 call_llm_stream 内部逐片下发；此处仅补一个 done 标记收尾。
                events::emit_text_chunk(app, "", true);
                messages.push(json!({ "role": "assistant", "content": content }));
                break 'chat content;
            }
            // 工具轮：执行挂载的 ReadSafe 工具（kb/MCP/只读 native），结果回灌后再来一轮。
            tool_rounds += 1;
            exec_simple_tool_round(
                app,
                cfg,
                simple_tools,
                &mut llm_messages,
                &outcome.tool_calls,
                &outcome.content,
            )
            .await;
        };
        events::emit_task_done(app, task_usage.0, task_usage.1);
        if let Some(sid) = &cfg.session_id {
            crate::agent::engine::round_compactor::persist_session_tokens(app, sid, task_usage.0, task_usage.1).await;
        }
        if let Some(round_id) = &cfg.round_id {
            let round_messages = &messages[round_base..];
            match serde_json::to_string(round_messages) {
                Ok(raw_json) => {
                    crate::agent::engine::round_compactor::persist_round_raw(app, round_id, &raw_json).await;
                    crate::agent::engine::round_compactor::persist_round_answer_if_empty(app, round_id, &simple_final_text).await;
                    // #8 per-run：取当前 run 的桶（task_local 注入的 run_id）。
                    let rid = crate::agent::events::current_run_id();
                    let trace_thinking = crate::agent::events::trace_thinking_snapshot(&rid);
                    let trace_tools = crate::agent::events::trace_tool_calls_summary_json(&rid);
                    crate::agent::engine::round_compactor::persist_round_process_if_empty(app, round_id, &trace_thinking, &trace_tools).await;
                }
                Err(e) => tracing::error!("[agent] run_simple_chat: 序列化 raw_messages_json 失败：{e}"),
            }
            if let Some(sid) = &cfg.session_id {
                crate::agent::engine::round_compactor::bump_session_turns(app, sid).await;
                crate::agent::engine::round_compactor::trigger_background_compaction(app, cfg, sid).await;
            }
        }
    }

/// 收集 SIMPLE_CHAT 路径可用的工具（台账 S1 回归修复）。
///
/// 过滤规则（双条件，缺一不可）：
///  - `check_permission == ReadSafe`：写/执行/审批类工具不进简单对话路径（该路径
///    无审批处理循环，高危工具挂上去就是裸奔）；
///  - `authz_domain == Local`：host__ 的 HostAuthz 门禁位于复合路径调度层
///    （run_tool_calls_round 的域分流），简单路径没有该门，host 工具一律不挂。
///
/// 按工具名排序保证 tool_defs 顺序稳定（prompt-cache 友好）。
pub(crate) fn collect_simple_chat_tools(
    registry: &ToolRegistry,
) -> Vec<(String, std::sync::Arc<dyn crate::agent::engine::tools::AgentTool>)> {
    let empty = serde_json::json!({});
    let mut out: Vec<(String, std::sync::Arc<dyn crate::agent::engine::tools::AgentTool>)> =
        registry
            .tool_names()
            .into_iter()
            .filter_map(|name| {
                let tool = registry.get(&name)?;
                let domain_ok =
                    tool.authz_domain() == crate::agent::engine::tools::AuthzDomain::Local;
                let safe = tool.check_permission(&empty)
                    == crate::agent::engine::tools::PermissionLevel::ReadSafe;
                (domain_ok && safe).then(|| (name, tool))
            })
            .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

