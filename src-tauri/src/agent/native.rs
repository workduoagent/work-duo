//! 系统原生工具（对应方案步骤 2）。
//!
//! 提供一组最小可用的本地工具，全部纳入 `native__` 命名空间：
//!  - `native__read_file`：读取工作空间内文本文件（ReadSafe）；
//!  - `native__write_file`：写入/覆盖文件（RequireApproval，sensitive）；
//!  - `native__edit_file`：字符串替换式改文件（RequireApproval，sensitive，审批弹窗走 Diff）；
//!  - `native__list_directory`：列出目录内容（ReadSafe）；
//!  - `native__path_exists`：判断路径（文件/目录）是否存在及类型（ReadSafe，list/edit/read/write 的强制前置闭环）；
//!  - `native__execute_command`：执行系统命令（RequireApproval，sensitive）；
//!  - `native__run_python_sandbox`：在 micromamba 沙箱环境运行 Python 脚本（RequireApproval）。
//!
//! 所有文件操作都经 `PathGuard` 校验，约束在 workspace 内；沙箱执行复用 `mamba_manager`
//! 的 `run_python_script` 命令（不新建运行时）。

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::io::Write;
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

use crate::agent::events;
use crate::agent::graph::{KnowledgeGraph, NodeKind};
use crate::agent::tools::AgentTool;
use crate::agent::tools::PathGuard;
use crate::agent::tools::PermissionLevel;
use crate::agent::tools::ToolContext;
use crate::agent::tools::ToolError;
use crate::agent::tools::ToolRegistry;
use crate::agent::types::ChoiceOption;
use crate::agent::types::ChoiceRequest;
use crate::mamba_manager::MambaManager;
use crate::mamba_manager::run_python_in_sandbox;
use crate::bun_manager::BunManager;
use crate::bun_manager::run_node_in_sandbox;

use std::path::Path;
use std::path::PathBuf;

// zip 读写（首梯队原生工具 zip_create / zip_extract 依赖；自带 deflate/flate2）。
use zip::write::FileOptions;
use zip::CompressionMethod;
use zip::ZipArchive;
use zip::ZipWriter;

// 正则替换工具（首梯队补全）：Rust regex，线性时间保证，无 ReDoS 风险。
use regex::Regex;
// HTTP 请求工具（首梯队补全）：重定向次数上限 5。
use reqwest::redirect::Policy as RedirectPolicy;
// SSRF 防御：自定义 DNS 解析器（reqwest::dns::Resolve），在连接前拦截环回 / 私有 / 链路本地等受限地址。
use reqwest::dns::Resolve;
use std::net::{IpAddr, SocketAddr};

/// 宿主命令绝对硬超时（秒）。超时即显式 Kill 子进程，严防阻塞型命令挂死 Tokio 运行时。
const COMMAND_TIMEOUT_SECS: u64 = 60;
/// read_file 体积上限（问题 6 修复）：超过该值的文件不读入内存，直接拒绝并引导改用沙箱分段处理。
/// 2MB 读入内存可接受（返回值再由 truncate_tool_output 截到约 15KB）；再大则为截断而全读不值得。
const MAX_READ_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// zip 打包总大小上限（与 zip_extract 的 500MB 解体对称）：待打包源文件累计超过该值直接拒绝，防磁盘写满。
const MAX_ZIP_TOTAL_BYTES: u64 = 1024 * 1024 * 1024; // 1GB
/// grep_files 遍历深度上限：防符号链接环 / 极端嵌套导致的无限递归。
const MAX_GREP_DEPTH: usize = 20;

/// zip 解压防御上限（防 zip 炸弹）：单包条目数 / 解压后总大小。
const MAX_ZIP_ENTRIES: usize = 10_000;
const MAX_ZIP_EXTRACT_BYTES: u64 = 500 * 1024 * 1024;

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

/// 执行闭环前置探测：检查工作空间内某路径的存在性与真实类型。
///
/// 供 `native__list_directory` / `native__edit_file` / `native__read_file` 在进入实际的
/// 读/写/列目录之前调用，把裸 `os error` 翻译成结构化结果，落实「操作前先看一眼路径有没有、
/// 是什么类型」的闭环约定，避免「文件不存在」「目标是目录」类报错浪费重试与调用开销。
struct PathProbe {
    /// 路径是否存在（文件或目录）。
    exists: bool,
    /// 存在且为目录。
    is_dir: bool,
    /// 非 NotFound 类的访问错误（如权限不足）；None 表示可正常访问或单纯不存在。
    access_err: Option<String>,
}

fn probe_path(abs: &std::path::Path) -> PathProbe {
    match std::fs::metadata(abs) {
        Ok(meta) => PathProbe {
            exists: true,
            is_dir: meta.is_dir(),
            access_err: None,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PathProbe {
            exists: false,
            is_dir: false,
            access_err: None,
        },
        Err(e) => PathProbe {
            exists: false,
            is_dir: false,
            access_err: Some(format!("{e}")),
        },
    }
}

/* ----------------------------- 首梯队工具共享 helper ----------------------------- */

/// 路径比较归一化：剥离 Windows `\\?\` 前缀并（Windows 下）转小写，使 `PathGuard::check`
/// 返回的「存在时带前缀 / 不存在时无前缀」两种路径可一致比较（系统目录保护、workspace 根判定、zip-slip 防御）。
fn norm_for_cmp(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().replace("\\\\?\\", "");
    let s = if cfg!(windows) { s.to_lowercase() } else { s };
    PathBuf::from(s)
}

/// 路径是否含某段（如 `.wd_mem` / `.attachments`），不受 `\\?\` 前缀差异影响。
/// Windows 路径大小写不敏感，故在 Windows 下先小写化再比，防御用户手建 `.WD_MEM` 等大写变体绕过系统目录保护；
/// Unix 保持精确匹配（区分大小写）。
fn path_has_segment(p: &Path, seg: &str) -> bool {
    if cfg!(windows) {
        let seg_lower = seg.to_lowercase();
        p.components()
            .any(|c| c.as_os_str().to_string_lossy().to_lowercase() == seg_lower)
    } else {
        p.components().any(|c| c.as_os_str() == seg)
    }
}

/// `child` 是否位于 `parent` 之内（含等于 `parent`）。用于系统目录保护、zip-slip 防御、输出自包含检查。
fn within_parent(child: &Path, parent: &Path) -> bool {
    let c = norm_for_cmp(child);
    let p = norm_for_cmp(parent);
    c == p || c.starts_with(&p)
}

/// 简易文件名通配匹配：仅支持 `*`(任意序列) 与 `?`(单字符)，够 `grep_files` 的 file_glob 用。
fn glob_match(pattern: &str, name: &str) -> bool {
    fn matched(p: &[char], n: &[char]) -> bool {
        if p.is_empty() {
            return n.is_empty();
        }
        if p[0] == '*' {
            for i in 0..=n.len() {
                if matched(&p[1..], &n[i..]) {
                    return true;
                }
            }
            false
        } else if n.is_empty() {
            false
        } else if p[0] == '?' || p[0] == n[0] {
            matched(&p[1..], &n[1..])
        } else {
            false
        }
    }
    matched(
        &pattern.chars().collect::<Vec<_>>(),
        &name.chars().collect::<Vec<_>>(),
    )
}

/// 递归统计目录内条目总数（文件 + 子目录），用于 delete 的回执信息。
fn count_descendants(dir: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            n += 1;
            if let Ok(meta) = e.metadata() {
                if meta.is_dir() {
                    n += count_descendants(&e.path());
                }
            }
        }
    }
    n
}

/// grep / zip 遍历时跳过的系统 / 依赖目录（按目录名精确匹配）。
fn is_skipped_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "__pycache__" | ".wd_mem" | ".attachments"
    )
}

/// 递归收集目录内文件（跳过系统 / 依赖目录），生成 `(entry 名, 绝对路径)`。
/// entry 基名为 source 在工作空间内的相对路径（src_rel），子路径拼在其后。
fn collect_dir(src_abs: &Path, src_rel: &str, out: &mut Vec<(String, PathBuf)>) -> Result<(), ToolError> {
    let mut stack: Vec<PathBuf> = vec![src_abs.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(e) => return Err(ToolError::ExecutionFailed(format!("读取目录失败：{e}"))),
        };
        for entry in rd.flatten() {
            let p = entry.path();
            let is_dir = match entry.file_type() {
                Ok(ft) => ft.is_dir(),
                Err(_) => continue,
            };
            if is_dir {
                if is_skipped_dir(&entry.file_name().to_string_lossy()) {
                    continue;
                }
                stack.push(p);
            } else {
                let sub = p.strip_prefix(src_abs).unwrap_or(&p);
                let sub_s = sub.to_string_lossy().replace('\\', "/");
                let entry_name = if src_rel.is_empty() || src_rel == "." {
                    sub_s
                } else {
                    format!("{}/{}", src_rel, sub_s)
                };
                out.push((sanitize_entry(&entry_name), p));
            }
        }
    }
    Ok(())
}

/// zip entry 名消毒：统一为 `/` 分隔、去前导 `./`；真实路径不会含 `..`，此处做基本归一化。
fn sanitize_entry(name: &str) -> String {
    name.replace('\\', "/").trim_start_matches("./").to_string()
}

/// 解压中止时清理（仅当目标目录是本次新建的，避免误删既有目录）。
fn cleanup_on_abort(dest: &Path, pre_existed: bool) {
    if !pre_existed {
        let _ = std::fs::remove_dir_all(dest);
    }
}

