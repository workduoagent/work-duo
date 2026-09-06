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

use crate::agent::memory::MemoryItem;
use crate::agent::memory::SquadMemoryItem;
use crate::agent::recovery::RecoveryRequest;
use crate::agent::types::ApprovalRequest;
use crate::agent::types::ArtifactRef;
use crate::agent::types::IntentProfile;
use crate::agent::types::ToolStep;

pub const EVT_AGENT_EVENT: &str = "agent-event";
pub const EVT_APPROVAL: &str = "agent-awaiting-approval";
pub const EVT_TASK_DONE: &str = "agent-task-done";
pub const EVT_TASK_ERROR: &str = "agent-task-error";
/// 实时 token 用量增量：任务运行中按累计值推送（规划后 + 每个子任务完成后各一次），
/// 供前端顶栏「本次任务」计数卡实时跳数；与 `agent-task-done` 同构但语义独立（不触发完成态）。
pub const EVT_TOKEN_UPDATE: &str = "agent-token-update";
/// 子任务产物登记：每当一个子任务成功闭环并登记文件产物即推送，
/// 供前端「产物画廊」按步骤浏览 / 打开 / 定位 / 复制路径。
pub const EVT_ARTIFACT_CREATED: &str = "agent-artifact-created";
/// 步骤级恢复：子任务自动重试耗尽仍失败，挂起等待用户决策（重试/跳过/接管）。
pub const EVT_RECOVERY_NEEDED: &str = "agent-recovery-needed";
/// 分支重规划：前端「从此步骤分支」触发的双分支对比结果（原尾段 vs 新分支），
/// 供画布分支对比横幅渲染 + 「应用分支」按钮。
pub const EVT_PLAN_BRANCH: &str = "agent-plan-branch";
/// 记忆召回：某条记忆被自动/手动召回（引用计数 +1）后推送，供「记忆宫殿」实时刷新引用计数热力图。
pub const EVT_MEMORY_RECALLED: &str = "agent-memory-recalled";
/// 上下文压缩完成（结构化事件）：替代原先只发一句 `emit_status` 字符串，携带压缩轮数/摘要长度/
/// 估算节省 token，供「记忆宫殿」「上下文健康」视图结构化展示。
pub const EVT_CONTEXT_COMPACTED: &str = "agent-context-compacted";

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
    /// 规划/步骤视图（plan_generated / step_started / step_finished 事件携带）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<serde_json::Value>,
    /// 意图分类结果（intent_classified 事件携带），序列化后的 IntentProfile。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub text: String,
    pub done: bool,
    /// 思考分层标签（thinking_chunk 事件携带）：plan=规划 / exec=执行 / selfcheck=自检。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
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
            plan: None,
            intent: None,
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
            plan: None,
            intent: None,
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
                layer: None,
            }),
            message: None,
            seq: None,
            plan: None,
            intent: None,
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
            plan: None,
            intent: None,
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
            plan: None,
            intent: None,
        },
    );
}

/// 意图分类结果（阶段一分流后推送），供轨迹视图首节点展示。
/// `IntentProfile` 已序列化进 `intent` 字段。
pub fn emit_intent_classified(app: &AppHandle, profile: &IntentProfile) {
    let intent = serde_json::to_value(profile).ok();
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "intent_classified".into(),
            step: None,
            chunk: None,
            message: None,
            seq: None,
            plan: None,
            intent,
        },
    );
}

/// 分层思考片段（thinking_chunk）：规划/执行/自检三层的推理文本。
/// 替代原先把规划推理误塞进 `status` 的做法，让轨迹视图能按 layer 着色区分。
pub fn emit_thinking_chunk(app: &AppHandle, text: &str, done: bool, layer: &str) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "thinking_chunk".into(),
            step: None,
            chunk: Some(StreamChunk {
                text: text.into(),
                done,
                layer: Some(layer.into()),
            }),
            message: None,
            seq: None,
            plan: None,
            intent: None,
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

