//! 系统原生工具（对应方案步骤 2）。
//!
//! 提供一组最小可用的本地工具，全部纳入 `native__` 命名空间：
//!  - `native__read_file`：读取工作空间内文本文件（ReadSafe）；
//!  - `native__write_file`：写入/覆盖文件（RequireApproval，sensitive）；
//!  - `native__edit_file`：字符串替换式改文件（RequireApproval，sensitive，审批弹窗走 Diff）；
//!  - `native__list_directory`：列出目录内容（ReadSafe）；
//!  - `native__execute_command`：执行系统命令（RequireApproval，sensitive）；
//!  - `native__run_python_sandbox`：在 micromamba 沙箱环境运行 Python 脚本（RequireApproval）。
//!
//! 所有文件操作都经 `PathGuard` 校验，约束在 workspace 内；沙箱执行复用 `mamba_manager`
//! 的 `run_python_script` 命令（不新建运行时）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;
use tauri::Manager;

use crate::agent::tools::AgentTool;
use crate::agent::tools::PathGuard;
use crate::agent::tools::PermissionLevel;
use crate::agent::tools::ToolContext;
use crate::agent::tools::ToolError;
use crate::agent::tools::ToolRegistry;
use crate::mamba_manager::MambaManager;
use crate::mamba_manager::run_python_in_sandbox;

/// 构造标准 function-calling 定义骨架。
fn def(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required
            }
        }
    })
}

/* ----------------------------- read_file ----------------------------- */

pub struct ReadFileTool;

#[async_trait]
impl AgentTool for ReadFileTool {
    fn name(&self) -> String {
        "native__read_file".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__read_file",
            "读取工作空间内指定文本文件的内容。",
            json!({ "path": { "type": "string", "description": "文件相对或绝对路径（须在工作空间内）" } }),
            &["path"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("read_file 缺少 path 参数".into())
        })?;
        let abs = PathGuard::check(path, ctx)?;
        std::fs::read_to_string(&abs).map_err(|e| ToolError::ExecutionFailed(format!("读取失败：{e}")))
    }
}

/* ----------------------------- write_file ----------------------------- */

pub struct WriteFileTool;

#[async_trait]
impl AgentTool for WriteFileTool {
    fn name(&self) -> String {
        "native__write_file".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__write_file",
            "将内容写入指定文件（覆盖已存在文件）。需用户审批。",
            json!({
                "path": { "type": "string", "description": "目标文件路径（须在工作空间内）" },
                "content": { "type": "string", "description": "要写入的完整文本" }
            }),
            &["path", "content"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("write_file 缺少 path 参数".into())
        })?;
        let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let abs = PathGuard::check(path, ctx)?;
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ToolError::ExecutionFailed(format!("创建父目录失败：{e}"))
            })?;
        }
        std::fs::write(&abs, content)
            .map_err(|e| ToolError::ExecutionFailed(format!("写入失败：{e}")))?;
        Ok(format!("已写入 {} 字节到 {}", content.len(), abs.display()))
    }
}

/* ----------------------------- edit_file ----------------------------- */

pub struct EditFileTool;

#[async_trait]
impl AgentTool for EditFileTool {
    fn name(&self) -> String {
        "native__edit_file".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__edit_file",
            "在文件中做字符串替换（old_str → new_str）。需用户审批，前端以 Diff 展示。",
            json!({
                "path": { "type": "string", "description": "目标文件路径（须在工作空间内）" },
                "old_str": { "type": "string", "description": "要被替换的原片段（须唯一存在）" },
                "new_str": { "type": "string", "description": "替换后的新片段" }
            }),
            &["path", "old_str", "new_str"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("edit_file 缺少 path 参数".into())
        })?;
        let old_str = args.get("old_str").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("edit_file 缺少 old_str 参数".into())
        })?;
        let new_str = args.get("new_str").and_then(|v| v.as_str()).unwrap_or("");

        let abs = PathGuard::check(path, ctx)?;
        let original = std::fs::read_to_string(&abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("读取失败：{e}")))?;
        let count = original.matches(old_str).count();
        if count == 0 {
            return Err(ToolError::InvalidArgs("old_str 在文件中未找到".into()));
        }
        if count > 1 {
            return Err(ToolError::InvalidArgs(
                "old_str 在文件中出现多次，无法确定替换位置".into(),
            ));
        }
        let updated = original.replace(old_str, new_str);
        std::fs::write(&abs, updated)
            .map_err(|e| ToolError::ExecutionFailed(format!("写回失败：{e}")))?;
        Ok(format!("已在 {} 完成 1 处替换", abs.display()))
    }
}

