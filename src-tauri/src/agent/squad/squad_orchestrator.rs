//! 小分队协作引擎（Phase 3-5 共用）。
//!
//! 编排式（orchestrator）：主管智能体（leader）把任务拆解成子任务、委派给成员智能体，
//! 每个成员以独立 `AgentRuntimeConfig` 运行（各自 LLM / MCP / Skill / 记忆 / 沙箱），
//! 成员间靠「产物文本」单向传递上下文，最后由 leader 汇总。
//! 流水线 / 群聊模式在 Phase 4 / Phase 5 复用并扩展本文件的运行骨架。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

/// S0-4a：squad 会话 id 进程内序号（叠加纳秒时间戳，进程内严格唯一）。
static SQUAD_SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

/// S0-4d（2026-09-28）：per-session metrics 累加器（tokens/wall/memberStats 最小集）。
/// 注册表模式同 SQUAD_CANCELS：run_squad_task 注册（session_id 键），终态落 metrics round
/// 后移除；编排侧 call_llm 与成员 pipeline 双源累加。落库形态：round 表 kind='metrics' 行，
/// content = JSON（零 DDL 变更，前端按 kind 过滤或忽略）。
#[derive(serde::Serialize)]
struct SquadMemberStat {
    agent_id: String,
    role: String,
    prompt_tokens: u64,
    completion_tokens: u64,
    wall_ms: u64,
}
#[derive(Default, serde::Serialize)]
struct SquadMetricsAcc {
    prompt_tokens: u64,
    completion_tokens: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    members: Vec<SquadMemberStat>,
    /// S2：token 总预算（0=不限），注册时固化；用于 80% 告警 / 100% 软熔断。
    #[serde(skip_serializing_if = "Budget::is_zero", default)]
    budget: Budget,
}

#[derive(Default, Clone, Copy, serde::Serialize, serde::Deserialize)]
struct Budget(u64);

impl Budget {
    fn is_zero(&self) -> bool {
        self.0 == 0
    }
}

/// S2：会话级预算注册（run_squad_task 开头调用；budget=0 表示不限）。
fn squad_metrics_register_budget(session_id: &str, budget_tokens: u64) {
    let mut g = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(std::collections::HashMap::new)
        .entry(session_id.to_string())
        .or_default()
        .budget = Budget(budget_tokens);
}

/// S2：预算状态查询 —— (已用 tokens, 预算, 已告警)。告警去重由调用方处理。
fn squad_metrics_used(session_id: &str) -> u64 {
    let g = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref()
        .and_then(|m| m.get(session_id))
        .map(|a| a.prompt_tokens + a.completion_tokens)
        .unwrap_or(0)
}

fn squad_metrics_budget(session_id: &str) -> u64 {
    let g = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    g.as_ref()
        .and_then(|m| m.get(session_id))
        .map(|a| a.budget.0)
        .unwrap_or(0)
}
static SQUAD_METRICS: std::sync::Mutex<Option<std::collections::HashMap<String, SquadMetricsAcc>>> =
    std::sync::Mutex::new(None);

fn squad_metrics_add_usage(session_id: &str, usage: (u64, u64)) {
    if usage.0 == 0 && usage.1 == 0 {
        return;
    }
    let mut g = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    let acc = g.get_or_insert_with(std::collections::HashMap::new)
        .entry(session_id.to_string())
        .or_default();
    acc.prompt_tokens += usage.0;
    acc.completion_tokens += usage.1;
}
fn squad_metrics_add_member(session_id: &str, stat: SquadMemberStat) {
    let mut g = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(std::collections::HashMap::new)
        .entry(session_id.to_string())
        .or_default()
        .members.push(stat);
}
async fn write_metrics_round(_app: &AppHandle, pool: &sqlx::SqlitePool, squad_id: &str, session_id: &str) {
    let taken = squad_metrics_take(session_id);
    tracing::info!("[squad] write_metrics_round: session={session_id} acc_present={}", taken.is_some());
    let Some(acc) = taken else { return };
    if acc.prompt_tokens == 0 && acc.completion_tokens == 0 && acc.members.is_empty() {
        return;
    }
    let payload = serde_json::to_string(&acc).unwrap_or_default();
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '系统', ?, 'metrics', ?)")
    .bind(format!("sqr_{}", now_ms()))
    .bind(squad_id)
    .bind(session_id)
    .bind(&payload)
    .bind(now_ms())
    .execute(pool)
    .await;
    tracing::info!("[squad] 会话 {session_id} metrics 已落盘（prompt={} completion={} members={}）", acc.prompt_tokens, acc.completion_tokens, acc.members.len());
}

fn squad_metrics_take(session_id: &str) -> Option<SquadMetricsAcc> {
    let mut g = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(std::collections::HashMap::new).remove(session_id)
}

use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_sql::DbInstances;
use tauri_plugin_sql::DbPool;

use crate::agent::hitl::approval::ApprovalManager;
use crate::agent::events;
use crate::agent::plugins::mcp_adapter;
use crate::agent::engine::native;
use crate::agent::engine::planner;
use crate::agent::engine::pipeline;
use crate::agent::engine::graph::KnowledgeGraph;
use crate::agent::engine::llm::extract_llm_content;
use crate::agent::hitl::recovery::RecoveryHub;
use crate::agent::engine::tools::ToolContext;
use crate::agent::engine::tools::ToolRegistry;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::SquadMemberConfig;
use crate::agent::types::SquadRuntimeConfig;

/// squad 级取消注册表：session_id → (squad_id, 取消标志)。
///
/// run_squad_task 建会话后注册（SquadCancelGuard Drop 时回收），cancel_squad_sessions
/// 按 squad_id 置位——成员 pipeline / build_plan / 编排侧 call_llm 三层共用同一标志，
/// 取消在调用级（≤180s）与节点级（检测点即时）生效。
static SQUAD_CANCELS: std::sync::Mutex<Option<std::collections::HashMap<String, (String, std::sync::Arc<AtomicBool>)>>> =
    std::sync::Mutex::new(None);

/// Drop 守卫：任务任意出口（正常 / 取消 / 失败）自动从注册表移除，不残留孤儿标志。
struct SquadCancelGuard(String);
impl Drop for SquadCancelGuard {
    fn drop(&mut self) {
        let mut g = SQUAD_CANCELS.lock().unwrap_or_else(|e| e.into_inner());
        g.get_or_insert_with(std::collections::HashMap::new).remove(&self.0);
        // S0-4d 兜底：正常路径终态已 take 并落 metrics round；异常路径（panic/提前 return）
        // 残留的累加器在此清理，防跨 run 串账。
        let mut m = SQUAD_METRICS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = m.as_mut() {
            map.remove(&self.0);
        }
    }
}

/// 取消指定小分队的全部活跃会话（S0-3 取消穿线对外入口，cancel_squad_task 命令调用）。
/// 返回置位的活跃会话数。
pub fn cancel_squad_sessions(squad_id: &str) -> usize {
    let mut cancelled = 0usize;
    let mut g = SQUAD_CANCELS.lock().unwrap_or_else(|e| e.into_inner());
    {
        let map = g.get_or_insert_with(std::collections::HashMap::new);
        {
            for (sid, (sq, flag)) in map.iter() {
                if sq == squad_id {
                    flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    tracing::info!("[squad] 取消信号已置位：session={sid} squad={squad_id}");
                    cancelled += 1;
                }
            }
        }
    }
    cancelled
}

/// 统一收尾：会话状态落库（done/cancelled/failed）+ 系统 round + done 事件。
/// S0-3 新路径（取消 / 失败 / 早退）使用；既有 done 收尾保持原样（最小 diff）。
/// S2（§4.8）：Delivery Pack——会话终态证据包（合同 + 成员执行证据 + 产物索引 + 决策卡 + 成本）。
/// 落 session.pack_json（前端/导出读取）+ 导出人类可读 Markdown 到交接箱 shared/。
#[derive(Debug, Default, serde::Serialize)]
struct DeliveryPack {
    squad_id: String,
    session_id: String,
    /// done | partial | failed | cancelled
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    contract: Option<serde_json::Value>,
    summary: String,
    /// 成员执行证据（来自 handoff 表聚合）
    member_runs: Vec<serde_json::Value>,
    /// 产物总目录（board.artifactsIndex）
    #[serde(skip_serializing_if = "Vec::is_empty")]
    deliverables: Vec<String>,
    /// 决策卡
    #[serde(skip_serializing_if = "Vec::is_empty")]
    decisions: Vec<BoardDecision>,
    cost: CostSummary,
}

#[derive(Debug, Default, serde::Serialize)]
struct CostSummary {
    prompt_tokens: u64,
    completion_tokens: u64,
}

/// 组装并落库 Delivery Pack（finish_squad_session 内调用；尽力而为，失败不阻塞终态）。
async fn build_and_persist_pack(
    pool: &sqlx::SqlitePool,
    app: &AppHandle,
    squad_id: &str,
    session_id: &str,
    status: &str,
    summary: &str,
) {
    let pack = build_delivery_pack(pool, squad_id, session_id, status, summary).await;
    // 1) pack_json 落库
    if let Ok(json) = serde_json::to_string(&pack) {
        let _ = sqlx::query("UPDATE agent_squad_session SET pack_json=? WHERE id=?")
            .bind(json)
            .bind(session_id)
            .execute(pool)
            .await;
    }
    // 2) 人类可读 Markdown 导出到交接箱 shared/
    let md = render_pack_markdown(&pack);
    let dir = squad_shared_inbox(squad_id).replace("/inbox", ""); // shared 根
    let path = std::path::Path::new(&dir).join(format!("delivery-pack-{}.md", &session_id[4..12]));
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&path, &md) {
        Ok(_) => tracing::info!("[squad] 交付包已导出：{}", path.display()),
        Err(e) => tracing::warn!("[squad] 交付包 Markdown 导出失败：{e}"),
    }
    let _ = app;
}

async fn build_delivery_pack(
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    session_id: &str,
    status: &str,
    summary: &str,
) -> DeliveryPack {
    let mut pack = DeliveryPack {
        squad_id: squad_id.into(),
        session_id: session_id.into(),
        status: status.into(),
        summary: summary.chars().take(2000).collect(),
        ..Default::default()
    };
    // 合同
    if let Ok(Some((cj,))) =
        sqlx::query_as::<_, (Option<String>,)>("SELECT contract_json FROM agent_squad_session WHERE id=?")
            .bind(session_id)
            .fetch_optional(pool)
            .await
    {
        pack.contract = cj.and_then(|s| serde_json::from_str(&s).ok());
    }
    // 成员执行证据（handoff 表聚合）
    if let Ok(rows) = sqlx::query_as::<_, (String, String, String)>(
        "SELECT task_id, status, bundle_json FROM agent_squad_handoff WHERE session_id=? ORDER BY created_at",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await
    {
        for (task_id, hstatus, bundle_json) in rows {
            let bundle: Option<HandoffBundle> = serde_json::from_str(&bundle_json).ok();
            pack.member_runs.push(serde_json::json!({
                "taskId": task_id,
                "status": hstatus,
                "role": bundle.as_ref().map(|b| b.from_role.clone()).unwrap_or_default(),
                "artifacts": bundle.as_ref().map(|b| b.artifacts.len()).unwrap_or(0),
                "openQuestions": bundle.as_ref().map(|b| b.open_questions.clone()).unwrap_or_default(),
                "tokens": bundle.as_ref().map(|b| { let m = &b.metrics; vec![m.prompt_tokens, m.completion_tokens] }),
                "durationMs": bundle.as_ref().map(|b| b.metrics.duration_ms).unwrap_or(0),
            }));
        }
    }
    // board（产物索引 + 决策卡）
    if let Ok(Some((bj,))) =
        sqlx::query_as::<_, (Option<String>,)>("SELECT board_json FROM agent_squad_session WHERE id=?")
            .bind(session_id)
            .fetch_optional(pool)
            .await
    {
        if let Some(b) = bj.and_then(|s| serde_json::from_str::<BoardState>(&s).ok()) {
            pack.deliverables = b.artifacts_index.clone();
            pack.decisions = b.decisions.clone();
        }
    }
    // 成本（metrics round 行，终态时 SQUAD_METRICS 已 take）
    if let Ok(Some((content,))) = sqlx::query_as::<_, (String,)>(
        "SELECT content FROM agent_squad_round WHERE session_id=? AND kind='metrics' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            pack.cost.prompt_tokens = v["prompt_tokens"].as_u64().unwrap_or(0);
            pack.cost.completion_tokens = v["completion_tokens"].as_u64().unwrap_or(0);
        }
    }
    pack
}

/// 人类可读 Markdown 版交付包。
fn render_pack_markdown(pack: &DeliveryPack) -> String {
    let mut s = String::new();
    s.push_str(&format!("# 交付包 · {} · {}\n\n", pack.squad_id, &pack.session_id[4..12]));
    s.push_str(&format!("- 状态：**{}**\n- 成本：prompt {} / completion {} tokens\n\n", pack.status, pack.cost.prompt_tokens, pack.cost.completion_tokens));
    s.push_str(&format!("## 任务结论\n\n{}\n\n", pack.summary));
    if let Some(c) = &pack.contract {
        s.push_str("## 任务合同（Mission Contract）\n\n");
        if let Some(tasks) = c.get("tasks").and_then(|t| t.as_array()) {
            for t in tasks {
                s.push_str(&format!(
                    "- [{}] {} → {}（依赖 {:?}，期望产物 {:?}）\n",
                    t.get("taskId").and_then(|v| v.as_str()).unwrap_or("-"),
                    t.get("title").and_then(|v| v.as_str()).unwrap_or("-"),
                    t.get("assignee").and_then(|v| v.as_str()).unwrap_or("-"),
                    t.get("dependsOn").cloned().unwrap_or(serde_json::json!([])),
                    t.get("expectedArtifacts").cloned().unwrap_or(serde_json::json!([])),
                ));
            }
        }
        s.push('\n');
    }
    if !pack.member_runs.is_empty() {
        s.push_str("## 成员执行证据\n\n| 任务 | 角色 | 状态 | 产物数 | tokens | 用时 |\n|---|---|---|---|---|---|\n");
        for r in &pack.member_runs {
            let tk = r.get("tokens").cloned().unwrap_or(serde_json::json!([0, 0]));
            s.push_str(&format!(
                "| {} | {} | {} | {} | {}/{} | {}ms |\n",
                r.get("taskId").and_then(|v| v.as_str()).unwrap_or("-"),
                r.get("role").and_then(|v| v.as_str()).unwrap_or("-"),
                r.get("status").and_then(|v| v.as_str()).unwrap_or("-"),
                r.get("artifacts").and_then(|v| v.as_u64()).unwrap_or(0),
                tk[0].as_u64().unwrap_or(0),
                tk[1].as_u64().unwrap_or(0),
                r.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(0),
            ));
        }
        s.push('\n');
    }
    if !pack.deliverables.is_empty() {
        s.push_str("## 产物索引\n\n");
        for d in &pack.deliverables {
            s.push_str(&format!("- {d}\n"));
        }
        s.push('\n');
    }
    if !pack.decisions.is_empty() {
        s.push_str("## 决策卡\n\n");
        for d in &pack.decisions {
            s.push_str(&format!("- [{}] {}\n", d.kind, d.text));
        }
    }
    s
}

async fn finish_squad_session(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    session_id: &str,
    status: &str,
    summary: &str,
) {
    // S2（§4.11）：终态即止——仍未消费的插话标记 dropped（§4.11.6「节点已结束」）。
    squad_inject_flush_session(app, pool, squad_id, session_id).await;
    let _ = sqlx::query(
        "UPDATE agent_squad_session SET status=?, snapshot=?, updated_at=? WHERE id=?",
    )
    .bind(status)
    .bind(summary)
    .bind(now_ms())
    .bind(session_id)
    .execute(pool)
    .await;
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '系统', ?, 'system', ?)",
    )
    .bind(format!("sqr_{}", now_ms()))
    .bind(squad_id)
    .bind(session_id)
    .bind(summary)
    .bind(now_ms())
    .execute(pool)
    .await;
    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "系统".into(),
            kind: "summary".into(),
            content: summary.to_string(),
        },
    );
    events::emit_squad_session_done(
        app,
        &events::SquadSessionDonePayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            summary: summary.to_string(),
        },
    );
    // S2：终态组装 Delivery Pack（证据链 + 成本 + 产物索引），尽力而为不阻塞终态。
    build_and_persist_pack(pool, app, squad_id, session_id, status, summary).await;
    tracing::info!("[squad] 会话 {} 终态：{}", session_id, status);
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn get_pool(app: &AppHandle) -> Result<sqlx::SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let db_pool = guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db）".to_string())?;
    match db_pool {
        DbPool::Sqlite(p) => Ok(p.clone()),
    }
}

struct DelegatedTask {
    title: String,
    assignee: String,
    instruction: String,
    /// S1：前置依赖（引用其他子任务的 title）；空 = 无依赖。
    depends_on: Vec<String>,
    /// S1：期望产物文件名（如 report.md）；生成 Handoff 时对照，缺失记入 open_questions。
    expected_artifacts: Vec<String>,
}

