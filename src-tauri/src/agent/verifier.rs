//! 子任务成功判定（Phase 2 #9 · Verifier L0/L1）。
//!
//! 不碰 LLM Verifier：仅做**确定性、可由文件/内容客观核验**的检查（L0 存在性 /
//! L1 内容正确性），由 Rust 在子任务终态即时执行。模型即便自报成功，只要
//! `success_criteria` 未通过即判未闭环，进入恢复链路（重试 / 跳过 / 接管）。
//!
//! 校验类型（与 `SuccessCriterion.check_type` 对应）：
//!  - `file_exists` / `file_nonempty` / `directory_exists`：文件系统存在性（L0）；
//!  - `json_valid`：JSON 可解析（L1）；
//!  - `text_contains`：文件内容包含指定片段（L1）；
//!  - `text_min_lines`：文件行数 ≥ 阈值（L1）；
//!  - `excel_row_count`：xlsx 行数 ≥ 阈值（**暂以「文件存在且非空」代理**，不引入 Excel 解析依赖）。

use std::path::{Path, PathBuf};

use crate::agent::types::PlanSubTask;
use crate::agent::types::SuccessCriterion;

/// 校验结果。
pub struct VerificationResult {
    /// 是否全部通过。
    pub met: bool,
    /// 未通过项的明细（多个用「；」拼接），通过时为空。
    pub details: String,
}

/// 把（可能相对的）目标路径解析为绝对路径：绝对路径原样保留，相对路径以工作空间为基准。
fn resolve_path(target: &str, workspace: Option<&Path>) -> PathBuf {
    let p = Path::new(target.trim());
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match workspace {
        Some(ws) => ws.join(p),
        None => p.to_path_buf(),
    }
}

/// 把 target 按 `|` 拆成多个候选路径（与 `text_contains` 的 value 容错对称）。
/// 单一路径（无 `|`）时退化为单元素向量，完全向后兼容。
fn resolve_candidates(target: &str, workspace: Option<&Path>) -> Vec<PathBuf> {
    target
        .split('|')
        .map(|x| resolve_path(x.trim(), workspace))
        .collect()
}

/// 在候选中找第一个满足谓词的文件/目录；找不到返回 None。
fn first_hit<F>(cands: &[PathBuf], pred: F) -> Option<PathBuf>
where
    F: Fn(&std::fs::Metadata) -> bool,
{
    cands
        .iter()
        .find(|p| p.metadata().map(|m| pred(&m)).unwrap_or(false))
        .cloned()
}

/// 候选路径的人类可读拼接（用于失败明细）。
fn cands_disp(cands: &[PathBuf]) -> String {
    cands
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(" | ")
}