/// 递归统计目录大小（字节），用于 zip_extract 回执。
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                if let Ok(meta) = e.metadata() {
                    if meta.is_dir() {
                        stack.push(e.path());
                    } else {
                        total = total.saturating_add(meta.len());
                    }
                }
            }
        }
    }
    total
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
            "读取工作空间内指定文本文件的内容。注意：执行前应先调用 native__path_exists 确认文件存在且为文件，避免「文件不存在 / 目标是目录」类错误。",
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
                tracing::info!("[agent] native__read_file: 路径校验失败 path={} error={:?}", path, e);
                return Err(e);
            }
        };
        tracing::info!("[agent] native__read_file: 开始 path={} resolved={}", path, abs.display());
        let started = Instant::now();
        // 闭环前置检查（统一复用 probe_path）：先确认「存在性 + 是否目录」，把裸 os error
        // 翻译成清晰中文，落实「读取文件内容前先看文件有没有，不能上来就读」。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            tracing::info!("[agent] native__read_file: 访问失败 path={} error={}", abs.display(), err);
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            tracing::info!("[agent] native__read_file: 文件不存在 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "文件不存在：{}（请先用 native__path_exists 确认，或用 native__write_file 创建）",
                abs.display()
            )));
        }
        if probe.is_dir {
            tracing::info!("[agent] native__read_file: 目标是目录 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "目标是目录而非文件：{}（目录无法作为文件读取，请先用 native__list_directory 查看其内容）",
                abs.display()
            )));
        }
        // TOCTOU 二次确认：先打开文件句柄，再基于句柄校验真实物理路径未逃逸工作空间，
        // 防御「check 与 open 之间符号链接被替换」的竞态窗口。
        let mut file = match File::open(&abs) {
            Ok(f) => f,
            Err(e) => {
                tracing::info!(
                    "[agent] native__read_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("读取失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__read_file: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        // 问题 6 修复：体积预检，避免「先读整个大文件进内存撑爆」再截断返回值。
        // 超过上限不读全文，明确拒绝并引导改用沙箱分段处理（不要「只读前 N 字节」误导模型以为是全文）。
        let meta = file
            .metadata()
            .map_err(|e| ToolError::ExecutionFailed(format!("读取文件元信息失败：{e}")))?;
        if meta.len() > MAX_READ_FILE_BYTES {
            tracing::info!(
                "[agent] native__read_file: 文件过大 path={} bytes={} 拒绝读取（上限 {}）",
                abs.display(),
                meta.len(),
                MAX_READ_FILE_BYTES
            );
            return Err(ToolError::ExecutionFailed(format!(
                "文件过大（{} 字节，上限 {} 字节）：请改用 native__run_python_sandbox 分段读取/处理，或指定更小的文件",
                meta.len(), MAX_READ_FILE_BYTES
            )));
        }
        let mut content = String::new();
        match file.read_to_string(&mut content) {
            Ok(_) => {
                tracing::info!(
                    "[agent] native__read_file: 成功 bytes={} chars={} 耗时={}ms 内容={}",
                    content.len(),
                    content.chars().count(),
                    started.elapsed().as_millis(),
                    crate::agent::runtime::clip(&content, 500),
                );
                Ok(content)
            }
            Err(e) => {
                tracing::info!(
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

pub struct WriteFileTool {
    /// 应用句柄（#20260918006：写 .wd_mem/artifacts/*.md 后异步索引用）。
    pub app: AppHandle,
}

#[async_trait]
impl AgentTool for WriteFileTool {
    fn name(&self) -> String {
        "native__write_file".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__write_file",
            "将内容写入指定文件（覆盖已存在文件）。需用户审批。注意：若目标已是目录会直接报错，执行前可先调用 native__path_exists 确认路径类型。",
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
                tracing::info!("[agent] native__write_file: 路径校验失败 path={} error={:?}", path, e);
                return Err(e);
            }
        };
        // 闭环前置检查（统一复用 probe_path）：若目标已存在且为目录，不能作为文件写入
        // （否则裸 os error）。不存在 / 是文件均按「没有就去创建 / 覆盖」的闭环继续。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            tracing::info!("[agent] native__write_file: 访问失败 path={} error={}", abs.display(), err);
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if probe.exists && probe.is_dir {
            tracing::info!("[agent] native__write_file: 目标是目录 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "目标是目录而非文件：{}（无法写入，请改用 native__list_directory 查看目录内容）",
                abs.display()
            )));
        }
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ToolError::ExecutionFailed(format!("创建父目录失败：{e}"))
            })?;
        }
        tracing::info!(
            "[agent] native__write_file: 开始 path={} resolved={} content_bytes={} content_preview={}",
            path,
            abs.display(),
            content.len(),
            crate::agent::runtime::clip(content, 500),
        );
        let started = Instant::now();
        // 问题 3 修复：打开时不截断（truncate(false)），待 TOCTOU 校验通过后再 set_len(0) 清空。
        // 若 verify_opened 失败（如 symlink 逃逸），原文件内容完好可恢复，不丢数据。
        let mut file = match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&abs)
        {
            Ok(f) => f,
            Err(e) => {
                tracing::info!(
                    "[agent] native__write_file: 失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("创建文件失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__write_file: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        // 校验通过：清空原内容（真正的截断点，置于 verify 之后），再写入新内容。
        if let Err(e) = file.set_len(0) {
            tracing::info!(
                "[agent] native__write_file: 清空失败 path={} 耗时={}ms error={}",
                abs.display(),
                started.elapsed().as_millis(),
                e
            );
            return Err(ToolError::ExecutionFailed(format!("清空原文件失败：{e}")));
        }
        match file.write_all(content.as_bytes()) {
            Ok(()) => {
                tracing::info!(
                    "[agent] native__write_file: 成功 path={} bytes={} 耗时={}ms",
                    abs.display(),
                    content.len(),
                    started.elapsed().as_millis()
                );
                // #20260918006：写 .wd_mem/artifacts/*.md 视为知识归档，异步索引进 LanceDB
                // （与 archive_artifact 同管道；digest 未变自动跳过）。fire-and-forget。
                if let Some(ws) = &ctx.workspace {
                    let ws_lossy = ws.to_string_lossy().to_string();
                    if is_artifacts_md_rel(path) {
                        super::artifact_index::spawn_artifact_index_sync(
                            self.app.clone(),
                            ws_lossy,
                            path.to_string(),
                            content.to_string(),
                        );
                    }
                }
                Ok(format!("已写入 {} 字节到 {}", content.len(), abs.display()))
            }
            Err(e) => {
                tracing::info!(
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

/// 判断相对路径是否为 `.wd_mem/artifacts/` 下的 Markdown 文件（#20260918006 向量索引范围）。
/// 宽松匹配：不区分大小写、容忍正反斜杠；仅 .md 纳入（分节切块器面向 Markdown）。
fn is_artifacts_md_rel(rel: &str) -> bool {
    let norm = rel.replace('\\', "/");
    let lower = norm.to_lowercase();
    lower.starts_with(".wd_mem/artifacts/") && lower.ends_with(".md")
}

/// 归档工具：把本次任务沉淀的「设计蓝图 / 架构约定 / 避坑法则」写入 `.wd_mem/artifacts/{name}.md`，
/// 构成长期记忆（语义记忆）的主动沉淀闭环。需用户审批；路径经 `PathGuard` 校验 + TOCTOU 句柄复核，
/// 确保不逃逸工作空间。
pub struct ArchiveArtifactTool {
    /// 应用句柄（#20260918006：归档成功后异步索引进 LanceDB artifacts 用）。
    pub app: AppHandle,
}

#[async_trait]
impl AgentTool for ArchiveArtifactTool {
    fn name(&self) -> String {
        "native__archive_artifact".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__archive_artifact",
            "将本次任务沉淀的核心设计/架构约定/避坑法则归档为 Markdown 到 .wd_mem/artifacts/（长期知识资产，随工程留存）。需用户审批。目标路径由工具按 name 自动生成并已内置目录冲突校验，无需调用 native__path_exists。",
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
                tracing::info!(
                    "[agent] native__archive_artifact: 路径校验失败 rel={} error={:?}",
                    rel, e
                );
                return Err(e);
            }
        };
        // 闭环前置检查（统一复用 probe_path）：防御目标已存在且为目录的极端情况
        // （正常 name 已剔除路径分隔符不会触发），落实「写前验存在/类型」。
        let probe = probe_path(&abs);
        if probe.exists && probe.is_dir {
            tracing::info!("[agent] native__archive_artifact: 目标已是目录 rel={}", rel);
            return Err(ToolError::ExecutionFailed(format!(
                "目标已是目录：{}（无法作为文件写入，请更换 name）",
                abs.display()
            )));
        }
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建父目录失败：{e}")))?;
        }
        tracing::info!(
            "[agent] native__archive_artifact: 开始 rel={} resolved={} content_bytes={}",
            rel,
            abs.display(),
            content.len()
        );
        let started = Instant::now();
        // 问题 3 修复：打开时不截断（truncate(false)），待 TOCTOU 校验通过后再 set_len(0) 清空；
        // 校验失败时原归档文件内容完好可恢复。
        let mut file = match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&abs)
        {
            Ok(f) => f,
            Err(e) => {
                tracing::info!(
                    "[agent] native__archive_artifact: 失败 rel={} 耗时={}ms error={}",
                    rel,
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("创建归档文件失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__archive_artifact: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        if let Err(e) = file.set_len(0) {
            tracing::info!(
                "[agent] native__archive_artifact: 清空失败 rel={} 耗时={}ms error={}",
                rel,
                started.elapsed().as_millis(),
                e
            );
            return Err(ToolError::ExecutionFailed(format!("清空原归档文件失败：{e}")));
        }
        match file.write_all(content.as_bytes()) {
            Ok(()) => {
                tracing::info!(
                    "[agent] native__archive_artifact: 成功 path={} bytes={} 耗时={}ms",
                    abs.display(),
                    content.len(),
                    started.elapsed().as_millis()
                );
                // #20260918006：归档成功后异步索引进 LanceDB artifacts（分节切块 → embed →
                // upsert；digest 未变跳过）。fire-and-forget，失败仅日志不影响归档结果。
                if let Some(ws) = &ctx.workspace {
                    super::artifact_index::spawn_artifact_index_sync(
                        self.app.clone(),
                        ws.to_string_lossy().to_string(),
                        rel.clone(),
                        content.to_string(),
                    );
                }
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

/* ----------------------------- anchor_memory（记忆宫殿 · 无感自动学习） ----------------------------- */

/// 记忆沉淀工具：把对话中确认的可跨会话复用信息（用户偏好 / 已决策架构约定 / 踩坑法则 / 可复用代码模式）
/// 写入 `agent_memories`（按 (agent_id, key) 去重），构成记忆宫殿的「无感自动学习」闭环。
/// 与手动「锚定」按钮不同，本工具只做沉淀（anchored=false，参与 ref_count 排序但不钉）；
/// 纯写库、无文件系统 / Shell 副作用，且不会自我触发新的锚定，故归属 ReadSafe（不弹审批）。
pub struct AnchorMemoryTool {
    app: AppHandle,
}

#[async_trait]
impl AgentTool for AnchorMemoryTool {
    fn name(&self) -> String {
        "native__anchor_memory".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__anchor_memory",
            "将对话中确认的可跨会话复用的稳定信息沉淀为长期记忆，使未来会话能自动召回：① 用户明确表达的偏好；② 已确认的技术决策/架构约定；③ 踩过的坑与规避方式；④ 可复用代码模式。按 (agent_id, key) 去重，重复调用只更新内容，可放心沉淀。请勿锚定一次性任务步骤、临时草稿或当轮琐碎状态。",
            json!({
                "key": { "type": "string", "description": "记忆关键词/标题（同 (agent_id, key) 重复调用会更新既有记忆内容）" },
                "content": { "type": "string", "description": "记忆正文（具体约定、决策背景、适用场景与规避方式）" },
                "category": { "type": "string", "description": "分类：decision(决策) / code_pattern(代码模式) / user_pref(用户偏好) / architecture(架构) / fix(避坑) / other(其他)，缺省 other" }
            }),
            &["key", "content"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let key = args
            .get("key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("anchor_memory 缺少 key 参数".into()))?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if content.trim().is_empty() {
            return Err(ToolError::InvalidArgs("anchor_memory 的 content 为空".into()));
        }
        let category = args
            .get("category")
            .and_then(|v| v.as_str())
            .unwrap_or("other")
            .to_string();
        match crate::agent::memory::anchor_memory(
            &self.app,
            if ctx.agent_id.is_empty() {
                None
            } else {
                Some(&ctx.agent_id)
            },
            ctx.session_id.as_deref(),
            key,
            &content,
            &category,
            false,
            // native 工具属自动路径，走质量护栏（去噪合并 + category 强校验）。
            true,
        )
        .await
        {
            Ok(item) => Ok(format!(
                "已沉淀记忆（key={}，分类={}，引用数={}）",
                item.key, item.category, item.ref_count
            )),
            Err(e) => Err(ToolError::ExecutionFailed(format!("锚定记忆失败：{e}"))),
        }
    }
}

/* ----------------------------- edit_file ----------------------------- */

pub struct EditFileTool {
    /// 应用句柄（#20260918006：编辑 .wd_mem/artifacts/*.md 后异步索引用）。
    pub app: AppHandle,
}

#[async_trait]
impl AgentTool for EditFileTool {
    fn name(&self) -> String {
        "native__edit_file".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__edit_file",
            "在文件中做字符串替换（old_str → new_str）。需用户审批，前端以 Diff 展示。注意：执行前应先调用 native__path_exists 确认目标文件存在且为文件，避免「文件不存在 / 目标是目录」类错误。",
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
        tracing::info!(
            "[agent] native__edit_file: 开始 path={} resolved={} old_str={} new_str={}",
            path,
            abs.display(),
            crate::agent::runtime::clip(old_str, 300),
            crate::agent::runtime::clip(new_str, 300),
        );
        let started = Instant::now();
        // 闭环前置检查（统一复用 probe_path）：先确认路径存在且为文件，把裸 os error 翻译成
        // 清晰中文，落实「编辑文件前先看文件有没有，不能上来就改」。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            tracing::info!("[agent] native__edit_file: 访问失败 path={} error={}", abs.display(), err);
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            tracing::info!("[agent] native__edit_file: 文件不存在 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "文件不存在：{}（请先用 native__path_exists 确认，或用 native__write_file 创建）",
                abs.display()
            )));
        }
        if probe.is_dir {
            tracing::info!("[agent] native__edit_file: 目标是目录 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "目标是目录而非文件：{}（无法编辑目录，请先用 native__list_directory 查看其内容）",
                abs.display()
            )));
        }
        // 问题 2 修复：补 TOCTOU 二次确认（read/write 均已做，edit 原漏了）。
        // 先打开句柄 → 基于句柄校验真实物理路径未逃逸工作空间 → 再读内容，防御「check 与 open 之间 symlink 替换」。
        let mut file = match File::open(&abs) {
            Ok(f) => f,
            Err(e) => {
                tracing::info!("[agent] native__edit_file: 读取失败 path={} error={}", abs.display(), e);
                return Err(ToolError::ExecutionFailed(format!("读取失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__edit_file: TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        let mut original = String::new();
        match file.read_to_string(&mut original) {
            Ok(_) => {}
            Err(e) => {
                tracing::info!("[agent] native__edit_file: 读取失败 path={} error={}", abs.display(), e);
                return Err(ToolError::ExecutionFailed(format!("读取失败：{e}")));
            }
        }
        let count = original.matches(old_str).count();
        // 改动 1：old_str 不匹配时，把文件前 800 字符回灌给模型，让它据此自行修正，
        // 避免「未找到 → 凭记忆再猜 → 再次失败」的死循环。
        let snippet = original.chars().take(800).collect::<String>();
        if count == 0 {
            return Err(ToolError::InvalidArgs(format!(
                "old_str 在文件中未找到。当前文件实际内容前 800 字符如下，请据此修正 old_str 后重试：\n---\n{}\n---\n提示：old_str 必须与文件中的文本完全一致（含缩进、空格、换行）。建议先用 native__read_file 读取完整文件内容。",
                snippet
            )));
        }
        if count > 1 {
            return Err(ToolError::InvalidArgs(format!(
                "old_str 在文件中出现 {} 次，无法确定替换位置。当前文件实际内容前 800 字符如下，请据此修正 old_str 使其唯一后重试：\n---\n{}\n---\n提示：old_str 必须与文件中的文本完全一致（含缩进、空格、换行），且应只出现一次。",
                count, snippet
            )));
        }
        let updated = original.replace(old_str, new_str);
        let updated_bytes = updated.len();
        // 问题 2 修复：写回同样补 TOCTOU 二次确认（防御「读写窗口间路径再被替换」）。
        // 与 write_file 一致：打开不截断 → verify_opened → set_len(0) 清空 → write_all。
        let mut file = match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&abs)
        {
            Ok(f) => f,
            Err(e) => {
                tracing::info!(
                    "[agent] native__edit_file: 写回失败 path={} 耗时={}ms error={}",
                    abs.display(),
                    started.elapsed().as_millis(),
                    e
                );
                return Err(ToolError::ExecutionFailed(format!("写回失败：{e}")));
            }
        };
        if let Err(e) = PathGuard::verify_opened(&abs, &file, ctx) {
            tracing::info!(
                "[agent] native__edit_file: 写回 TOCTOU 校验失败 path={} error={:?}",
                abs.display(),
                e
            );
            return Err(e);
        }
        if let Err(e) = file.set_len(0) {
            tracing::info!(
                "[agent] native__edit_file: 清空失败 path={} 耗时={}ms error={}",
                abs.display(),
                started.elapsed().as_millis(),
                e
            );
            return Err(ToolError::ExecutionFailed(format!("清空原文件失败：{e}")));
        }
        match file.write_all(updated.as_bytes()) {
            Ok(()) => {
                tracing::info!(
                    "[agent] native__edit_file: 成功 path={} 原始bytes={} 新bytes={} 耗时={}ms",
                    abs.display(),
                    original.len(),
                    updated_bytes,
                    started.elapsed().as_millis()
                );
                // #20260918006：编辑 .wd_mem/artifacts/*.md 同样触发异步索引（与 write_file
                // 同管道；digest 未变自动跳过，变了删旧分节重写）。fire-and-forget。
                if let Some(ws) = &ctx.workspace {
                    let ws_lossy = ws.to_string_lossy().to_string();
                    if is_artifacts_md_rel(path) {
                        super::artifact_index::spawn_artifact_index_sync(
                            self.app.clone(),
                            ws_lossy,
                            path.to_string(),
                            updated,
                        );
                    }
                }
                Ok(format!("已在 {} 完成 1 处替换", abs.display()))
            }
            Err(e) => {
                tracing::info!(
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
            "列出工作空间内指定目录的内容（文件与子目录名）。注意：执行前应先调用 native__path_exists 确认目录存在，避免「目录不存在 / 路径是文件」类错误。",
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
        // 闭环前置检查（统一复用 probe_path）：先确认路径存在且为目录，把裸 os error 翻译成
        // 清晰中文，落实「列目录前先看路径有没有，不能上来就列」。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            tracing::info!("[agent] native__list_directory: 访问失败 path={} error={}", abs.display(), err);
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            tracing::info!("[agent] native__list_directory: 目录不存在 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "目录不存在：{}（请先用 native__path_exists 确认路径是否正确）",
                abs.display()
            )));
        }
        if !probe.is_dir {
            tracing::info!("[agent] native__list_directory: 路径是文件而非目录 path={}", abs.display());
            return Err(ToolError::ExecutionFailed(format!(
                "路径是文件而非目录：{}（请用 native__read_file 读取文件内容）",
                abs.display()
            )));
        }
        tracing::info!("[agent] native__list_directory: 开始 path={} resolved={}", path, abs.display());
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
        tracing::info!(
            "[agent] native__list_directory: 成功 entries={} result={}字符 耗时={}ms",
            result.matches("\"").count() / 2,
            result.chars().count(),
            started.elapsed().as_millis(),
        );
        Ok(result)
    }
}

/* ----------------------------- path_exists（存在性闭环前置） ----------------------------- */

/// 判断工作空间内某路径（文件或目录）是否存在及其真实类型。
///
/// 这是 `native__read_file` / `native__write_file` / `native__edit_file` / `native__list_directory`
/// 的**强制前置闭环**：这些工具在执行实际读/写/列之前都会先经 `probe_path` 做存在性与类型校验
/// （运行时层面保证「永远在之前执行」，不依赖模型自觉）。本工具同时暴露给模型用于显式规划/诊断，
/// 仅读取元信息（`metadata`），不读写文件内容，属 ReadSafe，不触发审批。
pub struct PathExistsTool;

#[async_trait]
impl AgentTool for PathExistsTool {
    fn name(&self) -> String {
        "native__path_exists".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__path_exists",
            "判断工作空间内某个路径（文件或目录）是否存在，并返回它的真实类型（文件/目录）。\
             文件还会额外返回 size（字节）与 modified_ms（最后修改时间，UNIX 毫秒）。\
             在调用 native__list_directory / native__edit_file / native__read_file / native__write_file 之前应先调用本工具确认路径存在且类型正确，\
             避免「文件不存在 / 目标是目录」类错误。仅读取元信息，不读写文件内容，不触发审批。\
             注意：native__write_file / edit_file / read_file / list_directory 内部已自动探测路径存在性与类型，无需在调用它们之前预先调用本工具；\
             仅在需要显式确认路径状态（如决策分支）时才使用本工具。",
            json!({ "path": { "type": "string", "description": "相对或绝对路径（须在工作空间内），如 src/utils 或 src/App.tsx" } }),
            &["path"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("path_exists 缺少 path 参数".into())
        })?;
        // 经 PathGuard 校验，约束在 workspace 内（路径不合法时直接透传错误）。
        let abs = match PathGuard::check(path, ctx) {
            Ok(abs) => abs,
            Err(e) => return Err(e),
        };
        // 复用统一的存在性探测，保证与 read/write/edit/list 的前置校验语义一致。
        let probe = probe_path(&abs);
        let result = if !probe.exists {
            json!({
                "exists": false,
                "is_file": false,
                "is_dir": false,
                "message": format!(
                    "路径不存在：{}（如需创建请使用 native__write_file 或 native__edit_file 新建）",
                    abs.display()
                )
            })
        } else if probe.is_dir {
            json!({
                "exists": true,
                "is_file": false,
                "is_dir": true,
                "message": format!("存在，是目录：{}", abs.display())
            })
        } else {
            // 文件：额外返回大小（字节）与最后修改时间（UNIX 毫秒）。
            // 用 Map 条件插入，metadata 取不到时省略字段（不报错），语义等同 skip_serializing。
            let mut obj = serde_json::Map::new();
            obj.insert("exists".into(), json!(true));
            obj.insert("is_file".into(), json!(true));
            obj.insert("is_dir".into(), json!(false));
            if let Ok(meta) = std::fs::metadata(&abs) {
                obj.insert("size".into(), json!(meta.len()));
                if let Ok(modified) = meta.modified() {
                    if let Ok(elapsed) = modified.duration_since(std::time::UNIX_EPOCH) {
                        obj.insert("modified_ms".into(), json!(elapsed.as_millis() as u64));
                    }
                }
            }
            obj.insert(
                "message".into(),
                json!(format!("存在，是文件：{}", abs.display())),
            );
            json!(obj)
        };
        Ok(serde_json::to_string(&result).unwrap_or_else(|_| "{}".into()))
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
            json!({
                "command": { "type": "string", "description": "要执行的命令（含参数）" },
                "fail_on_nonzero": {
                    "type": "boolean",
                    "description": "命令非零退出是否视为执行失败（默认 true，对齐 P2a「命令非 0→档A」契约；grep 无匹配等合法非 0 可传 false 关闭）"
                }
            }),
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
        // 缺口 A：非零退出视为执行失败（默认开启，对齐 P2a 契约）。合法非 0（如 grep 无匹配）调用方传 false 关闭。
        let fail_on_nonzero = args
            .get("fail_on_nonzero")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let cwd = match ctx.workspace.clone() {
            Some(ws) => ws,
            None => {
                // 问题 4 修复：未设置工作空间时拒绝执行系统命令（收紧），
                // 不回退进程 CWD（可能是安装目录，越权风险）。
                return Err(ToolError::PermissionDenied(
                    "未设置工作空间，拒绝执行系统命令".into(),
                ));
            }
        };
        tracing::info!(
            "[agent] native__execute_command: 开始 cwd={} command={}",
            cwd.display(),
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
            .current_dir(cwd)
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
                tracing::info!(
                    "[agent] native__execute_command: 返回 exit_code={:?} stdout={}字符 stderr={}字符 耗时={}ms stdout_preview={} stderr_preview={}",
                    out.status.code(),
                    stdout.chars().count(),
                    stderr.chars().count(),
                    start.elapsed().as_millis(),
                    crate::agent::runtime::clip(&stdout, 500),
                    crate::agent::runtime::clip(&stderr, 500),
                );
                let code = out.status.code();
                // 缺口 A 修复：非零退出码按「执行失败」返回（对齐 P2a「命令非 0→档A」契约），
                // 驱动 pipeline 连续错误计数→受阻弹窗。命令可能合法返回非 0（如 grep 无匹配）时，
                // 调用方可传 fail_on_nonzero=false 关闭此行为。
                if fail_on_nonzero && !out.status.success() {
                    return Err(ToolError::ExecutionFailed(format!(
                        "命令非零退出（code={:?}）：stdout={} stderr={}",
                        code,
                        crate::agent::runtime::clip(&stdout, 300),
                        crate::agent::runtime::clip(&stderr, 300),
                    )));
                }
                Ok(serde_json::to_string_pretty(&json!({
                    "exit_code": code,
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
                tracing::info!(
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

/// 工作空间路径归一化：去掉 Windows 长路径前缀 `\\?\`，并把反斜杠统一为正斜杠。
/// 注入到沙箱脚本后，模型无需再做 `WORKSPACE.replace(/^\\\\?\\/, '')` 之类的路径 mangling。
fn normalize_workspace_path(ws: &std::path::Path) -> String {
    let s = ws.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    s.replace('\\', "/")
}

/// future-safe 注入（外部评审 D05）：把注入行插到 shebang / 注释 / 空行 / `from __future__`
/// 块**之后**——`from __future__` 前不得有任何其他语句，头部注入会让它 SyntaxError
/// （实测模型反复踩坑浪费轮次）。遇 docstring/普通代码即停在当前位置之前。
fn inject_workspace_line(src: &str, inject_line: &str) -> String {
    let mut insert_at = 0usize;
    for (i, raw) in src.lines().enumerate() {
        let t = raw.trim();
        if i == 0 && t.starts_with("#!") {
            insert_at = i + 1;
            continue;
        }
        if t.is_empty() || t.starts_with('#') || t.starts_with("from __future__") {
            insert_at = i + 1;
            continue;
        }
        break;
    }
    let mut out: Vec<&str> = src.lines().collect();
    out.insert(insert_at.min(out.len()), inject_line);
    let mut joined = out.join("\n");
    if src.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

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
            "在 Work Duo 内置的 micromamba 隔离 Python 环境（依赖隔离，非安全沙箱——文件/网络/进程无 OS 级限制）中运行脚本（默认环境 default），单次执行最长 600 秒（超时强杀）。\n\
             【运行 Python 的唯一正确方式】\n\
             1. 直接用 code 参数给 Python 源码（工具会自动落盘 .wd_mem/runtime/scripts/ 再执行，脚本内相对路径以工作空间根为基准），或先用 native__write_file 写脚本再传 script_path；\n\
             2. 脚本里直接 import 你需要的库（pandas / numpy / openpyxl / scipy / matplotlib 等），运行时若缺失会自动按需安装并重试，无需你手动安装，也不要浪费轮次逐个探测库是否存在。\n\
             【严禁】\n\
             - 不要执行系统 python / python3 命令，不要用 where python、python --version 探测本机 Python；\n\
             - 绝对禁止用 winget / choco / brew / apt / pip 安装系统级 Python 或任何系统软件——\
             这会脱离沙箱并污染用户本机环境；缺库时交给运行时自动安装即可。\n\
            本工具需用户审批，且要求该智能体已开启沙箱权限。\n\
            脚本中已注入 `WORKSPACE` 变量（工作空间绝对路径字符串，code 与 script_path 两路均注入），文件操作请用 `os.path.join(WORKSPACE, '相对路径')` 拼接，不要使用相对路径直接 open。\n\
            ⚠️ 脚本执行前会被复制到沙箱临时目录：`__file__` 指向临时副本而非工作区，**严禁用 `__file__` 推断工作区/项目根**，一律用注入的 WORKSPACE 变量。",
            json!({
                "code": {
                    "type": "string",
                    "description": "Python 源代码（推荐用法：直接给代码，工具会自动落盘到 .wd_mem/runtime/scripts/ 再执行）"
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
        tracing::info!(
            "[agent] native__run_python_sandbox: 请求 sandbox_enabled={} args={}",
            ctx.sandbox_enabled,
            crate::agent::runtime::clip(&args.to_string(), 500),
        );
        if !ctx.sandbox_enabled {
            tracing::info!("[agent] native__run_python_sandbox: 拒绝，allow_sandbox=false");
            return Err(ToolError::PermissionDenied(
                "该智能体未开启沙箱权限（allow_sandbox=false），拒绝执行".into(),
            ));
        }
        // 两种调用方式（code 优先）：
        // ① code：直接给源码 → 内部落盘到 `.wd_mem/runtime/scripts/` 再执行。
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
            let dir = ws.join(".wd_mem").join("runtime").join("scripts");
            std::fs::create_dir_all(&dir)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建脚本目录失败：{e}")))?;
            let p = dir.join(&safe_name);
            // 改动 2B：code 落盘前头部注入 WORKSPACE 常量（工作空间绝对路径），
            // 模型脚本里可直接引用，避免相对路径解析到临时目录导致 ENOENT。
            let injected = inject_workspace_line(
                code,
                &format!("WORKSPACE = r\"{}\"", normalize_workspace_path(&ws)),
            );
            std::fs::write(&p, &injected)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入脚本失败：{e}")))?;
            // 落盘后仍过 PathGuard，确保最终执行路径未逃逸工作空间（安全边界不降低）
            let abs = PathGuard::check(&p.to_string_lossy(), ctx)?;
            abs.to_string_lossy().to_string()
        } else if let Some(sp) = script_path {
            // 脚本路径同样受 PathGuard 约束（须在工作空间内）。
            let abs = PathGuard::check(sp, ctx)?;
            // Fix（2026-09-18 真机烧钱事故）：script_path 脚本执行时会被复制到 mamba 临时目录
            // （mamba_root/run_tmp/__sandbox_run_*.py），`__file__` 指向临时副本——模型用
            // `Path(__file__).parents[n]` 推断工作区全部解析到 target\debug\...，反复迭代验证
            // 脚本直至撞轮数上限。与 code 路径同款修复：读取原脚本、头部注入 WORKSPACE 常量，
            // 落盘 .wd_mem/runtime/scripts/ 注入版（不覆盖原脚本）再执行，两路行为一致。
            let ws = ctx.workspace.clone().ok_or_else(|| {
                ToolError::PermissionDenied(
                    "未提供工作空间，无法为 script_path 注入 WORKSPACE（请先绑定工程目录）".into(),
                )
            })?;
            let src = std::fs::read_to_string(&abs)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取脚本失败：{e}")))?;
            let stem = abs
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("script")
                .chars()
                .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
                .collect::<String>();
            let dir = ws.join(".wd_mem").join("runtime").join("scripts");
            std::fs::create_dir_all(&dir)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建脚本目录失败：{e}")))?;
            let injected_path = dir.join(format!("injected_{stem}.py"));
            let injected = inject_workspace_line(
                &src,
                &format!("WORKSPACE = r\"{}\"", normalize_workspace_path(&ws)),
            );
            std::fs::write(&injected_path, &injected)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入注入脚本失败：{e}")))?;
            let checked = PathGuard::check(&injected_path.to_string_lossy(), ctx)?;
            checked.to_string_lossy().to_string()
        } else {
            return Err(ToolError::InvalidArgs(
                "run_python_sandbox 需要提供 code（Python 源码，推荐）或 script_path（工作空间内脚本绝对路径）之一".into(),
            ));
        };
        // 沙箱审计（2026-09-24 安全增强批次）：脚本静态特征扫描，只记录不拦截（用户决策）。
        if let Ok(script_src) = std::fs::read_to_string(&resolved_script) {
            let feats = crate::sandbox_audit::scan_script("python", &script_src);
            crate::sandbox_audit::audit_script_features(
                &self.app,
                "python",
                &resolved_script,
                ctx.workspace.as_deref(),
                &feats,
            );
        }
        let env_name = args
            .get("env_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        // resolved_script 已是校验并归一化的绝对路径：模型可能传相对路径（如 `install_openpyxl.py`），
        // 而 Rust 进程 cwd 并非工作空间，直接交给 mamba 会因「脚本文件不存在」失败。

        tracing::info!(
            "[agent] native__run_python_sandbox: 开始 script={} env={}",
            resolved_script,
            env_name.as_deref().unwrap_or("default"),
        );
        let started = Instant::now();
        let mgr = self.app.state::<MambaManager>();
        match run_python_in_sandbox(
            &self.app,
            &*mgr,
            env_name,
            resolved_script.clone(),
            ctx.workspace.as_deref(),
        )
        .await {
            Ok(out) => {
                // 透传退出码给 verifier：command_succeeded 直接读 exit_code（通用判定，与输出措辞无关）。
                if let Ok(mut g) = ctx.run_outcomes.lock() {
                    g.push(crate::agent::tools::RunOutcome {
                        output: out.stdout.clone(),
                        exit_code: out.exit_code,
                    });
                }
                tracing::info!(
                    "[agent] native__run_python_sandbox: 成功 result={}字符 耗时={}ms 退出码={:?} 内容={}",
                    out.stdout.chars().count(),
                    started.elapsed().as_millis(),
                    out.exit_code,
                    crate::agent::runtime::clip(&out.stdout, 500),
                );
                Ok(out.stdout)
            }
            Err(e) => {
                tracing::info!(
                    "[agent] native__run_python_sandbox: 失败 耗时={}ms error={}",
                    started.elapsed().as_millis(),
                    e
                );
                // 失败诊断增强（外部评审 D06）：语法类失败时附落盘脚本头部预览——
                // 注入行位置/转义损坏在此一目了然（模型一轮即可自纠，不再盲试）。
                let hint = if e.contains("SyntaxError") || e.contains("IndentationError") {
                    match std::fs::read_to_string(&resolved_script) {
                        Ok(content) => {
                            let head: Vec<&str> = content.lines().take(8).collect();
                            format!("\n[落盘脚本头部预览]\n{}", head.join("\n"))
                        }
                        Err(_) => String::new(),
                    }
                } else {
                    String::new()
                };
                Err(ToolError::ExecutionFailed(format!("{e}{hint}")))
            }
        }
    }
}

/* ----------------------------- run_node_sandbox ----------------------------- */

pub struct RunNodeSandboxTool {
    app: AppHandle,
}

impl RunNodeSandboxTool {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait]
impl AgentTool for RunNodeSandboxTool {
    fn name(&self) -> String {
        "native__run_node_sandbox".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__run_node_sandbox",
            "在 Work Duo 内置的 Bun 隔离 Node 环境（依赖隔离，非安全沙箱——文件/网络/进程无 OS 级限制）中运行 JavaScript / TypeScript 脚本（默认环境 default），单次执行最长 600 秒（超时强杀）。\n\
             【运行 Node 的唯一正确方式】\n\
             1. 直接用 code 参数给 JS/TS 源码（工具会自动落盘 .wd_mem/runtime/scripts/ 再执行，脚本内相对路径以工作空间根为基准），或先用 native__write_file 写脚本再传 script_path；\n\
             2. 脚本里直接 `import` / `require` 你需要的包（lodash / axios / zod / exceljs 等），运行时若缺失会自动按需安装并重试，无需你手动安装，也不要浪费轮次逐个探测包是否存在。\n\
             【严禁】\n\
             - 不要执行系统 node / bun 命令，不要用 `node --version`、`bun --version` 探测本机运行时；\n\
             - 绝对禁止用 `npm install -g` / 系统包管理器安装全局 Node 环境或任何系统软件——\
             这会脱离沙箱并污染用户本机环境；缺包时交给运行时自动安装即可。\n\
            本工具需用户审批，且要求该智能体已开启沙箱权限。\n\
            脚本中已注入 `WORKSPACE` 常量（工作空间绝对路径，code 与 script_path 两路均注入），文件操作请用 `WORKSPACE + '/相对路径'` 拼接，不要使用相对路径直接 open。\n\
            ⚠️ 脚本执行前会被复制到临时目录：`__file__` / `import.meta.url` 指向临时副本而非工作区，**严禁用它们推断工作区/项目根**，一律用注入的 WORKSPACE 常量。",
            json!({
                "code": {
                    "type": "string",
                    "description": "JavaScript / TypeScript 源代码（推荐用法：直接给代码，工具会自动落盘到 .wd_mem/runtime/scripts/ 再执行）"
                },
                "filename": {
                    "type": "string",
                    "description": "可选，配合 code 使用：落盘脚本名（默认 auto_run_<时间戳>.mjs），无需带路径；可带 .mjs/.cjs/.js/.ts 后缀"
                },
                "script_path": {
                    "type": "string",
                    "description": "已存在脚本的绝对路径（须在工作空间内）；与 code 二选一，两者都给时以 code 为准"
                },
                "env_name": { "type": "string", "description": "Bun 环境名，默认 default" }
            }),
            &[],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        tracing::info!(
            "[agent] native__run_node_sandbox: 请求 sandbox_enabled={} args={}",
            ctx.sandbox_enabled,
            crate::agent::runtime::clip(&args.to_string(), 500),
        );
        if !ctx.sandbox_enabled {
            tracing::info!("[agent] native__run_node_sandbox: 拒绝，allow_sandbox=false");
            return Err(ToolError::PermissionDenied(
                "该智能体未开启沙箱权限（allow_sandbox=false），拒绝执行".into(),
            ));
        }
        // 与 Python 沙箱同构：① code 直传（消除模型绕道到系统 node 的动机）；② script_path 兼容旧用法。
        let code = args.get("code").and_then(|v| v.as_str());
        let script_path = args.get("script_path").and_then(|v| v.as_str());

        let resolved_script: String = if let Some(code) = code {
            let ws = ctx.workspace.clone().ok_or_else(|| {
                ToolError::PermissionDenied(
                    "未提供工作空间，无法落盘 Node 脚本（请先绑定工程目录），或改用 script_path 传入已有脚本".into(),
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
                format!("auto_run_{ts}.mjs")
            } else if raw_name.ends_with(".mjs")
                || raw_name.ends_with(".cjs")
                || raw_name.ends_with(".js")
                || raw_name.ends_with(".ts")
            {
                raw_name.to_string()
            } else {
                format!("{raw_name}.mjs")
            };
            // 文件名消毒：剔除路径分隔符与非法字符，杜绝 ../ 穿越
            let safe_name: String = name
                .chars()
                .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
                .collect();
            let dir = ws.join(".wd_mem").join("runtime").join("scripts");
            std::fs::create_dir_all(&dir)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建脚本目录失败：{e}")))?;
            let p = dir.join(&safe_name);
            // 改动 2A：code 落盘前头部注入 WORKSPACE 常量（JSON 转义处理反斜杠/引号），
            // 模型脚本里可直接引用，避免相对路径解析到临时目录导致 ENOENT。
            let injected = inject_workspace_line(
                code,
                &format!(
                    "const WORKSPACE = {};",
                    serde_json::to_string(&normalize_workspace_path(&ws)).unwrap_or_default()
                ),
            );
            std::fs::write(&p, &injected)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入脚本失败：{e}")))?;
            // 落盘后仍过 PathGuard，确保最终执行路径未逃逸工作空间。
            let abs = PathGuard::check(&p.to_string_lossy(), ctx)?;
            abs.to_string_lossy().to_string()
        } else if let Some(sp) = script_path {
            let abs = PathGuard::check(sp, ctx)?;
            // Fix（同 Python 沙箱 2026-09-18）：Node 脚本执行时同样会被复制到临时目录，
            // `__file__`/`import.meta.url` 指向临时副本——与 code 路径同款注入 WORKSPACE 常量，
            // 落盘注入版（不覆盖原脚本，保留原后缀）再执行，两路行为一致。
            let ws = ctx.workspace.clone().ok_or_else(|| {
                ToolError::PermissionDenied(
                    "未提供工作空间，无法为 script_path 注入 WORKSPACE（请先绑定工程目录）".into(),
                )
            })?;
            let src = std::fs::read_to_string(&abs)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取脚本失败：{e}")))?;
            let stem = abs
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("script")
                .chars()
                .filter(|c| !matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*'))
                .collect::<String>();
            let ext = abs
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{e}"))
                .unwrap_or_else(|| ".mjs".to_string());
            let dir = ws.join(".wd_mem").join("runtime").join("scripts");
            std::fs::create_dir_all(&dir)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建脚本目录失败：{e}")))?;
            let injected_path = dir.join(format!("injected_{stem}{ext}"));
            let injected = inject_workspace_line(
                &src,
                &format!(
                    "const WORKSPACE = {};",
                    serde_json::to_string(&normalize_workspace_path(&ws)).unwrap_or_default()
                ),
            );
            std::fs::write(&injected_path, &injected)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入注入脚本失败：{e}")))?;
            let checked = PathGuard::check(&injected_path.to_string_lossy(), ctx)?;
            checked.to_string_lossy().to_string()
        } else {
            return Err(ToolError::InvalidArgs(
                "run_node_sandbox 需要提供 code（JS/TS 源码，推荐）或 script_path（工作空间内脚本绝对路径）之一".into(),
            ));
        };
        let env_name = args
            .get("env_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // 沙箱审计（2026-09-24 安全增强批次）：与 python 同款，只记录不拦截。
        if let Ok(script_src) = std::fs::read_to_string(&resolved_script) {
            let feats = crate::sandbox_audit::scan_script("bun", &script_src);
            crate::sandbox_audit::audit_script_features(
                &self.app,
                "bun",
                &resolved_script,
                ctx.workspace.as_deref(),
                &feats,
            );
        }

        tracing::info!(
            "[agent] native__run_node_sandbox: 开始 script={} env={}",
            resolved_script,
            env_name.as_deref().unwrap_or("default"),
        );
        let started = Instant::now();
        let mgr = self.app.state::<BunManager>();
        match run_node_in_sandbox(&self.app, &*mgr, env_name, resolved_script, ctx.workspace.as_deref()).await {
            Ok(out) => {
                // 透传退出码给 verifier：command_succeeded 直接读 exit_code（通用判定，与输出措辞无关）。
                if let Ok(mut g) = ctx.run_outcomes.lock() {
                    g.push(crate::agent::tools::RunOutcome {
                        output: out.stdout.clone(),
                        exit_code: out.exit_code,
                    });
                }
                tracing::info!(
                    "[agent] native__run_node_sandbox: 成功 result={}字符 耗时={}ms 退出码={:?} 内容={}",
                    out.stdout.chars().count(),
                    started.elapsed().as_millis(),
                    out.exit_code,
                    crate::agent::runtime::clip(&out.stdout, 500),
                );
                Ok(out.stdout)
            }
            Err(e) => {
                tracing::info!(
                    "[agent] native__run_node_sandbox: 失败 耗时={}ms error={}",
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
/* ----------------------------- delete_path（CRUD 的 D） ----------------------------- */

pub struct DeletePathTool;

#[async_trait]
impl AgentTool for DeletePathTool {
    fn name(&self) -> String {
        "native__delete_path".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__delete_path",
            "删除工作空间内的文件或目录（CRUD 的 D）。需用户审批。删除非空目录需传 recursive=true。\
             .wd_mem / .attachments 系统目录与工作空间根目录受保护不可删；执行前可先调用 native__path_exists 确认路径类型。",
            json!({
                "path": { "type": "string", "description": "要删除的文件或目录路径（须在工作空间内）" },
                "recursive": { "type": "boolean", "description": "目录是否递归删除，默认 false（仅删空目录；非空目录需传 true）" }
            }),
            &["path"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("delete_path 缺少 path 参数".into())
        })?;
        let recursive = args.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
        let abs = PathGuard::check(path, ctx)?;
        // 安全边界：保护系统目录与 workspace 根（与 PathGuard 越界拦截互补）。
        let ws = ctx
            .workspace
            .clone()
            .expect("PathGuard::check 已保证 workspace 存在");
        if norm_for_cmp(&abs) == norm_for_cmp(&ws) {
            return Err(ToolError::PermissionDenied("禁止删除工作空间根目录".into()));
        }
        if path_has_segment(&abs, ".wd_mem") {
            return Err(ToolError::PermissionDenied(format!(
                "禁止删除系统目录：{}（.wd_mem 受保护）",
                abs.display()
            )));
        }
        if path_has_segment(&abs, ".attachments") {
            return Err(ToolError::PermissionDenied(format!(
                "禁止删除系统目录：{}（.attachments 受保护）",
                abs.display()
            )));
        }
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            return Err(ToolError::ExecutionFailed(format!(
                "路径不存在：{}（请先用 native__path_exists 确认）",
                abs.display()
            )));
        }
        if probe.is_dir {
            let empty = std::fs::read_dir(&abs)
                .map(|mut rd| rd.next().is_none())
                .unwrap_or(false);
            if !recursive {
                if !empty {
                    return Err(ToolError::ExecutionFailed(format!(
                        "目标是非空目录：{}（传 recursive=true 可递归删除，或先用 native__list_directory 查看）",
                        abs.display()
                    )));
                }
                std::fs::remove_dir(&abs)
                    .map_err(|e| ToolError::ExecutionFailed(format!("删除目录失败：{e}")))?;
                Ok(format!("已删除空目录 {}", abs.display()))
            } else {
                let n = count_descendants(&abs);
                std::fs::remove_dir_all(&abs)
                    .map_err(|e| ToolError::ExecutionFailed(format!("递归删除失败：{e}")))?;
                Ok(format!("已删除目录 {}（含 {} 个子项）", abs.display(), n))
            }
        } else {
            let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            std::fs::remove_file(&abs)
                .map_err(|e| ToolError::ExecutionFailed(format!("删除文件失败：{e}")))?;
            Ok(format!("已删除文件 {}（{} 字节）", abs.display(), size))
        }
    }
}

/* ----------------------------- move_path（CRUD 的 U / 重命名） ----------------------------- */

pub struct MovePathTool;

#[async_trait]
impl AgentTool for MovePathTool {
    fn name(&self) -> String {
        "native__move_path".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__move_path",
            "移动 / 重命名工作空间内的文件或目录。需用户审批。\
             目标已存在时默认报错，传 overwrite=true 可覆盖文件（不会静默替换目录）。\
             src 与 dst 都须在工作空间内；.wd_mem / .attachments 受保护，dst 不能落入其中。",
            json!({
                "src": { "type": "string", "description": "源路径（须在工作空间内）" },
                "dst": { "type": "string", "description": "目标路径（须在工作空间内）" },
                "overwrite": { "type": "boolean", "description": "目标已存在时是否覆盖，默认 false" }
            }),
            &["src", "dst"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let src = args.get("src").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("move_path 缺少 src 参数".into())
        })?;
        let dst = args.get("dst").and_then(|v| v.as_str()).ok_or_else(|| {
            ToolError::InvalidArgs("move_path 缺少 dst 参数".into())
        })?;
        let overwrite = args.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);
        let ws = ctx
            .workspace
            .clone()
            .expect("PathGuard::check 已保证 workspace 存在");
        let src_abs = PathGuard::check(src, ctx)?;
        let dst_abs = PathGuard::check(dst, ctx)?;
        // 安全边界
        if norm_for_cmp(&src_abs) == norm_for_cmp(&ws) {
            return Err(ToolError::PermissionDenied("禁止移动工作空间根目录".into()));
        }
        if path_has_segment(&dst_abs, ".wd_mem") || path_has_segment(&dst_abs, ".attachments") {
            return Err(ToolError::PermissionDenied(format!(
                "目标不能落入系统目录：{}（.wd_mem / .attachments 受保护）",
                dst_abs.display()
            )));
        }
        let src_probe = probe_path(&src_abs);
        if let Some(err) = src_probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问源路径：{}（{}）",
                src_abs.display(),
                err
            )));
        }
        if !src_probe.exists {
            return Err(ToolError::ExecutionFailed(format!(
                "源路径不存在：{}",
                src_abs.display()
            )));
        }
        let dst_probe = probe_path(&dst_abs);
        if let Some(err) = dst_probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问目标路径：{}（{}）",
                dst_abs.display(),
                err
            )));
        }
        if dst_probe.exists {
            if !overwrite {
                return Err(ToolError::ExecutionFailed(format!(
                    "目标已存在：{}（传 overwrite=true 可覆盖文件）",
                    dst_abs.display()
                )));
            }
            if dst_probe.is_dir {
                return Err(ToolError::ExecutionFailed(format!(
                    "目标是目录，无法覆盖：{}（不要静默递归替换目录）",
                    dst_abs.display()
                )));
            }
            // 原子覆盖（P1 #6）：先把目标备份到临时名，再 rename 源→目标；
            // 若 rename 失败则回滚备份，保证原目标内容不丢失（尤其跨设备失败场景）。
            let bak = dst_abs.with_added_extension("wbak");
            std::fs::rename(&dst_abs, &bak)
                .map_err(|e| ToolError::ExecutionFailed(format!("覆盖前备份目标失败：{e}")))?;
            match std::fs::rename(&src_abs, &dst_abs) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&bak); // 成功：删备份
                    let kind = if src_probe.is_dir { "目录" } else { "文件" };
                    return Ok(format!(
                        "已将{} {} 移动到 {}（覆盖原目标）",
                        kind,
                        src_abs.display(),
                        dst_abs.display()
                    ));
                }
                Err(e) => {
                    let _ = std::fs::rename(&bak, &dst_abs); // 回滚：恢复原目标
                    if e.kind() == std::io::ErrorKind::CrossesDevices {
                        return Err(ToolError::ExecutionFailed(
                            "跨文件系统移动暂不支持（rename 跨设备失败），请改用 read + write + delete 分步完成".into(),
                        ));
                    }
                    return Err(ToolError::ExecutionFailed(format!("移动失败：{e}")));
                }
            }
        }
        // 目标不存在：常规重命名。
        if let Some(parent) = dst_abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建目标父目录失败：{e}")))?;
        }
        match std::fs::rename(&src_abs, &dst_abs) {
            Ok(()) => {
                let kind = if src_probe.is_dir { "目录" } else { "文件" };
                Ok(format!(
                    "已将{} {} 移动到 {}",
                    kind,
                    src_abs.display(),
                    dst_abs.display()
                ))
            }
            Err(e) => {
                // 跨设备等 rename 失败：首版直接报错提示，不做 copy + remove 降级。
                if e.kind() == std::io::ErrorKind::CrossesDevices {
                    Err(ToolError::ExecutionFailed(
                        "跨文件系统移动暂不支持（rename 跨设备失败），请改用 read + write + delete 分步完成".into(),
                    ))
                } else {
                    Err(ToolError::ExecutionFailed(format!("移动失败：{e}")))
                }
            }
        }
    }
}

/* ----------------------------- grep_files（子串检索） ----------------------------- */

pub struct GrepFilesTool;

#[async_trait]
impl AgentTool for GrepFilesTool {
    fn name(&self) -> String {
        "native__grep_files".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__grep_files",
            "在工作空间内递归检索子串（区分大小写，不支持正则），返回命中行的 path:line:text。\
             仅读取文本文件，自动跳过 .git / node_modules / target / __pycache__ / .wd_mem / .attachments 与二进制文件；\
             单文件超过 2MB 跳过，结果上限由 max_results 控制（硬上限 200）。不触发审批。",
            json!({
                "keyword": { "type": "string", "description": "检索关键词（子串匹配，区分大小写）" },
                "path": { "type": "string", "description": "检索起始目录（相对工作空间），默认工作空间根" },
                "max_results": { "type": "integer", "description": "最大返回条数，默认 50，上限 200" },
                "file_glob": { "type": "string", "description": "文件名通配（如 *.rs），支持 * 与 ?，默认全部文本文件" }
            }),
            &["keyword"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let keyword = args
            .get("keyword")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("grep_files 缺少 keyword 参数".into()))?;
        if keyword.is_empty() {
            return Err(ToolError::InvalidArgs("grep_files 的 keyword 为空".into()));
        }
        let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let max_results = args
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(50)
            .min(200) as usize;
        let file_glob = args
            .get("file_glob")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let root = PathGuard::check(path, ctx)?;
        // 遍历深度上限（P1 #8）：防符号链接环 / 极端嵌套导致的无限递归。
        let mut stack: Vec<(PathBuf, usize)> = vec![(root.clone(), 0)];
        let mut results: Vec<String> = Vec::new();
        let mut scanned: u32 = 0;
        let mut non_utf8: u32 = 0;
        'walk: while let Some((dir, depth)) = stack.pop() {
            let rd = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in rd.flatten() {
                let p = entry.path();
                let is_dir = match entry.file_type() {
                    Ok(ft) => ft.is_dir(),
                    Err(_) => continue,
                };
                if is_dir {
                    if is_skipped_dir(&entry.file_name().to_string_lossy()) {
                        continue;
                    }
                    if depth + 1 <= MAX_GREP_DEPTH {
                        stack.push((p, depth + 1));
                    }
                } else {
                    scanned += 1;
                    if let Some(glob) = &file_glob {
                        if !glob.is_empty() && !glob_match(glob, &entry.file_name().to_string_lossy()) {
                            continue;
                        }
                    }
                    let meta = match entry.metadata() {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    if meta.len() > MAX_READ_FILE_BYTES {
                        continue;
                    }
                    // 二进制探测：前 8KB 含 \0 则跳过
                    let head = {
                        let mut f = match File::open(&p) {
                            Ok(f) => f,
                            Err(_) => continue,
                        };
                        let mut buf = [0u8; 8192];
                        match f.read(&mut buf) {
                            Ok(n) => buf[..n].to_vec(),
                            Err(_) => continue,
                        }
                    };
                    if head.contains(&0) {
                        continue;
                    }
                    let content = match std::fs::read_to_string(&p) {
                        Ok(c) => c,
                        Err(_) => {
                            non_utf8 += 1; // P2 #12：非 UTF-8 / 不可读文本文件，统计后跳过并在结果中报告
                            continue;
                        }
                    };
                    for (i, line) in content.lines().enumerate() {
                        if line.contains(keyword) {
                            let trimmed = if line.chars().count() > 200 {
                                format!("{}…", line.chars().take(200).collect::<String>())
                            } else {
                                line.to_string()
                            };
                            let rel = p.strip_prefix(&root).unwrap_or(&p);
                            results.push(format!("{}:{}:{}", rel.display(), i + 1, trimmed));
                            if results.len() >= max_results {
                                break 'walk;
                            }
                        }
                    }
                }
            }
        }
        if results.is_empty() {
            Ok(format!(
                "未找到包含「{}」的内容（扫描了 {} 个文件）",
                keyword, scanned
            ))
        } else {
            let joined = results.join("\n");
            // 达 max_results 时无法区分「恰好命中这么多」与「被截断」：保守标注截断提示，
            // 引导用户收窄关键词或 file_glob 以确认是否还有更多命中。
            let truncated_note = if results.len() >= max_results {
                format!(
                    "\n（结果已达上限 {}，可能还有更多命中；请收窄关键词或 file_glob 继续检索）",
                    max_results
                )
            } else {
                String::new()
            };
            // P2 #12：非 UTF-8 / 不可读文本文件被静默跳过，此处汇总报告，避免用户误以为「扫描完整」。
            let non_utf8_note = if non_utf8 > 0 {
                format!("\n（另有 {} 个文件因非 UTF-8 / 不可读文本被跳过）", non_utf8)
            } else {
                String::new()
            };
            Ok(format!(
                "命中 {} 条（上限 {}）：\n{}{}{}",
                results.len(),
                max_results,
                joined,
                truncated_note,
                non_utf8_note
            ))
        }
    }
}

/* ----------------------------- zip_create（打包） ----------------------------- */

pub struct ZipCreateTool;

#[async_trait]
impl AgentTool for ZipCreateTool {
    fn name(&self) -> String {
        "native__zip_create".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__zip_create",
            "将工作空间内的一个或多个目录 / 文件打包为 zip（deflate 压缩）。需用户审批。\
             source 可为单个路径或路径数组；目录会递归收集内部文件（跳过 .git / node_modules 等）。\
             输出路径不能落在 source 目录内（避免自包含越滚越大）。",
            json!({
                "source": { "type": "array", "description": "要打包的路径：单一字符串或字符串数组（每项须在工作空间内），如 \"src/\" 或 [\"data/\", \"report.md\"]" },
                "output": { "type": "string", "description": "输出 zip 路径（须在工作空间内），如 output/pkg.zip" }
            }),
            &["source", "output"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        // source：兼容字符串或数组
        let sources: Vec<String> = match args.get("source") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            _ => {
                return Err(ToolError::InvalidArgs(
                    "zip_create 缺少 source 参数（字符串或数组）".into(),
                ))
            }
        };
        if sources.is_empty() {
            return Err(ToolError::InvalidArgs("zip_create 的 source 为空".into()));
        }
        let output = args
            .get("output")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("zip_create 缺少 output 参数".into()))?;
        let output_abs = PathGuard::check(output, ctx)?;
        // 输出已存在且为目录 → 拒绝
        let out_probe = probe_path(&output_abs);
        if out_probe.exists && out_probe.is_dir {
            return Err(ToolError::ExecutionFailed(format!(
                "输出路径已存在且为目录：{}（请换一个输出文件名）",
                output_abs.display()
            )));
        }
        if let Some(parent) = output_abs.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建输出父目录失败：{e}")))?;
        }
        // 收集 (entry 名, 绝对路径)
        let mut entries: Vec<(String, PathBuf)> = Vec::new();
        for src in &sources {
            let src_abs = PathGuard::check(src, ctx)?;
            let src_probe = probe_path(&src_abs);
            if let Some(err) = src_probe.access_err {
                return Err(ToolError::ExecutionFailed(format!(
                    "无法访问源路径：{}（{}）",
                    src_abs.display(),
                    err
                )));
            }
            if !src_probe.exists {
                return Err(ToolError::ExecutionFailed(format!(
                    "源路径不存在：{}",
                    src_abs.display()
                )));
            }
            // 自包含防御：输出不能落在目录型 source 之内
            if src_probe.is_dir && within_parent(&output_abs, &src_abs) {
                return Err(ToolError::ExecutionFailed(format!(
                    "输出路径不能在源目录内：{} 位于 {} 之内",
                    output_abs.display(),
                    src_abs.display()
                )));
            }
            let src_rel = src.trim().trim_matches('/').trim_start_matches("./").to_string();
            if src_probe.is_dir {
                collect_dir(&src_abs, &src_rel, &mut entries)?;
            } else {
                let name = src_abs
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| ToolError::ExecutionFailed("无法解析源文件名".into()))?
                    .to_string();
                entries.push((sanitize_entry(&name), src_abs.clone()));
            }
        }
        if entries.is_empty() {
            return Err(ToolError::ExecutionFailed(
                "未收集到任何可打包的文件（源目录可能为空或仅含被跳过项）".into(),
            ));
        }
        // 总大小上限（P1 #7，与 zip_extract 的 500MB 解体对称）：累加源文件体积，超限直接拒绝，防磁盘写满。
        let mut total_bytes: u64 = 0;
        for (_, p) in &entries {
            if let Ok(m) = std::fs::metadata(p) {
                total_bytes += m.len();
            }
            if total_bytes > MAX_ZIP_TOTAL_BYTES {
                return Err(ToolError::ExecutionFailed(format!(
                    "待打包文件总大小 {} 字节超过 {} 上限，拒绝打包（请缩小范围或分批）",
                    total_bytes, MAX_ZIP_TOTAL_BYTES
                )));
            }
        }
        let file = File::create(&output_abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("创建 zip 失败：{e}")))?;
        let mut zip = ZipWriter::new(file);
        // P3 #14：Unix 下显式设置归档条目权限位（0644），避免权限丢失；Windows 无意义故跳过。
        #[cfg(unix)]
        let options: FileOptions<'_, ()> = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        #[cfg(not(unix))]
        let options: FileOptions<'_, ()> =
            FileOptions::default().compression_method(CompressionMethod::Deflated);
        for (entry_name, abs_path) in &entries {
            zip.start_file(entry_name, options)
                .map_err(|e| ToolError::ExecutionFailed(format!("写入 zip 条目失败：{e}")))?;
            let mut f = File::open(abs_path)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取源文件失败：{e}")))?;
            std::io::copy(&mut f, &mut zip)
                .map_err(|e| ToolError::ExecutionFailed(format!("压缩写入失败：{e}")))?;
        }
        zip.finish()
            .map_err(|e| ToolError::ExecutionFailed(format!("关闭 zip 失败：{e}")))?;
        let size = std::fs::metadata(&output_abs).map(|m| m.len()).unwrap_or(0);
        Ok(format!(
            "已创建 {}（{} 个文件，共 {} 字节）",
            output_abs.display(),
            entries.len(),
            size
        ))
    }
}

/* ----------------------------- zip_extract（解压 · 防 zip-slip） ----------------------------- */

pub struct ZipExtractTool;

#[async_trait]
impl AgentTool for ZipExtractTool {
    fn name(&self) -> String {
        "native__zip_extract".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__zip_extract",
            "解压 zip 到工作空间内目标目录（防 zip-slip）。需用户审批。\
             默认解压到 zip 同名目录（去掉 .zip）；zip_path 必须是 .zip 文件。\
             含越界条目（../ 或绝对路径）的 zip 整体拒绝；符号链接条目跳过；条目数上限 10000，解压总大小上限 500MB。",
            json!({
                "zip_path": { "type": "string", "description": "zip 文件路径（须在工作空间内，扩展名 .zip）" },
                "dest": { "type": "string", "description": "解压目标目录（须在工作空间内），默认 zip 同名目录（去掉 .zip）" }
            }),
            &["zip_path"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let zip_path = args
            .get("zip_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("zip_extract 缺少 zip_path 参数".into()))?;
        let zip_abs = PathGuard::check(zip_path, ctx)?;
        let zip_probe = probe_path(&zip_abs);
        if let Some(err) = zip_probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问 zip：{}（{}）",
                zip_abs.display(),
                err
            )));
        }
        if !zip_probe.exists {
            return Err(ToolError::ExecutionFailed(format!(
                "zip 不存在：{}",
                zip_abs.display()
            )));
        }
        if zip_probe.is_dir {
            return Err(ToolError::ExecutionFailed(format!(
                "zip 路径是目录而非文件：{}",
                zip_abs.display()
            )));
        }
        if zip_abs.extension().and_then(|e| e.to_str()) != Some("zip") {
            return Err(ToolError::ExecutionFailed(format!(
                "不是 .zip 文件：{}（仅支持 zip 解压）",
                zip_abs.display()
            )));
        }
        // 目标目录
        let dest_abs = match args.get("dest").and_then(|v| v.as_str()) {
            Some(d) if !d.is_empty() => PathGuard::check(d, ctx)?,
            _ => {
                let stem = zip_abs
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let parent = zip_abs.parent().unwrap_or_else(|| Path::new("."));
                let default_dest = parent.join(stem);
                PathGuard::check(&default_dest.to_string_lossy(), ctx)?
            }
        };
        let ws = ctx
            .workspace
            .clone()
            .expect("PathGuard::check 已保证 workspace 存在");
        if norm_for_cmp(&dest_abs) == norm_for_cmp(&ws) {
            return Err(ToolError::PermissionDenied("禁止解压到工作空间根目录".into()));
        }
        if path_has_segment(&dest_abs, ".wd_mem") || path_has_segment(&dest_abs, ".attachments") {
            return Err(ToolError::PermissionDenied(format!(
                "目标不能落入系统目录：{}",
                dest_abs.display()
            )));
        }
        let dest_pre_existed = probe_path(&dest_abs).exists;
        // 预检：条目数与总大小上限（防 zip 炸弹）
        let file = File::open(&zip_abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("打开 zip 失败：{e}")))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|e| ToolError::ExecutionFailed(format!("读取 zip 失败：{e}")))?;
        if archive.len() as usize > MAX_ZIP_ENTRIES {
            return Err(ToolError::ExecutionFailed(format!(
                "zip 条目数 {} 超过上限 {}（疑似 zip 炸弹）",
                archive.len(),
                MAX_ZIP_ENTRIES
            )));
        }
        let mut total_size: u64 = 0;
        for i in 0..archive.len() {
            let ent = archive
                .by_index(i)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取 zip 条目失败：{e}")))?;
            if !ent.is_dir() {
                total_size = total_size.saturating_add(ent.size());
            }
        }
        if total_size > MAX_ZIP_EXTRACT_BYTES {
            return Err(ToolError::ExecutionFailed(format!(
                "zip 解压总大小 {} 字节超过上限 {} 字节（疑似 zip 炸弹）",
                total_size, MAX_ZIP_EXTRACT_BYTES
            )));
        }
        // 解压
        std::fs::create_dir_all(&dest_abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("创建目标目录失败：{e}")))?;
        let mut file_count: u64 = 0;
        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| ToolError::ExecutionFailed(format!("读取 zip 条目失败：{e}")))?;
            let name = entry.name().to_string().replace('\\', "/");
            // 消毒 + zip-slip 防御：含绝对路径或 .. 的条目整体拒绝
            if name.starts_with('/') || name.contains("..") {
                cleanup_on_abort(&dest_abs, dest_pre_existed);
                return Err(ToolError::ExecutionFailed(
                    "zip 含越界条目（绝对路径或 ..），拒绝解压（zip-slip 防御）".into(),
                ));
            }
            // 逐段拼装目标路径（避免分隔符歧义），并再确认在 dest 内
            let mut target = dest_abs.to_path_buf();
            for part in name.split('/') {
                if part.is_empty() || part == "." {
                    continue;
                }
                target.push(part);
            }
            if !within_parent(&target, &dest_abs) {
                cleanup_on_abort(&dest_abs, dest_pre_existed);
                return Err(ToolError::ExecutionFailed(
                    "zip 条目逃逸目标目录，拒绝解压（zip-slip 防御）".into(),
                ));
            }
            if entry.is_dir() {
                std::fs::create_dir_all(&target)
                    .map_err(|e| ToolError::ExecutionFailed(format!("创建目录失败：{e}")))?;
                continue;
            }
            if entry.is_symlink() {
                // 跳过符号链接条目（攻击面）
                continue;
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| ToolError::ExecutionFailed(format!("创建父目录失败：{e}")))?;
            }
            let mut out = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&target)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建解压文件失败：{e}")))?;
            if let Err(e) = PathGuard::verify_opened(&target, &out, ctx) {
                let _ = out.set_len(0);
                cleanup_on_abort(&dest_abs, dest_pre_existed);
                return Err(e);
            }
            if let Err(e) = out.set_len(0) {
                cleanup_on_abort(&dest_abs, dest_pre_existed);
                return Err(ToolError::ExecutionFailed(format!("清空目标文件失败：{e}")));
            }
            std::io::copy(&mut entry, &mut out)
                .map_err(|e| ToolError::ExecutionFailed(format!("解压写入失败：{e}")))?;
            file_count += 1;
        }
        let size = dir_size(&dest_abs);
        Ok(format!(
            "已解压 {} 到 {}（{} 个文件，共 {} 字节）",
            zip_abs.display(),
            dest_abs.display(),
            file_count,
            size
        ))
    }
}

