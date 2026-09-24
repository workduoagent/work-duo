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
//!  - `excel_row_count`：xlsx 行数 ≥ 阈值（**暂以「文件存在且非空」代理**，不引入 Excel 解析依赖）；
//!  - `stdout_contains` / `tool_output_contains`：工具**运行输出流**（如沙箱 stdout）包含指定片段（L1）。
//!    用于「运行结果须包含 X / stdout 须包含 X」这类**显式内容断言**——planner 不应再把流误生成成
//!    `text_contains` 指向一个名为 `stdout` 的**文件**，否则该校验永不命中、陷入恢复死循环。
//!  - `command_succeeded`：**运行类工具进程退出码为 0**（通用判定真相源）。与语言 / 框架 / 输出措辞 /
//!    emoji 完全无关（同 `cargo check` 退出 0 即通过的契约）；替代「去 stdout 文本里猜测试过没」的脆弱做法。
//!    本步未执行运行类工具（无退出码）时降级为通过，避免对破碎条件死循环；
//!    **降级项不计入客观证据**——含降级项的步骤聚合后标暂定（verified=false），不得打「已验证」。

use std::path::{Path, PathBuf};

use crate::agent::tools::RunOutcome;
use crate::agent::types::PlanSubTask;
use crate::agent::types::SuccessCriterion;

/// 校验结果。
pub struct VerificationResult {
    /// 是否全部通过。
    pub met: bool,
    /// 未通过项的明细（多个用「；」拼接），通过时为空。
    pub details: String,
    /// 是否具备客观可核验证据（Phase E 验证优先）：
    /// `true`=已验证（步骤声明了 success_criteria 且客观通过）；`false`=暂定（无 criteria 或仅模型自报）。
    pub verified: bool,
    /// 客观证据说明（首个客观通过项详情 / 暂定原因），供前端/回复展示。
    pub evidence: String,
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

/// 校验条件**结构性不完整**（缺 target/value 等必备字段，或类型未知）时，
/// 该条件本身无法被客观评估，不应据它判任务「未闭环」——否则恢复链路会对同一条
/// 破碎条件无限重跑（典型：`text_contains` 缺 `value`，重跑也补不上 value → 死循环）。
/// 处理原则：**仅当「条件不可评估」才降级**；条件完整但客观未命中仍返回 `false`（真实失败，重试有意义）。
/// 降级即按「以模型自报为准」视为通过，并打 warn 日志便于排查是 planner 生成了残缺条件。
///
/// ⚠️ 降级 ≠ 客观通过：降级项没有客观证据，聚合时必须把整步标为**暂定**（verified=false）。
/// 所有降级明细都以 [`DEGRADED_MARK`] 开头，聚合端据此识别（见 `verify_task`）。
fn degraded(check_type: &str, reason: &str) -> (bool, String) {
    tracing::warn!(
        "[agent] verifier: 校验条件不完整，降级为「以模型自报为准」（视为通过）：type={check_type} reason={reason}"
    );
    (
        true,
        format!("{DEGRADED_MARK}，已降级为以模型自报为准）{reason}"),
    )
}

/// 降级明细的统一标记前缀（含开括号，避免与正文撞词）。聚合端据此把含降级项的步骤标暂定。
const DEGRADED_MARK: &str = "（校验条件不完整";

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
///
/// `extra` 为「本步工具实际写出的文件」绝对路径（图驱动兜底源）：追加进候选集后，
/// 即便 planner 把 `target` 瞎填成占位名（如 `generated_code_content`），只要模型真写出了
/// 满足谓词的真实文件，仍可作为候选命中，避免客观校验被垃圾 target 恒判失败。
fn check_one(c: &SuccessCriterion, workspace: Option<&Path>, extra: &[PathBuf]) -> (bool, String) {
    let ct = c.check_type.to_lowercase();
    match ct.as_str() {
        "file_exists" => {
            let target = match &c.target {
                Some(t) => t,
                None => return degraded("file_exists", "缺 target"),
            };
            let mut cands = resolve_candidates(target, workspace);
            cands.extend(extra.iter().cloned());
            match first_hit(&cands, |m| m.is_file()) {
                Some(p) => (true, format!("文件应存在：{}", p.display())),
                None => (false, format!("文件应存在（任一）：{}", cands_disp(&cands))),
            }
        }
        "file_nonempty" => {
            let target = match &c.target {
                Some(t) => t,
                None => return degraded("file_nonempty", "缺 target"),
            };
            let mut cands = resolve_candidates(target, workspace);
            cands.extend(extra.iter().cloned());
            match first_hit(&cands, |m| m.is_file() && m.len() > 0) {
                Some(p) => (true, format!("文件应存在且非空：{}", p.display())),
                None => (false, format!("文件应存在且非空（任一）：{}", cands_disp(&cands))),
            }
        }
        "directory_exists" => {
            let target = match &c.target {
                Some(t) => t,
                None => return degraded("directory_exists", "缺 target"),
            };
            let mut cands = resolve_candidates(target, workspace);
            cands.extend(extra.iter().cloned());
            match first_hit(&cands, |m| m.is_dir()) {
                Some(p) => (true, format!("目录应存在：{}", p.display())),
                None => (false, format!("目录应存在（任一）：{}", cands_disp(&cands))),
            }
        }
        "json_valid" => {
            let target = match &c.target {
                Some(t) => t,
                None => return degraded("json_valid", "缺 target"),
            };
            let mut cands = resolve_candidates(target, workspace);
            cands.extend(extra.iter().cloned());
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
                None => return degraded("text_contains", "缺 target"),
            };
            let value = match &c.value {
                Some(v) => v,
                None => return degraded("text_contains", "缺 value"),
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
                return degraded("text_contains", &format!("value 为空：{value}"));
            }
            // 目标支持 `|` 多候选（与 value 容错对称）；任一候选命中即通过。
            let mut cands = resolve_candidates(target, workspace);
            cands.extend(extra.iter().cloned());
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
                None => return degraded("text_min_lines", "缺 target"),
            };
            let n = c.threshold.unwrap_or(1);
            let mut cands = resolve_candidates(target, workspace);
            cands.extend(extra.iter().cloned());
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
                None => return degraded("excel_row_count", "缺 target"),
            };
            let n = c.threshold.unwrap_or(1);
            let mut cands = resolve_candidates(target, workspace);
            cands.extend(extra.iter().cloned());
            match first_hit(&cands, |m| m.is_file() && m.len() > 0) {
                Some(p) => (true, format!("（Excel 行数≥{n} 暂以文件存在且非空代理）xlsx 应存在：{}", p.display())),
                None => (false, format!("（Excel 行数≥{n} 暂以文件存在且非空代理）xlsx 应存在（任一）：{}", cands_disp(&cands))),
            }
        }
        other => degraded(other, &format!("未知校验类型：{other}")),
    }
}

