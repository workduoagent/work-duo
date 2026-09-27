//! 任务交付包导出（台账 D4 第三步）。
//!
//! 把一次已完成 run 的轨迹、产物、知识库引用、审批链与成本归档为
//! 用户选定目录下的自包含交付包：
//!   `交付包-<run_id 前 8 位>-<finished_at epochMs>/`
//!     - `manifest.json`    运行元信息（run/agent/session/时间/成本/计数/文件清单）
//!     - `trajectory.json`  全事件流（pretty JSON，与 agent_get_run_trace 同源）
//!     - `approvals.json`   审批链（事件流中的审批请求原样导出；决策未事件化，口径见注）
//!     - `sources.json`     知识库引用（匹配轮次 segments 的 kb-sources 段）
//!     - `report.md`        人类可读交付报告（目标/工具/产物/成本/审批/引用/最终回复）
//!     - `artifacts/`       事件流登记的产物文件拷贝（缺失项记入 manifest.missingArtifacts）
//!
//! 数据底座：`agent_run_trace`（events.rs 终态落盘）+ `agent_conversation_round`（首问与
//! kb-sources）+ `agent_conversation_session`（会话名/agent_code）。
//! 审批「决策」当前不落事件流（init.sql 无 agent 审批决策表），v1 只导出请求侧并明示口径。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 从事件流中提取的 run 事实（纯函数，单测覆盖）。
#[derive(Debug, Default, PartialEq)]
pub(crate) struct RunFacts {
    /// 产物绝对路径（去重、保持出现顺序，来自 agent-artifact-created 事件）。
    pub artifact_paths: Vec<String>,
    /// 审批请求事件的原样 payload（agent-awaiting-approval）。
    pub approvals: Vec<Value>,
    /// 工具调用名序列（agent-event 且 type=tool_started，按出现顺序）。
    pub tool_names: Vec<String>,
}

