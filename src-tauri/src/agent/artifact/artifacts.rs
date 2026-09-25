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

use crate::agent::engine::round_compactor;
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

/// 结构化产物来源（图/工具驱动，取代单纯扫 `summary` 文本）。
///
/// 优先级：P0 `changed_files`（工具真实写出） > P1 `success_targets`（声明 criteria 且存在）>
/// P3 `summary` 文本推断（兜底，命中即 warn）。
pub struct ArtifactSources<'a> {
    /// P0：本步工具真实写出的路径（write_file/edit_file 真实返回），最可信。
    pub changed_files: &'a [String],
    /// P1：本步声明的 `success_criteria.target`（相对工作空间、存在的文件）。
    pub success_targets: Vec<String>,
}

/// 按优先级合并产物候选路径（纯函数，便于单测）。
///
/// 返回 `(raw_path, is_summary_fallback)`：
/// - P0 `changed_files` 与 P1 `success_targets` 来源 `is_summary_fallback = false`
/// - 仅由 `summary` 文本推断命中者 `is_summary_fallback = true`（调用方据此 warn 幽灵产物风险）
///
/// 全局去重：同路径只保留首次命中来源（P0 > P1 > P3）。
fn merge_artifact_candidates(
    changed_files: &[String],
    success_targets: &[String],
    summary: &str,
) -> Vec<(String, bool)> {
    let mut raw: Vec<(String, bool)> = Vec::new();
    for p in changed_files {
        raw.push((p.clone(), false));
    }
    for p in success_targets {
        if !raw.iter().any(|(r, _)| r == p) {
            raw.push((p.clone(), false));
        }
    }
    let summary_cands = candidate_paths(summary);
    for c in summary_cands {
        if !raw.iter().any(|(r, _)| *r == c) {
            raw.push((c, true));
        }
    }
    raw
}

/// 解析候选并按「物理文件」去重，返回 `(resolved_path, is_fallback)`。
///
/// 关键修复（#20260918010-#2 幽灵产物重复登记）：`merge_artifact_candidates` 按原始字符串去重、
/// 旧 `register_artifacts` 按「朴素解析路径」去重，均无法识别「同一物理文件的不同写法」——
/// 例如工具真实写出的相对路径 `decision.md` 与 summary 文本里的 `.\decision.md` / 绝对路径 /
/// 大小写不同路径（Windows 路径大小写不敏感但字符串不等），会被当作两个候选各登记一次，
/// 既重复登记产物、又误触发幽灵产物 WARN（Q1 实证 `登记 2 个产物：memory-v2-lancedb-decision.md, memory-v2-lancedb-decision.md`）。
///
/// 此处按 `physical_key`（折叠 `.`/`..`、统一分隔符、Windows 小写、去 `\\?\`）判定物理等价，
/// 同一文件只保留一条；当真实来源（fallback=false）与 summary 推断（fallback=true）命中同一文件时，
/// 以真实来源为准（升级为非兜底、丢弃 summary 推断重复项，不再误报幽灵产物）。仅 summary 推断、
/// 无真实来源命中同一文件的候选保留 fallback 标记（该 WARN 仍合理：确有文件但无工具证据）。
///
/// 文件不存在的候选直接丢弃（L1 文件存在校验）。
fn resolve_artifact_entries(raw_candidates: Vec<(String, bool)>, ws: &str) -> Vec<(String, bool)> {
    let mut resolved: Vec<(String, String, bool)> = Vec::new(); // (key, path, is_fallback)
    for (raw, is_fallback) in raw_candidates {
        let path = match resolve_path(&raw, &ws) {
            Some(p) => p,
            None => continue,
        };
        // L1 文件存在校验：不存在的文件不登记（避免登记「声称但未产生」的产物）。
        if std::fs::metadata(&path).is_err() {
            continue;
        }
        let key = physical_key(&path);
        if let Some(existing) = resolved.iter_mut().find(|(k, _, _)| *k == key) {
            // 同物理文件重复候选：真实来源优先，升级为非兜底并丢弃 summary 推断重复项。
            if !is_fallback && existing.2 {
                existing.1 = path;
                existing.2 = false;
            }
            continue;
        }
        resolved.push((key, path, is_fallback));
    }
    resolved.into_iter().map(|(_, p, fb)| (p, fb)).collect()
}

