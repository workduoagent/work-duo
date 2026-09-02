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
}