/* ----------------------------- regex_replace ----------------------------- */

/// 用正则表达式在文件中做模式替换（与 `native__edit_file` 的字面唯一替换互补）。
/// 全程与 edit_file 同构的 PathGuard + probe + TOCTOU 读写；正则语法错误返回 InvalidArgs 让模型自纠。
pub struct RegexReplaceTool;

#[async_trait]
impl AgentTool for RegexReplaceTool {
    fn name(&self) -> String {
        "native__regex_replace".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__regex_replace",
            "用正则表达式在文件中做模式替换（支持 $1 / $2 捕获组），与 native__edit_file（字面唯一替换）互补。需用户审批。\
             执行前应先调用 native__path_exists 确认目标文件存在且为文件。正则语法错误会返回明确提示供模型自行纠正；\
             替换结果超过 2MB 拒绝写回。",
            json!({
                "path": { "type": "string", "description": "目标文件路径（须在工作空间内）" },
                "pattern": { "type": "string", "description": "Rust 正则语法（regex crate），如 (?s)<div>.*?</div>" },
                "replacement": { "type": "string", "description": "替换文本，支持 $1 / $2 等捕获组引用" },
                "all": { "type": "boolean", "description": "true=替换全部匹配（默认）；false=仅替换第一个" }
            }),
            &["path", "pattern", "replacement"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("regex_replace 缺少 path 参数".into()))?;
        let pattern = args
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("regex_replace 缺少 pattern 参数".into()))?;
        let replacement = args
            .get("replacement")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let all = args.get("all").and_then(|v| v.as_bool()).unwrap_or(true);