/// S1（设计方案 v1.4 §4.4.2）：结构化交接包——Agent 间不传聊天全文，传「摘要 + 产物索引 + 未决点」。
/// 全文留在磁盘（成员私有区 + squad 级交接箱），下游按需 read_file。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct HandoffBundle {
    from_agent_id: String,
    from_role: String,
    task_id: String,
    /// ok | partial | failed（失败也强制产出，不允许静默消失）
    status: String,
    /// ≤800 字的结论 + 做了什么，给人和下游看
    summary: String,
    artifacts: Vec<HandoffArtifact>,
    #[serde(default)]
    open_questions: Vec<String>,
    #[serde(default)]
    metrics: HandoffMetrics,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct HandoffArtifact {
    /// 交接箱内相对路径（shared/inbox/{task_id}/{...}）
    path: String,
    /// file | dir | text
    kind: String,
    bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct HandoffMetrics {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    duration_ms: u64,
}

/// 交接箱目录（squad 级共享）：`.wd_mem/squads/{squad_id}/shared/inbox/{task_id}/`。
/// 成员私有区产物在此留档（审计/Delivery Pack 用），投递下游时再拷进下游私有区 inbox。
fn squad_shared_inbox(squad_id: &str) -> String {
    let rel = format!(".wd_mem/squads/{}/shared/inbox", squad_id);
    if std::path::Path::new(&rel).is_absolute() {
        return rel;
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(&rel).to_string_lossy().to_string(),
        Err(_) => rel,
    }
}

/// 判断产物扫描时是否跳过该路径段（引擎内部结构 / 构建产物）。
fn is_ignored_segment(name: &str) -> bool {
    matches!(
        name,
        ".wd_mem" | "node_modules" | "__pycache__" | ".git" | "target" | ".venv" | ".pytest_cache" | "inbox"
    )
}

/// 递归收集工作空间产物文件（相对路径 + 字节量），排除引擎内部结构；上限 200 个防爆炸。
fn collect_artifacts(ws: &str) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let root = std::path::PathBuf::from(ws);
    fn walk(dir: &std::path::Path, rel: &str, out: &mut Vec<(String, u64)>) {
        if out.len() >= 200 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            if is_ignored_segment(&name) {
                continue;
            }
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            match e.file_type() {
                Ok(t) if t.is_dir() => walk(&e.path(), &child_rel, out),
                Ok(t) if t.is_file() => {
                    let bytes = e.metadata().map(|m| m.len()).unwrap_or(0);
                    out.push((child_rel, bytes));
                }
                _ => {}
            }
            if out.len() >= 200 {
                return;
            }
        }
    }
    walk(&root, "", &mut out);
    out
}

/// 读取文本产物前 2KB 作为 preview（二进制内容截断后可能乱码，调用方按扩展名跳过）。
fn read_preview(ws: &str, rel: &str) -> Option<String> {
    let p = std::path::Path::new(ws).join(rel);
    const TEXT_EXT: &[&str] = &[
        "md", "txt", "json", "csv", "py", "js", "ts", "tsx", "jsx", "html", "css", "rs", "go",
        "java", "yaml", "yml", "toml", "xml", "sql", "sh", "log",
    ];
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let ext = ext.as_deref()?;
    if !TEXT_EXT.contains(&ext) {
        return None;
    }
    let mut buf = Vec::new();
    let f = std::fs::File::open(&p).ok()?;
    use std::io::Read;
    f.take(2048).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).to_string())
}

/// 成员子任务终态生成 HandoffBundle（成功/失败都产出——设计 §4.4.2「不允许静默消失」）。
/// 产物 = 成员工作空间内排除内部结构后的文件；同时把产物**留档到 squad 级交接箱**
/// （`.wd_mem/squads/{squad_id}/shared/inbox/{task_id}/`），投递下游由调度器执行。
fn build_handoff_bundle(
    ws: &str,
    squad_id: &str,
    member_agent_id: &str,
    member_role: &str,
    task_id: &str,
    final_text: &str,
    status: &str,
    usage: (u64, u64),
    wall_ms: u64,
    expected: &[String],
) -> HandoffBundle {
    let _ = squad_id; // 交接箱落档由调用方（有 pool 上下文）完成；此处仅组装 bundle
    let files = collect_artifacts(ws);
    let mut artifacts = Vec::new();
    for (rel, bytes) in &files {
        artifacts.push(HandoffArtifact {
            path: rel.clone(),
            kind: "file".into(),
            bytes: *bytes,
            preview: read_preview(ws, rel),
            label: None,
        });
    }
    // expectedArtifacts 对照：点名要的产物缺失 → 记入 open_questions（§13「做了活不交件」对策第一层）
    let mut open_questions: Vec<String> = Vec::new();
    if status == "ok" {
        for exp in expected {
            let hit = files.iter().any(|(rel, _)| {
                rel == exp || rel.ends_with(&format!("/{exp}")) || rel.ends_with(exp.as_str())
            });
            if !hit {
                open_questions.push(format!("期望产物「{exp}」未在工作空间找到"));
            }
        }
    }
    // 失败/部分：final_text 为空时给错误占位摘要
    let mut summary = final_text.trim().chars().take(800).collect::<String>();
    if summary.is_empty() {
        summary = if status == "failed" {
            "（子任务失败：无终文输出，详见会话错误记录）".into()
        } else {
            "（子任务完成但无文本输出；产物见下方列表）".into()
        };
    }
    HandoffBundle {
        from_agent_id: member_agent_id.into(),
        from_role: member_role.into(),
        task_id: task_id.into(),
        status: status.into(),
        summary,
        artifacts,
        open_questions,
        metrics: HandoffMetrics {
            prompt_tokens: usage.0,
            completion_tokens: usage.1,
            duration_ms: wall_ms,
        },
    }
}

/// 把 bundle 的产物从成员私有区**留档**到 squad 级交接箱（shared/inbox/{task_id}/）。
fn archive_handoff_to_inbox(ws: &str, inbox_root: &str, task_id: &str, bundle: &HandoffBundle) {
    for art in &bundle.artifacts {
        let src = std::path::Path::new(ws).join(&art.path);
        let dst = std::path::Path::new(inbox_root).join(task_id).join(&art.path);
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::copy(&src, &dst).is_err() {
            tracing::warn!("[squad] 交接箱留档失败：{} → {}", src.display(), dst.display());
        }
    }
}

/// 把上游 Handoff 的产物**投递**到下游成员工作空间 `inbox/{task_id}/`（调度器代投，
/// PathGuard 天然放行——文件在下游自己的工作空间内）。返回注入用的展示路径列表。
fn deliver_handoff_to_downstream(
    inbox_root: &str,
    downstream_ws: &str,
    task_id: &str,
    bundle: &HandoffBundle,
) -> Vec<String> {
    let mut shown = Vec::new();
    for art in &bundle.artifacts {
        let src = std::path::Path::new(inbox_root).join(task_id).join(&art.path);
        let dst = std::path::Path::new(downstream_ws)
            .join("inbox")
            .join(task_id)
            .join(&art.path);
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::copy(&src, &dst).is_ok() {
            shown.push(format!("inbox/{}/{}（{} bytes）", task_id, art.path, art.bytes));
        }
    }
    shown
}

/// 按 §4.4.3 注入模板渲染单个上游交接段（只注入摘要+产物索引+未决点，不注入全文）。
fn render_handoff_section(idx: usize, total: usize, bundle: &HandoffBundle, delivered: &[String]) -> String {
    let mut s = format!(
        "## 上游交接 {}/{}（来自 {}·{}，任务 {}）\n状态：{}\n摘要：\n{}\n",
        idx, total, bundle.from_role, bundle.from_agent_id, bundle.task_id, bundle.status, bundle.summary
    );
    if !delivered.is_empty() {
        s.push_str("\n可用产物（已投递到你的工作空间，需要全文用 read_file 读相对路径）：\n");
        for d in delivered {
            s.push_str(&format!("- {d}\n"));
        }
    }
    if !bundle.open_questions.is_empty() {
        s.push_str("\n未决点：\n");
        for q in &bundle.open_questions {
            s.push_str(&format!("- {q}\n"));
        }
    }
    s.push_str("\n请基于以上交接继续你的任务；若交接不足，先读文件或说明缺口，不要臆造。");
    s
}

/// S2（§4.6）：团队计划门禁（L1）——manual 模式下委派计划生成后挂起等用户批准。
/// 注册表模式同 SQUAD_CANCELS：run_squad_task 注册，squad_plan_approve 命令决议，等待循环消费。
static SQUAD_PLAN_GATES: std::sync::Mutex<Option<std::collections::HashMap<String, PlanGate>>> =
    std::sync::Mutex::new(None);

struct PlanGate {
    /// None=待决议；Some(true)=批准；Some(false)=拒绝。
    /// （2026-09-28 修复：旧版 resolve 先 remove 再置位 AtomicBool，等待循环看到「gate 已不在
    /// 注册表」一律按拒绝处理——批准也会走取消收尾；tri-state 化后 resolve 置值不摘除，
    /// 摘除统一由 remove_plan_gate 在等待返回后收尾。）
    approved: Arc<std::sync::Mutex<Option<bool>>>,
}

/// 用户决议入口（Tauri 命令 squad_plan_approve 调用）。返回是否命中注册表。
pub fn resolve_plan_gate(session_id: &str, approved: bool) -> bool {
    let g = SQUAD_PLAN_GATES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(map) = g.as_ref() else { return false };
    match map.get(session_id) {
        Some(gate) => {
            *gate.approved.lock().unwrap_or_else(|e| e.into_inner()) = Some(approved);
            true
        }
        None => false,
    }
}

/// 挂起等待计划批准（manual 专用；每 2s 轮询批准/取消，永久等待与单 Agent 恢复语义一致）。
async fn wait_plan_gate(
    session_id: &str,
    squad_cancel: &Arc<AtomicBool>,
) -> bool {
    loop {
        if squad_cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        // gate 缺失（未注册/已被清理的异常路径）→ 视为批准放行，防卡死。
        let decision = {
            let g = SQUAD_PLAN_GATES.lock().unwrap_or_else(|e| e.into_inner());
            match g.as_ref().and_then(|m| m.get(session_id)) {
                None => Some(true),
                Some(gate) => gate.approved.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            }
        };
        match decision {
            Some(v) => return v,
            None => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
        }
    }
}

/// 清理 gate（会话收尾防泄漏）。
fn remove_plan_gate(session_id: &str) {
    let mut g = SQUAD_PLAN_GATES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut() {
        map.remove(session_id);
    }
}

/* ------------------------------------------------------------------ *
 * S2（§4.11）打断说话信箱（InjectMailbox）
 *
 * 注册表模式同 SQUAD_CANCELS：run_squad_task 建会话后注册（SquadInjectGuard
 * Drop 兜底回收），squad_inject_send 命令 / API 入队，消费点两处：
 *   - 任务启动前（pre_talk / 提前入队的全部待达插话）→ 预嘱段合并进成员 prompt；
 *   - 成员 pipeline 工具轮边界安全点（live inject）→ user 消息注入下一轮。
 * 审计唯一事实源在 agent_squad_inject 表（queued → delivered | dropped）。
 * ------------------------------------------------------------------ */

/// 一条待投递插话（内存信箱元素；DB 行为审计源）。
#[derive(Debug, Clone)]
struct InjectNote {
    id: String,
    /// soft | hard | pre_talk（MVP 中 soft/hard 均在下一安全点注入，hard 仅 UI 强调）。
    mode: String,
    content: String,
}

/// 会话级信箱集合：按「目标键」取信箱（编排式任务 id / 流水线节点 id / 群聊成员 agent_id /
/// 成员 role——同一名成员的多个别名键共享同一个 Arc 信箱，发送方用任意键都能命中）。
#[derive(Default)]
struct SessionInjectMailbox {
    /// 无人值守（schedule/api）会话：拒绝一切插话（§4.11.8 三路统一策略）。
    unattended: bool,
    /// 频率限制：目标键 → 最近一次入队毫秒（单目标 ≥2s，防刷屏打断）。
    last_send_ms: std::collections::HashMap<String, i64>,
    /// 目标键 → 共享信箱。
    targets: std::collections::HashMap<String, Arc<std::sync::Mutex<Vec<InjectNote>>>>,
}

static SQUAD_INJECTS: std::sync::Mutex<Option<std::collections::HashMap<String, SessionInjectMailbox>>> =
    std::sync::Mutex::new(None);

/// Drop 守卫：会话任意出口自动摘除注册表条目（DB 层 dropped 兜底由显式 flush 完成）。
struct SquadInjectGuard(String);
impl Drop for SquadInjectGuard {
    fn drop(&mut self) {
        let mut g = SQUAD_INJECTS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = g.as_mut() {
            map.remove(&self.0);
        }
    }
}

/// 会话启动时注册信箱集合（run_squad_task 建会话后调用）。
fn squad_inject_register_session(session_id: &str, unattended: bool) {
    let mut g = SQUAD_INJECTS.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(std::collections::HashMap::new).insert(
        session_id.to_string(),
        SessionInjectMailbox {
            unattended,
            ..Default::default()
        },
    );
}

/// 绑定目标键到信箱。primary 键（成员 agent_id）查找/创建信箱；别名键（task_id 等）
/// 仅在未绑定时挂到该信箱（or_insert）——同一成员多任务共享一个信箱（per-agent 键本就
/// 串行执行），且绝不把不同成员误并到一个队列（角色名可能重复，故不用 role 作键）。
fn squad_inject_bind(
    session_id: &str,
    primary: &str,
    aliases: &[&str],
) -> Arc<std::sync::Mutex<Vec<InjectNote>>> {
    let mut g = SQUAD_INJECTS.lock().unwrap_or_else(|e| e.into_inner());
    let entry = g.get_or_insert_with(std::collections::HashMap::new)
        .entry(session_id.to_string())
        .or_default();
    let mailbox = entry
        .targets
        .get(primary)
        .cloned()
        .unwrap_or_else(|| {
            let mb: Arc<std::sync::Mutex<Vec<InjectNote>>> = Default::default();
            entry.targets.insert(primary.to_string(), mb.clone());
            mb
        });
    for k in aliases {
        entry.targets.entry((*k).to_string()).or_insert_with(|| mailbox.clone());
    }
    mailbox
}

/// 排空单个信箱（FIFO；消费点调用）。
fn squad_inject_take_mailbox(mailbox: &Arc<std::sync::Mutex<Vec<InjectNote>>>) -> Vec<InjectNote> {
    let mut m = mailbox.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *m)
}

/// 按目标键排空（预嘱 / 群聊插话消费点）。
fn squad_inject_take(session_id: &str, target: &str) -> Vec<InjectNote> {
    let g = SQUAD_INJECTS.lock().unwrap_or_else(|e| e.into_inner());
    let Some(entry) = g.as_ref().and_then(|m| m.get(session_id)) else {
        return Vec::new();
    };
    match entry.targets.get(target) {
        Some(mailbox) => squad_inject_take_mailbox(mailbox),
        None => Vec::new(),
    }
}

/// 入参校验：内容非空且 ≤2000 字（§4.11.8），mode 归一化（未知值宽容归 soft）。返回归一化 mode。
fn validate_inject_input(content: &str, mode: &str) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("插话内容不能为空".into());
    }
    if trimmed.chars().count() > 2000 {
        return Err("插话过长（单条 ≤2000 字，超出请拆分或贴附件）".into());
    }
    let mode = match mode.trim() {
        "hard" => "hard",
        "pre_talk" | "preTalk" | "pre-talk" => "pre_talk",
        _ => "soft",
    };
    Ok(mode.to_string())
}

/// 注入形态（§4.11.3，对齐单 Agent takeover）：user 消息 + 稳定指令（§4.11.8 优先级约定）。
fn format_inject_user_msg(content: &str) -> String {
    format!(
        "（用户打断补充：{content}\n以上为用户运行中插入的补充指示，优先级高于原任务指令中与之冲突的部分；若与既有做法冲突，先列出待改点再继续执行。）"
    )
}

/// 预嘱段渲染（任务启动前合并进 prompt，优先级最高段）。
fn render_pre_talk_section(notes: &[InjectNote]) -> String {
    let mut s = String::from("## 用户预嘱（任务启动前补充，优先级最高）\n");
    for n in notes {
        s.push_str(&format!("- {}\n", n.content));
    }
    s
}

/// 群聊插话段渲染（成员发言前合并进 user 消息）。
fn render_inject_section(notes: &[InjectNote]) -> String {
    let mut s = String::from("## 用户插话（运行中打断，请优先回应）\n");
    for n in notes {
        s.push_str(&format!("- {}\n", n.content));
    }
    s
}

fn squad_inject_event_payload(
    inject_id: &str,
    squad_id: &str,
    session_id: &str,
    task_id: &str,
    mode: &str,
) -> events::SquadInjectEventPayload {
    events::SquadInjectEventPayload {
        inject_id: inject_id.to_string(),
        squad_id: squad_id.to_string(),
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
        mode: mode.to_string(),
    }
}

/// DB 层：插话标记已投递（消费点异步回调，尽力而为不阻塞成员执行）。
async fn squad_inject_mark_delivered(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    session_id: &str,
    target: &str,
    notes: &[InjectNote],
) {
    for n in notes {
        let _ = sqlx::query(
            "UPDATE agent_squad_inject SET status='delivered', delivered_at=? WHERE id=?",
        )
        .bind(now_ms())
        .bind(&n.id)
        .execute(pool)
        .await;
        events::emit_squad_inject_delivered(
            app,
            &squad_inject_event_payload(&n.id, squad_id, session_id, target, &n.mode),
        );
    }
}

