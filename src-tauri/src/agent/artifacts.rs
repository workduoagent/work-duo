//! 产物注册表（Artifact Registry）。
//!
//! 子任务成功闭环后，从产物摘要里抽取模型报告的「文件产物」路径，规范化并落盘校验后
//! 登记进 `artifacts` 表，并推送 `agent-artifact-created` 事件，驱动前端「产物画廊」。
//!
//! 设计要点：
//!  - 产物是「逻辑实体」，文件只是其一种实现；这里只登记**真实存在**的文件（L1 文件存在校验）。
//!  - 不引入正则依赖（crate 未启用 `regex`），路径识别用手写扫描 + 分词。
//!  - 相对路径以工作空间为基准解析；URL（含 `://`）一律忽略。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

use crate::agent::round_compactor;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::ArtifactRef;
use crate::agent::types::PlanSubTask;

/// 已知文件扩展名（用于判断「这是不是一个文件产物」以及推导类型）。
const KNOWN_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tif", "tiff", "heic",
    "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "tsv",
    "json", "yaml", "yml", "xml", "toml", "ini", "cfg", "conf",
    "md", "txt", "log", "rst", "text",
    "py", "js", "jsx", "ts", "tsx", "html", "htm", "go", "rs", "java", "c", "cpp", "h", "hpp",
    "php", "rb", "sh", "bat", "ps1", "sql", "ipynb", "r", "scala", "kt",
    "zip", "tar", "gz", "tgz", "rar", "7z", "bz2",
    "mp3", "wav", "mp4", "mov", "webm", "mkv", "avi",
    "db", "sqlite", "duckdb",
];

/// 子任务成功闭环后登记其文件产物。
///
/// 返回登记成功的产物清单（供调用方写回 `SubTaskOutput.artifacts`）。
/// 任何单条产物登记失败都不影响其它产物（best-effort）。
pub async fn register_artifacts(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    task: &PlanSubTask,
    summary: &str,
) -> Vec<ArtifactRef> {
    let ws = cfg.workspace.clone().unwrap_or_default();
    let candidates = candidate_paths(summary);
    let now = now_ms();
    let mut out: Vec<ArtifactRef> = Vec::new();
    let mut idx: u32 = 0;

    for raw in candidates {
        let path = match resolve_path(&raw, &ws) {
            Some(p) => p,
            None => continue,
        };
        // 步骤内去重（同一路径只登记一次）。
        if out.iter().any(|a| a.path == path) {
            continue;
        }
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue, // 文件不存在 → 不登记（L1 文件存在校验）
        };
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let ext = Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let artifact_type = infer_type(&ext, is_dir);
        let mime = infer_mime(&ext, is_dir);
        let description = Path::new(&path)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("")
            .to_string();
        let artifact_id = format!("art_{}_{}_{}", now, task.step, idx);
        idx += 1;
        let ar = ArtifactRef {
            artifact_id: artifact_id.clone(),
            task_id: task.task_id.clone(),
            step: task.step,
            artifact_type,
            path,
            mime_type: mime,
            description,
            size,
            created_at: now as i64,
        };
        round_compactor::persist_artifact(app, cfg.session_id.as_deref(), cfg.round_id.as_deref(), &ar).await;
        out.push(ar);
    }

    if !out.is_empty() {
        crate::agent::events::emit_artifact_created(app, task.step, &out);
        println!(
            "[agent] artifacts: 步骤 {} 登记 {} 个产物：{}",
            task.step,
            out.len(),
            out.iter().map(|a| a.description.as_str()).collect::<Vec<_>>().join(", "),
        );
    }
    out
}

/// 从文本摘要中抽取候选文件路径（绝对/相对均可，忽略 URL）。
fn candidate_paths(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = text.as_bytes();

    // 1) Windows 绝对盘符路径 `X:\...`：手写扫描（避开正则依赖）。
    let mut i = 0;
    while i + 2 < bytes.len() {
        let is_drive = bytes[i].is_ascii_alphabetic() && bytes[i + 1] == b':' && bytes[i + 2] == b'\\';
        if is_drive {
            let start = i;
            let mut j = i + 3;
            while j < bytes.len() && !is_path_terminator(bytes[j]) {
                j += 1;
            }
            out.push(text[start..j].to_string());
            i = j.max(i + 1);
            continue;
        }
        i += 1;
    }

    // 2) 分词：按空白与中文/英文标点切分，再逐 token 判定是否为路径。
    for token in text.split(|c: char| is_split(c)) {
        let t = token.trim_matches(|c| c == '"' || c == '\'' || c == '`' || c == '(' || c == ')' || c == '[' || c == ']');
        if t.is_empty() {
            continue;
        }
        if is_path_token(t) {
            out.push(t.to_string());
        }
    }

    // 全局去重（盘符扫描与分词可能重复命中同一路径）。
    let mut seen = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.clone()));
    out
}

