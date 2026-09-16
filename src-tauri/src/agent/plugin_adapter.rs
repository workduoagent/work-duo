//! 本地插件 → AgentTool 适配（对应设计方案 §7）。
//!
//! 把挂载的本地插件包装为 `AgentTool`，工具名固定 `custom__<identifier>`，权限恒
//! `RequireApproval`（用户本机任意代码，默认高敏），`execute` 委托 `plugin_runner::run_plugin`
//! 在沙箱内执行并把 `run()` 返回值序列化为字符串回传。
//!
//! `register_plugins_into` 由 P2 的 `runtime.rs` 在装配工具集时调用（传入 `app` 与
//! `cfg.plugin_tools`）；P1 阶段 `cfg.plugin_tools` 恒为空，本模块仅保证可独立编译。

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Manager};

use crate::agent::plugin_runner::{run_plugin, PluginExecSpec};
use crate::agent::tools::{AgentTool, PermissionLevel, ToolContext, ToolError, ToolRegistry};
use crate::agent::types::MountedUserPlugin;
use crate::bun_manager::BunManager;
use crate::mamba_manager::MambaManager;

/// 单个本地插件的 AgentTool 包装。
pub struct PluginTool {
    pub spec: PluginExecSpec,
    /// 工具 slug（无 `custom__` 前缀）。
    pub identifier: String,
    /// 展示名（给人看）。
    pub name: String,
    pub description: String,
    /// 对外暴露给 LLM 的 JSON Schema（parameters）。
    pub parameters_schema: JsonValue,
    /// 运行时句柄（执行时取 mamba/bun 管理器）。
    pub app: AppHandle,
}

#[async_trait]
impl AgentTool for PluginTool {
    fn name(&self) -> String {
        format!("custom__{}", self.identifier)
    }

    fn tool_definition(&self) -> JsonValue {
        json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": format!("[Plugin] {} — {}", self.name, self.description),
                "parameters": self.parameters_schema,
            }
        })
    }

    fn check_permission(&self, _args: &JsonValue) -> PermissionLevel {
        // 用户本机任意代码，默认高敏，恒需审批（见 §5.1 / ADR #6）。
        PermissionLevel::RequireApproval
    }

    async fn execute(&self, args: JsonValue, ctx: &ToolContext) -> Result<String, ToolError> {
        let call_id = format!("call_{}", crate::agent::runtime::now_ms());
        let mamba = self.app.state::<MambaManager>();
        let bun = self.app.state::<BunManager>();
        let result = run_plugin(
            &self.app,
            &*mamba,
            &*bun,
            &self.spec,
            &args,
            &call_id,
            Some(&ctx.agent_id),
            ctx.session_id.as_deref(),
            "agent",
        )
        .await;
        if result.ok {
            match result.result {
                Some(v) => Ok(serde_json::to_string(&v).unwrap_or_else(|_| "null".to_string())),
                None => Ok("null".to_string()),
            }
        } else {
            let mut msg = result
                .error_message
                .clone()
                .unwrap_or_else(|| "插件执行失败".to_string());
            if let Some(tb) = result.traceback {
                msg.push_str(&format!("\n{tb}"));
            }
            Err(ToolError::ExecutionFailed(format!(
                "[Plugin {}] {}",
                self.identifier, msg
            )))
        }
    }
}

/// 把若干已挂载本地插件注册进工具注册表（由 `runtime.rs` 在工具集装配时调用）。
///
/// `plugins` 已是经过 `is_active=1 AND enabled=1 AND allow_sandbox=1` 过滤的列表
/// （`load_config` 负责）；此处再做一次运行时合法性兜底。
#[allow(dead_code)] // P2 runtime.rs 装配工具集时调用；P1 仅前置落地
pub fn register_plugins_into(registry: &mut ToolRegistry, app: &AppHandle, plugins: &[MountedUserPlugin]) {
    for p in plugins {
        if p.runtime != "python" && p.runtime != "bun" {
            tracing::warn!(
                "[plugin] 跳过未知运行时插件：{} ({})",
                p.identifier,
                p.runtime
            );
            continue;
        }
        let spec = PluginExecSpec {
            plugin_id: p.plugin_id.clone(),
            runtime: p.runtime.clone(),
            script_content: p.script_content.clone(),
            timeout_sec: p.timeout_sec,
            dependencies: Vec::new(),
        };
        let tool = PluginTool {
            spec,
            identifier: p.identifier.clone(),
            name: p.name.clone(),
            description: p.description.clone(),
            parameters_schema: p.parameters_schema.clone(),
            app: app.clone(),
        };
        registry.register(Arc::new(tool));
    }
}