/// 实时 token 用量增量载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUpdatePayload {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// 实时 token 用量增量：任务运行中累计推送（prompt + completion）。
/// 与 `emit_task_done` 同构，但独立事件、不触发完成态；前端据此实时更新顶栏计数卡。
pub fn emit_token_update(app: &AppHandle, prompt_tokens: u64, completion_tokens: u64) {
    emit(
        app,
        EVT_TOKEN_UPDATE,
        &TokenUpdatePayload {
            prompt_tokens,
            completion_tokens,
        },
    );
}

/// 阶段二规划生成：推送任务步骤清单，前端渲染步骤进度条。
pub fn emit_plan_generated(app: &AppHandle, plan: &crate::agent::types::PlanDAG) {
    let tasks: Vec<serde_json::Value> = plan
        .tasks
        .iter()
        .map(|t| {
            serde_json::json!({
                "step": t.step,
                "taskId": t.task_id,
                "title": t.title,
                "description": t.description,
                "status": "pending",
                "dependsOn": t.depends_on,
            })
        })
        .collect();
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "plan_generated".into(),
            step: None,
            chunk: None,
            message: None,
            seq: None,
            plan: Some(serde_json::json!({
                "goalSummary": plan.goal_summary,
                "tasks": tasks,
            })),
            intent: None,
        },
    );
}

/// 子任务开始：进度条对应步骤置为 running。
pub fn emit_step_started(app: &AppHandle, step: usize, total: usize, title: &str) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "step_started".into(),
            step: None,
            chunk: None,
            message: Some(format!("步骤 {step}/{total}：{title}")),
            seq: None,
            plan: Some(serde_json::json!({
                "step": step,
                "total": total,
                "title": title,
                "status": "running",
            })),
            intent: None,
        },
    );
}

/// 子任务结束：进度条对应步骤置为 success / failed，并携带产物摘要。
pub fn emit_step_finished(
    app: &AppHandle,
    step: usize,
    total: usize,
    title: &str,
    ok: bool,
    summary: &str,
) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "step_finished".into(),
            step: None,
            chunk: None,
            message: Some(format!(
                "步骤 {step}/{total}：{} {}",
                title,
                if ok { "完成" } else { "失败" }
            )),
            seq: None,
            plan: Some(serde_json::json!({
                "step": step,
                "total": total,
                "title": title,
                "status": if ok { "success" } else { "failed" },
                "summary": summary,
            })),
            intent: None,
        },
    );
}

/// 子任务产物登记载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCreatedPayload {
    pub step: usize,
    pub artifacts: Vec<ArtifactRef>,
}

/// 子任务成功闭环并登记文件产物后推送，供前端「产物画廊」渲染。
pub fn emit_artifact_created(app: &AppHandle, step: usize, artifacts: &[ArtifactRef]) {
    emit(
        app,
        EVT_ARTIFACT_CREATED,
        &ArtifactCreatedPayload {
            step,
            artifacts: artifacts.to_vec(),
        },
    );
}

/// 步骤级恢复载荷（camelCase）：受阻子任务信息，供前端恢复面板渲染。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNeededPayload {
    pub step: usize,
    pub task_id: String,
    pub title: String,
    pub reason: String,
    pub summary: String,
}

/// 子任务自动重试耗尽仍失败：登记受阻步骤并推前端渲染恢复面板（重试/跳过/接管）。
pub fn emit_recovery_needed(app: &AppHandle, req: &RecoveryRequest) {
    emit(
        app,
        EVT_RECOVERY_NEEDED,
        &RecoveryNeededPayload {
            step: req.step,
            task_id: req.task_id.clone(),
            title: req.title.clone(),
            reason: req.reason.clone(),
            summary: req.summary.clone(),
        },
    );
}

/// 分支重规划结果：推前端画布「从此步骤分支」的对比横幅（原尾段 vs 新分支）。
pub fn emit_plan_branch(app: &AppHandle, branch: &crate::agent::types::PlanBranchGenerated) {
    emit(app, EVT_PLAN_BRANCH, branch);
}

/// 记忆召回载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecalledPayload {
    pub item: MemoryItem,
}

/// 记忆被召回（引用计数 +1）后推送，供「记忆宫殿」实时刷新引用计数与热力图。
pub fn emit_memory_recalled(app: &AppHandle, item: &MemoryItem) {
    emit(
        app,
        EVT_MEMORY_RECALLED,
        &MemoryRecalledPayload {
            item: item.clone(),
        },
    );
}

