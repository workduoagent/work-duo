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

/// 执行单条判定标准，返回 (是否通过, 人类可读说明)。
fn check_one(c: &SuccessCriterion, workspace: Option<&Path>) -> (bool, String) {
    let ct = c.check_type.to_lowercase();
    match ct.as_str() {
        "file_exists" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "file_exists 缺 target".into()),
            };
            let p = resolve_path(target, workspace);
            let ok = p.metadata().map(|m| m.is_file()).unwrap_or(false);
            (ok, format!("文件应存在：{}", p.display()))
        }
        "file_nonempty" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "file_nonempty 缺 target".into()),
            };
            let p = resolve_path(target, workspace);
            let ok = p
                .metadata()
                .map(|m| m.is_file() && m.len() > 0)
                .unwrap_or(false);
            (ok, format!("文件应存在且非空：{}", p.display()))
        }
        "directory_exists" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "directory_exists 缺 target".into()),
            };
            let p = resolve_path(target, workspace);
            let ok = p.metadata().map(|m| m.is_dir()).unwrap_or(false);
            (ok, format!("目录应存在：{}", p.display()))
        }
        "json_valid" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "json_valid 缺 target".into()),
            };
            let p = resolve_path(target, workspace);
            match std::fs::read_to_string(&p) {
                Ok(s) => {
                    let ok = serde_json::from_str::<serde_json::Value>(&s).is_ok();
                    (ok, format!("JSON 应可解析：{}", p.display()))
                }
                Err(e) => (false, format!("读取失败 {}：{}", p.display(), e)),
            }
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
            let p = resolve_path(target, workspace);
            match std::fs::read_to_string(&p) {
                Ok(s) => {
                    // 多关键词容错：value 以 `|` 分隔多个候选措辞，任一命中即通过
                    // （语义包含即算过）。例如 `风险提示|主要风险|风险` 可避免被散文措辞卡死。
                    // 单一关键词（无 `|`）时退化为精确子串匹配，完全向后兼容。
                    let candidates: Vec<&str> = value
                        .split('|')
                        .map(|x| x.trim())
                        .filter(|x| !x.is_empty())
                        .collect();
                    if candidates.is_empty() {
                        (false, format!("text_contains 的 value 为空：{value}"))
                    } else if candidates.iter().any(|kw| s.contains(kw)) {
                        (true, format!("文件 {} 内容包含「{}」之一", p.display(), value))
                    } else {
                        (
                            false,
                            format!(
                                "文件 {} 应包含「{}」之一（实际未命中任一关键词）",
                                p.display(),
                                candidates.join(" / ")
                            ),
                        )
                    }
                }
                Err(e) => (false, format!("读取失败 {}：{}", p.display(), e)),
            }
        }
        "text_min_lines" => {
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "text_min_lines 缺 target".into()),
            };
            let n = c.threshold.unwrap_or(1);
            let p = resolve_path(target, workspace);
            match std::fs::read_to_string(&p) {
                Ok(s) => {
                    let lines = s.lines().count();
                    let ok = lines >= n;
                    (ok, format!("文件 {} 行数应 ≥ {}（实际 {}）", p.display(), n, lines))
                }
                Err(e) => (false, format!("读取失败 {}：{}", p.display(), e)),
            }
        }
        "excel_row_count" => {
            // 暂以「文件存在且非空」代理（不引入 Excel 解析依赖）。
            let target = match &c.target {
                Some(t) => t,
                None => return (false, "excel_row_count 缺 target".into()),
            };
            let n = c.threshold.unwrap_or(1);
            let p = resolve_path(target, workspace);
            let meta = p.metadata();
            let ok = meta.map(|m| m.is_file() && m.len() > 0).unwrap_or(false);
            (
                ok,
                format!("（Excel 行数≥{n} 暂以文件存在且非空代理）xlsx 应存在：{}", p.display()),
            )
        }
        other => (false, format!("未知校验类型：{other}")),
    }
}

/// 对一个子任务的全部 `success_criteria` 做确定性校验，汇总结果。
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