/// 读取文件用于校验：先确认「存在性 + 是否目录」，再读内容。
/// 把裸 `os error 2/3/5` 翻译成清晰中文，落实「先看文件有没有，你不能上来就读」的闭环要求。
fn read_text_for_verify(p: &Path) -> Result<String, String> {
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => Err(format!(
            "目标是目录而非文件：{}（目录无法按文本读取，请指定具体文件或改用 directory_exists）",
            p.display()
        )),
        Ok(_) => std::fs::read_to_string(p)
            .map_err(|e| format!("读取失败 {}：{}", p.display(), e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(format!(
            "文件不存在：{}（请确认路径，或先用 native__write_file 创建该文件）",
            p.display()
        )),
        Err(e) => Err(format!("读取失败 {}：{}", p.display(), e)),
    }
}

/// 递归遍历目录，任一文件内容命中任一关键词即通过（用于 `text_contains` 目标是目录的场景）。
/// 跳过 >4MB 的文件避免误吞巨型产物；读取失败的文件静默跳过（不阻塞其他文件命中）。
fn grep_dir(dir: &Path, keywords: &[&str]) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let meta = entry.metadata()?;
        if meta.is_dir() {
            if grep_dir(&path, keywords)? {
                return Ok(true);
            }
        } else if meta.is_file() && meta.len() <= 4 * 1024 * 1024 {
            if let Ok(s) = std::fs::read_to_string(&path) {
                if keywords.iter().any(|kw| s.contains(kw)) {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

/// 执行单条判定标准，返回 (是否通过, 人类可读说明)。
fn check_one(c: &SuccessCriterion, workspace: Option<&Path>) -> (bool, String) {
    let ct = c.check_type.to_lowercase();
    match ct.as_str() {
        "file_exists" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "file_exists 缺 target".into()),
            };
            let cands = resolve_candidates(target, workspace);
            match first_hit(&cands, |m| m.is_file()) {
                Some(p) => (true, format!("文件应存在：{}", p.display())),
                None => (false, format!("文件应存在（任一）：{}", cands_disp(&cands))),
            }
        }
        "file_nonempty" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "file_nonempty 缺 target".into()),
            };
            let cands = resolve_candidates(target, workspace);
            match first_hit(&cands, |m| m.is_file() && m.len() > 0) {
                Some(p) => (true, format!("文件应存在且非空：{}", p.display())),
                None => (false, format!("文件应存在且非空（任一）：{}", cands_disp(&cands))),
            }
        }
        "directory_exists" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "directory_exists 缺 target".into()),
            };
            let cands = resolve_candidates(target, workspace);
            match first_hit(&cands, |m| m.is_dir()) {
                Some(p) => (true, format!("目录应存在：{}", p.display())),
                None => (false, format!("目录应存在（任一）：{}", cands_disp(&cands))),
            }
        }
        "json_valid" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "json_valid 缺 target".into()),
            };
            let cands = resolve_candidates(target, workspace);
            // 任一候选可读且 JSON 可解析即通过（与文件类分支的「任一命中」对称）。
            let mut last_err = String::new();
            for p in &cands {
                match read_text_for_verify(p) {
                    Ok(s) if serde_json::from_str::<serde_json::Value>(&s).is_ok() => {
                        return (true, format!("JSON 应可解析：{}", p.display()));
                    }
                    Ok(_) => last_err = format!("JSON 解析失败：{}", p.display()),
                    Err(msg) => last_err = msg,
                }
            }
            (
                false,
                if last_err.is_empty() {
                    format!("JSON 应可解析（任一）：{}", cands_disp(&cands))
                } else {
                    last_err
                },
            )
        }
        "text_contains" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "text_contains 缺 target".into()),
            };
            let value = match &c.value {
                Some(v) => v,
                None => return (false, "text_contains 缺 value".into()),
            };
            // 多关键词容错：value 以 `|` 分隔多个候选措辞，任一命中即通过
            // （语义包含即算过）。例如 `风险提示|主要风险|风险` 可避免被散文措辞卡死。
            // 单一关键词（无 `|`）时退化为精确子串匹配，完全向后兼容。
            let keywords: Vec<&str> = value
                .split('|')
                .map(|x| x.trim())
                .filter(|x| !x.is_empty())
                .collect();
            if keywords.is_empty() {
                return (false, format!("text_contains 的 value 为空：{value}"));
            }
            // 目标支持 `|` 多候选（与 value 容错对称）；任一候选命中即通过。
            let cands = resolve_candidates(target, workspace);
            let mut last_err = String::new();
            for p in &cands {
                // 目标是目录：递归遍历各文件内容，任一文件命中即通过（闭环校验，不把目录当文件读）。
                if let Ok(m) = std::fs::metadata(p) {
                    if m.is_dir() {
                        match grep_dir(p, &keywords) {
                            Ok(true) => {
                                return (
                                    true,
                                    format!(
                                        "目录 {} 下存在文件内容包含「{}」之一",
                                        p.display(),
                                        value
                                    ),
                                )
                            }
                            Ok(false) => {
                                last_err = format!(
                                    "目录 {} 下所有文件均未包含「{}」之一",
                                    p.display(),
                                    keywords.join(" / ")
                                );
                                continue;
                            }
                            Err(e) => {
                                last_err = format!("遍历目录失败 {}：{}", p.display(), e);
                                continue;
                            }
                        }
                    }
                }
                // 目标是文件（或不存在）：读取后做子串匹配。
                match read_text_for_verify(p) {
                    Ok(s) => {
                        if keywords.iter().any(|kw| s.contains(kw)) {
                            return (
                                true,
                                format!("文件 {} 内容包含「{}」之一", p.display(), value),
                            );
                        } else {
                            last_err = format!(
                                "文件 {} 应包含「{}」之一（实际未命中任一关键词）",
                                p.display(),
                                keywords.join(" / ")
                            );
                        }
                    }
                    Err(msg) => last_err = msg,
                }
            }
            (
                false,
                if last_err.is_empty() {
                    format!("text_contains 目标（任一）：{}", cands_disp(&cands))
                } else {
                    last_err
                },
            )
        }
        "text_min_lines" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "text_min_lines 缺 target".into()),
            };
            let n = c.threshold.unwrap_or(1);
            let cands = resolve_candidates(target, workspace);
            let mut last_err = String::new();
            for p in &cands {
                match read_text_for_verify(p) {
                    Ok(s) => {
                        let lines = s.lines().count();
                        let ok = lines >= n;
                        if ok {
                            return (true, format!("文件 {} 行数应 ≥ {}（实际 {}）", p.display(), n, lines));
                        } else {
                            last_err = format!("文件 {} 行数应 ≥ {}（实际 {}）", p.display(), n, lines);
                        }
                    }
                    Err(msg) => last_err = msg,
                }
            }
            (
                false,
                if last_err.is_empty() {
                    format!("text_min_lines 目标（任一）：{}", cands_disp(&cands))
                } else {
                    last_err
                },
            )
        }
        "excel_row_count" => {
            // 暂以「文件存在且非空」代理（不引入 Excel 解析依赖）。
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "excel_row_count 缺 target".into()),
            };
            let n = c.threshold.unwrap_or(1);
            let cands = resolve_candidates(target, workspace);
            match first_hit(&cands, |m| m.is_file() && m.len() > 0) {
                Some(p) => (true, format!("（Excel 行数≥{n} 暂以文件存在且非空代理）xlsx 应存在：{}", p.display())),
                None => (false, format!("（Excel 行数≥{n} 暂以文件存在且非空代理）xlsx 应存在（任一）：{}", cands_disp(&cands))),
            }
        }
        other => (false, format!("未知校验类型：{other}")),
    }
}

/// 对一个子任务的全部 `success_criteria` 做确定性校验，汇总结果。
#[tracing::instrument(skip_all)]
pub fn verify_task(task: &PlanSubTask, workspace: Option<&Path>) -> VerificationResult {
    if task.success_criteria.is_empty() {
        return VerificationResult {
            met: true,
            details: String::new(),
        };
    }
    let mut failed: Vec<String> = Vec::new();
    for c in &task.success_criteria {
        let (ok, detail) = check_one(c, workspace);
        if !ok {
            failed.push(detail);
        }
    }
    if failed.is_empty() {
        VerificationResult {
            met: true,
            details: String::new(),
        }
    } else {
        VerificationResult {
            met: false,
            details: failed.join("；"),
        }
    }
}