/// 上下文压缩完成载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompactedPayload {
    /// 本次被合并进摘要的历史轮次数。
    pub compacted_rounds: usize,
    /// 压缩后摘要字符长度。
    pub summary_length: usize,
    /// 估算节省的上下文 token（被压缩轮次 raw_messages 总字符 / 4 近似）。
    pub tokens_saved: usize,
    /// 是否成功写出新摘要（false 时仅事件提示，未真正压缩）。
    pub success: bool,
}

/// 滚动压缩完成：推送结构化事件（替代纯 `emit_status` 字符串），供前端结构化展示。
pub fn emit_context_compacted(app: &AppHandle, payload: &ContextCompactedPayload) {
    emit(app, EVT_CONTEXT_COMPACTED, payload);
}

/// 记忆锚定（手动或智能体自动沉淀）后推送，供「记忆宫殿」实时新增/更新卡片（无需重开页面）。
pub const EVT_MEMORY_ANCHORED: &str = "agent-memory-anchored";

/// 记忆锚定载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAnchoredPayload {
    pub item: MemoryItem,
}

/// 记忆被锚定后推送：手动锚定（UI 按钮）与智能体自动沉淀（native__anchor_memory 工具）都走
/// `memory::anchor_memory`，故在此统一发射，前端据此 upsert 卡片网格实现实时刷新。
pub fn emit_memory_anchored(app: &AppHandle, item: &MemoryItem) {
    emit(app, EVT_MEMORY_ANCHORED, &MemoryAnchoredPayload { item: item.clone() })
}

// ============================ 小分队协作（Squad）事件 ============================

/// 小分队协作会话开始（编排式 / 流水线 / 群聊 共用）。
pub const EVT_SQUAD_SESSION_STARTED: &str = "agent-squad-session-started";
/// 协作轮次产出（某成员发言 / 子任务交付 / 最终汇总）。
pub const EVT_SQUAD_ROUND: &str = "agent-squad-round";
/// 小分队协作会话结束（带最终汇总）。
pub const EVT_SQUAD_SESSION_DONE: &str = "agent-squad-session-done";
/// 小分队记忆被锚定后推送：手动锚定（记忆面板 UI）与（未来）智能体自动沉淀都走
/// `memory::anchor_squad_memory`，故在此统一发射，前端记忆面板据此 upsert 卡片实现实时刷新。
pub const EVT_SQUAD_MEMORY_ANCHORED: &str = "agent-squad-memory-anchored";

/// 小分队会话开始载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadSessionStartedPayload {
    pub squad_id: String,
    pub session_id: String,
    /// 协作模式：orchestrator / pipeline / chat。
    pub mode: String,
}

/// 协作轮次载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadRoundPayload {
    pub squad_id: String,
    pub session_id: String,
    /// 发言成员智能体 id（汇总轮次为 None）。
    pub speaker_agent_id: Option<String>,
    /// 该成员承担的角色，如「后端开发」。
    pub role: String,
    /// 轮次类型：delegation（主管委派规划）/ subtask（成员子任务交付）/ summary（最终汇总）。
    pub kind: String,
    pub content: String,
}

/// 小分队会话结束载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadSessionDonePayload {
    pub squad_id: String,
    pub session_id: String,
    pub summary: String,
}

pub fn emit_squad_session_started(app: &AppHandle, payload: &SquadSessionStartedPayload) {
    emit(app, EVT_SQUAD_SESSION_STARTED, payload);
}

pub fn emit_squad_round(app: &AppHandle, payload: &SquadRoundPayload) {
    emit(app, EVT_SQUAD_ROUND, payload);
}

pub fn emit_squad_session_done(app: &AppHandle, payload: &SquadSessionDonePayload) {
    emit(app, EVT_SQUAD_SESSION_DONE, payload);
}

/// 小分队记忆锚定载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadMemoryAnchoredPayload {
    pub item: SquadMemoryItem,
}

pub fn emit_squad_memory_anchored(app: &AppHandle, item: &SquadMemoryItem) {
    emit(
        app,
        EVT_SQUAD_MEMORY_ANCHORED,
        &SquadMemoryAnchoredPayload { item: item.clone() },
    );
}