/// 通用「运行成功」判定：直接读运行类工具的退出码（进程退出码 0 = 运行成功）。
/// 与语言 / 框架 / 输出措辞 / emoji 完全无关（同 `cargo check` 退出 0 即通过的契约）。
///
/// 语义（与用户确认的「通用方式」一致）：
///  - 本步执行过运行类工具（run_outcomes 非空）且存在退出码为 0 的结果 → 通过；
///  - 存在非零退出码、且没有任何 0 → 未通过（命令确实失败）；
///  - 本步未执行任何运行类工具（无退出码信息）→ 条件无法被客观评估，降级为通过，
///    避免对破碎条件无限重试（与 `degraded` 一致）。
fn check_command_succeeded(run_outcomes: &[RunOutcome]) -> (bool, String) {
    if run_outcomes.is_empty() {
        return degraded(
            "command_succeeded",
            "本步未执行任何运行类工具（无退出码信息），降级为以模型自报为准",
        );
    }
    let codes: Vec<String> = run_outcomes
        .iter()
        .map(|o| match o.exit_code {
            Some(c) => c.to_string(),
            None => "无".to_string(),
        })
        .collect();
    if run_outcomes.iter().any(|o| o.exit_code == Some(0)) {
        (true, format!("运行命令退出码为 0（成功）：{:?}", codes))
    } else {
        (false, format!("运行命令退出码非 0（失败）：{:?}", codes))
    }
}