fn is_path_terminator(b: u8) -> bool {
    b.is_ascii_whitespace() || b == b'"' || b == b'\'' || b == b'<' || b == b'>'
}

fn is_split(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '，' | '。' | '；' | '：' | '、' | '“' | '”' | '（' | '）' | '【' | '】' | '《' | '》'
                | ',' | ';' | ':' | '"' | '\'' | '(' | ')' | '[' | ']' | '<' | '>' | '`'
                | '\n' | '\r' | '\t'
        )
}

/// 判定 token 是否像一个文件路径。
fn is_path_token(t: &str) -> bool {
    if t.contains("://") {
        return false; // URL，忽略
    }
    let lower = t.to_lowercase();
    if lower.starts_with("http") {
        return false;
    }
    if t.len() < 3 {
        return false;
    }
    let has_sep = t.contains('/') || t.contains('\\');
    if has_sep {
        if t.ends_with('/') || t.ends_with('\\') {
            return true; // 目录路径
        }
        if t.starts_with("./") || t.starts_with("../") || t == "." || t == ".." {
            return true;
        }
        return has_known_ext(t);
    }
    // 无分隔符：仅当是带已知扩展名的裸文件名才算（如 `report.xlsx`）。
    has_known_ext(t)
}

fn has_known_ext(t: &str) -> bool {
    match t.rfind('.') {
        Some(pos) if pos + 1 < t.len() => {
            let ext = &t[pos + 1..];
            // 扩展名不含路径分隔符、长度 1~6
            !ext.contains('/') && !ext.contains('\\') && (1..=6).contains(&ext.len()) && KNOWN_EXT.contains(&ext.to_lowercase().as_str())
        }
        _ => false,
    }
}

/// 把原始路径解析为绝对路径（相对路径以工作空间为基准）。
fn resolve_path(raw: &str, ws: &str) -> Option<String> {
    let t = raw.trim();
    let t = t.strip_prefix("./").unwrap_or(t);
    let t = t.strip_prefix("../").unwrap_or(t);
    let t = t.trim_start_matches('/');

    let p = Path::new(t);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        if ws.is_empty() {
            return None;
        }
        Path::new(ws).join(t)
    };
    // 不调用 canonicalize（Windows 会引入 `\\?\` 前缀，干扰后续 openPath），
    // 直接用绝对形式；文件存在性由调用方 metadata 校验。
    Some(abs.to_string_lossy().to_string())
}

fn infer_type(ext: &str, is_dir: bool) -> String {
    if is_dir {
        return "directory".to_string();
    }
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "bmp" | "ico" | "tif" | "tiff" | "heic" => {
            "image"
        }
        "xls" | "xlsx" | "csv" | "tsv" => "spreadsheet",
        "doc" | "docx" | "pdf" | "ppt" | "pptx" => "document",
        "json" | "yaml" | "yml" | "xml" | "toml" | "ini" | "cfg" | "conf" => "json",
        "py" | "js" | "jsx" | "ts" | "tsx" | "html" | "htm" | "go" | "rs" | "java" | "c" | "cpp"
        | "h" | "hpp" | "php" | "rb" | "sh" | "bat" | "ps1" | "sql" | "ipynb" | "r" | "scala"
        | "kt" => "code",
        "md" | "txt" | "log" | "rst" | "text" => "report",
        _ => "file",
    }
    .to_string()
}

fn infer_mime(ext: &str, is_dir: bool) -> String {
    if is_dir {
        return "inode/directory".to_string();
    }
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "csv" | "tsv" => "text/csv",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "ppt" => "application/vnd.ms-powerpoint",
        "json" | "ipynb" => "application/json",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "toml" => "application/toml",
        "html" | "htm" => "text/html",
        "md" | "txt" | "log" | "text" | "py" | "js" | "ts" | "go" | "rs" | "java" | "c" | "cpp"
        | "h" | "php" | "sh" | "bat" | "ps1" | "sql" | "r" | "scala" | "kt" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