        let abs = PathGuard::check(path, ctx)?;
        tracing::info!(
            "[agent] native__regex_replace: 开始 path={} resolved={} pattern={}",
            path,
            abs.display(),
            crate::agent::runtime::clip(pattern, 300)
        );
        let started = Instant::now();
        // 闭环前置检查（统一复用 probe_path）。
        let probe = probe_path(&abs);
        if let Some(err) = probe.access_err {
            return Err(ToolError::ExecutionFailed(format!(
                "无法访问路径：{}（{}）",
                abs.display(),
                err
            )));
        }
        if !probe.exists {
            return Err(ToolError::ExecutionFailed(format!(
                "文件不存在：{}（请先用 native__path_exists 确认）",
                abs.display()
            )));
        }
        if probe.is_dir {
            return Err(ToolError::ExecutionFailed(format!(
                "目标是目录而非文件：{}（无法编辑目录）",
                abs.display()
            )));
        }
        // TOCTOU：先开句柄 → 校验真实物理路径 → 再读内容（与 edit_file 对齐）。
        let mut file = File::open(&abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("读取失败：{e}")))?;
        PathGuard::verify_opened(&abs, &file, ctx)?;
        // 体积预检（P1 #5）：与 read_file 同阈值，避免超大文件整读入内存 OOM。
        let meta_len = file
            .metadata()
            .map_err(|e| ToolError::ExecutionFailed(format!("读取文件元信息失败：{e}")))?
            .len();
        if meta_len > MAX_READ_FILE_BYTES {
            return Err(ToolError::ExecutionFailed(format!(
                "文件 {} 字节超过 {} 上限，拒绝读取（请改用沙箱分段处理或缩小范围）",
                meta_len, MAX_READ_FILE_BYTES
            )));
        }
        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|e| ToolError::ExecutionFailed(format!("读取失败：{e}")))?;

        let re = match Regex::new(pattern) {
            Ok(re) => re,
            Err(e) => return Err(ToolError::InvalidArgs(format!("正则表达式语法错误：{e}"))),
        };
        let count = re.find_iter(&content).count();
        if count == 0 {
            return Ok(format!("未匹配到任何内容（pattern={}），文件未改动", pattern));
        }
        let updated: String = if all {
            re.replace_all(&content, replacement.as_str()).into_owned()
        } else {
            re.replace(&content, replacement.as_str()).into_owned()
        };
        // 2MB 阈值：替换结果过大拒绝写回（与 read_file 阈值对齐）。
        if (updated.len() as u64) > MAX_READ_FILE_BYTES {
            return Err(ToolError::ExecutionFailed(format!(
                "替换后内容超过 {} 字节上限，拒绝写回（请缩小范围或分批处理）",
                MAX_READ_FILE_BYTES
            )));
        }
        // 写回：打开不截断 → verify_opened → set_len(0) → write_all（与 edit_file 同构 TOCTOU）。
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(false)
            .open(&abs)
            .map_err(|e| ToolError::ExecutionFailed(format!("写回失败：{e}")))?;
        PathGuard::verify_opened(&abs, &file, ctx)?;
        file.set_len(0)
            .map_err(|e| ToolError::ExecutionFailed(format!("清空原文件失败：{e}")))?;
        file.write_all(updated.as_bytes())
            .map_err(|e| ToolError::ExecutionFailed(format!("写回失败：{e}")))?;
        tracing::info!(
            "[agent] native__regex_replace: 成功 path={} 替换数={} 耗时={}ms",
            abs.display(),
            count,
            started.elapsed().as_millis()
        );
        Ok(format!("已在 {} 完成 {} 处替换", abs.display(), count))
    }
}