/// DB 层：会话收尾时把仍未消费的插话标记 dropped（终态不可达即未送达，§4.11.6）。
/// 同时摘除注册表条目（幂等：SquadInjectGuard Drop 再摘一次无副作用）。
async fn squad_inject_flush_session(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    session_id: &str,
) {
    // 同一信箱可能挂多个别名键：排空后按 note id 去重，防重复标记。
    let remaining: Vec<(String, Vec<InjectNote>)> = {
        let g = SQUAD_INJECTS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = g.as_ref().and_then(|m| m.get(session_id)) else {
            return;
        };
        entry
            .targets
            .iter()
            .map(|(k, m)| (k.clone(), squad_inject_take_mailbox(m)))
            .filter(|(_, notes)| !notes.is_empty())
            .collect()
    };
    let mut seen = std::collections::HashSet::new();
    for (target, notes) in remaining {
        for n in &notes {
            if !seen.insert(n.id.clone()) {
                continue;
            }
            let _ = sqlx::query("UPDATE agent_squad_inject SET status='dropped' WHERE id=?")
                .bind(&n.id)
                .execute(pool)
                .await;
            events::emit_squad_inject_dropped(
                app,
                &squad_inject_event_payload(&n.id, squad_id, session_id, &target, &n.mode),
            );
        }
    }
    let mut g = SQUAD_INJECTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut() {
        map.remove(session_id);
    }
}

/// 用户插话入口（Tauri 命令 squad_inject_send / API /inject 共用）。
/// 校验（无人值守拒绝 / 频率 ≥2s / 长度 ≤2000）→ 落表（queued）→ 落 round（kind='inject'）→ 入信箱。
/// 返回 inject_id。
pub async fn squad_inject_send(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    session_id: &str,
    target: &str,
    content: &str,
    mode: &str,
) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("缺少插话目标（任务 / 成员）".into());
    }
    let mode = validate_inject_input(content, mode)?;
    let content = content.trim().to_string();

    let mailbox = {
        let mut g = SQUAD_INJECTS.lock().unwrap_or_else(|e| e.into_inner());
        let entry = g
            .get_or_insert_with(std::collections::HashMap::new)
            .get_mut(session_id)
            .ok_or_else(|| "协作会话未在运行，无法插话".to_string())?;
        // §4.11.8：无人值守（schedule/api）默认忽略全部说话路径——统一拒绝。
        if entry.unattended {
            return Err("无人值守会话（schedule/api）不支持插话".into());
        }
        // 频率限制：单目标 ≥2s。
        let now = now_ms();
        if let Some(last) = entry.last_send_ms.get(target) {
            if now - *last < 2000 {
                return Err("插话太频繁（单目标间隔 ≥2 秒）".into());
            }
        }
        entry.last_send_ms.insert(target.to_string(), now);
        // 目标不存在（未绑定的任务/成员）→ 拒绝，防「以为送达了」。
        if !entry.targets.contains_key(target) {
            return Err(format!("插话目标「{target}」不存在或未在运行"));
        }
        entry
            .targets
            .get(target)
            .cloned()
            .unwrap_or_default()
    };

    let inject_id = format!(
        "sqij_{}_{:05}",
        now_ms(),
        ROUND_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    // 审计落表（queued）。
    let _ = sqlx::query(
        "INSERT INTO agent_squad_inject (id, squad_id, session_id, task_id, run_id, source, mode, content, status, created_at, delivered_at) \
         VALUES (?, ?, ?, ?, NULL, 'user', ?, ?, 'queued', ?, NULL)",
    )
    .bind(&inject_id)
    .bind(squad_id)
    .bind(session_id)
    .bind(target)
    .bind(&mode)
    .bind(&content)
    .bind(now_ms())
    .execute(pool)
    .await;

    // 审计链：round 流水（kind='inject'）。
    let mode_label = match mode.as_str() {
        "hard" => "打断",
        "pre_talk" => "预嘱",
        _ => "补充",
    };
    let round_note = format!("→ {target}（用户{mode_label}）：{content}");
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '用户插话', ?, 'inject', ?)",
    )
    .bind(round_id())
    .bind(squad_id)
    .bind(session_id)
    .bind(&round_note)
    .bind(now_ms())
    .execute(pool)
    .await;
    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "用户插话".into(),
            kind: "inject".into(),
            content: round_note,
        },
    );
    events::emit_squad_inject_queued(
        app,
        &squad_inject_event_payload(&inject_id, squad_id, session_id, target, &mode),
    );

    // 最后入信箱（校验全部通过后才可见，消费者不会看到校验失败的插话）。
    mailbox.lock().unwrap_or_else(|e| e.into_inner()).push(InjectNote {
        id: inject_id.clone(),
        mode,
        content,
    });
    tracing::info!("[squad] 插话入队：session={session_id} target={target} inject={inject_id}");
    Ok(inject_id)
}

/* ------------------------------------------------------------------ *
 * S2（§4.6 L2）检查点：manual 模式每个 Wave 完成后挂起等决议（继续 / 返工）。
 * ------------------------------------------------------------------ */

struct CheckpointGate {
    /// None=待决议；Some("continue"|"rework")=已决议（resolve 置值不摘除，摘除统一收尾）。
    decision: Arc<std::sync::Mutex<Option<String>>>,
}

static SQUAD_CHECKPOINTS: std::sync::Mutex<Option<std::collections::HashMap<String, CheckpointGate>>> =
    std::sync::Mutex::new(None);

/// 决议归一化：rework（返工）之外的值一律视为 continue（宽容，防前端拼写差异卡死）。
fn normalize_checkpoint_decision(decision: &str) -> &'static str {
    if decision.trim().eq_ignore_ascii_case("rework") {
        "rework"
    } else {
        "continue"
    }
}

/// 用户决议入口（Tauri 命令 squad_checkpoint_resolve 调用）。返回是否命中挂起的检查点。
pub fn resolve_squad_checkpoint(session_id: &str, decision: &str) -> bool {
    let normalized = normalize_checkpoint_decision(decision).to_string();
    let g = SQUAD_CHECKPOINTS.lock().unwrap_or_else(|e| e.into_inner());
    let Some(map) = g.as_ref() else { return false };
    match map.get(session_id) {
        Some(gate) => {
            *gate.decision.lock().unwrap_or_else(|e| e.into_inner()) = Some(normalized);
            true
        }
        None => false,
    }
}

/// 挂起等待检查点决议（manual 专用；每 2s 轮询）。取消 → None；正常返回 Some(decision)。
async fn wait_checkpoint_gate(
    session_id: &str,
    squad_cancel: &Arc<AtomicBool>,
) -> Option<String> {
    loop {
        if squad_cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return None;
        }
        let decision = {
            let g = SQUAD_CHECKPOINTS.lock().unwrap_or_else(|e| e.into_inner());
            g.as_ref()
                .and_then(|m| m.get(session_id))
                .and_then(|gate| gate.decision.lock().unwrap_or_else(|e| e.into_inner()).clone())
        };
        match decision {
            Some(d) => return Some(d),
            None => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
        }
    }
}

/// 清理检查点 gate（决议读取后收尾防泄漏）。
fn remove_checkpoint_gate(session_id: &str) {
    let mut g = SQUAD_CHECKPOINTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut() {
        map.remove(session_id);
    }
}

/// 挂起一个检查点：落 checkpoint round + 事件 → 等决议 → 决议 system round + 事件。
/// 返回 Some("continue"|"rework")；取消返回 None（调用方按取消收尾）。
async fn squad_checkpoint_hang(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    session_id: &str,
    note: &str,
    squad_cancel: &Arc<AtomicBool>,
) -> Option<String> {
    SQUAD_CHECKPOINTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(std::collections::HashMap::new)
        .insert(
            session_id.to_string(),
            CheckpointGate {
                decision: Arc::new(std::sync::Mutex::new(None)),
            },
        );
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) VALUES (?, ?, ?, NULL, '系统', ?, 'checkpoint', ?)",
    )
    .bind(round_id())
    .bind(squad_id)
    .bind(session_id)
    .bind(note)
    .bind(now_ms())
    .execute(pool)
    .await;
    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "系统".into(),
            kind: "checkpoint".into(),
            content: note.to_string(),
        },
    );
    let decision = match wait_checkpoint_gate(session_id, squad_cancel).await {
        Some(d) => d,
        // 取消路径也要摘除 gate，防注册表残留（session_id 每次 run 都新建，残留即永久泄漏）。
        None => {
            remove_checkpoint_gate(session_id);
            return None;
        }
    };
    remove_checkpoint_gate(session_id);
    let decision_normalized = normalize_checkpoint_decision(&decision);
    let follow = if decision_normalized == "rework" {
        "↩️ 检查点决议：返工本波任务。"
    } else {
        "✅ 检查点决议：继续执行。"
    };
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) VALUES (?, ?, ?, NULL, '系统', ?, 'system', ?)",
    )
    .bind(round_id())
    .bind(squad_id)
    .bind(session_id)
    .bind(follow)
    .bind(now_ms())
    .execute(pool)
    .await;
    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "系统".into(),
            kind: "system".into(),
            content: follow.to_string(),
        },
    );
    Some(decision_normalized.to_string())
}

/* ------------------------------------------------------------------ *
 * S2（§4.6 L4）交付确认：Delivery Pack 生成后 manual 模式挂起等确认。
 * ------------------------------------------------------------------ */

struct DeliveryGate {
    /// None=待决议；Some(true)=确认交付；Some(false)=要求修订。
    approved: Arc<std::sync::Mutex<Option<bool>>>,
}

static SQUAD_DELIVERY_GATES: std::sync::Mutex<Option<std::collections::HashMap<String, DeliveryGate>>> =
    std::sync::Mutex::new(None);

/// 用户决议入口（Tauri 命令 squad_delivery_resolve 调用）。返回是否命中挂起的交付门禁。
pub fn resolve_squad_delivery(session_id: &str, approved: bool) -> bool {
    let g = SQUAD_DELIVERY_GATES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(map) = g.as_ref() else { return false };
    match map.get(session_id) {
        Some(gate) => {
            *gate.approved.lock().unwrap_or_else(|e| e.into_inner()) = Some(approved);
            true
        }
        None => false,
    }
}

/// 挂起等待交付确认。取消 → false。
async fn wait_delivery_gate(
    session_id: &str,
    squad_cancel: &Arc<AtomicBool>,
) -> bool {
    loop {
        if squad_cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        // gate 缺失（异常路径）→ 视为确认放行，防卡死。
        let decision = {
            let g = SQUAD_DELIVERY_GATES.lock().unwrap_or_else(|e| e.into_inner());
            match g.as_ref().and_then(|m| m.get(session_id)) {
                None => Some(true),
                Some(gate) => gate.approved.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            }
        };
        match decision {
            Some(v) => return v,
            None => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
        }
    }
}

/// 交付确认门禁（三模式 done 收尾前调用，manual 专用）：
/// session 置 awaiting_delivery → 落 delivery round + 事件 → 等决议 → 清理。
/// 返回 true=确认交付（继续 done 收尾）；false=要求修订 / 取消（调用方按取消收尾）。
async fn gate_delivery_confirm(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    squad_id: &str,
    session_id: &str,
    squad_cancel: &Arc<AtomicBool>,
) -> bool {
    let _ = sqlx::query("UPDATE agent_squad_session SET status='awaiting_delivery', updated_at=? WHERE id=?")
        .bind(now_ms())
        .bind(session_id)
        .execute(pool)
        .await;
    SQUAD_DELIVERY_GATES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(std::collections::HashMap::new)
        .insert(
            session_id.to_string(),
            DeliveryGate {
                approved: Arc::new(std::sync::Mutex::new(None)),
            },
        );
    let note = "📦 Delivery Pack 已生成，等待交付确认（确认交付 / 要求修订）。";
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) VALUES (?, ?, ?, NULL, '系统', ?, 'delivery', ?)",
    )
    .bind(round_id())
    .bind(squad_id)
    .bind(session_id)
    .bind(note)
    .bind(now_ms())
    .execute(pool)
    .await;
    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "系统".into(),
            kind: "delivery".into(),
            content: note.to_string(),
        },
    );
    let approved = wait_delivery_gate(session_id, squad_cancel).await;
    let mut g = SQUAD_DELIVERY_GATES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(map) = g.as_mut() {
        map.remove(session_id);
    }
    approved
}