/// `tests_passed` 校验（P-5 真根因对策，2026-09-24）：解析运行类工具输出流中的
/// pytest 汇总行，要求「存在 ≥1 passed 且 failed==0 且 errors==0 且非 no tests ran」。
///
/// 动机（S-J6 三跑实测）：修复类任务用 `command_succeeded`（退出码 0）做验收时，
/// agent 写一个「验证缺陷存在」的检查脚本（退出码 0）即可闭环，无需改码——
/// 「脚本跑通」≠「缺陷已修复」。本类型把验收锚定在**测试全绿**上。
fn check_tests_passed(run_outcomes: &[RunOutcome]) -> (bool, String) {
    if run_outcomes.is_empty() {
        return degraded(
            "tests_passed",
            "本步未执行任何运行类工具（无 pytest 输出可解析），降级为以模型自报为准",
        );
    }
    // 从输出流提取 pytest 风格汇总计数：token 以 passed/failed/error/errors 结尾且前缀为整数。
    // pytest 汇总样例：「2 failed, 2 passed in 0.04s」「4 passed in 0.05s」「2 errors」。
    let counts = |text: &str| -> (usize, usize, usize) {
        let toks: Vec<&str> = text.split_whitespace().collect();
        // word 之前紧邻的整数即该计数（「2 failed」「4 passed」「1 error」「3 errors」）
        let get = |word: &str| -> usize {
            for (i, t) in toks.iter().enumerate() {
                let clean = t.trim_end_matches(|c: char| c == ',' || c == ':');
                if clean.eq_ignore_ascii_case(word) && i > 0 {
                    if let Ok(n) = toks[i - 1].trim().parse::<usize>() {
                        return n;
                    }
                }
            }
            0
        };
        (get("passed"), get("failed"), get("error").max(get("errors")))
    };
    let mut best: Option<(usize, String)> = None;
    let mut saw_pytest_output = false;
    for o in run_outcomes {
        let out = &o.output;
        let has_summary = out.contains("passed")
            || out.contains("failed")
            || out.contains(" error")
            || out.contains("errors")
            || out.contains("no tests ran");
        if !has_summary {
            continue;
        }
        saw_pytest_output = true;
        if out.contains("no tests ran") {
            continue;
        }
        let (p, f, e) = counts(out);
        let green = p >= 1 && f == 0 && e == 0;
        let label = format!("pytest 汇总 passed={} failed={} errors={}", p, f, e);
        if green {
            return (true, format!("测试全绿（{}）", label));
        }
        let entry = format!("{}（非全绿）", label);
        match &best {
            Some((_, s)) if s.contains("非全绿") => {}
            _ => best = Some((p, entry)),
        }
    }
    if !saw_pytest_output {
        return degraded(
            "tests_passed",
            "运行类工具输出流中未见 pytest 汇总（需在步骤内实际运行 pytest 且输出保留）",
        );
    }
    let detail = best.map(|(_, s)| s).unwrap_or_else(|| "输出流含 pytest 汇总但未解析出计数".to_string());
    (false, format!("tests_passed 未达标：{}", detail))
}

/// 校验「工具运行输出流」是否包含指定关键词（`stdout_contains` / `tool_output_contains`）。
///
/// 与文件类检查不同：本类判定针对**工具 stdout 文本**，不读任何文件，`target` 字段被忽略。
/// `value` 以 `|` 分隔多个候选关键词，任一命中即通过（语义包含即算过）——这是**显式内容契约**：
/// planner 应填「输出必须出现的具体文字」（如 `测试通过`），而非去猜运行是否成功。
/// 「运行是否成功」请用 `command_succeeded`（读退出码，通用、与措辞无关），不要塞进此处的 value。
/// 工具输出为空（本步未执行运行类工具，或输出被截断）时判未命中。
fn check_tool_output(c: &SuccessCriterion, output: &str) -> (bool, String) {
    let value = match &c.value {
        Some(v) if !v.trim().is_empty() => v,
        _ => {
            return degraded(
                "stdout_contains",
                "缺 value（期望在工具输出流中匹配的关键词，如「测试通过」）",
            )
        }
    };
    let keywords: Vec<&str> = value
        .split('|')
        .map(|x| x.trim())
        .filter(|x| !x.is_empty())
        .collect();
    if keywords.is_empty() {
        return degraded("stdout_contains", &format!("value 为空：{value}"));
    }
    if output.is_empty() {
        return (
            false,
            "本步无工具输出流可供匹配（未执行运行类工具，或输出为空/被截断）".to_string(),
        );
    }
    if keywords.iter().any(|kw| output.contains(kw)) {
        (true, format!("工具输出流包含「{}」之一", value))
    } else {
        (
            false,
            format!("工具输出流未包含「{}」之一", keywords.join(" / ")),
        )
    }
}