/// 物理文件去重键：折叠 `.`/`..` 与空段、统一路径分隔符、Windows 下小写、去 `\\?\` 前缀。
/// 用于让「相对路径 / `.\` 前缀 / 绝对路径 / 大小写不同」等不同写法的候选判定为同一文件。
fn physical_key(p: &str) -> String {
    let (sep, norm) = if cfg!(windows) {
        ('\\', p.replace('/', "\\").to_lowercase())
    } else {
        ('/', p.replace('\\', "/"))
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in norm.split(sep) {
        match seg {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let mut s = parts.join(&sep.to_string());
    if let Some(stripped) = s.strip_prefix("\\\\?\\") {
        s = stripped.to_string();
    }
    s
}

/// 子任务成功闭环后登记其文件产物。
///
/// 返回登记成功的产物清单（供调用方写回 `SubTaskOutput.artifacts`）。
/// 任何单条产物登记失败都不影响其它产物（best-effort）。
///
/// 产物来源由 `sources` 提供（图/工具驱动的结构化事实），仅在无结构化来源时
/// 退化到 `summary` 文本推断（`candidate_paths`），命中即 `tracing::warn!`。
/// 登记前按「物理文件」去重（见 `resolve_artifact_entries`），消除幽灵产物重复登记。
pub async fn register_artifacts(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    task: &PlanSubTask,
    summary: &str,
    sources: &ArtifactSources<'_>,
) -> Vec<ArtifactRef> {
    let ws = cfg.workspace.clone().unwrap_or_default();

    // 候选路径按优先级合并：P0 工具真实写盘 > P1 success_criteria.target > P3 summary 文本推断（降级）。
    // 仅 summary 推断命中者 `is_fallback = true`（用于末尾 warn 幽灵产物风险）。
    let raw_candidates = merge_artifact_candidates(sources.changed_files, &sources.success_targets, summary);
    // 解析并按物理文件去重：真实来源优先，同文件只登记一次（消除幽灵产物重复登记，#2）。
    let resolved = resolve_artifact_entries(raw_candidates, &ws);

    let now = now_ms();
    let mut out: Vec<ArtifactRef> = Vec::new();
    let mut idx: u32 = 0;
    let mut had_summary_fallback = false;

    for (path, is_fallback) in resolved {
        let meta = std::fs::metadata(&path).expect("resolve_artifact_entries 仅返回已存在文件");
        if is_fallback {
            had_summary_fallback = true;
        }
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
        if had_summary_fallback {
            tracing::warn!(
                "[agent] artifacts: 步骤 {} 产物含仅由 summary 文本推断的候选（非工具真实写出），可能含幽灵产物",
                task.step,
            );
        }
        tracing::info!(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_prefers_changed_files_over_summary() {
        let changed = vec!["out.md".to_string()];
        let targets: Vec<String> = vec![];
        let summary = "我创建了 report.xlsx 和 out.md";
        let merged = merge_artifact_candidates(&changed, &targets, summary);

        // out.md 来自工具真实写出（changed_files），非兜底。
        let out_md = merged.iter().find(|(p, _)| p == "out.md");
        assert!(out_md.is_some(), "out.md 应出现在候选中");
        assert!(!out_md.unwrap().1, "out.md 应来自 changed_files，非 summary 兜底");

        // report.xlsx 仅由 summary 文本推断，应标 fallback。
        let report = merged.iter().find(|(p, _)| p == "report.xlsx");
        assert!(report.is_some(), "report.xlsx 应出现在候选中");
        assert!(report.unwrap().1, "report.xlsx 来自 summary，应标 fallback");
    }

    #[test]
    fn merge_summary_only_marks_fallback() {
        let changed: Vec<String> = vec![];
        let targets: Vec<String> = vec![];
        let summary = "例如 config.yaml 可以这样配置";
        let merged = merge_artifact_candidates(&changed, &targets, summary);
        let cfg = merged.iter().find(|(p, _)| p == "config.yaml");
        assert!(cfg.is_some(), "config.yaml 应被 summary 推断命中");
        assert!(cfg.unwrap().1, "纯 summary 推断应标 fallback（举例路径风险）");
    }

    #[test]
    fn merge_target_and_changed_dedup_no_fallback() {
        let changed = vec!["a.md".to_string()];
        let targets = vec!["a.md".to_string(), "b.json".to_string()];
        let merged = merge_artifact_candidates(&changed, &targets, "");
        for (p, fb) in &merged {
            if p == "a.md" || p == "b.json" {
                assert!(!*fb, "{} 来自结构化来源，不应标 fallback", p);
            }
        }
    }

    /// 不同写法的同一物理文件应映射到相同去重键（Windows 大小写不敏感、分隔符/`.`/`..` 折叠）。
    #[test]
    fn physical_key_unifies_same_file_spellings() {
        // 相对 vs 绝对、分隔符混合、`.`/`..` 折叠、Windows 大小写差异 → 同一键。
        assert_eq!(physical_key("src/A.md"), physical_key("src\\a.md"));
        assert_eq!(physical_key("./src/A.md"), physical_key("src/a.md"));
        assert_eq!(physical_key("src/./A.md"), physical_key("src/a.md"));
        assert_eq!(physical_key("src/b/../A.md"), physical_key("src/a.md"));
        assert_eq!(physical_key("src\\.\\A.md"), physical_key("src/a.md"));
    }

    /// 不同物理文件应映射到不同键（不应误合并）。
    #[test]
    fn physical_key_keeps_distinct_files() {
        assert_ne!(physical_key("src/a.md"), physical_key("src/b.md"));
        assert_ne!(physical_key("dir1/a.md"), physical_key("dir2/a.md"));
    }

    /// 复现 Q1 幽灵产物重复登记：工具真实写出的相对路径 + summary 里的绝对/前缀路径
    /// 指向同一文件，应只登记一次且以真实来源为准（不误报幽灵产物）。
    #[test]
    fn resolve_entries_real_beats_summary_same_file() {
        let (dir, file) = temp_workspace_with_file("decision.md");
        let abs = file.to_string_lossy().to_string();
        // summary 提到绝对路径写法；changed_files 为相对写法（与 ws 拼接后与 abs 物理等价）。
        let summary = format!("已生成决策记录 {abs}");
        let changed = vec!["decision.md".to_string()];
        let raw = merge_artifact_candidates(&changed, &[], &summary);
        let ws = dir.to_string_lossy().to_string();
        let resolved = resolve_artifact_entries(raw, &ws);
        assert_eq!(resolved.len(), 1, "同文件只应登记一次（消除幽灵重复登记）");
        assert!(!resolved[0].1, "真实来源优先，不应标 fallback（不误报幽灵产物）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 仅 summary 推断、确有其文件的候选：保留为 fallback（幽灵 WARN 仍合理）。
    #[test]
    fn resolve_entries_summary_only_keeps_fallback() {
        let (dir, file) = temp_workspace_with_file("report.xlsx");
        let abs = file.to_string_lossy().to_string();
        let summary = format!("例如 {abs} 可以这样配置");
        let raw = merge_artifact_candidates(&[], &[], &summary);
        let ws = dir.to_string_lossy().to_string();
        let resolved = resolve_artifact_entries(raw, &ws);
        assert_eq!(resolved.len(), 1, "确有文件的推断候选应保留");
        assert!(resolved[0].1, "纯 summary 推断应标 fallback（幽灵 WARN 合理）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 不存在的文件（summary 臆测但未产生）应被丢弃，不登记。
    #[test]
    fn resolve_entries_missing_file_dropped() {
        let dir = std::env::temp_dir().join(format!(
            "wd_art_test_{}_missing",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let summary = "我创建了 ghost.md 但没真写";
        let raw = merge_artifact_candidates(&[], &[], summary);
        let ws = dir.to_string_lossy().to_string();
        let resolved = resolve_artifact_entries(raw, &ws);
        assert!(resolved.is_empty(), "不存在的文件不应登记");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 并行安全：每个用例用唯一临时目录，避免 cargo 并行测试互相覆盖。
    fn temp_workspace_with_file(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("wd_art_test_{}_{}_{}", std::process::id(), n, name));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join(name);
        std::fs::write(&file, b"artifact-content").unwrap();
        (dir, file)
    }
}