/// round 主键进程内序号（并行 Wave 下 now_ms 同毫秒会撞主键，叠序号保唯一）。
static ROUND_SEQ: AtomicU64 = AtomicU64::new(0);
fn round_id() -> String {
    format!("sqr_{}_{:05}", now_ms(), ROUND_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

/// S1（§4.5）：黑板 L2 状态板（board_json 列）——任务状态机 + handoff 引用 + 全队产物索引。
/// 单写者=调度协程；Wave 内并行成员不直接 UPDATE session 行（读-改-写会丢更新）。
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct BoardTask {
    title: String,
    assignee: String,
    /// pending | running | done | failed | skipped
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    handoff_id: Option<String>,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct BoardState {
    /// task_id（t1/t2/...）→ 任务状态
    tasks: BTreeMap<String, BoardTask>,
    /// 全队产物总目录（交接箱相对路径 shared/inbox/{task_id}/{...}）
    artifacts_index: Vec<String>,
    /// S1 决策卡（群聊共识 / 关键决定；agent_squad_decision 表的 board 挂载视图）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    decisions: Vec<BoardDecision>,
}

async fn persist_board(pool: &sqlx::SqlitePool, session_id: &str, board: &BoardState) {
    match serde_json::to_string(board) {
        Ok(json) => {
            let _ = sqlx::query("UPDATE agent_squad_session SET board_json=? WHERE id=?")
                .bind(json)
                .bind(session_id)
                .execute(pool)
                .await;
        }
        Err(e) => tracing::warn!("[squad] board_json 序列化失败：{e}"),
    }
}

/// S1（§4.4.5）：决策卡（黑板 L2）——群聊共识结构化落下，供后续生产波继承。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct BoardDecision {
    kind: String, // plan | risk | scope
    text: String,
}

/// 宽容解析汇总文本中的【squad-decisions】JSON 尾块；无标记/解析失败返回空（不报错）。
fn parse_squad_decisions(summary: &str) -> Vec<BoardDecision> {
    const MARK: &str = "【squad-decisions】";
    let Some(idx) = summary.find(MARK) else {
        return Vec::new();
    };
    let tail = summary[idx + MARK.len()..].trim();
    // 去掉可能的代码围栏
    let json_str = tail
        .strip_prefix("```json")
        .or_else(|| tail.strip_prefix("```"))
        .unwrap_or(tail);
    let json_str = json_str
        .split("```")
        .next()
        .unwrap_or("");
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str.trim()) else {
        return Vec::new();
    };
    v.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let text = item.get("text")?.as_str()?.trim().to_string();
                    if text.is_empty() {
                        return None;
                    }
                    let kind = item
                        .get("kind")
                        .and_then(|k| k.as_str())
                        .unwrap_or("scope")
                        .to_string();
                    let kind = matches!(kind.as_str(), "plan" | "risk" | "scope")
                        .then_some(kind)
                        .unwrap_or_else(|| "scope".into());
                    Some(BoardDecision { kind, text })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 决策卡落库（agent_squad_decision 表 + board_json.decisions 挂载）。
async fn persist_decisions(
    pool: &sqlx::SqlitePool,
    app: &AppHandle,
    squad_id: &str,
    session_id: &str,
    decisions: &[BoardDecision],
) {
    if decisions.is_empty() {
        return;
    }
    for d in decisions {
        let _ = sqlx::query(
            "INSERT INTO agent_squad_decision (id, squad_id, session_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(round_id())
        .bind(squad_id)
        .bind(session_id)
        .bind(&d.kind)
        .bind(&d.text)
        .bind(now_ms())
        .execute(pool)
        .await;
    }
    // board_json 挂载决策引用（读-改-写：会话终态单点，无并发写者）
    if let Ok(Some((bj,))) = sqlx::query_as::<_, (Option<String>,)>(
        "SELECT board_json FROM agent_squad_session WHERE id=?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    {
        let mut board: BoardState = bj
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        board.decisions.extend(decisions.iter().cloned());
        if let Ok(json) = serde_json::to_string(&board) {
            let _ = sqlx::query("UPDATE agent_squad_session SET board_json=? WHERE id=?")
                .bind(json)
                .bind(session_id)
                .execute(pool)
                .await;
        }
    }
    tracing::info!("[squad] 决策卡落盘：session={session_id} 共 {} 条", decisions.len());
    let _ = app;
}

/// Mission Contract 快照落库（§4.3 团队版交付合同：任务分工/依赖/期望产物）。
async fn persist_contract(pool: &sqlx::SqlitePool, session_id: &str, contract_json: &serde_json::Value) {
    let _ = sqlx::query("UPDATE agent_squad_session SET contract_json=? WHERE id=?")
        .bind(contract_json.to_string())
        .bind(session_id)
        .execute(pool)
        .await;
}

/// 计算某成员的运行工作目录。
///
/// - 若 squad 配置了用户自选根目录（`workspace`，非空），成员工作区为 `{root}/{agent_id}`；
/// - 否则回退默认隔离目录 `.wd_mem/squads/{squad_id}/{agent_id}`。
fn squad_member_workspace(workspace: &Option<String>, squad_id: &str, agent_id: &str) -> String {
    let rel = match workspace {
        Some(root) if !root.trim().is_empty() => {
            let trimmed = root.trim().trim_end_matches(['/', '\\']);
            format!("{}/{}", trimmed, agent_id)
        }
        _ => format!(".wd_mem/squads/{}/{}", squad_id, agent_id),
    };
    // S0 修复（2026-09-28 真机实证）：必须返回**绝对路径**——相对路径会让 PathGuard
    // 的边界比对出现「相对目标 vs canonicalize 后的绝对工作空间」形态不一致，
    // 成员所有 write/archive 全被误判「路径越界」，子任务预算耗尽被跳过。
    if std::path::Path::new(&rel).is_absolute() {
        return rel;
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(&rel).to_string_lossy().to_string(),
        Err(_) => rel,
    }
}

/// 运行一次小分队协作任务（编排式）。
///
/// 流程：建会话 → 选主管 → 主管规划委派 → 逐子任务派成员执行（带重试）→ leader 汇总。
/// 每个成员运行在独立私有的 `.wd_mem/squads/{squad_id}/{agent_id}/` 工作区，互不干扰。
#[tracing::instrument(skip_all)]
pub async fn run_squad_task(app: &AppHandle, squad: SquadRuntimeConfig, prompt: String) {
    tracing::info!("[squad] 代码指纹 F4：run_squad_task 启动（应含 S0-4 全部：锁/事件/metrics/墙钟）");
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[squad] run_squad_task: 获取数据库失败：{e}");
            return;
        }
    };

    // S0-4a（2026-09-28）：会话 id 去时戳化——纳秒精度 + 进程内序号，消除「同毫秒并发建队」
    // 的 session_id 碰撞面（v1.4 §11：原 format!("sqs_{now_ms}") 同毫秒即撞）。
    let session_id = format!(
        "sqs_{}_{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(now_ms()),
        SQUAD_SESSION_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    squad_metrics_register_budget(&session_id, squad.run_strategy.budget_tokens);
    // S0-3 取消穿线：注册 squad 级取消标志（guard Drop 回收；cancel_squad_sessions 置位）。
    let squad_cancel = Arc::new(AtomicBool::new(false));
    {
        let mut g = SQUAD_CANCELS.lock().unwrap_or_else(|e| e.into_inner());
        g.get_or_insert_with(std::collections::HashMap::new).insert(
            session_id.clone(),
            (squad.squad_id.clone(), squad_cancel.clone()),
        );
    }
    let _cancel_guard = SquadCancelGuard(session_id.clone());
    // S2（§4.11）：打断说话信箱注册——无人值守（schedule/api）会话拒绝一切插话（§4.11.8 三路统一）。
    let unattended = matches!(squad.run_strategy.execution_mode.as_str(), "schedule" | "api");
    squad_inject_register_session(&session_id, unattended);
    let _inject_guard = SquadInjectGuard(session_id.clone());
    let title = prompt.chars().take(120).collect::<String>();
    let mode = squad.mode.clone();
    let _ = sqlx::query(
        "INSERT INTO agent_squad_session (id, squad_id, title, mode, status, snapshot, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 'running', NULL, ?, ?)",
    )
    .bind(&session_id)
    .bind(&squad.squad_id)
    .bind(&title)
    .bind(&mode)
    .bind(now_ms())
    .bind(now_ms())
    .execute(&pool)
    .await;

    events::emit_squad_session_started(
        app,
        &events::SquadSessionStartedPayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.clone(),
            mode: mode.clone(),
        },
    );

    // 按协作模式分派：pipeline / chat 走专用路径，其余默认编排式（orchestrator）。
    match squad.mode.as_str() {
        "pipeline" => {
            run_squad_pipeline(app, &squad, &prompt, &pool, &session_id, &squad_cancel).await;
            return;
        }
        "chat" => {
            run_squad_chat(app, &squad, &prompt, &pool, &session_id, &squad_cancel).await;
            return;
        }
        _ => {}
    }

    // 选出主管：is_leader > leader_agent_id 匹配 > 首个成员（兜底）。
    let leader = squad
        .members
        .iter()
        .find(|m| m.is_leader)
        .or_else(|| {
            squad
                .leader_agent_id
                .as_ref()
                .and_then(|lid| squad.members.iter().find(|m| m.agent.agent_id == *lid))
        })
        .or_else(|| squad.members.first())
        .cloned();

    let leader = match leader {
        Some(l) => l,
        None => {
            tracing::warn!("[squad] run_squad_task: 无可用主管成员，会话按失败收尾");
            finish_squad_session(app, &pool, &squad.squad_id, &session_id, "failed", "无可用主管成员，任务无法执行").await;
            return;
        }
    };

    // 主管规划委派。
    let delegated = plan_squad_delegation(&leader.agent, &prompt, &squad.members, &squad_cancel, &session_id).await;
    // S1 批次2：Mission Contract 快照落库（§4.3）——委派完成即固化任务分工/依赖/期望产物。
    if !delegated.is_empty() {
        let contract = serde_json::json!({
            "mission": prompt,
            "mode": "orchestrator",
            "tasks": delegated
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    serde_json::json!({
                        "taskId": format!("t{}", i + 1),
                        "title": t.title,
                        "assignee": t.assignee,
                        "dependsOn": t.depends_on,
                        "expectedArtifacts": t.expected_artifacts,
                    })
                })
                .collect::<Vec<_>>(),
        });
        persist_contract(&pool, &session_id, &contract).await;
    }
    if !delegated.is_empty() {
        let plan_text = delegated
            .iter()
            .enumerate()
            .map(|(i, t)| format!("{}. [{}] {}", i + 1, t.assignee, t.title))
            .collect::<Vec<_>>()
            .join("\n");
        events::emit_squad_round(
            app,
            &events::SquadRoundPayload {
                squad_id: squad.squad_id.clone(),
                session_id: session_id.clone(),
                speaker_agent_id: Some(leader.agent.agent_id.clone()),
                role: leader.role.clone(),
                kind: "delegation".into(),
                content: format!("任务委派规划：\n{plan_text}"),
            },
        );
    }

    let mut context = String::new();
    let retry = squad.run_strategy.retry_count.max(1) as usize;
    // P2-3 模式感知恢复（与 run_squad_pipeline 同源）：schedule/api 视为无人值守。
    // （S2：unattended 已在会话注册段提前计算——信箱注册需要它；此处不再重复。）

    // ===== S2（§4.6 L1）：团队计划门禁——manual 模式下委派计划挂起等用户批准 =====
    if !delegated.is_empty() && !unattended {
        let plan_text = delegated
            .iter()
            .enumerate()
            .map(|(i, t)| format!("{}. [{}] {}", i + 1, t.assignee, t.title))
            .collect::<Vec<_>>()
            .join("\n");
        SQUAD_PLAN_GATES.lock().unwrap_or_else(|e| e.into_inner())
            .get_or_insert_with(std::collections::HashMap::new)
            .insert(
                session_id.clone(),
                PlanGate {
                    approved: Arc::new(std::sync::Mutex::new(None)),
                },
            );
        let plan_note = format!(
            "⏸️ 计划待批准（L1 计划门禁）：\n{}\n\n请在运行控制台批准或拒绝本次委派计划。",
            plan_text
        );
        let _ = sqlx::query(
            "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, 'plan', ?)",
        )
        .bind(round_id())
        .bind(&squad.squad_id)
        .bind(&session_id)
        .bind(&leader.agent.agent_id)
        .bind(&leader.role)
        .bind(&plan_note)
        .bind(now_ms())
        .execute(&pool)
        .await;
        events::emit_squad_round(
            app,
            &events::SquadRoundPayload {
                squad_id: squad.squad_id.clone(),
                session_id: session_id.clone(),
                speaker_agent_id: Some(leader.agent.agent_id.clone()),
                role: leader.role.clone(),
                kind: "plan".into(),
                content: plan_note,
            },
        );
        let ok = wait_plan_gate(&session_id, &squad_cancel).await;
        remove_plan_gate(&session_id);
        if !ok {
            // 用户拒绝（或取消）：委派计划未获批准，会话以 cancelled 收尾。
            finish_squad_session(app, &pool, &squad.squad_id, &session_id, "cancelled", "委派计划未获批准，协作已取消").await;
            return;
        }
        let _ = sqlx::query(
            "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) VALUES (?, ?, ?, NULL, '系统', ?, 'system', ?)",
        )
        .bind(round_id())
        .bind(&squad.squad_id)
        .bind(&session_id)
        .bind("✅ 计划已批准，开始执行。")
        .bind(now_ms())
        .execute(&pool)
        .await;
        events::emit_squad_round(
            app,
            &events::SquadRoundPayload {
                squad_id: squad.squad_id.clone(),
                session_id: session_id.clone(),
                speaker_agent_id: None,
                role: "系统".into(),
                kind: "system".into(),
                content: "✅ 计划已批准，开始执行。".into(),
            },
        );
    }

    // ===== S1（设计方案 v1.4 §4.4.3）：HandoffBundle 交接 + dependsOn 拓扑 + Wave 并行 =====
    // 感知机制由调度器做（不是模型做）：任务 done 后扫描依赖解锁，下游启动时注入上游交接段。
    let n = delegated.len();
    let dep_idx: Vec<Vec<usize>> = delegated
        .iter()
        .map(|t| {
            t.depends_on
                .iter()
                .filter_map(|d| {
                    delegated
                        .iter()
                        .position(|x| x.title == *d && x.title != t.title)
                })
                .collect()
        })
        .collect();
    let inbox_root = squad_shared_inbox(&squad.squad_id);
    let mut board = BoardState::default();
    for (i, t) in delegated.iter().enumerate() {
        board.tasks.insert(
            format!("t{}", i + 1),
            BoardTask {
                title: t.title.clone(),
                assignee: t.assignee.clone(),
                status: "pending".into(),
                handoff_id: None,
            },
        );
    }
    persist_board(&pool, &session_id, &board).await;

    // S2（§4.11）：会话启动即为全部任务绑定信箱——pre_talk 才能投递给「还没开始」的任务。
    // primary=成员 agent_id（同成员多任务共享信箱，per-agent 键本就串行），task_id 作别名键。
    for (i, t) in delegated.iter().enumerate() {
        let member = match_member(&squad.members, &t.assignee).unwrap_or(&leader);
        squad_inject_bind(&session_id, &member.agent.agent_id, &[&format!("t{}", i + 1)]);
    }

    let mut done = vec![false; n];
    let mut skipped = vec![false; n];
    let mut handoffs: Vec<Option<HandoffBundle>> = vec![None; n];
    let mut budget_warned = false;
    let mut wave_count = 0usize; // L2 检查点文案用（完成的波数）
    loop {
        // S0-3 取消检测点：squad 级取消 → 立即收尾（status=cancelled，成员 pipeline 自身也会被同一标志中断）。
        if squad_cancel.load(std::sync::atomic::Ordering::SeqCst) {
            finish_squad_session(app, &pool, &squad.squad_id, &session_id, "cancelled", "任务已被用户取消").await;
            return;
        }
        // S2 预算闸门：≥80% 告警一次；≥100% 软熔断（不再启动新 Wave，已完成产物保留）。
        let budget = squad_metrics_budget(&session_id);
        if budget > 0 {
            let used = squad_metrics_used(&session_id);
            if used * 100 >= budget * 80 && !budget_warned {
                budget_warned = true;
                let note = format!("⚠️ 预算告警：已用 {used} / {budget} tokens（≥80%），请关注成本。");
                let _ = sqlx::query(
                    "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) VALUES (?, ?, ?, NULL, '系统', ?, 'system', ?)",
                )
                .bind(round_id())
                .bind(&squad.squad_id)
                .bind(&session_id)
                .bind(&note)
                .bind(now_ms())
                .execute(&pool)
                .await;
                events::emit_squad_round(
                    app,
                    &events::SquadRoundPayload {
                        squad_id: squad.squad_id.clone(),
                        session_id: session_id.clone(),
                        speaker_agent_id: None,
                        role: "系统".into(),
                        kind: "system".into(),
                        content: note,
                    },
                );
            }
            if used >= budget {
                let note = format!("🛑 预算耗尽软熔断：已用 {used} ≥ 预算 {budget} tokens，停止启动新子任务，已完成产物保留。");
                finish_squad_session(app, &pool, &squad.squad_id, &session_id, "done", &note).await;
                return;
            }
        }
        // 就绪集合：pending 且依赖全部完成。
        let ready: Vec<usize> = (0..n)
            .filter(|&i| !done[i] && !skipped[i] && dep_idx[i].iter().all(|&d| done[d]))
            .collect();
        if ready.is_empty() {
            // 死锁（循环依赖/依赖失败未解除）：剩余任务全部标 skipped，带说明。
            let remaining: Vec<usize> = (0..n).filter(|&i| !done[i] && !skipped[i]).collect();
            for i in remaining {
                skipped[i] = true;
                if let Some(b) = board.tasks.get_mut(&format!("t{}", i + 1)) {
                    b.status = "skipped".into();
                }
                context.push_str(&format!(
                    "\n\n[{}] （子任务「{}」因依赖无法满足未执行）\n",
                    delegated[i].assignee, delegated[i].title
                ));
            }
            break;
        }

        // 波次准备：上游投递 + 注入段构造（主协程做——board 单写者 + 磁盘拷贝串行无竞争）。
        let mut wave: Vec<(usize, String, String, String, AgentRuntimeConfig, String, Arc<std::sync::Mutex<Vec<InjectNote>>>, crate::agent::types::SquadToolProfile)> = Vec::new(); // (idx, task_id, prompt, ws, member_cfg, role, inject_mailbox, tool_profile)
        let mut wave_tasks: Vec<(usize, String)> = Vec::new(); // (idx, task_id)——L2 检查点返工回退用
        for &i in &ready {
            let task = &delegated[i];
            let member = match_member(&squad.members, &task.assignee).unwrap_or(&leader);
            let ws = squad_member_workspace(&squad.workspace, &squad.squad_id, &member.agent.agent_id);
            let task_id = format!("t{}", i + 1);
            // 直接上游的 Handoff 投递到本成员私有区 inbox（PathGuard 天然放行）。
            let ups = &dep_idx[i];
            let mut sections = String::new();
            for (k, &u) in ups.iter().enumerate() {
                if let Some(b) = &handoffs[u] {
                    let delivered =
                        deliver_handoff_to_downstream(&inbox_root, &ws, &format!("t{}", u + 1), b);
                    sections.push_str(&render_handoff_section(k + 1, ups.len(), b, &delivered));
                    sections.push('\n');
                }
            }
            // 注入优先 Handoff；全部上游无 Handoff（旧 schema/失败空产）→ 回退文本拼接兼容路径。
            let subtask_prompt = if !sections.is_empty() {
                format!("{}\n\n{sections}", task.instruction)
            } else if context.is_empty() {
                task.instruction.clone()
            } else {
                format!(
                    "{}\n\n## 前序成员产出（仅供参考，可引用其结论）\n{}",
                    task.instruction, context
                )
            };
            // S2（§4.11）：绑定信箱（primary=agent_id，task_id 别名；会话启动已绑过，此处幂等）+
            // 预嘱注入——任务启动前排空该信箱全部待达插话，合并为最高优先级段。
            let inject_mailbox = squad_inject_bind(&session_id, &member.agent.agent_id, &[&task_id]);
            let pre_notes = squad_inject_take_mailbox(&inject_mailbox);
            let subtask_prompt = if pre_notes.is_empty() {
                subtask_prompt
            } else {
                tracing::info!("[squad] 任务 {task_id} 启动前注入用户预嘱 {} 条", pre_notes.len());
                squad_inject_mark_delivered(app, &pool, &squad.squad_id, &session_id, &task_id, &pre_notes).await;
                format!("{}\n\n{}", subtask_prompt, render_pre_talk_section(&pre_notes))
            };
            if let Some(b) = board.tasks.get_mut(&task_id) {
                b.status = "running".into();
            }
            wave_tasks.push((i, task_id.clone()));
            wave.push((i, task_id, subtask_prompt, ws, member.agent.clone(), member.role.clone(), inject_mailbox, member.tool_profile.clone()));
        }
        persist_board(&pool, &session_id, &board).await;

        // Wave 并行执行（同成员多任务由 per-agent 锁排队串行；不同成员真并行）。
        let mut futs = Vec::with_capacity(wave.len());
        for (i, task_id, prompt_s, ws, agent_cfg, role, inject_mailbox, tool_profile) in wave {
            // clone 在 move 块外完成（async move 会先 move 原值再 clone，跨迭代即 E0382）。
            let cancel_c = squad_cancel.clone();
            let session_c = session_id.clone();
            // S2（§4.11）：Live inject 安全点钩子——成员 pipeline 工具轮边界排空信箱注入 user
            // 消息；DB delivered 标记经 spawn 异步回写（钩子保持同步，不阻塞执行轮）。
            let inject_hook: pipeline::InjectHook = {
                let app_c = app.clone();
                let pool_c = pool.clone();
                let sq_c = squad.squad_id.clone();
                let sid_c = session_id.clone();
                let tid_c = task_id.clone();
                let mb_c = inject_mailbox.clone();
                Arc::new(move || {
                    let notes = squad_inject_take_mailbox(&mb_c);
                    if notes.is_empty() {
                        return Vec::new();
                    }
                    let msgs: Vec<String> = notes.iter().map(|n| format_inject_user_msg(&n.content)).collect();
                    let (app2, pool2) = (app_c.clone(), pool_c.clone());
                    let (sq2, sid2, tid2) = (sq_c.clone(), sid_c.clone(), tid_c.clone());
                    tauri::async_runtime::spawn(async move {
                        squad_inject_mark_delivered(&app2, &pool2, &sq2, &sid2, &tid2, &notes).await;
                    });
                    msgs
                })
            };
            futs.push(async move {
                let mut out = MemberRunOutput {
                    text: String::new(),
                    usage: (0, 0),
                    wall_ms: 0,
                    success: false,
                };
                let mut last_err = String::new();
                for attempt in 0..retry {
                    match run_member_subtask(
                        app,
                        &agent_cfg,
                        &role,
                        session_c.as_str(),
                        &prompt_s,
                        &ws,
                        unattended,
                        Some(&cancel_c),
                        Some(inject_hook.clone()),
                        &tool_profile,
                    )
                    .await
                    {
                        Ok(o) => {
                            out = o;
                            break;
                        }
                        Err(e) => {
                            last_err = e.clone();
                            tracing::info!(
                                "[squad] 成员 {} 子任务 {task_id} 第 {} 次失败：{}",
                                agent_cfg.agent_id,
                                attempt + 1,
                                e
                            );
                        }
                    }
                }
                if out.text.is_empty() {
                    out.text = format!("（成员 {} 子任务执行失败：{}）", agent_cfg.agent_id, last_err);
                }
                (i, task_id, out, ws)
            });
        }
        let results = futures_util::future::join_all(futs).await;

        // 波次收尾（单写者）：round 落库 + Handoff 生成/留档/落表 + 黑板更新。
        for (i, task_id, out, ws) in results {
            let task = &delegated[i];
            let member = match_member(&squad.members, &task.assignee).unwrap_or(&leader);
            let status = if out.success { "ok" } else { "partial" };

            let _ = sqlx::query(
                "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, 'subtask', ?)",
            )
            .bind(round_id())
            .bind(&squad.squad_id)
            .bind(&session_id)
            .bind(&member.agent.agent_id)
            .bind(&member.role)
            .bind(&out.text)
            .bind(now_ms())
            .execute(&pool)
            .await;

            events::emit_squad_round(
                app,
                &events::SquadRoundPayload {
                    squad_id: squad.squad_id.clone(),
                    session_id: session_id.clone(),
                    speaker_agent_id: Some(member.agent.agent_id.clone()),
                    role: member.role.clone(),
                    kind: "subtask".into(),
                    content: out.text.clone(),
                },
            );

            // HandoffBundle 强制产出（失败也产出，§4.4.2「不允许静默消失」）。
            let bundle = build_handoff_bundle(
                &ws,
                &squad.squad_id,
                &member.agent.agent_id,
                &member.role,
                &task_id,
                &out.text,
                status,
                out.usage,
                out.wall_ms,
                &task.expected_artifacts,
            );
            archive_handoff_to_inbox(&ws, &inbox_root, &task_id, &bundle);
            let handoff_row_id = format!("sqdh_{}_{:05}", now_ms(), ROUND_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
            let bundle_json = serde_json::to_string(&bundle).unwrap_or_default();
            let _ = sqlx::query(
                "INSERT INTO agent_squad_handoff (id, squad_id, session_id, task_id, from_agent_id, status, bundle_json, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&handoff_row_id)
            .bind(&squad.squad_id)
            .bind(&session_id)
            .bind(&task_id)
            .bind(&member.agent.agent_id)
            .bind(status)
            .bind(&bundle_json)
            .bind(now_ms())
            .execute(&pool)
            .await;
            // handoff round（UI 可见交接事件）
            let handoff_note = format!(
                "「{}」{}：{}（产物 {} 项已入交接箱）",
                task.title,
                if status == "ok" { "完成" } else { "受阻" },
                bundle.summary.chars().take(160).collect::<String>(),
                bundle.artifacts.len()
            );
            let _ = sqlx::query(
                "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, 'handoff', ?)",
            )
            .bind(round_id())
            .bind(&squad.squad_id)
            .bind(&session_id)
            .bind(&member.agent.agent_id)
            .bind(&member.role)
            .bind(&handoff_note)
            .bind(now_ms())
            .execute(&pool)
            .await;
            events::emit_squad_round(
                app,
                &events::SquadRoundPayload {
                    squad_id: squad.squad_id.clone(),
                    session_id: session_id.clone(),
                    speaker_agent_id: Some(member.agent.agent_id.clone()),
                    role: member.role.clone(),
                    kind: "handoff".into(),
                    content: handoff_note,
                },
            );

            if let Some(b) = board.tasks.get_mut(&task_id) {
                b.status = if status == "ok" { "done".into() } else { "failed".into() };
                b.handoff_id = Some(handoff_row_id);
            }
            for art in &bundle.artifacts {
                let entry = format!("shared/inbox/{task_id}/{}", art.path);
                // 返工重跑会产生第二次 handoff：同一产物路径只记一条（09-29 真机验证发现的重复项）。
                if !board.artifacts_index.contains(&entry) {
                    board.artifacts_index.push(entry);
                }
            }
            // 兼容路径：文本拼接供 summarize / 无 Handoff 注入回退。
            context.push_str(&format!("\n\n[{}] {}\n", member.role, out.text));
            done[i] = true;
            handoffs[i] = Some(bundle);
        }
        persist_board(&pool, &session_id, &board).await;

        // ===== S2（§4.6 L2）：检查点——manual 模式每个 Wave 完成后挂起（仍有剩余任务时）=====
        // 决议：继续 → 进入下一波；返工 → 本波任务状态回 pending 重新执行（其上游 handoff 保留）；
        // 取消 → 会话 cancelled 收尾。unattended 自动放行（§4.6）。
        wave_count += 1;
        if !unattended && (0..n).any(|i| !done[i] && !skipped[i]) {
            let wave_titles = wave_tasks
                .iter()
                .map(|(_, tid)| {
                    format!(
                        "{tid}「{}」",
                        board.tasks.get(tid).map(|b| b.title.as_str()).unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("、");
            let note = format!(
                "⏸️ 检查点（L2）：第 {wave_count} 波（{wave_titles}）已完成，等待决议（继续 / 返工）。"
            );
            match squad_checkpoint_hang(app, &pool, &squad.squad_id, &session_id, &note, &squad_cancel).await {
                Some(d) if d == "rework" => {
                    for (i, tid) in wave_tasks.iter() {
                        done[*i] = false;
                        if let Some(b) = board.tasks.get_mut(tid.as_str()) {
                            b.status = "pending".into();
                        }
                    }
                    persist_board(&pool, &session_id, &board).await;
                }
                Some(_) => {}
                None => {
                    finish_squad_session(app, &pool, &squad.squad_id, &session_id, "cancelled", "检查点等待期间任务被取消").await;
                    return;
                }
            }
        }
    }

    // 汇总：交给主管总结（若无产出则取最后上下文）。
    let summary = summarize(&leader.agent, &prompt, &context, &squad_cancel, &session_id)
        .await
        .unwrap_or_else(|| context.clone());

    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '汇总', ?, 'summary', ?)",
    )
    .bind(format!("sqr_{}", now_ms()))
    .bind(&squad.squad_id)
    .bind(&session_id)
    .bind(&summary)
    .bind(now_ms())
    .execute(&pool)
    .await;

    write_metrics_round(app, &pool, &squad.squad_id, &session_id).await; // S0-4d metrics 落盘
    build_and_persist_pack(&pool, app, &squad.squad_id, &session_id, "done", &summary).await; // S2 交付包落库
    // ===== S2（§4.6 L4）：交付确认门禁——manual 模式 Pack 生成后挂起等用户确认 =====
    // 确认 → done 收尾；要求修订/取消 → cancelled 收尾（Pack 与产物保留在交接箱）。
    if !unattended {
        if !gate_delivery_confirm(app, &pool, &squad.squad_id, &session_id, &squad_cancel).await {
            finish_squad_session(app, &pool, &squad.squad_id, &session_id, "cancelled", "用户要求修订，会话按取消收尾（已完成产物保留在交接箱）").await;
            return;
        }
    }
    squad_inject_flush_session(app, &pool, &squad.squad_id, &session_id).await; // S2 插话兜底清账

    let _ = sqlx::query(
        "UPDATE agent_squad_session SET status='done', snapshot=?, updated_at=? WHERE id=?",
    )
    .bind(&summary)
    .bind(now_ms())
    .bind(&session_id)
    .execute(&pool)
    .await;

    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.clone(),
            speaker_agent_id: None,
            role: "汇总".into(),
            kind: "summary".into(),
            content: summary.clone(),
        },
    );
    events::emit_squad_session_done(
        app,
        &events::SquadSessionDonePayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.clone(),
            summary,
        },
    );
    tracing::info!(
        "[squad] run_squad_task: 会话 {} 完成，模式={}，子任务数={}",
        session_id,
        mode,
        delegated.len()
    );
}

