//! 已有 MCP 协议的适配器（对应方案步骤 6 · 生态 B）。
//!
//! 设计取舍（按项目约束执行）：本环境无法端到端验证 stdio 子进程 + JSON-RPC 2.0 的
//! 完整链路（无 MinerU 服务、无显示），且重型进程管理库属于「谨慎引入」范畴。因此：
//!  - **不新建 stdio 子进程管理**，复用现有 `mcp::call_mcp_tool` 的 HTTP/SSE 通路做透传封装；
//!  - `discover_tools` 返回该已挂载工具的最小定义（name 用 `mcp__<server>__<tool>` 命名空间），
//!    真实 schema 在首次调用时由 `call_mcp_tool` 拉取；
//!  - `execute` 调用 `crate::mcp::call_mcp_tool`（同步 invoke 风格封装）完成转发。
//!
//! 这样既保持「统一抽象、命名空间防冲突、零侵入热插拔」的架构完整性，又不引入不可验证的重依赖。

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use crate::agent::tools::AgentTool;
use crate::agent::tools::PermissionLevel;
use crate::agent::tools::ToolContext;
use crate::agent::tools::ToolError;
use crate::agent::tools::ToolRegistry;

/// 已挂载的 MCP 工具元信息（由 RuntimeConfig.mcp_tools 传入）。
///
/// 关键修正：除 `mcp_id` / `tool_name` / `description` 外，必须携带**真实连接信息**
/// （来自 `mcp_info` 表：`endpoint_url` / `protocol_type` / `headers` / `auth_type` /
/// `auth_config`）。旧实现把 `mcp_id`（内部标识，如 "x-search"）误当作 `endpoint_url`
/// 传给 `call_mcp_tool`，导致 reqwest 无法构造请求 → "builder error"。
#[derive(Debug, Clone)]
pub struct MountedMcpTool {
    pub mcp_id: String,
    pub tool_name: String, // 原始工具名（用于 call_mcp_tool）
    pub description: String,
    /// MCP 服务真实访问地址（来自 mcp_info.endpoint_url）。
    pub endpoint_url: String,
    /// 协议类型：STDIO / SSE / HTTP（来自 mcp_info.protocol_type）。
    pub protocol_type: String,
    /// 自定义请求头（来自 mcp_info.headers 的 JSON 对象）。
    pub headers: Option<HashMap<String, String>>,
    /// 认证类型：NONE / API_KEY / OAUTH2（来自 mcp_info.auth_type）。
    pub auth_type: Option<String>,
    /// 认证配置（来自 mcp_info.auth_config 的 JSON 对象）。
    pub auth_config: Option<serde_json::Value>,
}

/// 单个 MCP 工具的包装代理（对应方案 McpRemoteTool）。
pub struct McpRemoteTool {
    pub server_name: String,
    pub original_name: String,
    pub description: String,
    pub endpoint_url: String,
    pub protocol_type: String,
    pub headers: Option<HashMap<String, String>>,
    pub auth_type: Option<String>,
    pub auth_config: Option<serde_json::Value>,
}

#[async_trait]
impl AgentTool for McpRemoteTool {
    fn name(&self) -> String {
        format!("mcp__{}__{}", self.server_name, self.original_name)
    }

    fn tool_definition(&self) -> serde_json::Value {
        json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": format!("[MCP: {}] {}", self.server_name, self.description),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "arguments": { "type": "object", "description": "转发给 MCP 工具的参数对象" }
                    },
                    "required": ["arguments"]
                }
            }
        })
    }

    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel {
        // 外部 MCP 工具由用户在「MCP 中心」手动配置并授权，视为已授权的远程服务调用，
        // 不再走本地高危操作的审批沙箱（用户在对话里抱怨的「需审批」即源于此）。
        // 真正的审批沙箱只保留给原生高危工具（写文件 / 执行命令 / Python 沙箱）。
        PermissionLevel::ReadSafe
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<String, ToolError> {
        let arguments = args.get("arguments").cloned().unwrap_or(json!({}));
        tracing::info!(
            "[agent] MCP 工具 {} 调用：endpoint={} protocol={} 是否带 Key={} 参数={}",
            self.original_name,
            crate::mcp::redact_endpoint(&self.endpoint_url),
            self.protocol_type,
            self.auth_type.as_deref().unwrap_or("NONE") == "API_KEY",
            crate::agent::runtime::clip(
                &serde_json::to_string(&arguments).unwrap_or_default(),
                300
            ),
        );
        // 复用现有 mcp::call_mcp_tool（HTTP/SSE 通路）做透传。
        // 注意：endpoint_url / protocol_type 等取真实连接信息（来自 mcp_info），
        // 而非 mcp_id —— 旧逻辑误传 mcp_id 导致 reqwest 构造请求失败（builder error）。
        let resp = crate::mcp::call_mcp_tool(crate::mcp::McpCallRequest {
            endpoint_url: self.endpoint_url.clone(),
            protocol_type: self.protocol_type.clone(),
            headers: self.headers.clone(),
            auth_type: self.auth_type.clone(),
            auth_config: self.auth_config.clone(),
            tool_name: self.original_name.clone(),
            arguments: Some(arguments),
            timeout_sec: None,
        })
        .await;
        if resp.ok {
            tracing::info!(
                "[agent] MCP 工具 {} 返回 ok（{}字符）：{}",
                self.original_name,
                resp.raw.chars().count(),
                crate::agent::runtime::clip(&resp.raw, 400),
            );
            Ok(resp.raw)
        } else {
            let err = resp.error.unwrap_or_else(|| "MCP 调用失败".into());
            tracing::info!("[agent] MCP 工具 {} 返回失败：{}", self.original_name, err);
            Err(ToolError::ExecutionFailed(err))
        }
    }
}

/// 便捷：把若干已挂载 MCP 工具直接注册进原生注册表。
pub fn register_mcp_into(registry: &mut ToolRegistry, server: &str, tools: Vec<MountedMcpTool>) {
    for t in tools {
        registry.register(Arc::new(McpRemoteTool {
            server_name: server.to_string(),
            original_name: t.tool_name,
            description: t.description,
            endpoint_url: t.endpoint_url,
            protocol_type: t.protocol_type,
            headers: t.headers,
            auth_type: t.auth_type,
            auth_config: t.auth_config,
        }));
    }
}