/* ----------------------------- http_request ----------------------------- */

/// 发起 HTTP 请求（GET/POST/PUT/DELETE/PATCH）。需用户审批。
/// 仅允许 http/https；强制 30s 超时、重定向上限 5；save_to 落盘走 PathGuard + TOCTOU，否则内存截断返回。
/// 解析 app_config.http_allowed_hosts（逗号 / 分号 / 空白 / 换行分隔；小写、去空、去重）。
/// 空字符串 → 空列表（表示不限制）；非空 → 允许命中的主机列表（供 native__http_request 校验）。
pub fn parse_host_allowlist(raw: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for part in raw.split(|c: char| c.is_whitespace() || c == ',' || c == ';') {
        let p = part.trim().to_lowercase();
        if p.is_empty() {
            continue;
        }
        if seen.insert(p.clone()) {
            out.push(p);
        }
    }
    out
}

/// 主机是否命中允许项：精确相等，或属于该域的子域（host == entry 或 host.ends_with(".entry")）。
/// 例如允许项 `github.com` 可放行 `api.github.com` 与 `github.com` 本身。
fn host_matches(host: &str, entry: &str) -> bool {
    let host = host.to_lowercase();
    let entry = entry.to_lowercase();
    host == entry || host.ends_with(&format!(".{}", entry))
}