/// 按角色名或 agent_id 匹配成员；大小写不敏感、支持子串包含。
fn match_member<'a>(
    members: &'a [SquadMemberConfig],
    assignee: &str,
) -> Option<&'a SquadMemberConfig> {
    let a = assignee.trim();
    members
        .iter()
        .find(|m| m.role == a || m.agent.agent_id == a)
        .or_else(|| {
            let lower = a.to_lowercase();
            members
                .iter()
                .find(|m| m.role.to_lowercase().contains(&lower))
        })
}

/// 主管把任务拆解成委派子任务（纯 JSON 数组）。
async fn plan_squad_delegation(
    leader_cfg: &AgentRuntimeConfig,
    prompt: &str,
    members: &[SquadMemberConfig],
    cancel: &Arc<AtomicBool>,
    metrics_session: &str,
) -> Vec<DelegatedTask> {
    let roster = members
        .iter()
        .map(|m| format!("- 角色「{}」（智能体 {}）", m.role, m.agent.agent_id))
        .collect::<Vec<_>>()
        .join("\n");
    let sys = "你是小分队的主管智能体，负责把用户的任务拆解成若干子任务，并委派给合适的成员。\
每个子任务必须指定一个 assignee（填成员的角色名，如「后端开发」），并给出清晰的 instruction（含该成员需要的全部上下文与期望产物）。\
子任务之间有先后依赖时，用 dependsOn 标注前置子任务的 title（无依赖则省略该字段）——无依赖关系的子任务会并行执行。\
可给 expectedArtifacts 列出该子任务必须产出的文件名（如 report.md）。\
只输出一个 JSON 数组，不要任何额外解释，格式严格为：\
[{\"title\":\"子任务标题\",\"assignee\":\"成员角色\",\"instruction\":\"交给该成员的具体指令\",\"dependsOn\":[\"前置子任务标题\"],\"expectedArtifacts\":[\"期望产物文件名\"]}]";
    let user = format!(
        "用户任务：\n{}\n\n可用成员：\n{}\n\n请拆解并委派。",
        prompt, roster
    );
    let messages = vec![
        json!({ "role": "system", "content": sys }),
        json!({ "role": "user", "content": user }),
    ];
    match crate::agent::engine::runtime::call_llm(leader_cfg, &messages, &[], Some(cancel)).await {
        Ok((resp, usage)) => {
            squad_metrics_add_usage(metrics_session, usage);
            // 台账 G10：call_llm 返回归一化层（顶层 content），必须走唯一事实源取文本——
            // 原地钻信封 choices[0].message.content 永远取空，委派 JSON 解析必败。
            let content = extract_llm_content(&resp);
            parse_delegation(&content)
        }
        Err(e) => {
            tracing::warn!("[squad] plan_squad_delegation: LLM 调用失败：{e}");
            Vec::new()
        }
    }
}

