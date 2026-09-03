//! 前后端事件推送辅助（对应方案步骤 5 的事件流渲染）。
//!
//! 运行时通过 Tauri `app.emit` 推送以下事件（事件名即字符串常量）：
//!  - `agent-event`：常规事件（工具开始/结束、文本片段、状态、错误）；
//!  - `agent-awaiting-approval`：高危操作挂起，等待前端审批；
//!  - `agent-task-done`：整轮任务结束；
//!  - `agent-task-error`：整轮任务异常终止。

use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

use crate::agent::types::ApprovalRequest;
use crate::agent::types::ToolStep;

pub const EVT_AGENT_EVENT: &str = "agent-event";
pub const EVT_APPROVAL: &str = "agent-awaiting-approval";
pub const EVT_TASK_DONE: &str = "agent-task-done";
pub const EVT_TASK_ERROR: &str = "agent-task-error";

/// `agent-event` 载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPayload {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<ToolStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<StreamChunk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub text: String,
    pub done: bool,
}

fn emit(app: &AppHandle, event: &str, payload: &impl Serialize) {
    if let Err(e) = app.emit(event, payload) {
        println!("[agent] emit `{event}` failed: {e}");
    } else {
        println!("[agent] emit `{event}` ok");
    }
}

/// 工具开始调用。
pub fn emit_tool_started(app: &AppHandle, step: &ToolStep) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "tool_started".into(),
            step: Some(step.clone()),
            chunk: None,
            message: None,
            seq: None,
        },
    );
}

/// 工具结束（success / failed）。
pub fn emit_tool_finished(app: &AppHandle, step: &ToolStep) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "tool_finished".into(),
            step: Some(step.clone()),
            chunk: None,
            message: None,
            seq: None,
        },
    );
}

/// 模型流式文本片段。
pub fn emit_text_chunk(app: &AppHandle, text: &str, done: bool) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "text_chunk".into(),
            step: None,
            chunk: Some(StreamChunk {
                text: text.into(),
                done,
            }),
            message: None,
            seq: None,
        },
    );
}

/// 状态提示（如「正在规划…」）。
pub fn emit_status(app: &AppHandle, message: &str) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "status".into(),
            step: None,
            chunk: None,
            message: Some(message.into()),
            seq: None,
        },
    );
}

/// 单步错误。
pub fn emit_error(app: &AppHandle, message: &str) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "error".into(),
            step: None,
            chunk: None,
            message: Some(message.into()),
            seq: None,
        },
    );
}

/// 高危操作挂起（等待前端审批）。
pub fn emit_awaiting_approval(app: &AppHandle, req: &ApprovalRequest) {
    emit(app, EVT_APPROVAL, req);
}

/// 整轮任务结束载荷：携带本轮真实 token 用量（prompt + completion，跨所有 ReAct 轮累计）。
///
/// 后端在 `run_task` 中把本轮 LLM 真实 `usage` 累加后随事件带出，前端据此替代
/// 前端「仅首尾文本」的粗略估算，正确展示单条消息与会话环形图的 token 消耗。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDonePayload {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// 整轮任务结束。
pub fn emit_task_done(app: &AppHandle, prompt_tokens: u64, completion_tokens: u64) {
    emit(
        app,
        EVT_TASK_DONE,
        &TaskDonePayload {
            prompt_tokens,
            completion_tokens,
        },
    );
}

/// 整轮任务异常终止。
pub fn emit_task_error(app: &AppHandle, message: &str) {
    emit(app, EVT_TASK_ERROR, &message);
}