/// SSRF IP 级防御：解析到的目标地址若属于受限段（环回 / 私有 / 链路本地 / 组播 / 保留），
/// 一律拒绝。在 reqwest 连接前由自定义 `SsrfSafeResolver` 对每个 DNS 解析结果（含重定向跃点）校验，无 TOCTOU 窗口。
/// 全部用稳定的 `octets()` 位运算实现，不依赖可能未稳定的 `is_private` / `is_reserved` 等辅助方法。
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(o) => {
            let b = o.octets();
            // 0.0.0.0/8 未指定 | 10/8 | 127/8 环回 | 169.254/16 链路本地(云元数据) |
            // 172.16/12 | 192.168/16 | 100.64/10 CGNAT | 224~239/4 组播 | 255 广播
            b[0] == 0
                || b[0] == 10
                || b[0] == 127
                || (b[0] == 169 && b[1] == 254)
                || (b[0] == 172 && (b[1] & 0xf0) == 16)
                || (b[0] == 192 && b[1] == 168)
                || (b[0] == 100 && (b[1] & 0xc0) == 64)
                || (b[0] >= 224 && b[0] <= 239)
                || b[0] == 255
        }
        IpAddr::V6(o) => {
            let b = o.octets();
            // ::1 环回 | :: 未指定 | fc00::/7 唯一本地(ULA) | fe80::/10 链路本地 | ff00::/8 组播
            o.is_loopback()
                || o.is_unspecified()
                || (b[0] & 0xfe) == 0xfc
                || (b[0] == 0xfe && (b[1] & 0xc0) == 0x80)
                || b[0] == 0xff
        }
    }
}

/// 自定义 DNS 解析器：在连接前拦截 SSRF 受限地址。即使 `app_config.http_allowed_hosts` 为空（不限制主机名），
/// 内网 / 云元数据 / 环回地址仍被拦截，杜绝「空配置下内网全开」。
#[derive(Clone)]
struct SsrfSafeResolver;

impl Resolve for SsrfSafeResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let host = name.as_str().to_string();
            let addrs = match tokio::net::lookup_host((host.as_str(), 0)).await {
                Ok(a) => a,
                Err(e) => {
                    let err: Box<dyn std::error::Error + Send + Sync> = Box::new(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("DNS 解析失败：{}", e),
                    ));
                    return Err(err);
                }
            };
            let mut out: Vec<SocketAddr> = Vec::new();
            for addr in addrs {
                if is_blocked_ip(addr.ip()) {
                    let err: Box<dyn std::error::Error + Send + Sync> = Box::new(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!(
                            "目标主机 {} 解析到受限地址 {}，已拒绝（SSRF 防护：禁止环回/私有/链路本地/组播/保留地址）",
                            host, addr.ip()
                        ),
                    ));
                    return Err(err);
                }
                out.push(addr);
            }
            Ok(Box::new(out.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// P2-4（2026-09-23）：HTTP 瞬态错误分类——返回结构化 error_code 供上层/模型判读
/// （裸错误串难分辨 DNS 失败 vs SSRF 拦截 vs 超时）。
fn classify_http_error(e: &reqwest::Error) -> &'static str {
    let chain = format!("{e:#}");
    if chain.contains("SSRF 防护") {
        return "ssrf_blocked";
    }
    if e.is_timeout() {
        return "timeout";
    }
    if chain.contains("DNS 解析失败") || chain.contains("failed to lookup") || chain.contains("dns error") {
        return "dns_error";
    }
    if e.is_connect() {
        return "connection_error";
    }
    "http_error"
}

/// 每次工具执行生成短调用 ID，写入日志首行便于跨工具关联排查（P3 可观测性）。
static CALL_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn next_call_id() -> String {
    let n = CALL_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("h{:08x}", n.wrapping_add(0x9e3779b9))
}

pub struct HttpRequestTool;

#[async_trait]
impl AgentTool for HttpRequestTool {
    fn name(&self) -> String {
        "native__http_request".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__http_request",
            "发起 HTTP 请求（GET / POST / PUT / DELETE / PATCH），需用户审批。仅允许 http/https。\
             可指定 headers 与请求体 body；save_to 指定工作空间内落盘路径时响应体写盘并返回大小，\
             否则读入内存（超过 2MB 拒绝）并返回截断文本。超时 30s、重定向上限 5。\
             支持配置主机白名单（app_config.http_allowed_hosts）：配置后仅允许命中域（含子域）及其解析到的公网地址；\
             白名单为空时不限制主机名，但始终拦截环回/私有/链路本地等内网与云元数据地址（SSRF 防护）；审批作为最后一道门。",
            json!({
                "method": { "type": "string", "description": "HTTP 方法：GET / POST / PUT / DELETE / PATCH" },
                "url": { "type": "string", "description": "目标 URL（仅 http/https）" },
                "headers": { "type": "object", "description": "可选请求头键值对" },
                "body": { "type": "string", "description": "可选请求体（POST/PUT/PATCH 使用）" },
                "save_to": { "type": "string", "description": "可选响应体落盘路径（工作空间内），不传则返回截断文本" }
            }),
            &["method", "url"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::RequireApproval
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let method = args
            .get("method")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("http_request 缺少 method 参数".into()))?;
        let url = args
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("http_request 缺少 url 参数".into()))?;
        let body = args
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let save_to = args
            .get("save_to")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // 协议白名单：仅 http/https（拒绝 file:// / ftp:// 等）。
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(ToolError::InvalidArgs(
                "仅支持 http/https 协议（拒绝 file://、ftp:// 等）".into(),
            ));
        }
        // 解析 URL 以可靠提取 host（P0 #1：初始请求也必须过白名单，否则攻击可直接发往非白名单主机）。
        let parsed = match reqwest::Url::parse(url) {
            Ok(u) => u,
            Err(e) => {
                return Err(ToolError::InvalidArgs(format!(
                    "URL 解析失败：{}（{}）",
                    url, e
                )))
            }
        };
        // HTTP 方法白名单（P0 #3）：仅允许安全方法，拒绝 TRACE / CONNECT 等可滥用方法。
        let method = match method.to_uppercase().as_str() {
            "GET" | "POST" | "PUT" | "DELETE" | "PATCH" => {
                reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
                    .map_err(|e| ToolError::InvalidArgs(format!("非法 HTTP 方法：{}（{e}）", method)))?
            }
            other => {
                return Err(ToolError::InvalidArgs(format!(
                    "不支持的 HTTP 方法：{}（仅允许 GET / POST / PUT / DELETE / PATCH）",
                    other
                )))
            }
        };

        // 主机白名单（P0 #1）：配置后初始 URL 主机必须命中，否则直接拒绝，请求根本不发。
        let allowed = ctx.http_allowed_hosts.clone();
        if !allowed.is_empty() {
            match parsed.host_str() {
                Some(h) if allowed.iter().any(|e| host_matches(h, e)) => {}
                _ => {
                    return Err(ToolError::InvalidArgs(format!(
                        "目标主机不在白名单内：{}（配置 http_allowed_hosts 后可放宽；或留空不限制主机名）",
                        parsed.host_str().unwrap_or(url)
                    )))
                }
            }
        }

        let call_id = next_call_id();
        tracing::info!(
            "[agent][{}] native__http_request: method={} url={} host_mode={}",
            call_id,
            method,
            crate::agent::runtime::clip(url, 300),
            if allowed.is_empty() {
                "任意(SSRF IP 拦截)"
            } else {
                "白名单"
            }
        );

        // 客户端：始终挂载自定义 DNS 解析器做 SSRF IP 级防御（P0 #2，连接前拦截环回/私有/链路本地等）；
        // 白名单非空时再叠加每个重定向跃点的主机校验（防开放重定向绕过白名单），否则沿用默认上限 5 次跟随。
        let mut client_builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .dns_resolver(std::sync::Arc::new(SsrfSafeResolver));
        client_builder = if allowed.is_empty() {
            client_builder.redirect(RedirectPolicy::limited(5))
        } else {
            client_builder.redirect(RedirectPolicy::custom(move |attempt| {
                match attempt.url().host_str() {
                    Some(h) if allowed.iter().any(|e| host_matches(h, e)) => attempt.follow(),
                    _ => attempt.stop(),
                }
            }))
        };
        let client = client_builder
            .build()
            .map_err(|e| ToolError::ExecutionFailed(format!("创建 HTTP 客户端失败：{e}")))?;

        let mut req = client.request(method.clone(), url);
        let mut has_content_type = false;
        let mut has_user_agent = false;
        if let Some(headers) = args.get("headers").and_then(|v| v.as_object()) {
            for (k, v) in headers {
                let hv = match v.as_str() {
                    Some(s) => s,
                    None => continue, // 非字符串 header 值跳过
                };
                match (
                    reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                    reqwest::header::HeaderValue::from_str(hv),
                ) {
                    (Ok(name), Ok(val)) => {
                        if name == reqwest::header::CONTENT_TYPE {
                            has_content_type = true;
                        }
                        if name == reqwest::header::USER_AGENT {
                            has_user_agent = true;
                        }
                        req = req.header(name, val);
                    }
                    _ => {
                        return Err(ToolError::InvalidArgs(format!("非法请求头：{}", k)));
                    }
                }
            }
        }
        // P2 #10：带 body 且未显式设置 Content-Type 时，默认 application/json。
        if body.is_some() && !has_content_type {
            req = req.header(reqwest::header::CONTENT_TYPE, "application/json");
        }
        // P3 #15：未显式设置 User-Agent 时，默认带标识，便于服务端审计。
        if !has_user_agent {
            req = req.header(reqwest::header::USER_AGENT, "WorkDuo-Agent/1.0");
        }
        if let Some(b) = &body {
            req = req.body(b.clone());
        }

        let start = Instant::now();
        // P2-4（2026-09-23）：瞬态网络错误（连接/DNS/超时）自动重试 ≤2 次（退避 1s/2s）——
        // L2 实测外部源偶发 `error sending request` 一败即整步挂。非瞬态（协议/参数/白名单/SSRF）不重试；
        // 失败统一带 error_code= 前缀供上层结构化判读（DNS/SSRF/超时不再是难分辨的裸串）。
        const HTTP_ATTEMPTS: usize = 3; // 首次 + 2 次重试
        let mut resp: Option<reqwest::Response> = None;
        let mut last_err: Option<reqwest::Error> = None;
        for attempt in 1..=HTTP_ATTEMPTS {
            let this_req = req.try_clone().ok_or_else(|| {
                ToolError::ExecutionFailed("请求构建失败（body 不可克隆，无法重试）".into())
            })?;
            match this_req.send().await {
                Ok(r) => {
                    resp = Some(r);
                    break;
                }
                Err(e) => {
                    if !(e.is_connect() || e.is_timeout()) || attempt == HTTP_ATTEMPTS {
                        last_err = Some(e);
                        break;
                    }
                    let wait = Duration::from_millis(1000 * attempt as u64);
                    tracing::warn!(
                        "[agent][{}] http_request 第 {attempt} 次瞬态失败（{e}），{}ms 后重试",
                        call_id,
                        wait.as_millis()
                    );
                    tokio::time::sleep(wait).await;
                }
            }
        }
        if let Some(e) = last_err {
            let code = classify_http_error(&e);
            return Err(ToolError::ExecutionFailed(format!(
                "请求失败（error_code={code}）：{e}"
            )));
        }
        let resp = resp.ok_or_else(|| ToolError::ExecutionFailed("请求未返回（内部错误）".into()))?;
        let status = resp.status();
        let headers_summary: Vec<String> = resp
            .headers()
            .iter()
            .take(20)
            .map(|(k, v)| format!("{}: {}", k, v.to_str().unwrap_or("<binary>")))
            .collect();
        let elapsed_ms = start.elapsed().as_millis();

        // 无 save_to 时按 content-length 预先拦截超 2MB（避免全量读入内存）。
        if save_to.is_none() {
            if let Some(cl) = resp.content_length() {
                if cl > MAX_READ_FILE_BYTES {
                    return Err(ToolError::ExecutionFailed(format!(
                        "响应体 {} 字节超过 2MB 上限，请改用 save_to 落盘",
                        cl
                    )));
                }
            }
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ToolError::ExecutionFailed(format!("读取响应体失败：{e}")))?;

        let mut out = format!("HTTP {}（耗时 {}ms）\n", status.as_u16(), elapsed_ms);
        if !headers_summary.is_empty() {
            out.push_str(&headers_summary.join("\n"));
            out.push('\n');
        }

        if let Some(save_path) = &save_to {
            // 落盘：过 PathGuard + 闭环前置检查 + TOCTOU 写回（与 write_file 同构）。
            let abs = PathGuard::check(save_path, ctx)?;
            let probe = probe_path(&abs);
            if probe.exists && probe.is_dir {
                return Err(ToolError::ExecutionFailed(format!(
                    "save_to 目标是目录：{}",
                    abs.display()
                )));
            }
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| ToolError::ExecutionFailed(format!("创建父目录失败：{e}")))?;
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .open(&abs)
                .map_err(|e| ToolError::ExecutionFailed(format!("创建文件失败：{e}")))?;
            PathGuard::verify_opened(&abs, &file, ctx)?;
            file.set_len(0)
                .map_err(|e| ToolError::ExecutionFailed(format!("清空失败：{e}")))?;
            file.write_all(&bytes)
                .map_err(|e| ToolError::ExecutionFailed(format!("写回失败：{e}")))?;
            out.push_str(&format!("已保存到 {}（{} 字节）", abs.display(), bytes.len()));
        } else {
            // 无 save_to：内存截断返回。
            if (bytes.len() as u64) > MAX_READ_FILE_BYTES {
                return Err(ToolError::ExecutionFailed(format!(
                    "响应体 {} 字节超过 2MB 上限，请改用 save_to 落盘",
                    bytes.len()
                )));
            }
            let text = String::from_utf8_lossy(&bytes);
            let clipped = if text.chars().count() > 1000 {
                format!(
                    "{}…（已截断，完整内容请用 save_to 落盘）",
                    text.chars().take(1000).collect::<String>()
                )
            } else {
                text.to_string()
            };
            out.push_str(&format!("Body（截断）：\n{}", clipped));
        }
        Ok(out)
    }
}

