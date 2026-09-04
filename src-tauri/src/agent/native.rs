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

use std::fs::File;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;
use tauri::Manager;
use tokio::process::Command as AsyncCommand;
use tokio::time::timeout;
use tokio::time::Duration;

use crate::agent::tools::AgentTool;
use crate::agent::tools::PathGuard;
use crate::agent::tools::PermissionLevel;
use crate::agent::tools::ToolContext;
use crate::agent::tools::ToolError;
use crate::agent::tools::ToolRegistry;
use crate::mamba_manager::MambaManager;
use crate::mamba_manager::run_python_in_sandbox;

/// 宿主命令绝对硬超时（秒）。超时即显式 Kill 子进程，严防阻塞型命令挂死 Tokio 运行时。
const COMMAND_TIMEOUT_SECS: u64 = 60;

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
        let abs = match PathGuard::check(path, ctx) {
            Ok(abs) => abs,
            Err(e) => {
                println!("[agent] native__read_file: 路径校验失败 path={} error={:?}", path, e);
                return Err(e);
            }
        };
        println!("[agent] native__read_file: 开始 path={} resolved={}", path, abs.display());
        let started = Instant::now();
        // TOCTOU 二次确认：先打开文件句柄，再基于句柄校验真实物理路径未逃逸工作空间，
        // 防御「check 与 open 之间符号链接被替换」的竞态窗口。
        let mut file = match File::open(&abs) {
            Ok(f) => f,
            Err(e) => {
                println!(
                    "[agent] native__read_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("读取失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            println!(
                "[agent] native__read_file: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        let mut content = String::new();
        match file.read_to_string(&mut content) {
            Ok(_) => {
                println!(
                    "[agent] native__read_file: 成功 bytes={} chars={} 耗时={}ms 内容={}",
                    content.len(),
                    content.chars().count(),
                    started.elapsed().as_millis(),
                    crate::agent::runtime::clip(&content, 500),
                );
                Ok(content)
            }
            Err(e) => {
                println!(
                    "[agent] native__read_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                Err(ToolError::ExecutionFailed(format!("读取失败：{e}")))
            }
        }
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
        let abs = match PathGuard::check(path, ctx) {
            Ok(abs) => abs,
            Err(e) => {
                println!("[agent] native__write_file: 路径校验失败 path={} error={:?}", path, e);
                return Err(e);
            }
        };
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ToolError::ExecutionFailed(format!("创建父目录失败：{e}"))
            })?;
        }
        println!(
            "[agent] native__write_file: 开始 path={} resolved={} content_bytes={} content_preview={}",
            path,
            abs.display(),
            content.len(),
            crate::agent::runtime::clip(content, 500),
        );
        let started = Instant::now();
        // TOCTOU 二次确认：先创建文件句柄，再基于句柄校验真实物理路径未逃逸工作空间。
        let mut file = match File::create(&abs) {
            Ok(f) => f,
            Err(e) => {
                println!(
                    "[agent] native__write_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("创建文件失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            println!(
                "[agent] native__write_file: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        match file.write_all(content.as_bytes()) {
            Ok(()) => {
                println!(
                    "[agent] native__write_file: 成功 path={} bytes={} 耗时={}ms",
                    abs.display(),
                    content.len(),
                    started.elapsed().as_millis()
                );
                Ok(format!("已写入 {} 字节到 {}", content.len(), abs.display()))
            }
            Err(e) => {
                println!(
                    "[agent] native__write_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                Err(ToolError::ExecutionFailed(format!("写入失败：{e}")))
            }
        }
    }
}

/* ----------------------------- archive_artifact（长期记忆固化闭环） ----------------------------- */

/// 归档工具：把本次任务沉淀的「设计蓝图 / 架构约定 / 避坑法则」写入 `.wd_mem/artifacts/{name}.md`，
/// 构成长期记忆（语义记忆）的主动沉淀闭环。需用户审批；路径经 `PathGuard` 校验 + TOCTOU 句柄复核，
/// 确保不逃逸工作空间。
pub struct ArchiveArtifactTool;

#[async_trait]
impl AgentTool for ArchiveArtifactTool {
    fn name(&self) -> String {
        "native__archive_artifact".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__archive_artifact",
            "将本次任务沉淀的核心设计/架构约定/避坑法则归档为 Markdown 到 .wd_mem/artifacts/（长期知识资产，随工程留存）。需用户审批。",
            json!({
                "name": { "type": "string", "description": "归档文件名（kebab-case，可带或不带 .md 后缀，如 auth-flow 或 auth-flow.md）" },
                "content": { "type": "string", "description": "Markdown 正文（设计蓝图/约定摘要）" }
            }),
            &["name", "content"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let name = args.get("name").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("archive_artifact 缺少 name 参数".into())
        })?;
        let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
        // 无绑定工作空间（全局沙箱旁路）：无法落盘 .wd_mem，直接拒绝。
        if ctx.workspace.is_none() {
            return Err(ToolError::ExecutionFailed(
                "当前无绑定工作空间，无法归档到 .wd_mem/artifacts/（全局闲聊模式不落地项目文件）".into(),
            ));
        }
        // 规范化文件名：去非法字符、确保 .md 后缀。
        let cleaned: String = name
            .chars()
            .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
            .collect();
        let cleaned = cleaned.trim();
        if cleaned.is_empty() {
            return Err(ToolError::InvalidArgs("archive_artifact 的 name 为空或非法".into()));
        }
        let file_name = if cleaned.to_lowercase().ends_with(".md") {
            cleaned.to_string()
        } else {
            format!("{}.md", cleaned)
        };
        let rel = format!(".wd_mem/artifacts/{}", file_name);
        let abs = match PathGuard::check(&rel, ctx) {
            Ok(abs) => abs,
            Err(e) => {
                println!(
                    "[agent] native__archive_artifact: 路径校验失败 rel={} error={:?}",
                    rel, e
                );
                return Err(e);
            }
        };
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建父目录失败：{e}")))?;
        }
        println!(
            "[agent] native__archive_artifact: 开始 rel={} resolved={} content_bytes={}",
            rel,
            abs.display(),
            content.len()
        );
        let started = Instant::now();
        // TOCTOU 二次确认：先创建文件句柄，再基于句柄校验真实物理路径未逃逸工作空间。
        let mut file = match File::create(&abs) {
            Ok(f) => f,
            Err(e) => {
                println!(
                    "[agent] native__archive_artifact: 失败 rel={} 耗时={}ms error={}",
                    rel,
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("创建归档文件失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            println!(
                "[agent] native__archive_artifact: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        match file.write_all(content.as_bytes()) {
            Ok(()) => {
                println!(
                    "[agent] native__archive_artifact: 成功 path={} bytes={} 耗时={}ms",
                    abs.display(),
                    content.len(),
                    started.elapsed().as_millis()
                );
                Ok(format!(
                    "已归档 {} 字节到 .wd_mem/artifacts/{}",
                    content.len(),
                    file_name
                ))
            }
            Err(e) => Err(ToolError::ExecutionFailed(format!("写入归档失败：{e}"))),
        }
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
        println!(
            "[agent] native__edit_file: 开始 path={} resolved={} old_str={} new_str={}",
            path,
            abs.display(),
            crate::agent::runtime::clip(old_str, 300),
            crate::agent::runtime::clip(new_str, 300),
        );
        let started = Instant::now();
        let original = match std::fs::read_to_string(&abs) {
            Ok(content) => content,
            Err(e) => {
                println!("[agent] native__edit_file: 读取失败 path={} error={}", abs.display(), e);
                return Err(ToolError::ExecutionFailed(format!("读取失败：{e}")));
            }
        };
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
        let updated_bytes = updated.len();
        match std::fs::write(&abs, &updated) {
            Ok(()) => {
                println!(
                    "[agent] native__edit_file: 成功 path={} 原始bytes={} 新bytes={} 耗时={}ms",
                    abs.display(),
                    original.len(),
                    updated_bytes,
                    started.elapsed().as_millis()
                );
                Ok(format!("已在 {} 完成 1 处替换", abs.display()))
            }
            Err(e) => {
                println!(
                    "[agent] native__edit_file: 写回失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                Err(ToolError::ExecutionFailed(format!("写回失败：{e}")))
            }
        }
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
            println!("[agent] native__list_directory: 目标不是目录 path={}", abs.display());
            return Err(ToolError::InvalidArgs(format!("{} 不是目录", abs.display())));
        }
        println!("[agent] native__list_directory: 开始 path={} resolved={}", path, abs.display());
        let started = Instant::now();
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
        let result = serde_json::to_string(&json!({ "entries": entries }))
            .unwrap_or_else(|_| "{}".into());
        println!(
            "[agent] native__list_directory: 成功 entries={} result={}字符 耗时={}ms",
            result.matches("\"").count() / 2,
            result.chars().count(),
            started.elapsed().as_millis(),
        );
        Ok(result)
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
        println!(
            "[agent] native__execute_command: 开始 cwd={} command={}",
            cwd.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "<默认>".into()),
            crate::agent::runtime::clip(command, 500),
        );
        let start = Instant::now();
        // 防僵死：使用异步 tokio::process::Command 替代阻塞型 std::process::Command，
        // 外层包裹绝对硬超时；超时则显式 Kill 子进程（kill_on_drop 兜底），并向模型返回 JSON 错误提示。
        let mut cmd = if cfg!(target_os = "windows") {
            AsyncCommand::new("cmd")
        } else {
            AsyncCommand::new("sh")
        };
        cmd.arg(if cfg!(target_os = "windows") { "/C" } else { "-c" })
            .arg(command)
            .current_dir(cwd.unwrap_or_else(|| PathBuf::from(".")))
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = cmd
            .spawn()
            .map_err(|e| ToolError::ExecutionFailed(format!("命令启动失败：{e}")))?;

        let waited = timeout(Duration::from_secs(COMMAND_TIMEOUT_SECS), child.wait_with_output()).await;
        match waited {
            Ok(Ok(out)) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                println!(
                    "[agent] native__execute_command: 返回 exit_code={:?} stdout={}字符 stderr={}字符 耗时={}ms stdout_preview={} stderr_preview={}",
                    out.status.code(),
                    stdout.chars().count(),
                    stderr.chars().count(),
                    start.elapsed().as_millis(),
                    crate::agent::runtime::clip(&stdout, 500),
                    crate::agent::runtime::clip(&stderr, 500),
                );
                Ok(serde_json::to_string_pretty(&json!({
                    "exit_code": out.status.code(),
                    "stdout": stdout,
                    "stderr": stderr,
                    "elapsed_ms": start.elapsed().as_millis() as u64
                }))
                .unwrap_or_else(|_| "{}".into()))
            }
            Ok(Err(e)) => Err(ToolError::ExecutionFailed(format!("命令等待失败：{e}"))),
            Err(_elapsed) => {
                // 超时：wait_with_output 的 future 被 drop，kill_on_drop(true) 已显式终止子进程，
                // 确保主 Tokio 运行时不被永久挂起、进程不留活口。
                println!(
                    "[agent] native__execute_command: 超时 {}s，已强制终止子进程 command={}",
                    COMMAND_TIMEOUT_SECS,
                    crate::agent::runtime::clip(command, 300),
                );
                Err(ToolError::ExecutionFailed(format!(
                    "{{\"error\": \"Command execution timed out after {}s. Process killed.\"}}",
                    COMMAND_TIMEOUT_SECS
                )))
            }
        }
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
            "在 Work Duo 内置的 micromamba 隔离 Python 沙箱中运行脚本（默认环境 default）。\n\
             【运行 Python 的唯一正确方式】\n\
             1. 直接用 code 参数给 Python 源码（工具会自动落盘 .wd_mem/scripts/ 再执行），或先用 native__write_file 写脚本再传 script_path；\n\
             2. 脚本里直接 import 你需要的库（pandas / numpy / openpyxl / scipy / matplotlib 等），运行时若缺失会自动按需安装并重试，无需你手动安装，也不要浪费轮次逐个探测库是否存在。\n\
             【严禁】\n\
             - 不要执行系统 python / python3 命令，不要用 where python、python --version 探测本机 Python；\n\
             - 绝对禁止用 winget / choco / brew / apt / pip 安装系统级 Python 或任何系统软件——\
             这会脱离沙箱并污染用户本机环境；缺库时交给运行时自动安装即可。\n\
             本工具需用户审批，且要求该智能体已开启沙箱权限。",
            json!({
                "code": {
                    "type": "string",
                    "description": "Python 源代码（推荐用法：直接给代码，工具会自动落盘到 .wd_mem/scripts/ 再执行）"
                },
                "filename": {
                    "type": "string",
                    "description": "可选，配合 code 使用：落盘脚本名（默认 auto_run_<时间戳>.py），无需带路径"
                },
                "script_path": {
                    "type": "string",
                    "description": "已存在脚本的绝对路径（须在工作空间内）；与 code 二选一，两者都给时以 code 为准"
                },
                "env_name": { "type": "string", "description": "micromamba 环境名，默认 default" }
            }),
            // code 与 script_path 二选一，故此处不设必填，改在 execute 内校验并给出明确错误
            &[],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        println!(
            "[agent] native__run_python_sandbox: 请求 sandbox_enabled={} args={}",
            ctx.sandbox_enabled,
            crate::agent::runtime::clip(&args.to_string(), 500),
        );
        if !ctx.sandbox_enabled {
            println!("[agent] native__run_python_sandbox: 拒绝，allow_sandbox=false");
            return Err(ToolError::PermissionDenied(
                "该智能体未开启沙箱权限（allow_sandbox=false），拒绝执行".into(),
            ));
        }
        // 两种调用方式（code 优先）：
        // ① code：直接给源码 → 内部落盘到 `.wd_mem/scripts/` 再执行。
        //    这一步是消除「模型改用 execute_command 跑系统 python」动机的关键：原先强制
        //    「先 write_file 写脚本、再传 script_path」（两步 + 每次审批），摩擦过大导致绕道。
        // ② script_path：已存在脚本的绝对路径（兼容旧用法）。
        let code = args.get("code").and_then(|v| v.as_str());
        let script_path = args.get("script_path").and_then(|v| v.as_str());

        let resolved_script: String = if let Some(code) = code {
            let ws = ctx.workspace.clone().ok_or_else(|| {
                ToolError::PermissionDenied(
                    "未提供工作空间，无法落盘 Python 脚本（请先绑定工程目录），或改用 script_path 传入已有脚本".into(),
                )
            })?;
            let raw_name = args
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let name = if raw_name.is_empty() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                format!("auto_run_{ts}.py")
            } else if raw_name.ends_with(".py") {
                raw_name.to_string()
            } else {
                format!("{raw_name}.py")
            };
            // 文件名消毒：剔除路径分隔符与非法字符，杜绝 ../ 穿越
            let safe_name: String = name
                .chars()
                .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
                .collect();
            let dir = ws.join(".wd_mem").join("scripts");
            std::fs::create_dir_all(&dir)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建脚本目录失败：{e}")))?;
            let p = dir.join(&safe_name);
            std::fs::write(&p, code)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入脚本失败：{e}")))?;
            // 落盘后仍过 PathGuard，确保最终执行路径未逃逸工作空间（安全边界不降低）
            let abs = PathGuard::check(&p.to_string_lossy(), ctx)?;
            abs.to_string_lossy().to_string()
        } else if let Some(sp) = script_path {
            // 脚本路径同样受 PathGuard 约束（须在工作空间内）。
            let abs = PathGuard::check(sp, ctx)?;
            abs.to_string_lossy().to_string()
        } else {
            return Err(ToolError::InvalidArgs(
                "run_python_sandbox 需要提供 code（Python 源码，推荐）或 script_path（工作空间内脚本绝对路径）之一".into(),
            ));
        };
        let env_name = args
            .get("env_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        // resolved_script 已是校验并归一化的绝对路径：模型可能传相对路径（如 `install_openpyxl.py`），
        // 而 Rust 进程 cwd 并非工作空间，直接交给 mamba 会因「脚本文件不存在」失败。

        println!(
            "[agent] native__run_python_sandbox: 开始 script={} env={}",
            resolved_script,
            env_name.as_deref().unwrap_or("default"),
        );
        let started = Instant::now();
        let mgr = self.app.state::<MambaManager>();
        match run_python_in_sandbox(&self.app, &*mgr, env_name, resolved_script).await {
            Ok(out) => {
                println!(
                    "[agent] native__run_python_sandbox: 成功 result={}字符 耗时={}ms 内容={}",
                    out.chars().count(),
                    started.elapsed().as_millis(),
                    crate::agent::runtime::clip(&out, 500),
                );
                Ok(out)
            }
            Err(e) => {
                println!(
                    "[agent] native__run_python_sandbox: 失败 耗时={}ms error={}",
                    started.elapsed().as_millis(),
                    e
                );
                Err(ToolError::ExecutionFailed(e))
            }
        }
    }
}

/// 注册全部原生工具到注册表。
/// 注册全部原生工具。
///
/// `sandbox_enabled` 为 true 时**不注册** `native__execute_command`：
/// 沙箱模式的语义就是「Agent 只在隔离环境里运行」，若能力层仍提供宿主 shell，
/// 仅靠 system_prompt 写一句「你没有 execute_command」是无效约束——模型以工具表为准，
/// 试探后必然直接使用宿主命令（实测会去系统里找 python，甚至 winget 安装系统级 Python，
/// 彻底脱离沙箱并污染用户本机环境）。因此这里必须在**能力层**收敛，让提示与能力一致。
pub fn register_native_tools(registry: &mut ToolRegistry, app: &AppHandle, sandbox_enabled: bool) {
    registry.register(Arc::new(ReadFileTool));
    registry.register(Arc::new(WriteFileTool));
    registry.register(Arc::new(ArchiveArtifactTool));
    registry.register(Arc::new(EditFileTool));
    registry.register(Arc::new(ListDirectoryTool));
    if !sandbox_enabled {
        registry.register(Arc::new(ExecuteCommandTool));
    }
    registry.register(Arc::new(RunPythonSandboxTool::new(app.clone())));
}