fn parse_delegation(content: &str) -> Vec<DelegatedTask> {
    let trimmed = content.trim();
    // 去掉 ```json 围栏（模型偶尔会包裹）。
    let json_str = if let Some(s) = trimmed.strip_prefix("```json") {
        s.strip_suffix("```").unwrap_or(s).trim()
    } else if let Some(s) = trimmed.strip_prefix("```") {
        s.strip_suffix("```").unwrap_or(s).trim()
    } else {
        trimmed
    };
    let v: Value = match serde_json::from_str::<Value>(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|item| {
            let title = item.get("title")?.as_str()?.to_string();
            let assignee = item.get("assignee")?.as_str()?.to_string();
            let instruction = item
                .get("instruction")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            if title.is_empty() || assignee.is_empty() {
                return None;
            }
            // S1：dependsOn / expectedArtifacts（可省略字段，宽容解析）
            let depends_on = item
                .get("dependsOn")
                .and_then(|d| d.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let expected_artifacts = item
                .get("expectedArtifacts")
                .and_then(|d| d.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            Some(DelegatedTask {
                title,
                assignee,
                instruction,
                depends_on,
                expected_artifacts,
            })
        })
        .collect()
}

/// 主管汇总各成员产出为最终结论。
async fn summarize(leader_cfg: &AgentRuntimeConfig, prompt: &str, context: &str, cancel: &Arc<AtomicBool>, metrics_session: &str) -> Option<String> {
    if context.trim().is_empty() {
        return None;
    }
    let sys = "你是小分队主管，请基于各成员的产出，给出本次协作任务的最终汇总结论（简明、可交付）。";
    let user = format!(
        "原始任务：\n{}\n\n各成员产出：\n{}\n\n请给出最终汇总。",
        prompt, context
    );
    let messages = vec![
        json!({ "role": "system", "content": sys }),
        json!({ "role": "user", "content": user }),
    ];
    match crate::agent::engine::runtime::call_llm(leader_cfg, &messages, &[], Some(cancel)).await {
        Ok((resp, usage)) => {
            squad_metrics_add_usage(metrics_session, usage);
            let c = extract_llm_content(&resp);
            if c.is_empty() {
                None
            } else {
                Some(c)
            }
        }
        Err(e) => {
            tracing::warn!("[squad] summarize: LLM 调用失败：{e}");
            None
        }
    }
}

/* ------------------------------------------------------------------ *
 * S2（§4.2）角色工具面：能力层裁剪（allowlist / denylist）
 * ------------------------------------------------------------------ */

/// 单工具保留判定（纯函数，单测覆盖）：inherit 全留；allowlist 只留清单内；denylist 剔除清单内。
/// MCP 工具以注册全名（mcp__{server}__{tool}）匹配，原生工具为 native__* 全名。
fn tool_kept_by_profile(
    name: &str,
    profile: &crate::agent::types::SquadToolProfile,
) -> bool {
    if profile.is_inherit() {
        return true;
    }
    let listed = |list: &[String]| list.iter().any(|t| t == name);
    match profile.mode.as_str() {
        "allowlist" => listed(&profile.native_tools) || listed(&profile.mcp_tools),
        "denylist" => !listed(&profile.native_tools) && !listed(&profile.mcp_tools),
        _ => true,
    }
}

/// 对注册表应用工具面裁剪（规划侧与执行侧都应用，保证大纲与能力同源）。
fn apply_tool_profile(
    registry: &mut ToolRegistry,
    profile: &crate::agent::types::SquadToolProfile,
) {
    if profile.is_inherit() {
        return;
    }
    let before = registry.tool_names().len();
    registry.retain(|name| tool_kept_by_profile(name, profile));
    tracing::info!(
        "[squad] 工具面裁剪（mode={}）：{} → {} 项",
        profile.mode,
        before,
        registry.tool_names().len()
    );
}

/// 以独立 `AgentRuntimeConfig` 运行单个成员的子任务，复用现有 planner + pipeline 路径。
/// S1：成员子任务结构化产出（调度层据此生成 HandoffBundle）。
#[derive(Debug, Clone)]
struct MemberRunOutput {
    text: String,
    usage: (u64, u64),
    wall_ms: u64,
    success: bool,
}

async fn run_member_subtask(
    app: &AppHandle,
    member_cfg: &AgentRuntimeConfig,
    member_role: &str,
    // S0-4d：metrics 归属的 squad 会话 id（成员自身的 graph session 与此不同）。
    metrics_session: &str,
    prompt: &str,
    workspace: &str,
    // P2-3 无人值守模式（schedule/api）：子任务恢复等待超时自动取消整条流水线，防止卡死；
    // manual 模式恒为 false，恢复等待保持永久阻塞（行为不变）。
    unattended: bool,
    // S0-3 取消穿线：squad 级取消标志（编排式主循环传 Some；直接调用方可传 None 保持旧行为）。
    squad_cancel: Option<&Arc<AtomicBool>>,
    // S2（§4.11）：Live inject 安全点钩子（编排器按任务构造；None=无信箱，行为不变）。
    inject_hook: Option<pipeline::InjectHook>,
    // S2（§4.2）：角色工具面（能力层裁剪；inherit=不裁剪）。
    tool_profile: &crate::agent::types::SquadToolProfile,
) -> Result<MemberRunOutput, String> {
    tracing::info!("[squad] run_member_subtask 进入：member={} metrics_session={metrics_session}", member_cfg.agent_id);
    let mut cfg = member_cfg.clone();
    cfg.workspace = Some(workspace.to_string());
    cfg.session_id = None;
    cfg.round_id = None;
    let member_wall = std::time::Instant::now(); // S0-4d：成员墙钟

    // S0-4c（2026-09-28）：成员 run_id 贯穿 + member 事件透出——与单 Agent 同源 next_run_id，
    // 成员 pipeline 包 with_run_id_scope（事件/轨迹落自己的 run 桶，agent_get_run_trace 可查）；
    // member-started/finished 广播给 UI 运行控制台（v1.4 §7 状态映射）。
    let run_id = crate::agent::commands::next_run_id();
    let member_event = |phase: &str, ok: bool, summary: &str| {
        let payload = json!({
            "kind": "squad-member",
            "phase": phase,
            "memberAgentId": cfg.agent_id,
            "memberRole": member_role,
            "runId": run_id,
            "ok": ok,
            "summary": summary,
        });
        crate::agent::events::push_event("squad-member-event", &payload);
        if let Err(e) = app.emit("squad-member-event", &payload) {
            tracing::warn!("[squad] member 事件广播失败：{e}");
        }
    };
    member_event("started", true, prompt);

    // 台账 S6：注册链与能力大纲同源——成员子任务规划与单 Agent run_task 共用 build_full_registry。
    // S2（§4.2）：规划侧注册表先过工具面裁剪——planner_digest 从本表派生，大纲与能力同源。
    let mut plan_registry = crate::agent::engine::runtime::build_full_registry(app, &cfg);
    apply_tool_profile(&mut plan_registry, tool_profile);
    let (plan, _, _) = planner::build_plan(&cfg, prompt, Some(workspace), squad_cancel, &plan_registry, None).await;

    // 图驱动：为每个成员子任务打开独立实体图（按 workspace + 成员 id 区分会话），
    // 规划写入图，运行时状态由图承载，与单 Agent 路径一致。
    let session_id = format!("squad_{}", cfg.agent_id);
    let mut graph = match KnowledgeGraph::open(Some(workspace)) {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!("[squad] 打开成员实体图失败：{e}");
            return Err(format!("成员子任务图初始化失败：{e}"));
        }
    };
    graph.plan_to_graph(&plan, &session_id);

    // 工具注册表（镜像 run_task 分支 B：原生 + MCP；Skill 不再注册为工具，改由 run_subtask 注入 prompt）。
    let mut base = ToolRegistry::new();
    native::register_native_tools(&mut base, app, cfg.allow_sandbox, &cfg.memory_mode);
    let mut by_server: BTreeMap<String, Vec<mcp_adapter::MountedMcpTool>> = Default::default();
    for t in &cfg.mcp_tools {
        by_server.entry(t.mcp_id.clone()).or_default().push(t.clone());
    }
    for (server, tools) in by_server {
        mcp_adapter::register_mcp_into(&mut base, &server, tools);
    }
    // S2（§4.2）：执行侧注册表同款裁剪（与规划侧同一 profile，杜绝「大纲说可用、执行没工具」）。
    apply_tool_profile(&mut base, tool_profile);
    let registry = base;

    let ctx = ToolContext {
        workspace: Some(std::path::PathBuf::from(workspace)),
        sandbox_enabled: cfg.allow_sandbox,
        agent_id: cfg.agent_id.clone(),
        session_id: None,
        run_id: Some(run_id.clone()),
        http_allowed_hosts: cfg.http_allowed_hosts.clone(),
        run_outcomes: Default::default(),
        call_id: None,
    };

    let approval = ApprovalManager::new();
    let recovery = RecoveryHub::new();

    // S0-4b（2026-09-28）：成员执行过 per-agent 锁（v1.4 §11/§9）——此前成员 pipeline 完全
    // 绕锁，成员 agent 若同时被单 Agent 任务占用会并发互踩（tasks 图/审批/恢复）。
    // 语义：占用等待（每 2s 重试，默认最多 30s，`WD_SQUAD_MEMBER_LOCK_WAIT_SECS` 可调），
    // 取消感知（squad 取消立即放弃等待），超时报「成员忙」——**超时改派**需任务重分配
    // 基础设施，落 S1 Wave 并行调度（那里有 assignee 重分配）。
    let _run_guard = {
        let runtime = app.state::<crate::agent::engine::runtime::AgentRuntime>();
        let wait_cap = std::env::var("WD_SQUAD_MEMBER_LOCK_WAIT_SECS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(30);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait_cap);
        loop {
            if let Some(c) = squad_cancel {
                if c.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("子任务被取消：等待成员锁期间 squad 已取消".into());
                }
            }
            match runtime.try_acquire_run_lock(&cfg.agent_id) {
                Some((_, pair)) => break pair,
                None => {
                    if std::time::Instant::now() >= deadline {
                        return Err(format!(
                            "成员 agent {} 忙（运行锁占用超过 {wait_cap}s）——请稍后重试或停止该成员的当前任务",
                            cfg.agent_id
                        ));
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
    };

    // S0-3 取消穿线：pipeline 直接监听 squad 级取消标志（squad 取消 = 成员子任务取消，
    // 单一标志三层贯通；此前局部标志不接 squad 信号，squad 取消时成员 pipeline 继续烧 token）。
    let cancel = squad_cancel.cloned().unwrap_or_else(|| Arc::new(AtomicBool::new(false)));

    // S0-4e（2026-09-28）：成员子任务 run 级墙钟——与单 Agent 对齐（WD_RUN_MAX_SECS 同源，
    // 成员可用 WD_SQUAD_MEMBER_RUN_MAX_SECS 单独覆盖；默认 1800s）。超时强制终止（硬杀），
    // 与单 Agent「软窗口协作收尾 + 墙钟强杀」的最外层兜底等价；graph.snapshot 在超时分支
    // 跳过（pipeline 内部每步已落库，图快照损失可接受）。
    let member_run_limit: u64 = std::env::var("WD_SQUAD_MEMBER_RUN_MAX_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .or_else(|| std::env::var("WD_RUN_MAX_SECS").ok().and_then(|s| s.trim().parse::<u64>().ok()))
        .filter(|v| *v > 0)
        .unwrap_or(1800);
    let result = match tokio::time::timeout(
        std::time::Duration::from_secs(member_run_limit),
        crate::agent::events::with_run_id_scope(
            run_id.clone(),
            pipeline::run_pipeline(
                app,
                &cfg,
                &registry,
                &ctx,
                &approval,
                &mut graph,
                &session_id,
                &cancel,
                &recovery,
                unattended,
                // 小分队无授权集（15007）：策略不适用，维持旧行为
                None,
                inject_hook.as_ref(),
            ),
        ),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            let err = format!(
                "成员子任务运行超时（{member_run_limit}s），已强制终止——可加大 WD_SQUAD_MEMBER_RUN_MAX_SECS / WD_RUN_MAX_SECS 或拆分任务"
            );
            member_event("finished", false, &err);
            tracing::warn!("[squad] 成员 {} {err}", cfg.agent_id);
            return Err(err);
        }
    };
    graph.snapshot(&session_id);

    // S0-4c：member-finished（success 由 pipeline 客观校验给出；summary 取终文截断）
    let summary = result.final_text.chars().take(200).collect::<String>();
    member_event("finished", result.success, &summary);

    if result.cancelled {
        // 问题 1 配套：若取消带系统原因（无人值守超时），一并带入错误串，便于 squad 上层区分。
        let err = match &result.cancel_reason {
            Some(r) => format!("子任务被取消：{r}"),
            None => "子任务被取消".to_string(),
        };
        return Err(err.into());
    }
    // S0-4d：成员 token/墙钟入 per-session 累加器（返回类型保持 String，调用方只消费文本）
    let member_wall_ms = member_wall.elapsed().as_millis() as u64;
    squad_metrics_add_usage(metrics_session, result.usage);
    tracing::info!(
        "[squad] 成员 metrics 入账：{} usage=({},{})",
        member_role,
        result.usage.0,
        result.usage.1
    );
    squad_metrics_add_member(
        metrics_session,
        SquadMemberStat {
            agent_id: cfg.agent_id.clone(),
            role: member_role.to_string(),
            prompt_tokens: result.usage.0,
            completion_tokens: result.usage.1,
            wall_ms: member_wall_ms,
        },
    );
    Ok(MemberRunOutput {
        text: result.final_text,
        usage: result.usage,
        wall_ms: member_wall_ms,
        success: result.success,
    })}

/// 流水线执行计划：拓扑顺序 + 每个节点的上游输入（成员下标）。
struct DagPlan {
    order: Vec<usize>,
    inputs: Vec<Vec<usize>>,
}

/// 由成员的 `depends_on` 构建 DAG 执行计划（Kahn 拓扑排序）。检测到环则返回错误。
/// 未指向任何已知成员的依赖被忽略（防御脏数据）；同一条上游依赖去重，避免重复注入。
fn build_dag_plan(members: &[SquadMemberConfig]) -> Result<DagPlan, String> {
    use std::collections::{HashMap, VecDeque};
    let id_to_idx: HashMap<&str, usize> = members
        .iter()
        .enumerate()
        .map(|(i, m)| (m.agent.agent_id.as_str(), i))
        .collect();
    let mut deps: Vec<Vec<usize>> = Vec::with_capacity(members.len());
    for m in members {
        let mut d: Vec<usize> = m
            .depends_on
            .iter()
            .filter_map(|dep| id_to_idx.get(dep.as_str()).copied())
            .collect();
        d.sort_unstable();
        d.dedup();
        deps.push(d);
    }
    let mut indeg: Vec<usize> = deps.iter().map(|d| d.len()).collect();
    let mut queue: VecDeque<usize> = (0..members.len()).filter(|&i| indeg[i] == 0).collect();
    let mut order = Vec::new();
    let mut inputs: Vec<Vec<usize>> = Vec::new();
    while let Some(n) = queue.pop_front() {
        order.push(n);
        inputs.push(deps[n].clone());
        for (i, d) in deps.iter().enumerate() {
            if d.contains(&n) {
                indeg[i] -= 1;
                if indeg[i] == 0 {
                    queue.push_back(i);
                }
            }
        }
    }
    if order.len() != members.len() {
        return Err("流水线存在循环依赖（DAG 检测到环），无法执行".into());
    }
    Ok(DagPlan { order, inputs })
}

/// 执行单个流水线节点（带重试），落库并推送 round 事件，返回该成员最终产出文本。
/// 上游成员产出由调用方已折叠进 `prompt`（实现「前步产出→后步输入」的自动串联）。
#[allow(clippy::too_many_arguments)]
async fn run_pipeline_node(
    app: &AppHandle,
    squad_id: &str,
    workspace: &Option<String>,
    member: &SquadMemberConfig,
    prompt: &str,
    retry: usize,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    // P2-3 无人值守模式透传。
    unattended: bool,
    cancel: &Arc<AtomicBool>,
    // S2（§4.11）：Live inject 安全点钩子（本节点信箱；None=无）。
    inject_hook: Option<pipeline::InjectHook>,
) -> MemberRunOutput {
    let ws = squad_member_workspace(workspace, squad_id, &member.agent.agent_id);
    let mut out = MemberRunOutput {
        text: String::new(),
        usage: (0, 0),
        wall_ms: 0,
        success: false,
    };
    let mut last_err: Option<String> = None;
    for attempt in 0..retry {
        match run_member_subtask(app, &member.agent, &member.role, session_id, &prompt.to_string(), &ws, unattended, Some(cancel), inject_hook.clone(), &member.tool_profile).await {
            Ok(o) => {
                out = o;
                break;
            }
            Err(e) => {
                last_err = Some(e.clone());
                tracing::info!(
                    "[squad] 流水线成员 {} 第 {} 次失败：{}",
                    member.agent.agent_id,
                    attempt + 1,
                    e
                );
            }
        }
    }
    if out.text.is_empty() {
        out.text = format!(
            "（成员 {} 子任务执行失败：{}）",
            member.agent.agent_id,
            last_err.unwrap_or_default()
        );
    }
    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, 'subtask', ?)",
    )
    .bind(round_id())
    .bind(squad_id)
    .bind(session_id)
    .bind(&member.agent.agent_id)
    .bind(&member.role)
    .bind(&out.text)
    .bind(now_ms())
    .execute(pool)
    .await;
    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad_id.to_string(),
            session_id: session_id.to_string(),
            speaker_agent_id: Some(member.agent.agent_id.clone()),
            role: member.role.clone(),
            kind: "subtask".into(),
            content: out.text.clone(),
        },
    );
    out
}

/// 流水线（pipeline）：成员按 `pipeline_order` 线性串流，前序工序的 `final_text` 作为后序工序的
/// 上游上下文，折叠进后序成员的 prompt（实现「前步产出→后步输入」的链式传递，等价于原 run_pipeline 的 initial_context）。
///
/// 各成员运行在独立私有工作区，互不干扰；末工序输出即最终交付物（本模式不额外调用汇总 LLM，降本）。
/// 若任一成员设置了 `depends_on`，则升级为 DAG 拓扑执行：每个节点以所有上游成员产出为上游上下文，
/// 最终汇总取所有「汇点」（无下游依赖的节点）产出。
#[tracing::instrument(skip_all)]
async fn run_squad_pipeline(
    app: &AppHandle,
    squad: &SquadRuntimeConfig,
    prompt: &str,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    cancel: &Arc<AtomicBool>,
) {
    let retry = squad.run_strategy.retry_count.max(1) as usize;
    // P2-3 模式感知恢复：schedule / api 模式视为无人值守 → 子任务失败恢复超时自动取消；
    // manual 模式保持永久等待用户决策。execution_mode 取值即 SquadRunStrategy 既有字段。
    let unattended = matches!(squad.run_strategy.execution_mode.as_str(), "schedule" | "api");
    squad_metrics_register_budget(session_id, squad.run_strategy.budget_tokens);
    let use_dag = squad.members.iter().any(|m| !m.depends_on.is_empty());

    // 执行计划：执行顺序 + 每个节点的上游输入来源（成员下标）。
    let plan: DagPlan = if use_dag {
        match build_dag_plan(&squad.members) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("[squad] pipeline: DAG 构建失败，会话 {}：{e}", session_id);
                let _ = sqlx::query(
                    "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
                     VALUES (?, ?, ?, NULL, '系统', ?, 'system', ?)",
                )
                .bind(format!("sqr_{}", now_ms()))
                .bind(&squad.squad_id)
                .bind(session_id)
                .bind(format!("流水线 DAG 存在循环依赖，无法执行：{e}"))
                .bind(now_ms())
                .execute(pool)
                .await;
                let _ = sqlx::query(
                    "UPDATE agent_squad_session SET status='done', snapshot=?, updated_at=? WHERE id=?",
                )
                .bind(&e)
                .bind(now_ms())
                .bind(session_id)
                .execute(pool)
                .await;
                write_metrics_round(app, &pool, &squad.squad_id, &session_id).await; // S0-4d metrics 落盘
                build_and_persist_pack(pool, app, &squad.squad_id, session_id, "failed", &e).await; // S2 交付包落库
                squad_inject_flush_session(app, pool, &squad.squad_id, session_id).await; // S2 插话兜底清账（失败早退）
                events::emit_squad_session_done(
                    app,
                    &events::SquadSessionDonePayload {
                        squad_id: squad.squad_id.clone(),
                        session_id: session_id.to_string(),
                        summary: e,
                    },
                );
                return;
            }
        }
    } else {
        // 线性模式：按 pipeline_order 排序，每节点输入 = 之前所有节点产出。
        let mut order: Vec<usize> = (0..squad.members.len()).collect();
        order.sort_by_key(|&i| squad.members[i].pipeline_order.unwrap_or(usize::MAX));
        let inputs: Vec<Vec<usize>> = order
            .iter()
            .enumerate()
            .map(|(pos, _)| order[..pos].to_vec())
            .collect();
        DagPlan { order, inputs }
    };

    // 各成员产出缓存（按下标索引）。
    let mut outputs: Vec<String> = vec![String::new(); squad.members.len()];
    // ===== S1（§4.4.4）：pipeline 节点 Handoff 链——直接上游交接包投递 + 注入，文本拼接降级为兼容 =====
    let inbox_root = squad_shared_inbox(&squad.squad_id);
    let mut handoffs: Vec<Option<HandoffBundle>> = vec![None; squad.members.len()];
    let mut board = BoardState::default();
    for i in 0..squad.members.len() {
        board.tasks.insert(
            format!("n{}", i + 1),
            BoardTask {
                title: squad.members[i].role.clone(),
                assignee: squad.members[i].role.clone(),
                status: "pending".into(),
                handoff_id: None,
            },
        );
    }
    // S1 批次2：Mission Contract 快照落库（流水线节点=任务）。
    {
        let contract = serde_json::json!({
            "mission": prompt,
            "mode": "pipeline",
            "tasks": squad
                .members
                .iter()
                .enumerate()
                .map(|(i, m)| {
                    serde_json::json!({
                        "taskId": format!("n{}", i + 1),
                        "title": m.role,
                        "assignee": m.role,
                        "dependsOn": m.depends_on,
                        "expectedArtifacts": [],
                    })
                })
                .collect::<Vec<_>>(),
        });
        persist_contract(pool, session_id, &contract).await;
    }
    persist_board(pool, session_id, &board).await;

    // S2（§4.11）：会话启动即为全部节点绑定信箱（primary=agent_id，节点 id 别名）——pre_talk 可投给未启动节点。
    for (i, m) in squad.members.iter().enumerate() {
        squad_inject_bind(session_id, &m.agent.agent_id, &[&format!("n{}", i + 1)]);
    }

    // ===== S1 批次2（§4.4.4）：DAG 同层并行——层内 join_all，层间等待（线性模式每层 1 节点，行为不变） =====
    let mut level = vec![0usize; squad.members.len()];
    for (pos, &mi) in plan.order.iter().enumerate() {
        let l = plan.inputs[pos].iter().map(|&up| level[up] + 1).max().unwrap_or(0);
        level[mi] = l;
    }
    let max_level = level.iter().copied().max().unwrap_or(0);
    let mut _budget_warned = false;
    // S2（§4.6 L2）：L2 检查点「返工」需重跑本层——for 改 while（返工分支不递增 lv）。
    let mut lv: usize = 0;
    while lv <= max_level {
        // S0-3 取消检测点：squad 级取消 → 立即收尾。
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            finish_squad_session(app, pool, &squad.squad_id, session_id, "cancelled", "任务已被用户取消").await;
            return;
        }
        // S2 预算闸门：≥100% 软熔断（不再启动新层，已完成产物保留）。
        let budget = squad_metrics_budget(session_id);
        if budget > 0 && squad_metrics_used(session_id) >= budget {
            let note = format!("🛑 预算耗尽软熔断：已用 {} ≥ 预算 {budget} tokens，停止启动新节点，已完成产物保留。", squad_metrics_used(session_id));
            finish_squad_session(app, pool, &squad.squad_id, session_id, "done", &note).await;
            return;
        }
        let wave: Vec<(usize, usize)> = plan
            .order
            .iter()
            .enumerate()
            .filter(|(_, &mi)| level[mi] == lv)
            .map(|(pos, &mi)| (pos, mi))
            .collect();
        // 主协程准备（board 单写者）：running + 上游投递 + 注入段构造。
        let mut preps: Vec<(usize, String, String, String, Arc<std::sync::Mutex<Vec<InjectNote>>>)> = Vec::new(); // (mi, task_id, node_prompt, node_ws, inject_mailbox)
        let mut level_tasks: Vec<(usize, String)> = Vec::new(); // (mi, task_id)——L2 检查点返工回退用
        for &(pos, mi) in &wave {
            let member = &squad.members[mi];
            let node_ws =
                squad_member_workspace(&squad.workspace, &squad.squad_id, &member.agent.agent_id);
            let task_id = format!("n{}", mi + 1);
            if let Some(b) = board.tasks.get_mut(&task_id) {
                b.status = "running".into();
            }
            // 直接上游 Handoff 投递到本节点私有区 inbox + 注入段。
            let ups = &plan.inputs[pos];
            let mut sections = String::new();
            for (k, &u) in ups.iter().enumerate() {
                if let Some(b) = &handoffs[u] {
                    let delivered = deliver_handoff_to_downstream(
                        &inbox_root,
                        &node_ws,
                        &format!("n{}", u + 1),
                        b,
                    );
                    sections.push_str(&render_handoff_section(k + 1, ups.len(), b, &delivered));
                    sections.push('\n');
                }
            }
            // 兼容路径：上游文本拼接（无 Handoff 的旧数据时回退）。
            let upstream = plan.inputs[pos]
                .iter()
                .map(|&up| outputs[up].clone())
                .collect::<Vec<_>>()
                .join("\n\n");
            let node_prompt = if !sections.is_empty() {
                format!("{}\n\n{sections}", prompt)
            } else if upstream.trim().is_empty() {
                prompt.to_string()
            } else {
                format!(
                    "{}\n\n[上游成员已交付产物]\n{}\n\n请基于上述上游产出继续完成本节点任务。",
                    prompt, upstream
                )
            };
            // S2（§4.11）：绑定信箱（primary=agent_id，节点 id 别名；会话启动已绑过，幂等）+ 预嘱注入。
            let inject_mailbox = squad_inject_bind(session_id, &member.agent.agent_id, &[&task_id]);
            let pre_notes = squad_inject_take_mailbox(&inject_mailbox);
            let node_prompt = if pre_notes.is_empty() {
                node_prompt
            } else {
                tracing::info!("[squad] 节点 {task_id} 启动前注入用户预嘱 {} 条", pre_notes.len());
                squad_inject_mark_delivered(app, pool, &squad.squad_id, session_id, &task_id, &pre_notes).await;
                format!("{}\n\n{}", node_prompt, render_pre_talk_section(&pre_notes))
            };
            level_tasks.push((mi, task_id.clone()));
            preps.push((mi, task_id, node_prompt, node_ws, inject_mailbox));
        }
        persist_board(pool, session_id, &board).await;

        // Wave 并行执行（同成员由 per-agent 锁排队；不同成员真并行）。
        let mut futs = Vec::with_capacity(preps.len());
        for (_mi, _task_id, node_prompt, _node_ws, inject_mailbox) in preps {
            let member = &squad.members[_mi];
            // S2（§4.11）：Live inject 安全点钩子（同编排式；DB 回写 spawn 异步）。
            let inject_hook: pipeline::InjectHook = {
                let app_c = app.clone();
                let pool_c = pool.clone();
                let sq_c = squad.squad_id.clone();
                let sid_c = session_id.to_string();
                let tid_c = _task_id.clone();
                let mb_c = inject_mailbox.clone();
                Arc::new(move || {
                    let notes = squad_inject_take_mailbox(&mb_c);
                    if notes.is_empty() {
                        return Vec::new();
                    }
                    let msgs: Vec<String> = notes.iter().map(|n| format_inject_user_msg(&n.content)).collect();
                    let (app2, pool2) = (app_c.clone(), pool_c.clone());
                    let (sq2, sid2, tid2) = (sq_c.clone(), sid_c.clone(), tid_c.clone());
                    tauri::async_runtime::spawn(async move {
                        squad_inject_mark_delivered(&app2, &pool2, &sq2, &sid2, &tid2, &notes).await;
                    });
                    msgs
                })
            };
            futs.push(async move {
                run_pipeline_node(
                    app,
                    &squad.squad_id,
                    &squad.workspace,
                    member,
                    &node_prompt,
                    retry,
                    pool,
                    session_id,
                    unattended,
                    cancel,
                    Some(inject_hook),
                )
                .await
            });
        }
        let results = futures_util::future::join_all(futs).await;

        // 波次收尾（单写者）：outputs / Handoff 生成 / 留档 / 落表 / board。
        for (k, &(_pos, mi)) in wave.iter().enumerate() {
            let out = &results[k];
            let member = &squad.members[mi];
            let node_ws =
                squad_member_workspace(&squad.workspace, &squad.squad_id, &member.agent.agent_id);
            let task_id = format!("n{}", mi + 1);
            outputs[mi] = out.text.clone();
            let status = if out.success { "ok" } else { "partial" };
            let bundle = build_handoff_bundle(
                &node_ws,
                &squad.squad_id,
                &member.agent.agent_id,
                &member.role,
                &task_id,
                &out.text,
                status,
                out.usage,
                out.wall_ms,
                &[],
            );
            archive_handoff_to_inbox(&node_ws, &inbox_root, &task_id, &bundle);
            let handoff_row_id = format!(
                "sqdh_{}_{:05}",
                now_ms(),
                ROUND_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            let bundle_json = serde_json::to_string(&bundle).unwrap_or_default();
            let _ = sqlx::query(
                "INSERT INTO agent_squad_handoff (id, squad_id, session_id, task_id, from_agent_id, status, bundle_json, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&handoff_row_id)
            .bind(&squad.squad_id)
            .bind(session_id)
            .bind(&task_id)
            .bind(&member.agent.agent_id)
            .bind(status)
            .bind(&bundle_json)
            .bind(now_ms())
            .execute(pool)
            .await;
            if let Some(b) = board.tasks.get_mut(&task_id) {
                b.status = if status == "ok" { "done".into() } else { "failed".into() };
                b.handoff_id = Some(handoff_row_id);
            }
            for art in &bundle.artifacts {
                let entry = format!("shared/inbox/{task_id}/{}", art.path);
                // 返工重跑会产生第二次 handoff：同一产物路径只记一条（09-29 真机验证发现的重复项）。
                if !board.artifacts_index.contains(&entry) {
                    board.artifacts_index.push(entry);
                }
            }
            handoffs[mi] = Some(bundle);
        }
        persist_board(pool, session_id, &board).await;

        // ===== S2（§4.6 L2）：检查点——manual 模式每层完成后挂起（仍有后续层时）=====
        // 返工 → 本层节点回 pending，不递增 lv 重跑本层；继续 → lv += 1；取消 → cancelled 收尾。
        if !unattended && lv < max_level {
            let level_titles = level_tasks
                .iter()
                .map(|(_, tid)| {
                    format!(
                        "{tid}「{}」",
                        board.tasks.get(tid.as_str()).map(|b| b.title.as_str()).unwrap_or("")
                    )
                })
                .collect::<Vec<_>>()
                .join("、");
            let note = format!(
                "⏸️ 检查点（L2）：第 {} 层（{}）已完成，等待决议（继续 / 返工）。",
                lv + 1,
                level_titles
            );
            match squad_checkpoint_hang(app, pool, &squad.squad_id, session_id, &note, cancel).await {
                Some(d) if d == "rework" => {
                    for (mi, tid) in level_tasks.iter() {
                        outputs[*mi].clear();
                        if let Some(b) = board.tasks.get_mut(tid.as_str()) {
                            b.status = "pending".into();
                        }
                    }
                    persist_board(pool, session_id, &board).await;
                    continue;
                }
                Some(_) => {}
                None => {
                    finish_squad_session(app, pool, &squad.squad_id, session_id, "cancelled", "检查点等待期间任务被取消").await;
                    return;
                }
            }
        }
        lv += 1;
    }

    // 最终汇总：DAG 取所有「汇点」（无任何下游依赖的节点）产出；线性取末序节点产出。
    let summary = if use_dag {
        let sinks: Vec<usize> = plan
            .order
            .iter()
            .copied()
            .filter(|&mi| {
                let id = &squad.members[mi].agent.agent_id;
                !squad.members.iter().any(|m| m.depends_on.iter().any(|d| d == id))
            })
            .collect();
        if sinks.is_empty() {
            outputs
                .iter()
                .enumerate()
                .map(|(i, o)| format!("[{}] {}", squad.members[i].role, o))
                .collect::<Vec<_>>()
                .join("\n\n")
        } else if sinks.len() == 1 {
            outputs[sinks[0]].clone()
        } else {
            sinks
                .iter()
                .map(|&mi| format!("[{}] {}", squad.members[mi].role, outputs[mi]))
                .collect::<Vec<_>>()
                .join("\n\n")
        }
    } else {
        outputs[*plan.order.last().unwrap()].clone()
    };

    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '汇总', ?, 'summary', ?)",
    )
    .bind(format!("sqr_{}", now_ms()))
    .bind(&squad.squad_id)
    .bind(session_id)
    .bind(&summary)
    .bind(now_ms())
    .execute(pool)
    .await;

    write_metrics_round(app, &pool, &squad.squad_id, &session_id).await; // S0-4d metrics 落盘
    build_and_persist_pack(&pool, app, &squad.squad_id, &session_id, "done", &summary).await; // S2 交付包落库
    // S1 批次2（§4.4.5）：决策卡——汇总文本中的【squad-decisions】尾块结构化落表。
    let decisions = parse_squad_decisions(&summary);
    persist_decisions(pool, app, &squad.squad_id, session_id, &decisions).await;
    // ===== S2（§4.6 L4）：交付确认门禁——manual 模式 Pack 生成后挂起等用户确认 =====
    if !unattended {
        if !gate_delivery_confirm(app, pool, &squad.squad_id, session_id, cancel).await {
            finish_squad_session(app, pool, &squad.squad_id, session_id, "cancelled", "用户要求修订，会话按取消收尾（已完成产物保留在交接箱）").await;
            return;
        }
    }
    squad_inject_flush_session(app, pool, &squad.squad_id, session_id).await; // S2 插话兜底清账

    let _ = sqlx::query(
        "UPDATE agent_squad_session SET status='done', snapshot=?, updated_at=? WHERE id=?",
    )
    .bind(&summary)
    .bind(now_ms())
    .bind(session_id)
    .execute(pool)
    .await;

    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "汇总".into(),
            kind: "summary".into(),
            content: summary.clone(),
        },
    );
    events::emit_squad_session_done(
        app,
        &events::SquadSessionDonePayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.to_string(),
            summary,
        },
    );
    tracing::info!(
        "[squad] pipeline: 会话 {} 完成，模式={}{}",
        session_id,
        if use_dag { "DAG" } else { "线性" },
        plan.order.len()
    );
}