/// 事件流提取（台账 D4）：事件条目形如 `{event, payload, ts_ms}`（events.rs 桶形状）。
pub(crate) fn extract_run_facts(events: &Value) -> RunFacts {
    let mut facts = RunFacts::default();
    let Some(arr) = events.as_array() else {
        return facts;
    };
    for e in arr {
        let event = e.get("event").and_then(|x| x.as_str()).unwrap_or("");
        let payload = e.get("payload").cloned().unwrap_or(Value::Null);
        match event {
            "agent-artifact-created" => {
                if let Some(list) = payload.get("artifacts").and_then(|x| x.as_array()) {
                    for a in list {
                        if let Some(p) = a.get("path").and_then(|x| x.as_str()) {
                            if !p.is_empty() && !facts.artifact_paths.iter().any(|x| x == p) {
                                facts.artifact_paths.push(p.to_string());
                            }
                        }
                    }
                }
            }
            "agent-awaiting-approval" => facts.approvals.push(payload),
            "agent-event" => {
                let ty = payload.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if ty == "tool_started" {
                    let name = payload
                        .get("toolName")
                        .or_else(|| payload.get("tool"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("(未知工具)")
                        .to_string();
                    facts.tool_names.push(name);
                }
            }
            _ => {}
        }
    }
    facts
}

/// 从轮次 segments（JSON 数组）提取 kb-sources 段（纯函数，单测覆盖）。
pub(crate) fn extract_kb_sources(segments_json: &str) -> Vec<Value> {
    let Ok(arr) = serde_json::from_str::<Vec<Value>>(segments_json) else {
        return vec![];
    };
    arr.into_iter()
        .filter(|s| s.get("kind").and_then(|x| x.as_str()) == Some("kb-sources"))
        .collect()
}

/// 交付报告（纯函数，单测覆盖）。
pub(crate) fn build_report_md(
    agent_label: &str,
    session_name: &str,
    run_id: &str,
    prompt: &str,
    facts: &RunFacts,
    prompt_tokens: i64,
    completion_tokens: i64,
    reply: &str,
    artifact_files: &[String],
    approval_count: usize,
    kb_source_count: usize,
) -> String {
    let mut md = String::new();
    md.push_str("# 任务交付报告\n\n");
    md.push_str(&format!("- **运行 ID**：`{run_id}`\n"));
    md.push_str(&format!("- **智能体**：{agent_label}\n"));
    md.push_str(&format!("- **会话**：{session_name}\n"));
    md.push_str(&format!(
        "- **成本**：prompt {prompt_tokens} tok + completion {completion_tokens} tok\n\n"
    ));

    md.push_str("## 目标（首问）\n\n");
    md.push_str(if prompt.trim().is_empty() {
        "（未记录）\n"
    } else {
        prompt.trim()
    });
    md.push_str("\n\n");

    md.push_str("## 工具调用\n\n");
    if facts.tool_names.is_empty() {
        md.push_str("（本次运行未调用工具）\n\n");
    } else {
        for (i, name) in facts.tool_names.iter().enumerate() {
            md.push_str(&format!("{}. `{}`\n", i + 1, name));
        }
        md.push('\n');
    }

    md.push_str("## 产物\n\n");
    if artifact_files.is_empty() {
        md.push_str("（本次运行无文件产物）\n\n");
    } else {
        md.push_str("| 文件 | 说明 |\n|---|---|\n");
        for f in artifact_files {
            md.push_str(&format!("| [{}]({}) | |\n", f, f));
        }
        md.push('\n');
    }

    md.push_str("## 审批链\n\n");
    if approval_count == 0 {
        md.push_str("（本次运行无审批请求）\n\n");
    } else {
        md.push_str(&format!(
            "共 {} 个审批请求（原样见 `approvals.json`）。审批「决策」当前未事件化落库，暂不包含。\n\n",
            approval_count
        ));
    }

    md.push_str("## 知识库引用\n\n");
    if kb_source_count == 0 {
        md.push_str("（本次运行无 KB 引用）\n\n");
    } else {
        md.push_str(&format!(
            "共 {} 条 kb-sources 段（原始引用见 `sources.json`）。\n\n",
            kb_source_count
        ));
    }

    md.push_str("## 最终回复\n\n");
    md.push_str(if reply.trim().is_empty() {
        "（空）\n"
    } else {
        reply.trim()
    });
    md.push('\n');
    md
}

// ───────────────────────── 事件级分叉（台账 D4 收官） ─────────────────────────
//
// 语义：从**已归档 run** 的事件时间线上选一个分叉点，把「原目标 + 该点前的执行进展
// 摘要」合成为续跑指令，在原会话开新一轮走既有 run(initialContext) 通路继续推进
// ——与 branch_from_step（计划步粒度）互补，不做运行态字节级重建。

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildEventForkInput {
    pub run_id: String,
    /// 分叉点：摘要覆盖 ts ≤ 此值的事件；0 = 仅原目标（无进展摘要）。
    pub upto_ts_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildEventForkOutput {
    pub prompt: String,
    pub initial_context: String,
    /// 摘要覆盖的事件条数。
    pub digest_event_count: usize,
    pub session_id: String,
}

/// 进展摘要（纯函数，单测覆盖）：取分叉点前事件的**尾部**行（最近进展优先），
/// 总量按 char_budget 截断；工具结果/产物/计划/审批各成一行。
pub(crate) fn digest_events_up_to(events: &Value, upto_ts_ms: i64, char_budget: usize) -> (Vec<String>, usize) {
    let mut lines: Vec<String> = vec![];
    let mut count = 0usize;
    let Some(arr) = events.as_array() else {
        return (lines, 0);
    };
    for e in arr {
        let ts = e.get("ts_ms").and_then(|x| x.as_i64()).unwrap_or(0);
        if ts > upto_ts_ms {
            continue;
        }
        count += 1;
        let event = e.get("event").and_then(|x| x.as_str()).unwrap_or("");
        let payload = e.get("payload").cloned().unwrap_or(Value::Null);
        match event {
            "agent-event" => {
                let ty = payload.get("type").and_then(|x| x.as_str()).unwrap_or("");
                if ty == "tool_finished" {
                    let name = payload
                        .get("toolName")
                        .or_else(|| payload.get("tool"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("(未知工具)");
                    let status = payload.get("status").and_then(|x| x.as_str()).unwrap_or("done");
                    let brief = payload
                        .get("result")
                        .and_then(|x| x.as_str())
                        .map(|s| {
                            let t: String = s.chars().take(120).collect();
                            t.replace('\n', " ")
                        })
                        .unwrap_or_default();
                    lines.push(format!("- [工具] {name} → {status}：{brief}"));
                }
            }
            "agent-artifact-created" => {
                if let Some(list) = payload.get("artifacts").and_then(|x| x.as_array()) {
                    for a in list {
                        if let Some(p) = a.get("path").and_then(|x| x.as_str()) {
                            lines.push(format!("- [产物] {p}"));
                        }
                    }
                }
            }
            "agent-awaiting-approval" => {
                lines.push(format!(
                    "- [审批] {}",
                    payload
                        .get("approvalId")
                        .and_then(|x| x.as_str())
                        .unwrap_or("(未编号)")
                ));
            }
            _ => {}
        }
    }
    // 尾部优先 + 预算截断：从末尾往前收，超预算即停。
    let mut kept: Vec<String> = vec![];
    let mut used = 0usize;
    for line in lines.iter().rev() {
        let l = line.chars().count() + 1;
        if used + l > char_budget {
            break;
        }
        used += l;
        kept.push(line.clone());
    }
    kept.reverse();
    (kept, count)
}

/// 续跑指令合成（纯函数，单测覆盖）。
pub(crate) fn build_fork_prompt(goal: &str, upto_ts_ms: i64, digest_lines: &[String]) -> String {
    let mut p = String::from("【事件级分叉续跑】\n原目标：\n");
    p.push_str(if goal.trim().is_empty() {
        "（未记录，请依据进展摘要推断）"
    } else {
        goal.trim()
    });
    p.push_str("\n\n以下为归档 run 在分叉点（ts=");
    p.push_str(&upto_ts_ms.to_string());
    p.push_str("）之前的执行进展摘要：\n");
    if digest_lines.is_empty() {
        p.push_str("（分叉点前无有效进展事件）\n");
    } else {
        for l in digest_lines {
            p.push_str(l);
            p.push('\n');
        }
    }
    p.push_str(
        "\n请基于以上进展继续推进：完成剩余目标；若目标已基本达成，请复核已有产出并输出最终交付说明。\n",
    );
    p
}

/// 主流程：读归档轨迹 → 分叉点摘要 → 取原目标 → 返回续跑指令与上下文。
pub async fn build_event_fork(
    app: &AppHandle,
    input: &BuildEventForkInput,
) -> Result<BuildEventForkOutput, String> {
    let pool = crate::agent::engine::round_compactor::get_pool(app)
        .await
        .map_err(|e| format!("取数据库池失败：{e}"))?;
    let row = sqlx::query(
        "SELECT run_id, agent_id, session_id, started_at, finished_at, events_json, thinking, reply, prompt_tokens, completion_tokens \
         FROM agent_run_trace WHERE run_id = ?",
    )
    .bind(&input.run_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("查询轨迹失败：{e}"))?
    .ok_or_else(|| format!("轨迹不存在：{}（仅终态 run 有归档）", input.run_id))?;

    let session_id: String = row.try_get("session_id").unwrap_or_default();
    let finished_at: i64 = row.try_get("finished_at").unwrap_or(0);
    let events_json_raw: String = row.try_get("events_json").map_err(|e| e.to_string())?;
    let events: Value =
        serde_json::from_str(&events_json_raw).unwrap_or_else(|_| Value::Array(vec![]));

    let upto = if input.upto_ts_ms > 0 {
        input.upto_ts_ms
    } else {
        finished_at // 0 = 全量进展
    };
    let (digest_lines, digest_count) = digest_events_up_to(&events, upto, 4000);

    // 原目标：与交付包同一匹配口径（start_time <= finished_at 的最近一轮首问）。
    let mut goal = String::new();
    if !session_id.is_empty() {
        if let Ok(Some(r)) = sqlx::query(
            "SELECT user_question FROM agent_conversation_round \
             WHERE session_id = ? AND start_time IS NOT NULL AND start_time <= ? \
             ORDER BY start_time DESC LIMIT 1",
        )
        .bind(&session_id)
        .bind(finished_at)
        .fetch_optional(&pool)
        .await
        {
            if let Ok(Some(q)) = r.try_get::<Option<String>, _>("user_question") {
                goal = q;
            }
        }
    }

    let initial_context = {
        let mut c = String::from("【分叉进展摘要】\n");
        if digest_lines.is_empty() {
            c.push_str("（无）");
        } else {
            for l in &digest_lines {
                c.push_str(l);
                c.push('\n');
            }
        }
        c
    };

    Ok(BuildEventForkOutput {
        prompt: build_fork_prompt(&goal, upto, &digest_lines),
        initial_context,
        digest_event_count: digest_count,
        session_id,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRunPackageInput {
    pub run_id: String,
    /// 用户经目录选择器给定的输出根目录（绝对路径）。
    pub out_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRunPackageOutput {
    pub package_dir: String,
    pub files: Vec<String>,
    pub artifact_count: usize,
    pub approval_count: usize,
}

fn short_run(run_id: &str) -> String {
    run_id.chars().take(8).collect()
}

fn safe_basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| "artifact".to_string())
}

/// 主流程：查轨迹行 → 提取事实 → 匹配轮次 → 拷贝产物 → 写包。
pub async fn export_run_package(
    app: &AppHandle,
    input: &ExportRunPackageInput,
) -> Result<ExportRunPackageOutput, String> {
    if input.out_dir.trim().is_empty() {
        return Err("输出目录为空".into());
    }
    let pool = crate::agent::engine::round_compactor::get_pool(app)
        .await
        .map_err(|e| format!("取数据库池失败：{e}"))?;

    let row = sqlx::query(
        "SELECT run_id, agent_id, session_id, started_at, finished_at, events_json, thinking, reply, prompt_tokens, completion_tokens \
         FROM agent_run_trace WHERE run_id = ?",
    )
    .bind(&input.run_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("查询轨迹失败：{e}"))?
    .ok_or_else(|| format!("轨迹不存在：{}（仅终态 run 有归档）", input.run_id))?;

    let agent_id: String = row.try_get("agent_id").unwrap_or_default();
    let session_id: String = row.try_get("session_id").unwrap_or_default();
    let finished_at: i64 = row.try_get("finished_at").unwrap_or(0);
    let events_json_raw: String = row.try_get("events_json").map_err(|e| e.to_string())?;
    let reply: String = row.try_get("reply").unwrap_or_default();
    let p_tok: i64 = row.try_get("prompt_tokens").unwrap_or(0);
    let c_tok: i64 = row.try_get("completion_tokens").unwrap_or(0);

    let events: Value =
        serde_json::from_str(&events_json_raw).unwrap_or_else(|_| Value::Array(vec![]));
    let facts = extract_run_facts(&events);

    // 会话元信息 + 匹配轮次（首问与 kb-sources）：start_time <= finished_at 的最近一轮。
    let mut agent_label = agent_id.clone();
    let mut session_name = session_id.clone();
    let mut prompt = String::new();
    let mut kb_sources: Vec<Value> = vec![];
    if !session_id.is_empty() {
        if let Ok(sess) = sqlx::query(
            "SELECT session_name, agent_code FROM agent_conversation_session WHERE id = ?",
        )
        .bind(&session_id)
        .fetch_one(&pool)
        .await
        {
            if let Ok(Some(n)) = sess.try_get::<Option<String>, _>("session_name") {
                if !n.trim().is_empty() {
                    session_name = n;
                }
            }
            if let Ok(code) = sess.try_get::<String, _>("agent_code") {
                agent_label = code;
            }
        }
        if let Ok(r) = sqlx::query(
            "SELECT user_question, segments_json FROM agent_conversation_round \
             WHERE session_id = ? AND start_time IS NOT NULL AND start_time <= ? \
             ORDER BY start_time DESC LIMIT 1",
        )
        .bind(&session_id)
        .bind(finished_at)
        .fetch_optional(&pool)
        .await
        {
            if let Some(r) = r {
                if let Ok(Some(q)) = r.try_get::<Option<String>, _>("user_question") {
                    prompt = q;
                }
                if let Ok(seg) = r.try_get::<String, _>("segments_json") {
                    kb_sources = extract_kb_sources(&seg);
                }
            }
        }
    }

    // 建包目录。
    let pkg = PathBuf::from(&input.out_dir)
        .join(format!("交付包-{}-{}", short_run(&input.run_id), finished_at.max(0)));
    std::fs::create_dir_all(&pkg).map_err(|e| format!("创建目录失败（{}）：{e}", pkg.display()))?;
    let artifacts_dir = pkg.join("artifacts");
    std::fs::create_dir_all(&artifacts_dir).map_err(|e| format!("创建 artifacts/ 失败：{e}"))?;

    let mut files: Vec<String> = vec![];
    let mut record = |rel: &'static str| {
        files.push(rel.to_string());
    };

    // 产物拷贝：源路径=工作空间内绝对路径；缺失/失败不阻断，记入 missingArtifacts。
    let mut artifact_files: Vec<String> = vec![];
    let mut missing_artifacts: Vec<String> = vec![];
    for src in &facts.artifact_paths {
        let name = safe_basename(src);
        let dst = artifacts_dir.join(&name);
        match std::fs::copy(src, &dst) {
            Ok(_) => artifact_files.push(name),
            Err(_) => missing_artifacts.push(src.clone()),
        }
    }
    if !artifact_files.is_empty() {
        record("artifacts/");
    }

    // manifest.json
    let manifest = serde_json::json!({
        "runId": input.run_id,
        "agentId": agent_id,
        "agentLabel": agent_label,
        "sessionId": session_id,
        "sessionName": session_name,
        "startedAt": row.try_get::<i64, _>("started_at").unwrap_or(0),
        "finishedAt": finished_at,
        "promptTokens": p_tok,
        "completionTokens": c_tok,
        "eventCount": events.as_array().map(|a| a.len()).unwrap_or(0),
        "toolCallCount": facts.tool_names.len(),
        "artifactCount": artifact_files.len(),
        "missingArtifacts": missing_artifacts,
        "approvalCount": facts.approvals.len(),
        "kbSourceSegments": kb_sources.len(),
        "exportedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    });
    std::fs::write(
        pkg.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("序列化 manifest 失败：{e}"))?,
    )
    .map_err(|e| format!("写 manifest.json 失败：{e}"))?;
    record("manifest.json");

    // trajectory.json / approvals.json / sources.json
    std::fs::write(
        pkg.join("trajectory.json"),
        serde_json::to_string_pretty(&events).map_err(|e| format!("序列化事件流失败：{e}"))?,
    )
    .map_err(|e| format!("写 trajectory.json 失败：{e}"))?;
    record("trajectory.json");

    std::fs::write(
        pkg.join("approvals.json"),
        serde_json::to_string_pretty(&facts.approvals)
            .map_err(|e| format!("序列化审批链失败：{e}"))?,
    )
    .map_err(|e| format!("写 approvals.json 失败：{e}"))?;
    record("approvals.json");

    std::fs::write(
        pkg.join("sources.json"),
        serde_json::to_string_pretty(&kb_sources)
            .map_err(|e| format!("序列化引用失败：{e}"))?,
    )
    .map_err(|e| format!("写 sources.json 失败：{e}"))?;
    record("sources.json");

    // report.md
    let md = build_report_md(
        &agent_label,
        &session_name,
        &input.run_id,
        &prompt,
        &facts,
        p_tok,
        c_tok,
        &reply,
        &artifact_files,
        facts.approvals.len(),
        kb_sources.len(),
    );
    std::fs::write(pkg.join("report.md"), md).map_err(|e| format!("写 report.md 失败：{e}"))?;
    record("report.md");

    Ok(ExportRunPackageOutput {
        package_dir: pkg.to_string_lossy().to_string(),
        files,
        artifact_count: artifact_files.len(),
        approval_count: facts.approvals.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_facts_artifacts_approvals_tools() {
        let events = json!([
            {"event": "agent-event", "payload": {"type": "text_chunk"}, "ts_ms": 1},
            {"event": "agent-event", "payload": {"type": "tool_started", "toolName": "fs__write_file"}, "ts_ms": 2},
            {"event": "agent-artifact-created", "payload": {"artifacts": [
                {"artifactId": "art_1", "path": "/ws/out/report.md"},
                {"artifactId": "art_2", "path": "/ws/out/report.md"}, // 重复路径去重
            ]}, "ts_ms": 3},
            {"event": "agent-awaiting-approval", "payload": {"approvalId": "ap_1", "riskLevel": "L3"}, "ts_ms": 4},
        ]);
        let f = extract_run_facts(&events);
        assert_eq!(f.artifact_paths, vec!["/ws/out/report.md"]);
        assert_eq!(f.approvals.len(), 1);
        assert_eq!(f.tool_names, vec!["fs__write_file"]);
    }

    #[test]
    fn extract_facts_non_array_is_empty() {
        assert_eq!(extract_run_facts(&json!({"x": 1})), RunFacts::default());
    }

    #[test]
    fn kb_sources_only_kb_segments() {
        let seg = json!([
            {"kind": "text", "text": "hi"},
            {"kind": "kb-sources", "hits": [{"title": "设计文档"}]},
            {"kind": "thought", "text": "t"},
        ])
        .to_string();
        let out = extract_kb_sources(&seg);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["hits"][0]["title"], "设计文档");
        assert!(extract_kb_sources("not json").is_empty());
    }

    #[test]
    fn report_md_sections() {
        let facts = RunFacts {
            artifact_paths: vec!["/ws/a.md".into()],
            approvals: vec![json!({"approvalId": "ap_1"})],
            tool_names: vec!["fs__write_file".into()],
        };
        let md = build_report_md(
            "coder", "修 bug", "run-1234", "修复登录", &facts, 120, 45, "已完成", &["a.md".into()], 1, 2,
        );
        for tag in ["# 任务交付报告", "run-1234", "修复登录", "`fs__write_file`", "[a.md](a.md)", "prompt 120", "## 最终回复", "已完成"] {
            assert!(md.contains(tag), "缺少片段：{tag}");
        }
        assert!(md.contains("共 1 个审批请求"));
        assert!(md.contains("共 2 条 kb-sources 段"));
    }

    #[test]
    fn short_run_and_basename() {
        assert_eq!(short_run("abcdefgh-xyz"), "abcdefgh");
        assert_eq!(safe_basename("/ws/out/报告.md"), "报告.md");
        assert_eq!(safe_basename("no-slash"), "no-slash");
    }

    #[test]
    fn digest_up_to_filters_and_truncates() {
        let events = json!([
            {"event": "agent-event", "payload": {"type": "tool_finished", "toolName": "fs__read_file", "status": "ok", "result": "file body"}, "ts_ms": 10},
            {"event": "agent-event", "payload": {"type": "text_chunk"}, "ts_ms": 11},
            {"event": "agent-artifact-created", "payload": {"artifacts": [{"path": "/ws/out.md"}]}, "ts_ms": 12},
            {"event": "agent-event", "payload": {"type": "tool_finished", "toolName": "fs__write_file", "status": "ok", "result": "written"}, "ts_ms": 13},
        ]);
        // 分叉点=12：只含 ts≤12 的事件；全量未截断时保持时间序（产物是最近一行）。
        let (lines, count) = digest_events_up_to(&events, 12, 4000);
        assert_eq!(count, 3);
        assert!(lines.last().unwrap().starts_with("- [产物] /ws/out.md"));
        assert!(lines.iter().any(|l| l.contains("fs__read_file")));
        assert!(!lines.iter().any(|l| l.contains("fs__write_file")));
        // 预算截断：budget 极小时保留 0 行但不 panic。
        let (lines2, _) = digest_events_up_to(&events, 13, 8);
        assert!(lines2.is_empty() || lines2.len() <= 1);
    }

    #[test]
    fn fork_prompt_sections() {
        let p = build_fork_prompt("修复登录", 1690000000000, &["- [工具] fs__read_file → ok：x".into()]);
        for tag in ["【事件级分叉续跑】", "修复登录", "ts=1690000000000", "fs__read_file", "继续推进"] {
            assert!(p.contains(tag), "缺少片段：{tag}");
        }
        let empty = build_fork_prompt("", 0, &[]);
        assert!(empty.contains("（未记录"));
        assert!(empty.contains("（分叉点前无有效进展事件）"));
    }
}