/* ----------------------------- 方案推荐：native__ask_user_choice ----------------------------- */

/// 方案推荐挂起超时（秒）：用户不点选时避免工具调用永久挂起，超时回灌「未收到选择」。
const CHOICE_TIMEOUT_SECS: u64 = 600;

/// 方案推荐：Agent 主动询问用户（HITL Choice Chip）。
///
/// 挂起机制：emit `agent-choice-needed` 推前端渲染选项弹窗，同时通过 `ChoiceHub` oneshot
/// 通道挂起当前工具调用，直到前端经 `submit_choice_decision` 回传所选 option_id 唤醒；
/// 结果以可读文本（「用户选择了：<label>」）回传，agent 据此续写。与审批（RequireApproval）
/// 区分：本工具是「信息不足/多分支决策」的主动询问，不执行危险动作，故 ReadSafe。
pub struct AskUserChoiceTool {
    app: AppHandle,
}

#[async_trait]
impl AgentTool for AskUserChoiceTool {
    fn name(&self) -> String {
        "native__ask_user_choice".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__ask_user_choice",
            "当需要用户在多个合理方案间做选择时调用（而非开放文本追问）。给出 2–5 个明确选项，用户点选后其结果（选中项文案/值）会作为本工具结果返回，供你据此续写。适用于：多分支路径决策、范围/格式确认、取舍对比。弹窗同时提供「其他 / 自定义」自由文本入口——若预设选项都不合适，用户可直接填写自己的方案，回传文案以「用户选择了（自定义）：<文本>」形式带回。不要用于危险动作授权（那走审批弹窗）。",
            json!({
                "question": { "type": "string", "description": "向用户提出的问题" },
                "options": {
                    "type": "array",
                    "description": "可选项列表（2–5 个）",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "选项唯一 id（前端回传时用）" },
                            "label": { "type": "string", "description": "展示文案" },
                            "description": { "type": "string", "description": "补充说明（可选）" },
                            "value": { "type": "string", "description": "机器语义值（可选，如具体路径/模型名；回传时一并带回）" }
                        },
                        "required": ["id", "label"]
                    }
                }
            }),
            &["question", "options"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let question = args
            .get("question")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidArgs("ask_user_choice 缺少 question 参数".into()))?
            .to_string();
        let options = args
            .get("options")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ToolError::InvalidArgs("ask_user_choice 缺少 options 参数".into()))?;
        if options.len() < 2 {
            return Err(ToolError::InvalidArgs(
                "ask_user_choice 的 options 至少需要 2 项".into(),
            ));
        }
        let mut opts = Vec::with_capacity(options.len());
        for (i, o) in options.iter().enumerate() {
            let id = o
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(&format!("opt_{i}"))
                .to_string();
            let label = o
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if label.trim().is_empty() {
                return Err(ToolError::InvalidArgs(format!(
                    "ask_user_choice 第 {i} 项缺少 label"
                )));
            }
            let description = o
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let value = o.get("value").and_then(|v| v.as_str()).map(|s| s.to_string());
            opts.push(ChoiceOption {
                id,
                label,
                description,
                value,
            });
        }
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let choice_id = format!("choice-{}-{}", ctx.agent_id, nanos);
        let req = ChoiceRequest {
            choice_id: choice_id.clone(),
            question,
            options: opts,
        };
        // 任务已完成后的「推荐」不弹阻塞弹窗：把建议作为工具结果回传，由模型写入最终回复。
        // 判定：会话计划步骤中至少已有一步闭环（任务已推进），且最多只有「最后一步」仍开口，
        // 说明主体工作已完成，此询问只是收尾推荐——不应再以弹窗打断用户（符合「推荐追加到最终回复」设定）。
        if let (Some(ws), Some(sid)) = (
            ctx.workspace.as_ref().and_then(|p| p.to_str()),
            ctx.session_id.as_deref(),
        ) {
            if let Ok(g) = KnowledgeGraph::open(Some(ws)) {
                if is_post_completion_recommendation(&g, sid) {
                    let opts_text = req
                        .options
                        .iter()
                        .enumerate()
                        .map(|(i, o)| format!("{}. {}", i + 1, o.label))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let rec = format!(
                        "（任务主体已完成，以下后续方向为可选建议，已记入最终回复，无需通过弹窗选择）\n\n{}\n{}",
                        req.question, opts_text
                    );
                    tracing::info!(
                        "[agent] ask_user_choice: 任务已完成，按「推荐」非阻塞处理（不弹窗），建议已回传模型写入最终回复"
                    );
                    return Ok(rec);
                }
            }
        }
        events::emit_choice_needed(&self.app, &req);
        // 20260919002 per-agent：经工具上下文的 agent_id 路由到本任务的状态束（choice 中枢随 agent 走）。
        let task_state = self
            .app
            .state::<crate::agent::runtime::AgentRuntime>()
            .task_state(&ctx.agent_id)
            .ok_or_else(|| ToolError::ExecutionFailed("任务状态已失效（任务可能已被回收）".into()))?;
        let rx = task_state.choice.suspend(req).await;
        let outcome = match timeout(Duration::from_secs(CHOICE_TIMEOUT_SECS), rx).await {
            Ok(Ok(o)) => o,
            Ok(Err(_)) => {
                // 通道关闭（停止触发 drop Sender）：回灌「已取消」，避免循环挂死。
                task_state.choice.cancel(&choice_id).await;
                return Ok("（用户已取消选择）".into());
            }
            Err(_) => {
                // 超时：清理挂起项后回灌「未收到选择」。
                task_state.choice.cancel(&choice_id).await;
                return Ok("（用户选择超时，未收到选择）".into());
            }
        };
        let text = if let Some(custom) = outcome.custom_text {
            // 用户走「其他 / 自定义」自由文本入口：以自定义文案回传。
            format!("用户选择了（自定义）：{}", custom)
        } else {
            match outcome.value {
                Some(v) => format!("用户选择了：{}（值：{}）", outcome.label, v),
                None => format!("用户选择了：{}", outcome.label),
            }
        };
        Ok(text)
    }
}

/// 判定当前 `ask_user_choice` 是否属于「任务已完成后的推荐」而非「任务进行中必须拍板的歧义分支」。
///
/// 规则：会话计划步骤中**至少已有一步闭环**（任务已实质推进），且未闭环步骤至多一个、
/// 且该步骤恰为最后一步（或已全部闭环）。满足则视为收尾推荐——后端应走非阻塞分支，
/// 把建议作为工具结果回传、由模型写入最终回复，而非弹出阻塞式选择窗。
fn is_post_completion_recommendation(graph: &KnowledgeGraph, session_id: &str) -> bool {
    let tasks = graph.session_tasks(session_id);
    if tasks.is_empty() {
        return false;
    }
    let max_step = tasks
        .iter()
        .filter_map(|n| n.props.get("step").and_then(|v| v.as_u64()))
        .max()
        .unwrap_or(0);
    let mut terminal_count = 0usize;
    let mut non_terminal: Vec<u64> = Vec::new();
    for n in &tasks {
        let s = n
            .props
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if matches!(s, "completed" | "skipped" | "obsolete") {
            terminal_count += 1;
        } else if let Some(step) = n.props.get("step").and_then(|v| v.as_u64()) {
            non_terminal.push(step);
        }
    }
    // 任务尚未推进（无闭环步骤）→ 仍需用户拍板，不按推荐处理。
    if terminal_count == 0 {
        return false;
    }
    match non_terminal.len() {
        0 => true,                             // 全部闭环 → 推荐
        1 => non_terminal[0] == max_step,      // 仅最后一步开口 → 收尾推荐
        _ => false,                            // 多个步骤仍开口 → 进行中歧义分支
    }
}

/* ----------------------------- register_native_tools ----------------------------- */

pub fn register_native_tools(registry: &mut ToolRegistry, app: &AppHandle, sandbox_enabled: bool, memory_mode: &str) {
    registry.register(Arc::new(ReadFileTool));
    registry.register(Arc::new(WriteFileTool { app: app.clone() }));
    registry.register(Arc::new(ArchiveArtifactTool { app: app.clone() }));
    // 记忆锚定工具仅在记忆模式非 off 时注册：off 模式既不放提示引导、也不注册工具，
    // 与能力层单一事实源原则一致（提示与能力必须同源，否则模型会绕过）。
    if memory_mode != "off" {
        registry.register(Arc::new(AnchorMemoryTool { app: app.clone() }));
    }
    registry.register(Arc::new(EditFileTool { app: app.clone() }));
    registry.register(Arc::new(ListDirectoryTool));
    // 存在性闭环前置工具：始终注册（ReadSafe），供模型在 read/write/edit/list 前显式判断路径类型，
    // 同时这些工具内部也已 bake probe_path 强制前置校验，双保险。
    registry.register(Arc::new(PathExistsTool));
    // 首梯队文件系统工具（删 / 移 / 检索 / 压缩解压）：系统能力，不依赖沙箱运行时，
    // 沙箱开 / 关都注册（与 execute_command / 沙箱工具分支对称，注册位置在分支之前）。
    registry.register(Arc::new(DeletePathTool));
    registry.register(Arc::new(MovePathTool));
    registry.register(Arc::new(GrepFilesTool));
    registry.register(Arc::new(ZipCreateTool));
    registry.register(Arc::new(ZipExtractTool));
    // 首梯队补全（系统能力，沙箱开/关都注册）：正则替换 + HTTP 请求。
    registry.register(Arc::new(RegexReplaceTool));
    registry.register(Arc::new(HttpRequestTool));
    // 阶段二图驱动：实体图检索工具（ReadSafe，始终注册），让智能体基于真实图数据决策（替代从 summary 猜）。
    registry.register(Arc::new(QueryGraphTool));
    // 方案推荐：Agent 主动询问用户（HITL Choice Chip），挂起等待选择后回传。
    registry.register(Arc::new(AskUserChoiceTool { app: app.clone() }));
    if !sandbox_enabled {
        // 非沙箱（宿主）模式：提供宿主 shell 直接执行；沙箱运行时未启用，不注册。
        registry.register(Arc::new(ExecuteCommandTool));
    } else {
        // 沙箱模式（方案 A，与 execute_command 对称）：沙箱开启时注册 Python / Node 沙箱工具，
        // 不提供宿主 shell（模型只能在隔离运行时内执行代码）；planner 能力大纲同步列出沙箱条目，
        // 保持「提示与能力同源」。两种隔离运行时并存，供模型按任务自选语言。
        registry.register(Arc::new(RunPythonSandboxTool::new(app.clone())));
        registry.register(Arc::new(RunNodeSandboxTool::new(app.clone())));
    }
}

/// 注册知识库检索工具（K2 第四期）：仅在智能体绑定了知识库时调用——
/// 未绑定不注册，planner 能力大纲也不列出（提示与能力同源，防止模型臆测能力）。
pub fn register_kb_search_tool(registry: &mut ToolRegistry, app: &AppHandle, kb_ids: Vec<String>) {
    if kb_ids.is_empty() {
        return;
    }
    registry.register(Arc::new(KbSearchTool {
        app: app.clone(),
        kb_ids,
        call_count: std::sync::atomic::AtomicUsize::new(0),
        seen_chunks: std::sync::Mutex::new(std::collections::HashSet::new()),
        cite_by_id: std::sync::Mutex::new(std::collections::HashMap::new()),
        cite_counter: std::sync::atomic::AtomicUsize::new(0),
    }));
}

/// 检索软上限：超过后在返回结果里注入收敛提示（真机 2026-09-19 实锤：知识库整理任务
/// 模型陷入纯检索循环，9 轮 30+ 次 kb_search 正文恒空）。工具实例生命周期 = 单次任务
/// 注册（registry 每次 run 重建），计数天然 per-run。
const KB_SEARCH_SOFT_LIMIT: usize = 6;

/// K3-4 护栏硬化（#5，2026-09-20）：软 notice 实测会被模型无视继续检索（复测 14 次案例），
/// 超过硬上限后直接拒绝执行检索（连嵌入+Lance 查询开销都省掉），强制收敛。
/// 注意：计数移到 execute 入口后，失败/被拒的调用同样占额度（防滥用语义）。
const KB_SEARCH_HARD_LIMIT: usize = 10;