/// 群聊协商（chat）：成员在共享讨论黑板上轮流发言，由 Moderator / 汇总主笔收口。
///
/// 与编排式（Leader 拆解委派）和流水线（线性串流）不同，群聊强调「多向讨论」：
/// 每轮各参与者基于讨论目标 + 共享黑板（所有人历史发言）给出见解，最后由汇总主笔产出结论。
/// 每轮发言为单次 `call_llm`（轻量、偏对话），不跑完整 pipeline，契合圆桌语义。
#[tracing::instrument(skip_all)]
async fn run_squad_chat(
    app: &AppHandle,
    squad: &SquadRuntimeConfig,
    prompt: &str,
    pool: &sqlx::SqlitePool,
    session_id: &str,
    cancel: &Arc<AtomicBool>,
) {
    let max_rounds = if squad.chat_config.max_rounds == 0 {
        8
    } else {
        squad.chat_config.max_rounds
    };

    // 汇总主笔：chat_config.summarizer_agent_id > leader_agent_id > 首个成员。
    let summarizer_id: Option<String> = squad
        .chat_config
        .summarizer_agent_id
        .clone()
        .or_else(|| squad.leader_agent_id.clone())
        .or_else(|| squad.members.first().map(|m| m.agent.agent_id.clone()));

    // 参与者 = 除汇总主笔外的成员；若无其他成员则全员参与。
    let participants: Vec<&SquadMemberConfig> = squad
        .members
        .iter()
        .filter(|m| Some(&m.agent.agent_id) != summarizer_id.as_ref())
        .collect();
    let speakers: Vec<&SquadMemberConfig> = if participants.is_empty() {
        squad.members.iter().collect()
    } else {
        participants
    };

    // S2（§4.11）：群聊插话信箱——每个成员绑定（primary=agent_id），发言前排空注入。
    for m in &squad.members {
        squad_inject_bind(session_id, &m.agent.agent_id, &[]);
    }

    let mut blackboard = String::new();
    for r in 0..max_rounds {
        // S0-3 取消检测点：squad 级取消 → 立即收尾。
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            finish_squad_session(app, pool, &squad.squad_id, session_id, "cancelled", "任务已被用户取消").await;
            return;
        }
        for member in speakers.clone() {
            let sys = format!(
                "你是小分队「{}」圆桌讨论的参与者，角色为「{}」。请基于讨论目标与其他成员的发言，给出你的专业见解（简洁、针对目标、可回应他人观点）。",
                squad.name, member.role
            );
            let history = if blackboard.is_empty() {
                "（暂无，等待你的开场发言）".to_string()
            } else {
                blackboard.clone()
            };
            // S2（§4.11）：用户插话注入——成员发言前排空其信箱（运行中打断，圆桌无 pipeline 安全点）。
            let inject_notes = squad_inject_take(session_id, &member.agent.agent_id);
            let user = if inject_notes.is_empty() {
                format!(
                    "讨论目标：\n{}\n\n## 当前讨论黑板（所有成员历史发言）\n{}\n\n请给出你第 {} 轮发言。",
                    prompt, history, r + 1
                )
            } else {
                tracing::info!("[squad] chat 成员 {} 第 {} 轮注入用户插话 {} 条", member.agent.agent_id, r + 1, inject_notes.len());
                squad_inject_mark_delivered(app, pool, &squad.squad_id, session_id, &member.agent.agent_id, &inject_notes).await;
                format!(
                    "讨论目标：\n{}\n\n## 当前讨论黑板（所有成员历史发言）\n{}\n\n{}\n\n请给出你第 {} 轮发言。",
                    prompt,
                    history,
                    render_inject_section(&inject_notes),
                    r + 1
                )
            };
            let messages = vec![
                json!({ "role": "system", "content": sys }),
                json!({ "role": "user", "content": user }),
            ];
            let content = match crate::agent::engine::runtime::call_llm(&member.agent, &messages, &[], Some(cancel)).await {
                Ok((resp, usage)) => { squad_metrics_add_usage(session_id, usage); extract_llm_content(&resp) }
                Err(e) => {
                    tracing::warn!("[squad] chat 成员 {} 第 {} 轮发言失败：{e}", member.agent.agent_id, r + 1);
                    format!("（成员 {} 发言失败：{e}）", member.agent.agent_id)
                }
            };

            let _ = sqlx::query(
                "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, 'message', ?)",
            )
            .bind(format!("sqr_{}", now_ms()))
            .bind(&squad.squad_id)
            .bind(session_id)
            .bind(&member.agent.agent_id)
            .bind(&member.role)
            .bind(&content)
            .bind(now_ms())
            .execute(pool)
            .await;

            events::emit_squad_round(
                app,
                &events::SquadRoundPayload {
                    squad_id: squad.squad_id.clone(),
                    session_id: session_id.to_string(),
                    speaker_agent_id: Some(member.agent.agent_id.clone()),
                    role: member.role.clone(),
                    kind: "message".into(),
                    content: content.clone(),
                },
            );

            blackboard.push_str(&format!("\n\n[{}·{}] {}", r + 1, member.role, content));
        }
    }

    // 汇总主笔收口：基于完整讨论黑板产出最终结论。
    let summarizer = summarizer_id
        .as_ref()
        .and_then(|id| squad.members.iter().find(|m| &m.agent.agent_id == id))
        .or_else(|| squad.members.first());
    let sum_cfg = match summarizer {
        Some(m) => &m.agent,
        None => {
            tracing::warn!("[squad] chat: 无可用汇总主笔");
            events::emit_squad_session_done(
                app,
                &events::SquadSessionDonePayload {
                    squad_id: squad.squad_id.clone(),
                    session_id: session_id.to_string(),
                    summary: blackboard.clone(),
                },
            );
            return;
        }
    };

    let sys = "你是小分队圆桌讨论的主持人 / 汇总主笔。请基于讨论黑板，给出本次协作任务的最终汇总结论（可交付、简明、归纳各方共识与待决点）。\n\n输出末尾，若讨论达成了明确共识或决议，请单独追加一段（有才输出，没有则省略）：\n【squad-decisions】\n[{\"kind\":\"scope|plan|risk\",\"text\":\"决议内容一句话\"}]";
    let user = format!(
        "讨论目标：\n{}\n\n## 讨论黑板\n{}\n\n请给出最终汇总。",
        prompt, blackboard
    );
    let messages = vec![
        json!({ "role": "system", "content": sys }),
        json!({ "role": "user", "content": user }),
    ];
    let summary = match crate::agent::engine::runtime::call_llm(sum_cfg, &messages, &[], Some(cancel)).await {
        Ok((resp, usage)) => {
            squad_metrics_add_usage(session_id, usage);
            let s = extract_llm_content(&resp);
            if s.is_empty() {
                blackboard.clone()
            } else {
                s
            }
        }
        Err(e) => {
            tracing::warn!("[squad] chat: 汇总主笔调用失败：{e}");
            blackboard.clone()
        }
    };

    let _ = sqlx::query(
        "INSERT INTO agent_squad_round (id, squad_id, session_id, speaker_agent_id, role, content, kind, created_at) \
         VALUES (?, ?, ?, NULL, '汇总', ?, 'summary', ?)",
    )
    .bind(format!("sqr_{}", now_ms()))
    .bind(&squad.squad_id)
    .bind(session_id)
    .bind(&summary)
    .bind(now_ms())
    .execute(pool)
    .await;

    write_metrics_round(app, &pool, &squad.squad_id, &session_id).await; // S0-4d metrics 落盘
    build_and_persist_pack(&pool, app, &squad.squad_id, &session_id, "done", &summary).await; // S2 交付包落库
    // S1 批次2（§4.4.5）：决策卡——汇总文本中的【squad-decisions】尾块结构化落表。
    let decisions = parse_squad_decisions(&summary);
    persist_decisions(pool, app, &squad.squad_id, session_id, &decisions).await;
    // ===== S2（§4.6 L4）：交付确认门禁——manual 模式 Pack 生成后挂起等用户确认 =====
    {
        let unattended = matches!(squad.run_strategy.execution_mode.as_str(), "schedule" | "api");
        if !unattended {
            if !gate_delivery_confirm(app, pool, &squad.squad_id, session_id, cancel).await {
                finish_squad_session(app, pool, &squad.squad_id, session_id, "cancelled", "用户要求修订，会话按取消收尾（已完成产物保留在交接箱）").await;
                return;
            }
        }
    }
    squad_inject_flush_session(app, pool, &squad.squad_id, session_id).await; // S2 插话兜底清账

    let _ = sqlx::query(
        "UPDATE agent_squad_session SET status='done', snapshot=?, updated_at=? WHERE id=?",
    )
    .bind(&summary)
    .bind(now_ms())
    .bind(session_id)
    .execute(pool)
    .await;

    events::emit_squad_round(
        app,
        &events::SquadRoundPayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.to_string(),
            speaker_agent_id: None,
            role: "汇总".into(),
            kind: "summary".into(),
            content: summary.clone(),
        },
    );
    events::emit_squad_session_done(
        app,
        &events::SquadSessionDonePayload {
            squad_id: squad.squad_id.clone(),
            session_id: session_id.to_string(),
            summary,
        },
    );
    tracing::info!(
        "[squad] chat: 会话 {} 完成，轮次={}，参与成员数={}",
        session_id,
        max_rounds,
        speakers.len()
    );
}
// 台账 G10：本地 extract_llm_text（钻信封层，永远取空）已删除——统一走
// llm::extract_llm_content（归一化层优先 + 信封兜底，见 engine/llm.rs）。

