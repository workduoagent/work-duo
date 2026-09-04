//! 智能体运行时共享类型（与前端 `session/types.ts` 事件契约对应）。
//!
//! 这些类型经 Tauri `app.emit` 推送给前端，命名与字段保持前后端一致。

use serde::Serialize;

use crate::agent::mcp_adapter::MountedMcpTool;
use crate::agent::skill_adapter::SkillToolWrapper;

/// 工具调用步骤的实时状态（对应前端 ToolStep）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStep {
    pub call_id: String,
    pub tool_name: String,
    pub status: String, // running | success | failed
    pub sensitive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub created_at: i64,
}

/// 审批请求（高危操作挂起，对应前端 ApprovalRequest）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub tool_name: String,
    pub description: String,
    /// 结构化入参（JSON 字符串）。
    pub args: String,
    /// 工具类别：edit_file / execute_command / other。
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// 聊天附件（多模态图片），由前端随 `run_agent_task` 传入，注入当前轮 user 消息。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    /// 附件类型（当前仅支持 image）。
    #[serde(rename = "type")]
    pub kind: String,
    /// data URL（`data:image/<ext>;base64,...`）。
    pub data_url: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// 单个 agent 运行配置（由前端 run_agent_task 传入，或从 agent_info 读取）。
#[derive(Debug, Clone, Default)]
pub struct AgentRuntimeConfig {
    pub agent_id: String,
    pub system_prompt: String,
    pub llm_base_url: String,
    pub llm_api_key: String,
    pub llm_model_name: String,
    pub llm_config: serde_json::Value, // 智能体私有参数副本（temperature / max_tokens ...）
    pub auto_tool_exec_mode: bool, // 外部资源自动执行：true 时敏感工具跳过逐次审批
    pub allow_sandbox: bool,
    pub workspace: Option<String>,
    pub mcp_tools: Vec<MountedMcpTool>, // 已挂载 MCP 工具（含真实 tool_code 与描述）
    pub skill_tools: Vec<SkillToolWrapper>, // 已绑定技能包装
    pub session_id: Option<String>, // 前端建好的会话 id（用于累计 input_token 与上下文压缩）
    pub round_id: Option<String>, // 前端建好的本轮 id（ReAct 循环结束后回填 raw_messages_json）
    /// 当前轮用户消息附件（多模态图片；仅注入当轮，历史轮由 raw_messages_json 原样保留）。
    pub attachments: Vec<AttachmentInput>,
}

/* ================= 三层流水线架构（意图分流 → DAG 规划 → 微 ReAct 执行） ================= */

/// 阶段一产物：意图分类结果（由 `intent.rs` 解析 LLM 返回的 JSON）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct IntentProfile {
    /// "SIMPLE_CHAT" | "COMPOSITE_TASK"
    pub intent_type: String,
    #[serde(default)]
    pub reason: String,
}

impl IntentProfile {
    pub fn is_simple_chat(&self) -> bool {
        self.intent_type.eq_ignore_ascii_case("SIMPLE_CHAT")
    }
}

/// 阶段二产物：单个原子子任务（DAG 节点；当前按 step 顺序串行执行）。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PlanSubTask {
    pub step: usize,
    pub task_id: String,
    pub title: String,
    pub description: String,
}

/// 阶段二产物：任务拆解规划（宏观目标 + 有序子任务列表）。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PlanDAG {
    pub goal_summary: String,
    pub tasks: Vec<PlanSubTask>,
}

/// 阶段三产物：单个子任务的结算输出。
/// 投入「产物管道」，作为后续子任务的**唯一**前置输入；
/// 子任务内部几万字的工具报文与报错重试记录全部物理销毁，绝不流入下一环。
#[derive(Debug, Clone)]
pub struct SubTaskOutput {
    pub step: usize,
    pub title: String,
    /// 纯文本产物摘要，如："已拉取 SOL 近 7 天数据共 168 条，写入 .wd_mem/data/sol_raw.json"
    pub summary: String,
    pub success: bool,
}