/// 对一个子任务的全部 `success_criteria` 做确定性校验，汇总结果。
///
/// 两阶段（图驱动）：
///  1) 仅按 planner 声明的 `target` 客观校验（保持原语义——用户显式路径命中即过）。
///  2) 若某条件 planner target 未命中，则兜底核验 `actual_written`（本步 write_file/edit_file
///     实际落盘的真实文件）；任一真实文件满足谓词即通过，避免 planner 把 target 填成占位名
///     （如 `generated_code_content`）导致客观校验恒判未闭环、误弹恢复窗。
///
/// 流类判定（`stdout_contains` / `tool_output_contains`）单独走 `check_tool_output`，
/// 直接对本步运行输出聚合文本做包含匹配，彻底绕开文件系统。
/// 运行成功通用判定（`command_succeeded`）走 `check_command_succeeded`，直接读退出码。
#[tracing::instrument(skip_all)]
pub fn verify_task(
    task: &PlanSubTask,
    workspace: Option<&Path>,
    actual_written: &[PathBuf],
    run_outcomes: &[RunOutcome],
) -> VerificationResult {
    if task.success_criteria.is_empty() {
        return VerificationResult {
            met: true,
            details: String::new(),
            verified: false,
            evidence: "步骤未声明 success_criteria，无客观依据，以模型自报为准".to_string(),
        };
    }
    // 工具运行输出流聚合文本：供 stdout_contains / tool_output_contains 精确子串匹配。
    let joined_output = run_outcomes
        .iter()
        .map(|o| o.output.as_str())
        .collect::<Vec<&str>>()
        .join("\n");
    let mut failed: Vec<String> = Vec::new();
    // 降级追踪：凡有条件是「降级视为通过」（而非客观命中），整步不能标已验证，
    // 必须回落到暂定（verified=false）——降级 = 无客观证据，与「无 criteria」同权。
    let mut degraded_notes: Vec<String> = Vec::new();
    // 通过明细（evidence 可回放：列出每条命中的 criteria 与实测值，替代模板话术）。
    let mut passed_notes: Vec<String> = Vec::new();
    for c in &task.success_criteria {
        let ct = c.check_type.to_lowercase();
        // 运行成功通用判定：直接读退出码，与输出措辞 / 语言 / emoji 无关（同 cargo check 契约）。
        if ct == "command_succeeded" {
            let (ok, detail) = check_command_succeeded(run_outcomes);
            if ok {
                if detail.contains(DEGRADED_MARK) {
                    degraded_notes.push(detail);
                } else {
                    passed_notes.push(format!("[command_succeeded] {detail}"));
                }
                continue;
            }
            failed.push(detail);
            continue;
        }
        // tests_passed（P-5 真根因对策，2026-09-24）：解析 pytest 汇总，锚定「测试全绿」。
        // 修复类任务用本类型替代 command_succeeded——「脚本跑通」≠「缺陷已修复」。
        if ct == "tests_passed" {
            let (ok, detail) = check_tests_passed(run_outcomes);
            if ok {
                if detail.contains(DEGRADED_MARK) {
                    degraded_notes.push(detail);
                } else {
                    passed_notes.push(format!("[tests_passed] {detail}"));
                }
                continue;
            }
            failed.push(detail);
            continue;
        }
        // 流类判定：直接对工具输出流做包含匹配，不读文件、不进两阶段文件兜底。
        if ct == "stdout_contains" || ct == "tool_output_contains" {
            let (ok, detail) = check_tool_output(c, &joined_output);
            if ok {
                if detail.contains(DEGRADED_MARK) {
                    degraded_notes.push(detail);
                } else {
                    passed_notes.push(format!("[{ct}] {detail}"));
                }
                continue;
            }
            failed.push(detail);
            continue;
        }
        // 第一阶段：仅 planner 声明的 target。
        let (planner_ok, planner_detail) = check_one(c, workspace, &[]);
        if planner_ok {
            if planner_detail.contains(DEGRADED_MARK) {
                degraded_notes.push(planner_detail);
            } else {
                passed_notes.push(format!("[{ct}] {planner_detail}"));
            }
            continue;
        }
        // 第二阶段：planner target 未命中 → 兜底核验工具实际写出的真实文件。
        let (real_ok, real_detail) = check_one(c, workspace, actual_written);
        if real_ok {
            if real_detail.contains(DEGRADED_MARK) {
                degraded_notes.push(real_detail);
            } else {
                passed_notes.push(format!("[{ct}] {real_detail}（以工具实际写出文件核验）"));
                tracing::info!(
                    "[agent] verifier: 计划 target 未命中，但以工具实际写出的文件通过 step 校验：{}",
                    real_detail
                );
            }
            continue;
        }
        failed.push(planner_detail);
    }
    if failed.is_empty() {
        if degraded_notes.is_empty() {
            VerificationResult {
                met: true,
                details: String::new(),
                verified: true,
                evidence: format!(
                    "客观校验通过 {} 项：{}",
                    passed_notes.len(),
                    passed_notes.join("；")
                ),
            }
        } else {
            VerificationResult {
                met: true,
                details: String::new(),
                verified: false,
                evidence: format!(
                    "步骤声明了 success_criteria，但存在不可评估条件（降级为以模型自报为准），无完整客观证据，暂定：{}",
                    degraded_notes.join("；")
                ),
            }
        }
    } else {
        VerificationResult {
            met: false,
            details: failed.join("；"),
            verified: false,
            evidence: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::RunOutcome;
    use crate::agent::types::{PlanSubTask, SuccessCriterion};

    /// 方案 A 确定性验证（Q8）：planner 把 `success_criteria.target` 填成垃圾占位名
    /// `generated_code_content`，但工具实际写出了真实文件——两阶段校验的 fallback 必须以
    /// 真实写出文件通过，不能恒判未闭环。此测试不依赖小模型随机性，确定性证明 fallback 生效。
    #[test]
    fn verify_task_fallback_on_actual_written_when_planner_target_garbage() {
        let dir = std::env::temp_dir().join("workduo_verifier_test");
        let _ = std::fs::create_dir_all(&dir);
        let real = dir.join("Profile.tsx");
        std::fs::write(&real, "export default function Profile() { return null; }")
            .expect("写测试文件");

        let task = PlanSubTask {
            step: 1,
            task_id: "t1".into(),
            title: "生成 React 组件".into(),
            description: String::new(),
            success_criteria: vec![SuccessCriterion {
                check_type: "file_nonempty".into(),
                target: Some("generated_code_content".into()), // 垃圾占位名（复现 Q8）
                value: None,
                threshold: None,
            }],
            depends_on: vec![],
        };

        // 第一阶段（仅 planner target）必然失败；第二阶段 fallback 用实际写出文件。
        let actual: Vec<PathBuf> = vec![real.clone()];
        let result = verify_task(&task, None, &actual, &[]);
        assert!(
            result.met,
            "fallback 应接住工具实际写出的真实文件：{}",
            result.details
        );

        let _ = std::fs::remove_file(&real);
        let _ = std::fs::remove_dir(&dir);
    }

    /// 反向保证：planner target 正确（无垃圾）且实际文件缺失时，仍应判未闭环（不能误过）。
    #[test]
    fn verify_task_planner_target_correct_but_missing_still_fails() {
        let task = PlanSubTask {
            step: 1,
            task_id: "t1".into(),
            title: "生成文件".into(),
            description: String::new(),
            success_criteria: vec![SuccessCriterion {
                check_type: "file_nonempty".into(),
                target: Some("src/views/DoesNotExist.tsx".into()),
                value: None,
                threshold: None,
            }],
            depends_on: vec![],
        };
        let result = verify_task(&task, None, &[], &[]);
        assert!(!result.met, "真实缺失时应判未闭环");
    }

    /// 流类判定：stdout_contains 直接对工具输出流做包含匹配，不读文件。
    /// 这是修复「planner 把『输出须包含 X』误生成 text_contains 指向文件 stdout』导致恢复死循环」的根因验证。
    #[test]
    fn verify_task_stdout_contains_checks_tool_output_not_file() {
        let task = PlanSubTask {
            step: 3,
            task_id: "t3".into(),
            title: "运行测试脚本并查看结果".into(),
            description: String::new(),
            success_criteria: vec![SuccessCriterion {
                check_type: "stdout_contains".into(),
                target: None, // 流类判定忽略 target
                value: Some("Ran 1 test".into()),
                threshold: None,
            }],
            depends_on: vec![],
        };
        // 工具输出流命中 → 判通过（即便没有任何落盘文件，也不应误弹恢复窗）。
        let out_ok = vec![RunOutcome {
            output: "...\nRan 1 test in 0.001s\nOK\n".into(),
            exit_code: None,
        }];
        let r1 = verify_task(&task, None, &[], &out_ok);
        assert!(r1.met, "工具输出含 'Ran 1 test' 应判通过：{}", r1.details);

        // 输出流为空 → 判未闭环。
        let r2 = verify_task(&task, None, &[], &[]);
        assert!(!r2.met, "无工具输出流时应判未闭环");

        // 输出流不含关键词 → 判未闭环。
        let out_miss = vec![RunOutcome {
            output: "Traceback (most recent call last): ...".into(),
            exit_code: None,
        }];
        let r3 = verify_task(&task, None, &[], &out_miss);
        assert!(!r3.met, "输出不含关键词时应判未闭环");

        // value 缺失 → 结构性不完整，降级为通过（避免对破碎条件死循环）。
        let task_no_value = PlanSubTask {
            step: 3,
            task_id: "t3".into(),
            title: "运行测试".into(),
            description: String::new(),
            success_criteria: vec![SuccessCriterion {
                check_type: "stdout_contains".into(),
                target: None,
                value: None,
                threshold: None,
            }],
            depends_on: vec![],
        };
        let r4 = verify_task(&task_no_value, None, &[], &[]);
        assert!(r4.met, "stdout_contains 缺 value 应降级通过");
        assert!(!r4.verified, "降级通过无客观证据，必须标暂定");
    }

    /// 通用运行成功判定：退出码 0 即通过，与输出措辞 / 语言 / emoji 完全无关。
    /// 覆盖英文 OK、中文「测试✅通过」、纯计数「PASSED 4/4」等任意输出形式——均零改动判对，
    /// 不再依赖任何关键词补丁（修复「去 stdout 文本里猜测试过没」的无底洞式打补丁）。
    #[test]
    fn verify_task_command_succeeded_passes_on_exit_zero_any_output() {
        let task = PlanSubTask {
            step: 3,
            task_id: "t3".into(),
            title: "运行测试脚本".into(),
            description: String::new(),
            success_criteria: vec![SuccessCriterion {
                check_type: "command_succeeded".into(),
                target: None,
                value: None,
                threshold: None,
            }],
            depends_on: vec![],
        };
        // 英文 unittest 输出，exit 0 → 通过。
        let r1 = verify_task(
            &task,
            None,
            &[],
            &[RunOutcome {
                output: "Ran 1 test in 0.001s\nOK\n".into(),
                exit_code: Some(0),
            }],
        );
        assert!(r1.met, "exit 0 应判通过：{}", r1.details);
        // 中文 + emoji 输出「测试✅通过」，exit 0 → 通过（不读文本）。
        let r2 = verify_task(
            &task,
            None,
            &[],
            &[RunOutcome {
                output: "运行结果：\n测试✅通过\n".into(),
                exit_code: Some(0),
            }],
        );
        assert!(r2.met, "中文 / emoji 输出 exit 0 应判通过：{}", r2.details);
        // 纯计数输出「PASSED 4/4」，exit 0 → 通过。
        let r3 = verify_task(
            &task,
            None,
            &[],
            &[RunOutcome {
                output: "PASSED 4/4\n".into(),
                exit_code: Some(0),
            }],
        );
        assert!(r3.met, "PASSED 4/4 exit 0 应判通过：{}", r3.details);
    }

    /// 反例：运行类工具退出码非 0 → 判未闭环（不因输出文本里恰好有「通过」字样而误过）。
    #[test]
    fn verify_task_command_succeeded_fails_on_nonzero_exit() {
        let task = PlanSubTask {
            step: 3,
            task_id: "t3".into(),
            title: "运行测试脚本".into(),
            description: String::new(),
            success_criteria: vec![SuccessCriterion {
                check_type: "command_succeeded".into(),
                target: None,
                value: None,
                threshold: None,
            }],
            depends_on: vec![],
        };
        // 输出含「测试通过」字样但 exit 1 → 应判未闭环。
        let r1 = verify_task(
            &task,
            None,
            &[],
            &[RunOutcome {
                output: "测试未通过（1/4）\n".into(),
                exit_code: Some(1),
            }],
        );
        assert!(!r1.met, "exit 非0 应判未闭环：{}", r1.details);
        // 英文 unittest FAILED，exit 1 → 应判未闭环。
        let r2 = verify_task(
            &task,
            None,
            &[],
            &[RunOutcome {
                output: "Ran 1 test in 0.001s\nFAILED (failures=1)\n".into(),
                exit_code: Some(1),
            }],
        );
        assert!(!r2.met, "FAILED exit 非0 应判未闭环：{}", r2.details);
    }

    /// 本步未执行任何运行类工具（无退出码）→ 条件无法客观评估，降级为通过（避免死循环）；
    /// 但降级 = 无客观证据，整步必须标暂定（verified=false），不得打「已验证」角标。
    #[test]
    fn verify_task_command_succeeded_degrades_without_run() {
        let task = PlanSubTask {
            step: 3,
            task_id: "t3".into(),
            title: "运行测试脚本".into(),
            description: String::new(),
            success_criteria: vec![SuccessCriterion {
                check_type: "command_succeeded".into(),
                target: None,
                value: None,
                threshold: None,
            }],
            depends_on: vec![],
        };
        let r = verify_task(&task, None, &[], &[]);
        assert!(r.met, "无运行工具应降级通过");
        assert!(!r.verified, "降级通过无客观证据，必须标暂定 verified=false");
        assert!(
            r.evidence.contains("降级"),
            "暂定 evidence 需说明降级原因：{}",
            r.evidence
        );
    }

    /// 混合场景：一条条件客观通过 + 一条条件降级通过 → 整步证据不完整，仍须标暂定。
    #[test]
    fn verify_task_mixed_objective_and_degraded_is_provisional() {
        let dir = std::env::temp_dir().join("workduo_verifier_mixed");
        let _ = std::fs::create_dir_all(&dir);
        let real = dir.join("a.txt");
        std::fs::write(&real, "content").expect("写测试文件");

        let task = PlanSubTask {
            step: 1,
            task_id: "t1".into(),
            title: "生成文件并运行".into(),
            description: String::new(),
            success_criteria: vec![
                SuccessCriterion {
                    check_type: "file_nonempty".into(),
                    target: Some(real.to_string_lossy().into()),
                    value: None,
                    threshold: None,
                },
                SuccessCriterion {
                    check_type: "command_succeeded".into(), // 未运行任何命令 → 降级
                    target: None,
                    value: None,
                    threshold: None,
                },
            ],
            depends_on: vec![],
        };
        let r = verify_task(&task, None, &[], &[]);
        assert!(r.met, "全部条件视为通过：{}", r.details);
        assert!(
            !r.verified,
            "含降级项时整步不得标已验证：{}",
            r.evidence
        );
        let _ = std::fs::remove_file(&real);
        let _ = std::fs::remove_dir(&dir);
    }

    /// Phase E：无 success_criteria 的步骤闭环应标 Provisional（verified=false）。
    #[test]
    fn verify_task_provisional_when_no_criteria() {
        let task = PlanSubTask {
            step: 2,
            task_id: "t2".into(),
            title: "总结需求要点".into(),
            description: String::new(),
            success_criteria: vec![], // 纯对话/总结类，无客观校验
            depends_on: vec![],
        };
        let r = verify_task(&task, None, &[], &[]);
        assert!(r.met, "无 criteria 应视为通过（以模型自报为准）");
        assert!(!r.verified, "无 criteria 必须标暂定 verified=false");
        assert!(
            r.evidence.contains("无客观依据"),
            "暂定需带原因说明：{}",
            r.evidence
        );
    }

    /// Phase E：声明了 success_criteria 且客观通过 → 标已验证（verified=true）。
    #[test]
    fn verify_task_verified_on_objective_pass() {
        let dir = std::env::temp_dir().join("workduo_verifier_evidence");
        let _ = std::fs::create_dir_all(&dir);
        let real = dir.join("calc.py");
        std::fs::write(&real, "def add(a, b):\n    return a + b\n").expect("写测试文件");

        let task = PlanSubTask {
            step: 1,
            task_id: "t1".into(),
            title: "生成 calc.py".into(),
            description: String::new(),
            success_criteria: vec![SuccessCriterion {
                check_type: "file_nonempty".into(),
                target: Some(real.to_string_lossy().into()),
                value: None,
                threshold: None,
            }],
            depends_on: vec![],
        };
        let r = verify_task(&task, None, &[], &[]);
        assert!(r.met, "文件存在应判通过");
        assert!(
            r.verified,
            "有 criteria 且客观通过应标已验证 verified=true"
        );
        assert!(
            r.evidence.contains("客观校验"),
            "已验证需带证据说明：{}",
            r.evidence
        );
        let _ = std::fs::remove_file(&real);
        let _ = std::fs::remove_dir(&dir);
    }
}
