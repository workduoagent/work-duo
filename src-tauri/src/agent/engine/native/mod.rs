//! 原生工具集（S1 拆分：按域分文件 native/{fs,exec,net,memory,kb}.rs，台账 §2.1）。
//!
//! `def`（工具 JSON Schema 规范构造）与路径安全辅助为本目录共享；register_native_tools /
//! register_kb_search_tool 聚合注册，外部调用路径 `engine::native::` 不变。

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

use std::sync::Arc;

use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;

use crate::agent::engine::graph::{KnowledgeGraph, NodeKind};
use crate::agent::engine::tools::ToolError;
use crate::agent::engine::tools::ToolRegistry;

use std::path::Path;
use std::path::PathBuf;

// zip 读写（首梯队原生工具 zip_create / zip_extract 依赖；自带 deflate/flate2）。

// 正则替换工具（首梯队补全）：Rust regex，线性时间保证，无 ReDoS 风险。
// HTTP 请求工具（首梯队补全）：重定向次数上限 5。
// SSRF 防御：自定义 DNS 解析器（reqwest::dns::Resolve），在连接前拦截环回 / 私有 / 链路本地等受限地址。
use reqwest::dns::Resolve;
use std::net::{IpAddr, SocketAddr};




/// 构造标准 function-calling 定义骨架。

mod exec;
mod fs;
mod kb;
mod memory;
mod net;

pub use exec::*;
pub use fs::*;
pub use memory::*;
pub use net::*;

pub(crate) fn def(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
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
pub(crate) struct PathProbe {
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

/* ----------------------------- write_file ----------------------------- */

pub struct WriteFileTool {
    /// 应用句柄（#20260918006：写 .wd_mem/artifacts/*.md 后异步索引用）。
    pub app: AppHandle,
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

/* ----------------------------- anchor_memory（记忆宫殿 · 无感自动学习） ----------------------------- */

/// 记忆沉淀工具：把对话中确认的可跨会话复用信息（用户偏好 / 已决策架构约定 / 踩坑法则 / 可复用代码模式）
/// 写入 `agent_memories`（按 (agent_id, key) 去重），构成记忆宫殿的「无感自动学习」闭环。
/// 与手动「锚定」按钮不同，本工具只做沉淀（anchored=false，参与 ref_count 排序但不钉）；
/// 纯写库、无文件系统 / Shell 副作用，且不会自我触发新的锚定，故归属 ReadSafe（不弹审批）。
pub struct AnchorMemoryTool {
    app: AppHandle,
}

/* ----------------------------- edit_file ----------------------------- */

pub struct EditFileTool {
    /// 应用句柄（#20260918006：编辑 .wd_mem/artifacts/*.md 后异步索引用）。
    pub app: AppHandle,
}

/* ----------------------------- list_directory ----------------------------- */

/* ----------------------------- path_exists（存在性闭环前置） ----------------------------- */

/* ----------------------------- execute_command ----------------------------- */

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

/* ----------------------------- run_node_sandbox ----------------------------- */

pub struct RunNodeSandboxTool {
    app: AppHandle,
}

impl RunNodeSandboxTool {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
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

/* ----------------------------- move_path（CRUD 的 U / 重命名） ----------------------------- */

/* ----------------------------- grep_files（子串检索） ----------------------------- */

/* ----------------------------- zip_create（打包） ----------------------------- */

/* ----------------------------- zip_extract（解压 · 防 zip-slip） ----------------------------- */

/* ----------------------------- regex_replace ----------------------------- */

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

impl KbSearchTool {
    /// 构造独立实例（20260922 #1：SIMPLE_CHAT 快路径由 runtime 直接携带 kb_search 工具，
    /// 纯 KB 问答跳过规划，单轮「检索→综合」即答）。
    #[allow(dead_code)]
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
        hits: Vec<crate::agent::knowledge::knowledge::KbSearchHit>,
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

#[cfg(test)]
mod behavior_tests {
    use super::*;
    use crate::agent::engine::tools::AgentTool;
    use crate::agent::engine::tools::ToolBehavior;

    /// 台账 S6 进阶：声明式行为元数据自检——可无参实例化的原生工具直接断言
    /// behavior() 声明与旧叶子名匹配语义一致（写/删/移/替换等危险语义工具漏标
    /// 会导致 policy 危险信号评估跳过，此处为声明落地的回归保障）。
    #[test]
    fn behavior_declarations_match_legacy_semantics() {
        assert_eq!(
            ReadFileTool.behavior(),
            ToolBehavior { op: Some("read"), file_mutating: false, file_reading: true }
        );
        assert_eq!(
            PathExistsTool.behavior(),
            ToolBehavior { op: Some("check"), file_mutating: false, file_reading: false }
        );
        assert_eq!(
            ListDirectoryTool.behavior(),
            ToolBehavior { op: Some("list"), file_mutating: false, file_reading: false }
        );
        assert_eq!(
            GrepFilesTool.behavior(),
            ToolBehavior { op: Some("search"), file_mutating: false, file_reading: false }
        );
        assert_eq!(
            ZipCreateTool.behavior(),
            ToolBehavior { op: Some("zip"), file_mutating: false, file_reading: false }
        );
        assert_eq!(
            ZipExtractTool.behavior(),
            ToolBehavior { op: Some("unzip"), file_mutating: false, file_reading: false }
        );
    }
}