#[cfg(test)]
mod s1_tests {
    use super::*;

    /// S1：委派解析支持 dependsOn / expectedArtifacts（可省略字段宽容解析）。
    #[test]
    fn parse_delegation_with_deps() {
        let json = r#"[
            {"title":"调研竞品","assignee":"调研员","instruction":"调研 A/B","expectedArtifacts":["notes.md"]},
            {"title":"写报告","assignee":"执行员","instruction":"写 report.md","dependsOn":["调研竞品","不存在的任务"]}
        ]"#;
        let tasks = parse_delegation(json);
        assert_eq!(tasks.len(), 2);
        assert!(tasks[0].depends_on.is_empty());
        assert_eq!(tasks[0].expected_artifacts, vec!["notes.md".to_string()]);
        assert_eq!(tasks[1].depends_on, vec!["调研竞品".to_string(), "不存在的任务".to_string()]);
        // 旧 schema（无新字段）兼容
        let legacy = r#"[{"title":"t","assignee":"a","instruction":"i"}]"#;
        let legacy_tasks = parse_delegation(legacy);
        assert_eq!(legacy_tasks.len(), 1);
        assert!(legacy_tasks[0].depends_on.is_empty() && legacy_tasks[0].expected_artifacts.is_empty());
    }

    /// S1：交接段渲染——含状态/摘要/产物索引/未决点（§4.4.3 注入模板）。
    #[test]
    fn render_handoff_section_shape() {
        let bundle = HandoffBundle {
            from_agent_id: "agent-1".into(),
            from_role: "调研员".into(),
            task_id: "t1".into(),
            status: "ok".into(),
            summary: "已完成调研".into(),
            artifacts: vec![HandoffArtifact {
                path: "notes.md".into(),
                kind: "file".into(),
                bytes: 1024,
                preview: None,
                label: None,
            }],
            open_questions: vec!["C 企业版价格需登录".into()],
            metrics: HandoffMetrics::default(),
        };
        let s = render_handoff_section(1, 2, &bundle, &["inbox/t1/notes.md（1024 bytes）".to_string()]);
        assert!(s.contains("上游交接 1/2"));
        assert!(s.contains("调研员"));
        assert!(s.contains("已完成调研"));
        assert!(s.contains("inbox/t1/notes.md"));
        assert!(s.contains("C 企业版价格需登录"));
        assert!(s.contains("不要臆造"));
    }

    /// S1 批次2：决策卡解析——【squad-decisions】尾块宽容解析（有标记/无标记/坏 JSON/非法 kind）。
    #[test]
    fn parse_squad_decisions_tolerant() {
        // 正常：带围栏
        let s = "汇总结论……\n\n【squad-decisions】\n```json\n[{\"kind\":\"scope\",\"text\":\"保留风险栏\"},{\"kind\":\"plan\",\"text\":\"先做调研\"}]\n```";
        let d = parse_squad_decisions(s);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].kind, "scope");
        assert_eq!(d[1].text, "先做调研");
        // 无标记 / 坏 JSON：宽容空
        assert!(parse_squad_decisions("纯文本汇总，无决议块").is_empty());
        assert!(parse_squad_decisions("【squad-decisions】不是json").is_empty());
        // 非法 kind 归 scope
        let s2 = "【squad-decisions】[{\"kind\":\"unknown\",\"text\":\"x\"}]";
        let d2 = parse_squad_decisions(s2);
        assert_eq!(d2[0].kind, "scope");
    }

    /// S1：HandoffBundle serde 往返（落表 bundle_json 的编解码一致性）。
    #[test]
    fn handoff_bundle_serde_roundtrip() {
        let bundle = HandoffBundle {
            from_agent_id: "a".into(),
            from_role: "r".into(),
            task_id: "t1".into(),
            status: "failed".into(),
            summary: "s".into(),
            artifacts: vec![],
            open_questions: vec![],
            metrics: HandoffMetrics { prompt_tokens: 10, completion_tokens: 2, duration_ms: 500 },
        };
        let json = serde_json::to_string(&bundle).unwrap();
        let back: HandoffBundle = serde_json::from_str(&json).unwrap();
        assert_eq!(back.status, "failed");
        assert_eq!(back.metrics.prompt_tokens, 10);
    }

    /// S1：产物扫描排除引擎内部结构；expectedArtifacts 对照进 open_questions。
    #[test]
    fn collect_artifacts_and_expected_check() {
        let tmp = std::env::temp_dir().join(format!("wd_s1_test_{}", std::process::id()));
        let sub = tmp.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(tmp.join("report.md"), "hello").unwrap();
        std::fs::write(sub.join("data.csv"), "a,b").unwrap();
        std::fs::create_dir_all(tmp.join(".wd_mem")).unwrap();
        std::fs::write(tmp.join(".wd_mem").join("internal.json"), "{}").unwrap();
        let files = collect_artifacts(tmp.to_str().unwrap());
        assert_eq!(files.len(), 2, "应排除 .wd_mem 内部结构");
        // preview：md/csv 可读，未知扩展名跳过
        assert!(read_preview(tmp.to_str().unwrap(), "report.md").is_some());
        // expected 对照：缺失产物进 open_questions（走 build_handoff_bundle）
        let bundle = build_handoff_bundle(
            tmp.to_str().unwrap(), "sqd", "agent", "角色", "t1", "完成", "ok",
            (1, 1), 100, &["missing.md".to_string()],
        );
        assert!(bundle.open_questions.iter().any(|q| q.contains("missing.md")));
        std::fs::remove_dir_all(&tmp).ok();
    }

    /* ================= S2 批次2 ================= */

    /// S2：插话入参校验——空内容/超长拒绝；mode 归一化（宽容，未知值归 soft）。
    #[test]
    fn inject_input_validation() {
        assert!(validate_inject_input("", "soft").is_err());
        assert!(validate_inject_input("   ", "soft").is_err());
        let long = "长".repeat(2001);
        assert!(validate_inject_input(&long, "soft").is_err());
        assert_eq!(validate_inject_input("用 JWT 不要 session", "hard").unwrap(), "hard");
        assert_eq!(validate_inject_input("先想清楚", "pre-talk").unwrap(), "pre_talk");
        assert_eq!(validate_inject_input("补充说明", "whatever").unwrap(), "soft");
    }

    /// S2：注入形态——user 消息带稳定指令（用户补充指示优先级高于冲突部分）。
    #[test]
    fn inject_message_format() {
        let msg = format_inject_user_msg("鉴权用 JWT");
        assert!(msg.contains("用户打断补充"));
        assert!(msg.contains("鉴权用 JWT"));
        assert!(msg.contains("优先级高于原任务指令"));
        // 预嘱段 / 群聊插话段渲染
        let notes = vec![
            InjectNote { id: "i1".into(), mode: "pre_talk".into(), content: "接口用 snake_case".into() },
            InjectNote { id: "i2".into(), mode: "soft".into(), content: "补一句".into() },
        ];
        let pre = render_pre_talk_section(&notes);
        assert!(pre.starts_with("## 用户预嘱"));
        assert!(pre.contains("- 接口用 snake_case"));
        let inj = render_inject_section(&notes);
        assert!(inj.starts_with("## 用户插话"));
        assert!(inj.contains("- 补一句"));
    }

    /// S2：检查点决议归一化——rework 之外一律 continue（宽容防卡死）。
    #[test]
    fn checkpoint_decision_normalize() {
        assert_eq!(normalize_checkpoint_decision("rework"), "rework");
        assert_eq!(normalize_checkpoint_decision(" REWORK "), "rework");
        assert_eq!(normalize_checkpoint_decision("continue"), "continue");
        assert_eq!(normalize_checkpoint_decision(" nonsense "), "continue");
    }

    /// S2：信箱多别名键共享——primary（agent_id）与别名键（task_id）排空的是同一个队列；
    /// 未绑定的别名键走独立信箱互不干扰。
    #[test]
    fn inject_mailbox_alias_keys_share_queue() {
        let sid = "sqs_test_alias";
        squad_inject_register_session(sid, false);
        let mb = squad_inject_bind(sid, "agent-a", &["t1"]);
        mb.lock().unwrap().push(InjectNote { id: "n1".into(), mode: "soft".into(), content: "x".into() });
        // 另一个目标键：独立信箱
        let mb2 = squad_inject_bind(sid, "agent-b", &[]);
        assert_eq!(squad_inject_take(sid, "t1").len(), 1, "别名键命中同一信箱");
        assert!(squad_inject_take(sid, "agent-a").is_empty(), "排空后不再重复");
        assert!(squad_inject_take(sid, "agent-b").is_empty(), "独立信箱互不干扰");
        mb2.lock().unwrap().push(InjectNote { id: "n2".into(), mode: "soft".into(), content: "y".into() });
        assert_eq!(squad_inject_take_mailbox(&mb2).len(), 1);
        // 清理：守卫式摘除等价物
        let mut g = SQUAD_INJECTS.lock().unwrap();
        g.as_mut().unwrap().remove(sid);
    }

    /// S2 回归：计划门禁批准必须放行（2026-09-28 真 bug——resolve 先 remove 再置位，
    /// 等待循环读不到 Some(true) 把批准当拒绝，批准也走取消收尾）。
    #[test]
    fn plan_gate_approve_resolves_true() {
        let sid = "sqs_test_plan_gate";
        SQUAD_PLAN_GATES
            .lock()
            .unwrap()
            .get_or_insert_with(std::collections::HashMap::new)
            .insert(sid.to_string(), PlanGate { approved: Arc::new(std::sync::Mutex::new(None)) });
        assert!(resolve_plan_gate(sid, true), "应命中挂起的 gate");
        {
            let g = SQUAD_PLAN_GATES.lock().unwrap();
            let gate = g.as_ref().unwrap().get(sid).unwrap();
            assert_eq!(*gate.approved.lock().unwrap(), Some(true), "决议应保留在 gate 上供等待循环读取");
        }
        remove_plan_gate(sid);
        assert!(!resolve_plan_gate(sid, true), "清理后不应再命中");
    }

    /// S2：检查点 / 交付门禁决议入口——命中置值；未注册返回 false。
    #[test]
    fn checkpoint_and_delivery_resolve() {
        let sid_cp = "sqs_test_checkpoint";
        SQUAD_CHECKPOINTS
            .lock()
            .unwrap()
            .get_or_insert_with(std::collections::HashMap::new)
            .insert(sid_cp.to_string(), CheckpointGate { decision: Arc::new(std::sync::Mutex::new(None)) });
        assert!(resolve_squad_checkpoint(sid_cp, "rework"));
        {
            let g = SQUAD_CHECKPOINTS.lock().unwrap();
            let gate = g.as_ref().unwrap().get(sid_cp).unwrap();
            assert_eq!(gate.decision.lock().unwrap().as_deref(), Some("rework"));
        }
        remove_checkpoint_gate(sid_cp);
        assert!(!resolve_squad_checkpoint(sid_cp, "continue"));

        let sid_dl = "sqs_test_delivery";
        SQUAD_DELIVERY_GATES
            .lock()
            .unwrap()
            .get_or_insert_with(std::collections::HashMap::new)
            .insert(sid_dl.to_string(), DeliveryGate { approved: Arc::new(std::sync::Mutex::new(None)) });
        assert!(resolve_squad_delivery(sid_dl, false), "要求修订也应命中");
        {
            let g = SQUAD_DELIVERY_GATES.lock().unwrap();
            let gate = g.as_ref().unwrap().get(sid_dl).unwrap();
            assert_eq!(*gate.approved.lock().unwrap(), Some(false));
        }
        let mut g = SQUAD_DELIVERY_GATES.lock().unwrap();
        g.as_mut().unwrap().remove(sid_dl);
    }

    /// S2（§4.2）：工具面保留判定——inherit 全留 / denylist 剔除清单内 / allowlist 只留清单内；
    /// 空 allowlist 降级为 inherit（防「白名单没配=零工具」误伤）。
    #[test]
    fn tool_profile_keeps_expected_tools() {
        let inherit = crate::agent::types::SquadToolProfile::default();
        assert!(inherit.is_inherit());
        assert!(tool_kept_by_profile("native__write_file", &inherit));
        assert!(tool_kept_by_profile("mcp__fs__read", &inherit));

        let mut deny = crate::agent::types::SquadToolProfile::default();
        deny.mode = "denylist".into();
        deny.native_tools = vec!["native__write_file".into(), "native__edit_file".into()];
        assert!(!deny.is_inherit());
        assert!(!tool_kept_by_profile("native__write_file", &deny), "黑名单内被剔除");
        assert!(tool_kept_by_profile("native__read_file", &deny), "黑名单外保留");
        assert!(tool_kept_by_profile("mcp__fs__read", &deny), "未提及的 MCP 工具保留");

        let mut allow = crate::agent::types::SquadToolProfile::default();
        allow.mode = "allowlist".into();
        allow.native_tools = vec!["native__read_file".into()];
        allow.mcp_tools = vec!["mcp__kb__search".into()];
        assert!(!allow.is_inherit());
        assert!(tool_kept_by_profile("native__read_file", &allow));
        assert!(tool_kept_by_profile("mcp__kb__search", &allow));
        assert!(!tool_kept_by_profile("native__write_file", &allow), "白名单外被剔除");
        assert!(!tool_kept_by_profile("mcp__fs__read", &allow));

        // 空 allowlist 降级 inherit
        let mut empty_allow = crate::agent::types::SquadToolProfile::default();
        empty_allow.mode = "allowlist".into();
        assert!(empty_allow.is_inherit());
        assert!(tool_kept_by_profile("native__write_file", &empty_allow));

        // serde 往返（camelCase 落库格式）
        let json = serde_json::to_string(&allow).unwrap();
        assert!(json.contains("nativeTools"));
        let back: crate::agent::types::SquadToolProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.native_tools, allow.native_tools);
        // snake_case alias 兼容（教训①：外部 JSON 可能用 snake_case）
        let snake: crate::agent::types::SquadToolProfile =
            serde_json::from_str(r#"{"mode":"denylist","native_tools":["native__write_file"]}"#).unwrap();
        assert_eq!(snake.mode, "denylist");
        assert_eq!(snake.native_tools.len(), 1);
    }
}