/// 知识库检索工具（K2）：语义优先、关键词降级，返回可溯源片段（源文件 + 层级路径）。
/// 只读（ReadSafe），无需审批。
/// K3-2 引用编号：每个命中带 `cite` 字段（任务内全局递增、同一 chunk 跨调用编号不变），
/// 模型被引导在回复句末标注 `[编号]`，前端据此渲染可悬浮溯源的正文内联引标。
pub struct KbSearchTool {
    app: AppHandle,
    /// 该智能体绑定的知识库 id（检索范围）。
    kb_ids: Vec<String>,
    /// 本任务内已执行的检索次数。
    call_count: std::sync::atomic::AtomicUsize,
    /// K3-4 任务内去重：已返回过的 chunk id（防止多轮检索重复付同一段内容的 token）。
    seen_chunks: std::sync::Mutex<std::collections::HashSet<String>>,
    /// K3-2 引用编号映射：chunk id → cite（首见分配，跨调用稳定）。
    cite_by_id: std::sync::Mutex<std::collections::HashMap<String, u32>>,
    /// K3-2 引用编号计数器（配合 cite_by_id 分配下一个编号）。
    cite_counter: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl AgentTool for KbSearchTool {
    fn name(&self) -> String {
        "native__kb_search".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__kb_search",
            "检索已绑定的知识库（Markdown/TXT 文档），默认范围为**全部已绑定库**（可用 kb_ids 收窄到指定库），返回与查询最相关的资料片段（含源文件路径与层级位置，可溯源）。回答事实性、配置类、领域知识问题时应优先调用本工具核对资料，而非凭记忆臆测。只读，无需审批。每个片段带 cite 字段 = 任务内全局引用编号（同一片段跨调用编号不变）；**在最终回答中引用某片段内容时，请在对应句子末尾标注其引用编号**（如 [1]、[2]，紧跟句末标点前），便于用户悬浮溯源；未引用到的片段不必标注。",
            json!({
                "query": { "type": "string", "description": "检索查询（自然语言，可含关键词）" },
                "top_k": { "type": "integer", "description": "返回片段数上限，默认 5，最大 8；除非确需多角度覆盖，保持默认即可" },
                "kb_ids": { "type": "array", "items": { "type": "string" }, "description": "可选：限定检索的知识库范围，值为知识库的 id 或 identifier（须为当前智能体已绑定的库，指定未绑定的库会直接报错）。默认省略 = 检索全部已绑定库。**不要把库名填进 tags**" },
                "tags": { "type": "array", "items": { "type": "string" }, "description": "可选：文档（资产）级标签过滤，匹配 meta_data.tags 文档标签——**不是知识库名/identifier**（按库限定请用 kb_ids）；仅检索打了这些标签的文件，标签清单见知识库详情页标签云。用户明确要求按标签限定范围时才传，否则省略" }
            }),
            &["query"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, _ctx: &ToolContext) -> Result<String, ToolError> {        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if query.is_empty() {
            return Err(ToolError::InvalidArgs("kb_search 缺少 query 参数".into()));
        }
        // 护栏硬化（#5）：先取号再干活——超过硬上限直接拒绝执行，强制模型基于已有资料作答。
        let n = self
            .call_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        if n > KB_SEARCH_HARD_LIMIT {
            return Ok(serde_json::to_string(&serde_json::json!({
                "blocked": true,
                "notice": format!(
                    "已达本任务知识库检索硬上限（{} 次），本次检索未执行。你已拥有足够的检索资料，请立即基于已有信息输出最终答案，不要再尝试调用本工具。",
                    KB_SEARCH_HARD_LIMIT
                ),
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        let top_k = args.get("top_k").and_then(|v| v.as_u64()).unwrap_or(5) as usize;
        // K3-3 标签圈定（可选）：传入资产标签 → 仅在命中标签的资产范围内检索。
        let mut tags: Option<Vec<String>> = args.get("tags").and_then(|v| v.as_array()).map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect::<Vec<_>>()
        });
        // P-04 §4.1/4.2：按库收窄（可选）——值可为库 id 或 identifier，必须 ⊆ 绑定库（越权明确报错）。
        let kb_req: Option<Vec<String>> = args.get("kb_ids").and_then(|v| v.as_array()).map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect::<Vec<_>>()
        });
        let mut scope: Option<Vec<String>> = None;
        if let Some(req) = kb_req.filter(|r| !r.is_empty()) {
            scope = Some(
                crate::agent::knowledge::resolve_kb_scope(&self.app, &self.kb_ids, &req)
                    .await
                    .map_err(ToolError::InvalidArgs)?,
            );
        } else if tags.as_ref().is_some_and(|t| !t.is_empty()) {
            // P-04 §4.5 兼容捷径：tags 值全部精确命中绑定库的 id/identifier → 视为按库过滤
            // （真机 2026-09-22 实锤：模型把库名塞进 tags → 标签圈定 0 命中静默空）。
            let tags_v = tags.clone().unwrap();
            if let Ok(resolved) =
                crate::agent::knowledge::resolve_kb_scope(&self.app, &self.kb_ids, &tags_v).await
            {
                if !resolved.is_empty() {
                    tracing::warn!(
                        "[agent] kb_search deprecated: tags-as-kb tags={:?} → 已按库过滤 scope={:?}；请改用 kb_ids 参数",
                        tags_v,
                        resolved
                    );
                    scope = Some(resolved);
                    tags = None;
                }
            }
        }
        let outcome = crate::agent::knowledge::kb_search(
            &self.app,
            &self.kb_ids,
            &query,
            top_k,
            false,
            tags.as_deref(),
            scope.as_deref(),
        )
        .await
        .map_err(ToolError::ExecutionFailed)?;
        if outcome.hits.is_empty() {
            // P-04 §4.3：空结果结构化诊断（消灭静默空/假绿）——reason 区分「语义无命中」vs「过滤误杀」。
            let diag = outcome.diagnostics;
            let reason = diag.as_ref().map(|d| d.reason).unwrap_or("no_match");
            tracing::warn!(
                "[agent] kb_search 空结果 reason={} tags={:?} bound_kb={:?}",
                reason,
                tags,
                self.kb_ids
            );
            let note = diag.as_ref().map(|d| d.note.as_str()).unwrap_or("");
            return Ok(serde_json::to_string(&serde_json::json!({
                "hits": [],
                "diagnostics": diag,
                "notice": format!("知识库中未找到与查询相关的片段。{note}"),
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        let hits = outcome.hits;
        // K3-4 任务内去重：过滤本任务已返回过的 chunk（省重复 token）；全部重复时
        // 直接给收敛指令而非空列表（避免模型把「空」误读为「知识库没有」而臆测）。
        // 轮 7 实锤：模型重检同一内容时，目标 chunk 被 seen 过滤，而 fresh 里只有
        // 次要新命中 → full 通路（仅在 fresh 全空时触发）没开，模型永远拿不回被
        // 截断的正文。此处记录「score 优于 fresh 全部」的重复命中（L2 距离越小越
        // 相关）= 模型明确重检想要的旧内容，供下方 full 重取附带完整原文。
        let (fresh_hits, duplicate_count, better_dup_ids) = {
            let mut seen = self
                .seen_chunks
                .lock()
                .map_err(|_| ToolError::ExecutionFailed("kb_search 去重锁中毒".into()))?;
            let mut fresh = Vec::new();
            let mut dup_ids: Vec<(String, f32)> = Vec::new();
            for h in hits {
                if seen.insert(h.id.clone()) {
                    fresh.push(h);
                } else {
                    dup_ids.push((h.id, h.score));
                }
            }
            let best_fresh = fresh.first().map(|h| h.score).unwrap_or(f32::INFINITY);
            let better: Vec<String> = dup_ids
                .iter()
                .filter(|(_, s)| *s < best_fresh)
                .map(|(id, _)| id.clone())
                .collect();
            (fresh, dup_ids.len(), better)
        };
        if fresh_hits.is_empty() {
            // K3-4 修订（2026-09-20 轮 4 实锤）：全重复时重取完整原文——裁剪分级+去重叠加
            // 曾导致超长 chunk（调色板 ~700 字）被 600 上限腰斩且永远拿不回完整版。
            let full_hits = crate::agent::knowledge::kb_search(
                &self.app,
                &self.kb_ids,
                &query,
                top_k,
                true,
                tags.as_deref(),
                scope.as_deref(),
            )
            .await
            .map_err(ToolError::ExecutionFailed)?
            .hits;
            let full_hits = self.with_cite(full_hits)?;
            return Ok(serde_json::to_string(&serde_json::json!({
                "notice": format!(
                    "该查询命中的 {} 个片段此前已返回过（截断版）；以下为未截断的完整原文，请以此为准整理最终答案，无需再次检索。",
                    duplicate_count
                ),
                "hits": full_hits,
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        // 轮 7 修订：fresh 非空但存在「更优重复命中」时，full 重取其完整原文附带返回
        // （上限 2 个，token 有界）——重取通路的最后一块拼图：只要模型明确重检旧内容，
        // 就能拿回完整版，不再依赖「本次命中全部重复」这个过窄的触发条件。
        let mut out_hits = fresh_hits;
        let mut extra_notice = String::new();
        if !better_dup_ids.is_empty() {
            let full_hits = crate::agent::knowledge::kb_search(
                &self.app,
                &self.kb_ids,
                &query,
                top_k,
                true,
                tags.as_deref(),
                scope.as_deref(),
            )
            .await
            .map_err(ToolError::ExecutionFailed)?
            .hits;
            let extras: Vec<_> = full_hits
                .into_iter()
                .filter(|h| better_dup_ids.contains(&h.id))
                .take(2)
                .collect();
            let extra_n = extras.len();
            if extra_n > 0 {
                out_hits.extend(extras);
                extra_notice = format!(
                    "另有 {extra_n} 个本次重检命中、此前被截断的片段，其未截断完整原文已附在结果尾部，请以此为准整理最终答案。"
                );
            }
        }
        let hits_json = serde_json::to_value(self.with_cite(out_hits)?)
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?;
        // 收敛引导（软上限）：超限后包装返回，注入「立即整理答案」的强提示，
        // 把模型从「无限换词再检索」循环里拽出来（硬上限在 execute 入口短路）。
        if n > KB_SEARCH_SOFT_LIMIT {
            let mut notice = format!(
                "注意：本任务已执行 {} 次知识库检索（硬上限 {} 次）。多数章节应已覆盖；若确有明确的信息缺口可继续检索，否则请立即基于已有资料整理最终答案。",
                n, KB_SEARCH_HARD_LIMIT
            );
            notice.push_str(&extra_notice);
            return Ok(serde_json::to_string(&serde_json::json!({
                "notice": notice,
                "hits": hits_json,
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        if !extra_notice.is_empty() {
            return Ok(serde_json::to_string(&serde_json::json!({
                "notice": extra_notice,
                "hits": hits_json,
            }))
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?);
        }
        serde_json::to_string(&hits_json)
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))
    }
}

impl KbSearchTool {
    /// 构造独立实例（20260922 #1：SIMPLE_CHAT 快路径由 runtime 直接携带 kb_search 工具，
    /// 纯 KB 问答跳过规划，单轮「检索→综合」即答）。
    pub fn new_arc(app: AppHandle, kb_ids: Vec<String>) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            app,
            kb_ids,
            call_count: std::sync::atomic::AtomicUsize::new(0),
            seen_chunks: std::sync::Mutex::new(std::collections::HashSet::new()),
            cite_by_id: std::sync::Mutex::new(std::collections::HashMap::new()),
            cite_counter: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    /// K3-2：为命中注入 `cite` 引用编号（首见分配任务内递增号，重复命中/完整版重取沿用原号），
    /// 序列化为 JSON Value 后逐条插入 cite 字段（编号属工具层会话态，不污染 KbSearchHit 结构）。
    fn with_cite(
        &self,
        hits: Vec<crate::agent::knowledge::KbSearchHit>,
    ) -> Result<Vec<Value>, ToolError> {
        let mut map = self
            .cite_by_id
            .lock()
            .map_err(|_| ToolError::ExecutionFailed("kb_search 引用编号锁中毒".into()))?;
        let mut out = Vec::with_capacity(hits.len());
        for h in hits {
            let cite = match map.get(&h.id) {
                Some(c) => *c,
                None => {
                    let c = (self.cite_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1) as u32;
                    map.insert(h.id.clone(), c);
                    c
                }
            };
            let mut v = serde_json::to_value(&h)
                .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))?;
            if let Some(obj) = v.as_object_mut() {
                obj.insert("cite".into(), serde_json::json!(cite));
            }
            out.push(v);
        }
        Ok(out)
    }
}

/* ----------------------------- query_graph (阶段二图驱动) ----------------------------- */

/// 把工具参数 `kind` 字符串映射为图节点类型（NodeKind）。
fn parse_node_kind(s: &str) -> Option<NodeKind> {
    match s.to_ascii_lowercase().as_str() {
        "session" => Some(NodeKind::Session),
        "task" => Some(NodeKind::Task),
        "artifact" => Some(NodeKind::Artifact),
        "file_ref" | "file" => Some(NodeKind::FileRef),
        "memory" => Some(NodeKind::Memory),
        "prompt" => Some(NodeKind::Prompt),
        _ => None,
    }
}

/// 实体图检索工具：智能体运行时查询「某步产出了哪些文件 / 某文件被哪些步骤读写 / 历史任务链」
/// 等真实图数据，替代从模型 summary 文本猜测（对齐图驱动约束铁律：约束必须读真实图数据）。
/// 只读，ReadSafe 始终注册。
pub struct QueryGraphTool;

#[async_trait]
impl AgentTool for QueryGraphTool {
    fn name(&self) -> String {
        "native__query_graph".into()
    }
    fn tool_definition(&self) -> Value {
        def(
            "native__query_graph",
            "检索当前工作区的实体图（任务/文件/产物/记忆节点），用于查询「某步产出了哪些文件」「某文件被哪些步骤读写」「历史任务链」等真实图数据，辅助后续决策。只读，无需审批。",
            json!({
                "keyword": { "type": "string", "description": "模糊匹配关键词（标题/描述/路径）" },
                "kind": { "type": "string", "enum": ["session", "task", "artifact", "file_ref", "memory", "prompt"], "description": "可选节点类型过滤" },
                "limit": { "type": "integer", "description": "返回上限，默认 20" }
            }),
            &["keyword"],
        )
    }
    fn check_permission(&self, _args: &Value) -> PermissionLevel {
        PermissionLevel::ReadSafe
    }
    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<String, ToolError> {
        let keyword = args
            .get("keyword")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if keyword.is_empty() {
            return Err(ToolError::InvalidArgs("query_graph 缺少 keyword 参数".into()));
        }
        let kind = args.get("kind").and_then(|v| v.as_str()).and_then(parse_node_kind);
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20) as usize;

        let workspace = ctx.workspace.as_ref().and_then(|p| p.to_str());
        let graph = KnowledgeGraph::open(workspace)
            .map_err(|e| ToolError::ExecutionFailed(format!("打开实体图失败：{e}")))?;

        let nodes = graph.search(&keyword, kind, limit);
        let mut out: Vec<Value> = Vec::new();
        for n in nodes {
            out.push(json!({
                "id": n.id,
                "kind": serde_json::to_value(n.kind).unwrap_or(Value::Null),
                "title": n.props.get("title").and_then(|v| v.as_str()),
                "status": n.props.get("status").and_then(|v| v.as_str()),
                "path": n.props.get("path").and_then(|v| v.as_str()),
                "step": n.props.get("step").and_then(|v| v.as_u64()),
                "description": n.props.get("description").and_then(|v| v.as_str()),
            }));
        }
        serde_json::to_string(&out)
            .map_err(|e| ToolError::ExecutionFailed(format!("序列化检索结果失败：{e}")))
    }
}