/* ----------------------------- list_directory ----------------------------- */

pub struct ListDirectoryTool;

#[async_trait]
impl AgentTool for ListDirectoryTool {
    fn name(&self) -> String {
        "native__list_directory".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__list_directory",
            "列出工作空间内指定目录的内容（文件与子目录名）。",
            json!({ "path": { "type": "string", "description": "目录路径（须在工作空间内），默认根" } }),
            &[],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let abs = PathGuard::check(path, ctx)?;
        if !abs.is_dir() {
            return Err(ToolError::InvalidArgs(format!("{} 不是目录", abs.display())));
        }
        let mut entries: Vec<String> = Vec::new();
        for e in std::fs::read_dir(&abs).map_err(|e| {
            ToolError::ExecutionFailed(format!("读取目录失败：{e}"))
        })? {
            if let Ok(entry) = e {
                let mut name = entry.file_name().to_string_lossy().to_string();
                if entry.path().is_dir() {
                    name.push('/');
                }
                entries.push(name);
            }
        }
        Ok(serde_json::to_string(&json!({ "entries": entries }))
            .unwrap_or_else(|_| "{}".into())
        )
    }
}

/* ----------------------------- execute_command ----------------------------- */

pub struct ExecuteCommandTool;

#[async_trait]
impl AgentTool for ExecuteCommandTool {
    fn name(&self) -> String {
        "native__execute_command".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__execute_command",
            "在工作空间内执行一条系统命令（shell）。需用户审批。",
            json!({ "command": { "type": "string", "description": "要执行的命令（含参数）" } }),
            &["command"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let command = args.get("command").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("execute_command 缺少 command 参数".into())
        })?;
        let cwd = ctx
            .workspace
            .clone()
            .or_else(|| std::env::current_dir().ok());
        let start = Instant::now();
        let output = if cfg!(target_os = "windows") {
            std::process::Command::new("cmd")
                .args(["/C", command])
                .current_dir(cwd.unwrap_or_else(|| PathBuf::from(".")))
                .output()
        } else {
            std::process::Command::new("sh")
                .args(["-c", command])
                .current_dir(cwd.unwrap_or_else(|| PathBuf::from(".")))
                .output()
        };
        let out = output.map_err(|e| ToolError::ExecutionFailed(format!("命令执行失败：{e}")))?;
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        Ok(serde_json::to_string_pretty(&json!({
            "exit_code": out.status.code(),
            "stdout": stdout,
            "stderr": stderr,
            "elapsed_ms": start.elapsed().as_millis() as u64
        }))
        .unwrap_or_else(|_| "{}".into())
        )
    }
}

/* ----------------------------- run_python_sandbox ----------------------------- */

pub struct RunPythonSandboxTool {
    app: AppHandle,
}

impl RunPythonSandboxTool {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait]
impl AgentTool for RunPythonSandboxTool {
    fn name(&self) -> String {
        "native__run_python_sandbox".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__run_python_sandbox",
            "在 micromamba 沙箱 Python 环境中运行脚本。需用户审批，且要求智能体开启沙箱权限。",
            json!({
                "script_path": { "type": "string", "description": "脚本绝对路径（须在工作空间内）" },
                "env_name": { "type": "string", "description": "micromamba 环境名，默认 default" }
            }),
            &["script_path"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        if !ctx.sandbox_enabled {
            return Err(ToolError::PermissionDenied(
                "该智能体未开启沙箱权限（allow_sandbox=false），拒绝执行".into(),
            ));
        }
        let script_path = args.get("script_path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("run_python_sandbox 缺少 script_path 参数".into())
        })?;
        // 脚本路径同样受 PathGuard 约束（须在工作空间内）。
        let _abs = PathGuard::check(script_path, ctx)?;
        let env_name = args
            .get("env_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mgr = self.app.state::<MambaManager>();
        match run_python_in_sandbox(&self.app, &*mgr, env_name, script_path.to_string()).await {
            Ok(out) => Ok(out),
            Err(e) => Err(ToolError::ExecutionFailed(e)),
        }
    }
}

/// 注册全部原生工具到注册表。
pub fn register_native_tools(registry: &mut ToolRegistry, app: &AppHandle) {
    registry.register(Arc::new(ReadFileTool));
    registry.register(Arc::new(WriteFileTool));
    registry.register(Arc::new(EditFileTool));
    registry.register(Arc::new(ListDirectoryTool));
    registry.register(Arc::new(ExecuteCommandTool));
    registry.register(Arc::new(RunPythonSandboxTool::new(app.clone())));
}
