//! 工具契约与注册表（对应方案步骤 1）。
//!
//! `AgentTool`：所有工具（原生 / Skill / MCP）统一实现的 trait；调度器只认它。
//! `PermissionLevel`：敏感度分级，决定是否需要用户审批（ApprovalManager 据此挂起）。
//! `ToolRegistry`：name → Arc<dyn AgentTool> 的注册表；运行时向 LLM 暴露其 `get_tools_for_llm()`。
//! `PathGuard`：绝对沙箱守卫，归一化路径、拦截 `..` 越界与符号链接逃逸，约束工具只能
//!   在用户授权的工作空间（workspace）内活动。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

/// 工具执行敏感度分级。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionLevel {
    /// 只读安全（如读取文件、列出目录）：自动执行，无需审批。
    ReadSafe,
    /// 需用户审批（如修改文件、执行命令、沙箱运行）：触发 ApprovalManager 挂起。
    RequireApproval,
}

/// 工具执行上下文（运行时在每次调用时注入）。
#[derive(Debug, Clone, Default)]
pub struct ToolContext {
    /// 用户授权的工作空间根目录（PathGuard 以此为沙箱边界）。
    pub workspace: Option<PathBuf>,
    /// 是否允许该智能体使用沙箱环境（agent.allow_sandbox）。
    pub sandbox_enabled: bool,
}

/// 工具执行错误。
#[derive(Debug)]
pub enum ToolError {
    /// 入参非法（如路径越界、缺必填字段）。
    InvalidArgs(String),
    /// 执行失败（含底层 IO / 进程错误）。
    ExecutionFailed(String),
    /// 权限不足（如未授权沙箱却请求 run_sandbox）。
    PermissionDenied(String),
}

/// 统一工具契约。
#[async_trait]
pub trait AgentTool: Send + Sync {
    /// 工具名（含命名空间，如 `native__edit_file`、`mcp__mineru__parse`）。
    fn name(&self) -> String;

    /// 对外暴露给 LLM 的 OpenAI function-calling 定义（name / description / parameters）。
    fn tool_definition(&self) -> serde_json::Value;

    /// 敏感度分级（决定是否需要审批）。
    fn check_permission(&self, _args: &serde_json::Value) -> PermissionLevel;

    /// 执行工具（args 为 LLM 传入的 JSON 参数）。
    async fn execute(&self, args: serde_json::Value, ctx: &ToolContext)
        -> Result<String, ToolError>;
}

/// 工具注册表：name → 工具实例。
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn AgentTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// 注册一个工具（重名将被覆盖）。
    pub fn register(&mut self, tool: Arc<dyn AgentTool>) {
        self.tools.insert(tool.name(), tool);
    }

    /// 按 name 取工具（供调度器派发）。
    pub fn get(&self, name: &str) -> Option<Arc<dyn AgentTool>> {
        self.tools.get(name).cloned()
    }

    /// 生成给 LLM 的 tools 数组（OpenAI function-calling 格式）。
    pub fn get_tools_for_llm(&self) -> Vec<serde_json::Value> {
        self.tools
            .values()
            .map(|t| t.tool_definition())
            .collect()
    }
}

/// 绝对沙箱守卫。
///
/// 所有涉及文件系统的原生工具都必须先经 `PathGuard::check` 归一化并校验，
/// 确保解析后的最终路径仍在 `ctx.workspace` 内，防止 `../` 越界或符号链接逃逸。
pub struct PathGuard;

impl PathGuard {
    /// 校验并归一化相对/绝对路径，返回绝对路径。
    ///
    /// - `workspace` 为 None 时拒绝一切文件操作（未授权工作空间）；
    /// - 解析后路径必须仍位于 workspace 之下（含 workspace 自身），否则返回 InvalidArgs。
    pub fn check(path: &str, ctx: &ToolContext) -> Result<PathBuf, ToolError> {
        let ws = ctx
            .workspace
            .as_ref()
            .ok_or_else(|| ToolError::PermissionDenied("未设置工作空间，文件操作被拒绝".into()))?;

        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            ws.join(path)
        };

        // 归一化（解析 `..` 与 `.`），失败回退原样。
        let normalized = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());

        let ws_norm = std::fs::canonicalize(ws)
            .unwrap_or_else(|_| ws.clone());

        // 比较前统一剥离 Windows 的 `\\?\` 前缀（verbatim 前缀）并（Windows 下）忽略大小写：
        // 文件存在时 canonicalize 返回带 `\\?\` 前缀的绝对路径，不存在时回退到不带前缀的原样
        // 路径，二者混用会导致 starts_with 误判「越界」（同在工作空间内却报失败）。
        let n = normalize_for_guard(&normalized);
        let w = normalize_for_guard(&ws_norm);
        if n != w && !n.starts_with(&w) {
            return Err(ToolError::InvalidArgs(format!(
                "路径越界：{} 不在工作空间 {} 之内",
                normalized.display(),
                ws_norm.display()
            )));
        }
        Ok(normalized)
    }
}

/// 路径比较前的归一化：剥离 Windows 的 `\\?\` 前缀（verbatim 前缀），Windows 下转小写，
/// 使「文件存在（带前缀）」与「文件不存在（无前缀）」两种情形下的路径可一致比较。
fn normalize_for_guard(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().replace("\\\\?\\", "");
    let s = if cfg!(windows) { s.to_lowercase() } else { s };
    PathBuf::from(s)
}

