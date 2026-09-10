//! 工具契约与注册表（对应方案步骤 1）。
//!
//! `AgentTool`：所有工具（原生 / Skill / MCP）统一实现的 trait；调度器只认它。
//! `PermissionLevel`：敏感度分级，决定是否需要用户审批（ApprovalManager 据此挂起）。
//! `ToolRegistry`：name → Arc<dyn AgentTool> 的注册表；运行时向 LLM 暴露其 `get_tools_for_llm()`。
//! `PathGuard`：绝对沙箱守卫，归一化路径、拦截 `..` 越界与符号链接逃逸，约束工具只能
//!   在用户授权的工作空间（workspace）内活动。

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
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
    /// 当前智能体 ID（原生工具据此把产出归属到具体智能体，如记忆沉淀）。
    pub agent_id: String,
    /// 当前会话 ID（原生工具据此把跨会话记忆归属到会话；空闲/非运行态为 None）。
    pub session_id: Option<String>,
    /// HTTP 请求主机白名单（由 app_config.http_allowed_hosts 解析后透传）：空 = 不限制；
    /// 非空 = native__http_request 仅放行命中列表中的主机（含其子域）。
    pub http_allowed_hosts: Vec<String>,
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

        // 两级归一化：
        // ① 文件存在 → canonicalize 拿到真实物理路径（解析 symlink），边界比对最准；
        // ② 文件不存在（如「要新建的文件」）→ canonicalize 失败，回退纯组件级的逻辑归一化，
        //    解析 `..`/`.` 后做边界比对。注意：不能把 canonicalize 失败的原样路径直接比，
        //    否则 `../../etc/passwd` 这类含 `..` 的路径会被 starts_with 按组件前缀误判「在工作空间内」（越界漏洞）。
        let normalized = match std::fs::canonicalize(&candidate) {
            Ok(real) => real,
            Err(_) => logical_normalize(&candidate)?,
        };

        let ws_norm = match std::fs::canonicalize(ws) {
            Ok(real) => real,
            Err(_) => logical_normalize(ws)?,
        };

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

    /// TOCTOU 二次确认：文件句柄已打开后，确认其真实物理路径未逃逸出 workspace。
    ///
    /// - Unix：基于文件描述符解析 `/proc/self/fd/<fd>` 的真实路径（强保证，可捕获 symlink 替换）；
    /// - Windows：无 `/proc/self/fd`，退化为对 abs 重新 canonicalize 并与 workspace 比对
    ///   （仍优于单次 `check` 校验，能捕获 open 前的 symlink 替换窗口）。
    pub fn verify_opened(
        abs: &Path,
        file: &std::fs::File,
        ctx: &ToolContext,
    ) -> Result<(), ToolError> {
        let ws = ctx
            .workspace
            .as_ref()
            .ok_or_else(|| ToolError::PermissionDenied("未设置工作空间，文件操作被拒绝".into()))?;
        let real = resolve_real_path(abs, file)?;
        let ws_norm = std::fs::canonicalize(ws).unwrap_or_else(|_| ws.clone());
        let r = normalize_for_guard(&real);
        let w = normalize_for_guard(&ws_norm);
        if r != w && !r.starts_with(&w) {
            return Err(ToolError::PermissionDenied(format!(
                "TOCTOU 检测：文件真实路径 {:?} 逃逸工作空间 {:?}",
                real, ws_norm
            )));
        }
        Ok(())
    }
}

/// 解析已打开文件句柄的真实物理路径（平台相关），供 `verify_opened` 做边界比对。
#[cfg(unix)]
fn resolve_real_path(abs: &Path, file: &std::fs::File) -> Result<PathBuf, ToolError> {
    let _ = abs;
    use std::os::unix::io::AsRawFd;
    let fd = file.as_raw_fd();
    std::fs::canonicalize(format!("/proc/self/fd/{}", fd))
        .map_err(|e| ToolError::PermissionDenied(format!("TOCTOU：无法解析 fd 真实路径：{e}")))
}

#[cfg(windows)]
fn resolve_real_path(abs: &Path, _file: &std::fs::File) -> Result<PathBuf, ToolError> {
    let _ = abs;
    std::fs::canonicalize(abs)
        .map_err(|e| ToolError::PermissionDenied(format!("TOCTOU：无法确认文件真实路径：{e}")))
}

#[cfg(not(any(unix, windows)))]
fn resolve_real_path(abs: &Path, _file: &std::fs::File) -> Result<PathBuf, ToolError> {
    let _ = abs;
    Err(ToolError::PermissionDenied(
        "当前平台不支持文件描述符级 TOCTOU 校验".into(),
    ))
}

/// 路径比较前的归一化：剥离 Windows 的 `\\?\` 前缀（verbatim 前缀），Windows 下转小写，
/// 使「文件存在（带前缀）」与「文件不存在（无前缀）」两种情形下的路径可一致比较。
fn normalize_for_guard(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().replace("\\\\?\\", "");
    let s = if cfg!(windows) { s.to_lowercase() } else { s };
    PathBuf::from(s)
}

/// 纯逻辑路径归一化（不依赖文件是否存在，不做任何 IO）。
///
/// 逐个组件处理：遇 `..` 弹出上一段；遇 `.` 跳过；其余压栈。用于 `canonicalize`
/// 失败（目标不存在）时的边界比对——把 `a/../b.txt` 解析为 `ws/b.txt`、把
/// `../../etc/passwd` 解析为 `etc/passwd`（明显越界）。
///
/// **逃逸判定**：若 `..` 弹出导致栈空（已到文件系统根仍上溯，或相对路径回退越过起点），
/// 视为路径逃逸工作空间边界，返回 `InvalidArgs` 拒绝，而非「尽力而为」继续比对。
fn logical_normalize(p: &Path) -> Result<PathBuf, ToolError> {
    let mut stack: Vec<Component> = Vec::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                // 弹出上一段；若已到根或相对起点（栈空）则视为逃逸。
                match stack.last() {
                    None => {
                        return Err(ToolError::InvalidArgs(format!(
                            "路径逃逸工作空间边界：{}",
                            p.display()
                        )))
                    }
                    Some(c) if matches!(c, Component::RootDir | Component::Prefix(_)) => {
                        return Err(ToolError::InvalidArgs(format!(
                            "路径逃逸工作空间边界：{}",
                            p.display()
                        )))
                    }
                    Some(_) => {
                        stack.pop();
                    }
                }
            }
            Component::CurDir => { /* 跳过 `.` */ }
            other => stack.push(other),
        }
    }
    let mut result = PathBuf::new();
    for comp in stack {
        result.push(comp.as_os_str());
    }
    Ok(result)
}

