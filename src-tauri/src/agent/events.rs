//! 前后端事件推送辅助（对应方案步骤 5 的事件流渲染）。
//!
//! 运行时通过 Tauri `app.emit` 推送以下事件（事件名即字符串常量）：
//!  - `agent-event`：常规事件（工具开始/结束、文本片段、状态、错误）；
//!  - `agent-awaiting-approval`：高危操作挂起，等待前端审批；
//!  - `agent-task-done`：整轮任务结束；
//!  - `agent-task-error`：整轮任务异常终止。

use sqlx::Row;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tauri::Emitter;

// —— 自测闭环观测：全量事件轨迹缓冲（#8 per-run 隔离）——
// 用途：get_run_logs 只回 Rust tracing 日志，不含思考/轨迹/正文；事件流原本只推前端、自测通道无前端订阅。
// 此缓冲把事件流落进程内存，由 MCP 工具 `agent_get_run_trace` 取出，供判断整链哪里断。
//
// #8 改造（2026-09-22）：原实现为三个进程级全局单例，靠 run 启动前 reset_trace() 清空复用——
// 并发多 Agent 运行时两 run 写同一缓冲会串台（parallel run 互混）。现改为 `HashMap<run_id, RunTrace>`
// 按 run 隔离；run_id 经 tokio task_local 在 `run_task_ex` / `run_agent_task` 的 spawned task 顶层注入
// （见 commands.rs），任一 emit 点读 `current_run_id()` 落到对应桶，并发 run 互不影响。
use tokio::task_local;

task_local! {
    /// 当前运行任务的 run_id（在 commands.rs 的 run_task_ex / run_agent_task spawn 顶层经 scope 注入）。
    pub(crate) static CURRENT_RUN_ID: String;
}

/// 读取当前任务的 run_id；未注入时返回空串（落到默认桶，不 panic）。
/// 终态回填（runtime.rs）也经此取 run_id，无需改动 `run_task` 签名。
pub fn current_run_id() -> String {
    CURRENT_RUN_ID.try_with(|s| s.clone()).unwrap_or_default()
}

/// #8 per-run：在给定 run_id 的作用域内执行 `f`，使 `current_run_id()` 在该 future 内返回 `rid`。
/// 封装 task_local 的 scope，避免跨模块直接引用宏生成类型。
/// F007 事件归属：读取当前任务归属会话（commands.rs spawn 顶层经 set_trace_context 注入，
/// 随 with_run_id_scope 作用域对全部 emit 点生效）。未注入（squad/非会话通道）返回 None——
/// 事件不带 sessionId 戳，前端回退既有「正在运行会话」路由。
pub fn current_session_id() -> Option<String> {
    let rid = current_run_id();
    if rid.is_empty() {
        return None;
    }
    let map = run_traces().lock().unwrap_or_else(|e| e.into_inner());
    map.get(&rid).and_then(|b| b.session_id.clone())
}

pub fn with_run_id_scope<F>(rid: String, f: F) -> impl std::future::Future<Output = F::Output>
where
    F: std::future::Future,
{
    CURRENT_RUN_ID.scope(rid, f)
}

/// 单次运行的轨迹缓冲（per-run 隔离）。
#[derive(Default)]
struct RunTrace {
    events: Vec<serde_json::Value>,
    thinking: String,
    reply: String,
    started_at: i64,
    /// 本轮真实 token 用量（prompt/completion，由 emit_task_done 随收尾写入；
    /// 供 MCP `agent_get_run_trace` 成本观测——此前 counts 只有字符数，成本观测断）。
    prompt_tokens: u64,
    completion_tokens: u64,
    /// 归属上下文（台账 D4 落盘用）：spawn 顶层经 set_trace_context 注入。
    agent_id: Option<String>,
    session_id: Option<String>,
}

/// per-run 轨迹缓冲表：run_id → 缓冲。进程级，并发 run 各自独立桶。
static RUN_TRACES: OnceLock<Mutex<HashMap<String, RunTrace>>> = OnceLock::new();
/// 缓冲表容量上限（超出按 started_at 淘汰最旧），防止长运行进程内存无限增长。
const TRACE_CAP: usize = 128;

fn run_traces() -> &'static Mutex<HashMap<String, RunTrace>> {
    RUN_TRACES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 取（或建）指定 run_id 的缓冲桶；首次访问初始化并做容量 GC。
fn with_run_trace_mut(rid: &str, f: impl FnOnce(&mut RunTrace)) {
    let mut map = run_traces().lock().unwrap_or_else(|e| e.into_inner());
    if !map.contains_key(rid) {
        map.insert(
            rid.to_string(),
            RunTrace {
                started_at: now_ms(),
                ..Default::default()
            },
        );
        if map.len() > TRACE_CAP {
            if let Some(oldest) = map
                .iter()
                .min_by_key(|(_, v)| v.started_at)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
        }
    }
    if let Some(b) = map.get_mut(rid) {
        f(b);
    }
}

/// 自测闭环（#8 per-run）：为指定 run_id 新建/重置其轨迹缓冲桶，保证只反映当次 run。
/// 不触碰其他 run 的桶（并发 run 互不干扰）。
pub fn reset_trace(run_id: &str) {
    let mut map = run_traces().lock().unwrap_or_else(|e| e.into_inner());
    map.insert(
        run_id.to_string(),
        RunTrace {
            started_at: now_ms(),
            ..Default::default()
        },
    );
}

/// 自测闭环（#8 per-run）：写入一次事件到当前 run 的桶。
/// agent-event 的 text_chunk / thinking_chunk 由专门累加器（append_reply / append_thinking）处理，
/// 此处跳过以免刷屏。
pub fn push_event(event: &str, payload: &impl Serialize) {
    let rid = current_run_id();
    if event == "agent-event" {
        if let Ok(v) = serde_json::to_value(payload) {
            // AgentEventPayload 的 event_type 经 #[serde(rename = "type")] 序列化为 "type"
            // （2026-09-22 修复：旧判据查 "eventType" 永不命中，text/thinking_chunk 从未被跳过，
            //   长回复会向 trace 缓冲塞几百条事件）。
            match v.get("type").and_then(|x| x.as_str()) {
                Some("text_chunk") | Some("thinking_chunk") => return,
                _ => {}
            }
        }
    }
    if let Ok(v) = serde_json::to_value(payload) {
        let ts = now_ms();
        with_run_trace_mut(&rid, |b| {
            b.events.push(serde_json::json!({
                "event": event,
                "payload": v,
                "ts_ms": ts,
            }));
        });
    }
}

/// 自测闭环（#8 per-run）：累计思考片段（thinking_chunk 的 text）到当前 run 的桶。
pub fn append_thinking(text: &str) {
    let rid = current_run_id();
    with_run_trace_mut(&rid, |b| b.thinking.push_str(text));
}
/// 自测闭环（#8 per-run）：累计正文回复片段（text_chunk 的 text）到当前 run 的桶。
pub fn append_reply(text: &str) {
    let rid = current_run_id();
    with_run_trace_mut(&rid, |b| b.reply.push_str(text));
}

/// 非正常终态收尾（P0-2，2026-09-23）：把「原因 + 工作空间已产出文件清单」写入 trace.reply，
/// 让 UI 与 MCP（agent_get_run_trace）都能看到失败现场，用户可据此决策续跑/拆分/加大预算。
/// 必须在 `with_run_id_scope` 内调用（reply 落当前 run 桶）；文件表过滤 `.wd_mem/`（红线：
/// 内部记忆目录绝不进用户可见正文），最多列 20 个、总数如实统计。
pub fn finalize_run_summary(workspace: Option<&str>, error_code: &str, message: &str) {
    let mut listed: Vec<String> = Vec::new();
    let mut total = 0usize;
    if let Some(ws) = workspace.map(str::trim).filter(|s| !s.is_empty()) {
        collect_workspace_files(std::path::Path::new(ws), ws, &mut listed, &mut total, 0);
    }
    let mut text = String::new();
    text.push_str("## 任务未正常完成\n");
    text.push_str(&format!("- 原因：{}（{}）\n", error_code, message));
    if total == 0 {
        text.push_str("- 已产出文件：无（工作空间为空或未绑定 workspace）\n");
    } else {
        text.push_str(&format!(
            "- 已产出文件（共 {} 个{}）：\n",
            total,
            if listed.len() < total { "，仅列前 20" } else { "" }
        ));
        for f in &listed {
            text.push_str(&format!("  - {}\n", f));
        }
    }
    text.push_str("- 建议：核对上方文件后决定续跑/拆分任务/加大预算（WD_RUN_MAX_SECS，改后重启生效）。\n");
    append_reply(&text);
    tracing::warn!(
        "[agent] finalize_run_summary: code={} 已产出文件总数={}",
        error_code,
        total
    );
}

/// 递归收集工作空间文件（相对路径 + 大小），跳过 `.wd_mem/`，最多收集 20 条、总数全统计。
fn collect_workspace_files(
    dir: &std::path::Path,
    root: &str,
    listed: &mut Vec<String>,
    total: &mut usize,
    depth: usize,
) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".wd_mem" {
            continue; // 红线：内部记忆目录不进用户可见正文
        }
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if meta.is_dir() {
            collect_workspace_files(&p, root, listed, total, depth + 1);
        } else {
            *total += 1;
            if listed.len() < 20 {
                let rel = p
                    .strip_prefix(root)
                    .map(|r| r.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| name.clone());
                listed.push(format!("{}（{} B）", rel, meta.len()));
            }
        }
    }
}

/// 自测闭环（#8 per-run）：取出指定 run 完整轨迹（事件列表 + 累计思考 + 累计正文 + 计数）。
/// run_id 不存在时返回空结构（不报错，便于并发场景早查询）。
pub fn get_trace(run_id: &str) -> serde_json::Value {
    let (events, thinking, reply, buckets) = {
        let map = run_traces().lock().unwrap_or_else(|e| e.into_inner());
        match map.get(run_id) {
            Some(b) => (
                b.events.clone(),
                b.thinking.clone(),
                b.reply.clone(),
                (b.prompt_tokens, b.completion_tokens),
            ),
            None => (Vec::new(), String::new(), String::new(), (0, 0)),
        }
    };
    serde_json::json!({
        "events": events,
        "thinking": thinking,
        "reply": reply,
        "counts": {
            "events": events.len(),
            "thinking_chars": thinking.chars().count(),
            "reply_chars": reply.chars().count(),
            "prompt_tokens": buckets.0,
            "completion_tokens": buckets.1,
        },
    })
}

/// 归属上下文注入（台账 D4 落盘用）：run spawn 顶层（commands.rs 两处 reset_trace 后）
/// 调用，使终态落盘的轨迹行带上 agent_id / session_id（历史回放按会话/智能体检索）。
pub fn set_trace_context(run_id: &str, agent_id: Option<String>, session_id: Option<String>) {
    with_run_trace_mut(run_id, |b| {
        b.agent_id = agent_id;
        b.session_id = session_id;
    });
}

/// 终态落盘（台账 D4-1）：把内存桶全量事件流归档进 `agent_run_trace`。
/// 由 emit_task_done spawn 异步执行（不阻塞终态推送）；重复终态经
/// `INSERT OR REPLACE` 幂等（后写覆盖前写，保留最后一次终态快照）。
async fn persist_finished_trace(app: AppHandle, run_id: String) {
    let snapshot = {
        let map = run_traces().lock().unwrap_or_else(|e| e.into_inner());
        match map.get(&run_id) {
            Some(b) => Some((
                b.events.clone(),
                b.thinking.clone(),
                b.reply.clone(),
                b.started_at,
                b.prompt_tokens,
                b.completion_tokens,
                b.agent_id.clone(),
                b.session_id.clone(),
            )),
            None => None,
        }
    };
    let Some((events, thinking, reply, started_at, p_tok, c_tok, agent_id, session_id)) = snapshot
    else {
        return;
    };
    if events.is_empty() {
        return; // 空桶（无事件）不值得归档
    }
    let pool = match crate::agent::engine::round_compactor::get_pool(&app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[events] persist_finished_trace: 取池失败（本次 run 不落盘）：{e}");
            return;
        }
    };
    let events_json = match serde_json::to_string(&events) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("[events] persist_finished_trace: 序列化失败：{e}");
            return;
        }
    };
    let finished_at = now_ms();
    let r = sqlx::query(
        "INSERT OR REPLACE INTO agent_run_trace \
         (run_id, agent_id, session_id, started_at, finished_at, events_json, thinking, reply, prompt_tokens, completion_tokens, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&run_id)
    .bind(&agent_id)
    .bind(&session_id)
    .bind(started_at)
    .bind(finished_at)
    .bind(&events_json)
    .bind(&thinking)
    .bind(&reply)
    .bind(p_tok as i64)
    .bind(c_tok as i64)
    .bind(finished_at)
    .execute(&pool)
    .await;
    match r {
        Ok(_) => tracing::info!(
            "[events] run 轨迹已落盘：run={} events={} reply={}字符 tokens=({},{})",
            run_id,
            events.len(),
            reply.chars().count(),
            p_tok,
            c_tok
        ),
        Err(e) => tracing::warn!("[events] run 轨迹落盘失败（run={}）：{e}", run_id),
    }
}

/// 历史 run 轨迹兜底读取（台账 D4-1）：内存桶 miss（重启/被淘汰）时查 `agent_run_trace`。
/// 返回与 get_trace 同构的 JSON；查无返回 None（调用方自行回退空桶）。
pub async fn get_trace_from_db(app: &AppHandle, run_id: &str) -> Option<serde_json::Value> {
    let pool = crate::agent::engine::round_compactor::get_pool(app).await.ok()?;
    let row = sqlx::query(
        "SELECT events_json, thinking, reply, prompt_tokens, completion_tokens \
         FROM agent_run_trace WHERE run_id = ?",
    )
    .bind(run_id)
    .fetch_optional(&pool)
    .await
    .ok()
    .flatten()?;
    let events_json: String = row.try_get("events_json").ok()?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&events_json).unwrap_or_default();
    let thinking: String = row.try_get("thinking").ok().unwrap_or_default();
    let reply: String = row.try_get("reply").ok().unwrap_or_default();
    let p_tok: i64 = row.try_get("prompt_tokens").ok().unwrap_or(0);
    let c_tok: i64 = row.try_get("completion_tokens").ok().unwrap_or(0);
    Some(serde_json::json!({
        "events": events,
        "thinking": thinking,
        "reply": reply,
        "counts": {
            "events": events.len(),
            "thinking_chars": thinking.chars().count(),
            "reply_chars": reply.chars().count(),
            "prompt_tokens": p_tok,
            "completion_tokens": c_tok,
        },
    }))
}

/// 引擎终态回填用（2026-09-21，#8 per-run）：指定 run 的思考累计快照（只读不清空，get_run_trace 仍可用）。
/// 此前仅前端链路在任务结束后经 updateRound 上报 thinking_content——MCP/无前端链路的轮次
/// 该列为空，UI 会话历史看不到思考过程（用户实锤「数据均要保存」）。
pub fn trace_thinking_snapshot(run_id: &str) -> String {
    run_traces()
        .lock()
        .unwrap()
        .get(run_id)
        .map(|b| b.thinking.clone())
        .unwrap_or_default()
}

/// 引擎终态回填用（#8 per-run）：从指定 run 的事件流提取 tool_finished 的工具调用摘要，
/// 序列化为前端 updateRound 同款落库格式 `[{name,status,args,result,step?}]`
/// （session-helpers 重建 ToolStep 卡片按此解析）。
pub fn trace_tool_calls_summary_json(run_id: &str) -> String {
    let events = run_traces()
        .lock()
        .unwrap()
        .get(run_id)
        .map(|b| b.events.clone())
        .unwrap_or_default();
    let mut out: Vec<serde_json::Value> = Vec::new();
    for e in events.iter() {
        let p = match e.get("payload") {
            Some(p) => p,
            None => continue,
        };
        if p.get("eventType").and_then(|x| x.as_str()) != Some("tool_finished") {
            continue;
        }
        let step = match p.get("step") {
            Some(s) => s,
            None => continue,
        };
        let name = step.get("toolName").and_then(|x| x.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        out.push(serde_json::json!({
            "name": name,
            "status": step.get("status").and_then(|x| x.as_str()).unwrap_or("success"),
            "args": step.get("args").cloned().unwrap_or(serde_json::Value::Null),
            "result": step.get("result").cloned().unwrap_or(serde_json::Value::Null),
            "step": step.get("step").cloned().unwrap_or(serde_json::Value::Null),
        }));
    }
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

use crate::agent::knowledge::memory::MemoryItem;
use crate::agent::knowledge::memory::SquadMemoryItem;
use crate::agent::hitl::plan_approval::PlanApprovalRequest;
use crate::agent::hitl::recovery::RecoveryRequest;
use crate::agent::types::ApprovalRequest;
use crate::agent::types::ChoiceRequest;
use crate::agent::types::ArtifactRef;
use crate::agent::types::IntentProfile;
use crate::agent::types::ToolStep;

pub const EVT_AGENT_EVENT: &str = "agent-event";
pub const EVT_APPROVAL: &str = "agent-awaiting-approval";
pub const EVT_TASK_DONE: &str = "agent-task-done";
pub const EVT_TASK_ERROR: &str = "agent-task-error";
/// 实时 token 用量增量：任务运行中按累计值推送（规划后 + 每个子任务完成后各一次），
/// 供前端顶栏「本次任务」计数卡实时跳数；与 `agent-task-done` 同构但语义独立（不触发完成态）。
pub const EVT_TOKEN_UPDATE: &str = "agent-token-update";
/// 子任务产物登记：每当一个子任务成功闭环并登记文件产物即推送，
/// 供前端「产物画廊」按步骤浏览 / 打开 / 定位 / 复制路径。
pub const EVT_ARTIFACT_CREATED: &str = "agent-artifact-created";
/// 步骤级恢复：子任务自动重试耗尽仍失败，挂起等待用户决策（重试/跳过/接管）。
pub const EVT_RECOVERY_NEEDED: &str = "agent-recovery-needed";
/// 方案推荐：Agent 主动询问用户，挂起等待选择（选项列表）。
pub const EVT_CHOICE_NEEDED: &str = "agent-choice-needed";
/// 计划审批门禁（Phase 2b-3）：DAG 规划完成后、流水线执行前，挂起等待用户确认/修改/拒绝。
pub const EVT_PLAN_APPROVAL_NEEDED: &str = "agent-plan-approval-needed";
/// 分支重规划：前端「从此步骤分支」触发的双分支对比结果（原尾段 vs 新分支），
/// 供画布分支对比横幅渲染 + 「应用分支」按钮。
pub const EVT_PLAN_BRANCH: &str = "agent-plan-branch";
/// 记忆召回：某条记忆被自动/手动召回（引用计数 +1）后推送，供「记忆宫殿」实时刷新引用计数热力图。
pub const EVT_MEMORY_RECALLED: &str = "agent-memory-recalled";

/// 记忆向量回填进度（#20260918004）：批量向量化存量记忆时逐批推送。
pub const EVT_MEMORY_BACKFILL: &str = "agent-memory-backfill";
/// 上下文压缩完成（结构化事件）：替代原先只发一句 `emit_status` 字符串，携带压缩轮数/摘要长度/
/// 估算节省 token，供「记忆宫殿」「上下文健康」视图结构化展示。
pub const EVT_CONTEXT_COMPACTED: &str = "agent-context-compacted";
/// 知识库索引进度（K1'）：单资产同步/全量重建时逐批推送（parse/chunk/embed/upsert/done/skip/error）。
pub const EVT_KB_INDEX_PROGRESS: &str = "agent-kb-index-progress";

/// `agent-event` 载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPayload {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<ToolStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk: Option<StreamChunk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    /// 规划/步骤视图（plan_generated / step_started / step_finished 事件携带）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<serde_json::Value>,
    /// 意图分类结果（intent_classified 事件携带），序列化后的 IntentProfile。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<serde_json::Value>,
    /// host__exec 增量输出（host_exec_output 事件携带，台账 D5）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_output: Option<HostExecOutputPayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub text: String,
    pub done: bool,
    /// 思考分层标签（thinking_chunk 事件携带）：plan=规划 / exec=执行 / selfcheck=自检。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
}

fn emit(app: &AppHandle, event: &str, payload: &impl Serialize) {
    // 自测闭环：把事件落轨迹缓冲（text/thinking_chunk 已在各自专用函数累加，此处跳过）。
    push_event(event, payload);
    // F007 事件归属：run 作用域内的事件统一盖 session 戳（归属会话经 set_trace_context 注入），
    // 前端据此路由到归属会话——并发 run 的事件不再互相污染；非会话通道无戳、走既有路由。
    let mut value = serde_json::to_value(payload).unwrap_or(serde_json::Value::Null);
    if let Some(obj) = value.as_object_mut() {
        if let Some(sid) = current_session_id() {
            obj.insert("sessionId".to_string(), serde_json::Value::String(sid));
        }
    }
    if let Err(e) = app.emit(event, &value) {
        tracing::warn!("[agent] emit `{event}` failed: {e}");
    } else {
        tracing::info!("[agent] emit `{event}` ok");
    }
}

/// 工具开始调用。
pub fn emit_tool_started(app: &AppHandle, step: &ToolStep) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "tool_started".into(),
            step: Some(step.clone()),
            chunk: None,
            message: None,
            seq: None,
            plan: None,
            intent: None,
            host_output: None,
        },
    );
}

/// 工具结束（success / failed）。
pub fn emit_tool_finished(app: &AppHandle, step: &ToolStep) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "tool_finished".into(),
            step: Some(step.clone()),
            chunk: None,
            message: None,
            seq: None,
            plan: None,
            intent: None,
            host_output: None,
        },
    );
}

/// 模型流式文本片段。
pub fn emit_text_chunk(app: &AppHandle, text: &str, done: bool) {
    // 自测闭环：累计正文回复片段（与前端流式推送解耦，独立落轨迹缓冲）。
    append_reply(text);
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "text_chunk".into(),
            step: None,
            chunk: Some(StreamChunk {
                text: text.into(),
                done,
                layer: None,
            }),
            message: None,
            seq: None,
            plan: None,
            intent: None,
            host_output: None,
        },
    );
}

/// 状态提示（如「正在规划…」）。
pub fn emit_status(app: &AppHandle, message: &str) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "status".into(),
            step: None,
            chunk: None,
            message: Some(message.into()),
            seq: None,
            plan: None,
            intent: None,
            host_output: None,
        },
    );
}

/// 单步错误。
pub fn emit_error(app: &AppHandle, message: &str) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "error".into(),
            step: None,
            chunk: None,
            message: Some(message.into()),
            seq: None,
            plan: None,
            intent: None,
            host_output: None,
        },
    );
}

/// 意图分类结果（阶段一分流后推送），供轨迹视图首节点展示。
/// `IntentProfile` 已序列化进 `intent` 字段。
pub fn emit_intent_classified(app: &AppHandle, profile: &IntentProfile) {
    let intent = serde_json::to_value(profile).ok();
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "intent_classified".into(),
            step: None,
            chunk: None,
            message: None,
            seq: None,
            plan: None,
            intent,
            host_output: None,
        },
    );
}

/// 分层思考片段（thinking_chunk）：规划/执行/自检三层的推理文本。
/// 替代原先把规划推理误塞进 `status` 的做法，让轨迹视图能按 layer 着色区分。
pub fn emit_thinking_chunk(app: &AppHandle, text: &str, done: bool, layer: &str) {
    // 自测闭环：累计思考片段（与前端流式推送解耦，独立落轨迹缓冲）。
    append_thinking(text);
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "thinking_chunk".into(),
            step: None,
            chunk: Some(StreamChunk {
                text: text.into(),
                done,
                layer: Some(layer.into()),
            }),
            message: None,
            seq: None,
            plan: None,
            intent: None,
            host_output: None,
        },
    );
}

/// 高危操作挂起（等待前端审批）。
pub fn emit_awaiting_approval(app: &AppHandle, req: &ApprovalRequest) {
    emit(app, EVT_APPROVAL, req);
}

/// 小分队成员高危操作挂起（2026-10-01 复盘 P3）：与单 Agent 通道分流成独立事件名，
/// agent-studio 的全局事件桥（只订阅 `agent-awaiting-approval`）不会再把成员审批
/// 误路由进正在运行的单 Agent 会话——此前会污染会话状态、代发系统通知，且 studio
/// 的批准按钮对成员审批是查不到挂起项的死路。
pub const EVT_SQUAD_APPROVAL: &str = "squad-awaiting-approval";

/// 成员审批事件负载：ApprovalRequest 打平 + squadId。前端工作台按 squadId 过滤，
/// 防止后台其他编队的审批串进当前工作台的卡片列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberApprovalEvent<'a> {
    #[serde(flatten)]
    pub request: &'a ApprovalRequest,
    pub squad_id: &'a str,
}

/// 成员高危操作挂起：携带所属小分队 id 推给前端工作台。
pub fn emit_member_awaiting_approval(app: &AppHandle, req: &ApprovalRequest, squad_id: &str) {
    emit(app, EVT_SQUAD_APPROVAL, &MemberApprovalEvent { request: req, squad_id });
}

/// 方案推荐挂起（Agent 主动询问用户，等待前端选择）。
pub fn emit_choice_needed(app: &AppHandle, req: &ChoiceRequest) {
    emit(app, EVT_CHOICE_NEEDED, req);
}

/// 整轮任务结束载荷：携带本轮真实 token 用量（prompt + completion，跨所有 ReAct 轮累计）。
///
/// 后端在 `run_task` 中把本轮 LLM 真实 `usage` 累加后随事件带出，前端据此替代
/// 前端「仅首尾文本」的粗略估算，正确展示单条消息与会话环形图的 token 消耗。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDonePayload {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// 整轮任务结束。同时把真实 token 用量写入 per-run 轨迹桶（成本观测；
/// 各分支每次传入的均为该 run 的最终累计值，覆盖写入即可）。
pub fn emit_task_done(app: &AppHandle, prompt_tokens: u64, completion_tokens: u64) {
    let rid = current_run_id();
    with_run_trace_mut(&rid, |b| {
        b.prompt_tokens = prompt_tokens;
        b.completion_tokens = completion_tokens;
    });
    // 台账 D4-1：终态异步落盘（agent_run_trace）——不阻塞终态推送；
    // app clone 进后台 Task（Send + 'static）。
    let app_bg = app.clone();
    let rid_bg = rid.clone();
    tauri::async_runtime::spawn(async move {
        persist_finished_trace(app_bg, rid_bg).await;
    });
    emit(
        app,
        EVT_TASK_DONE,
        &TaskDonePayload {
            prompt_tokens,
            completion_tokens,
        },
    );
}

/// 整轮任务异常终止。
pub fn emit_task_error(app: &AppHandle, message: &str) {
    // F007：载荷从裸字符串升级为对象（sessionId 归属戳由 emit 统一盖上）。
    emit(app, EVT_TASK_ERROR, &serde_json::json!({ "message": message }));
}

/// 实时 token 用量增量载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUpdatePayload {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// 实时 token 用量增量：任务运行中累计推送（prompt + completion）。
/// 与 `emit_task_done` 同构，但独立事件、不触发完成态；前端据此实时更新顶栏计数卡。
pub fn emit_token_update(app: &AppHandle, prompt_tokens: u64, completion_tokens: u64) {
    emit(
        app,
        EVT_TOKEN_UPDATE,
        &TokenUpdatePayload {
            prompt_tokens,
            completion_tokens,
        },
    );
}

/// 单次 LLM 请求的窗口占用（2026-09-18 修正）：每次 LLM 调用（流式/非流式）完成后推送
/// 该次请求的真实 prompt/completion。此前前端只有任务级累计（跨所有子任务所有 ReAct 轮），
/// 误当「窗口占用」展示（实测 5 步任务累计 912K 被显示成 713% 窗口——口径完全错误）。
/// 真实的上下文压力指标 = 最近一次请求的 prompt / contextLength。
pub const EVT_LLM_USAGE: &str = "agent-llm-usage";

pub fn emit_llm_usage(app: &AppHandle, prompt_tokens: u64, completion_tokens: u64) {
    emit(
        app,
        EVT_LLM_USAGE,
        &TokenUpdatePayload {
            prompt_tokens,
            completion_tokens,
        },
    );
}

/// 阶段二规划生成：推送任务步骤清单，前端渲染步骤进度条。
pub fn emit_plan_generated(app: &AppHandle, plan: &crate::agent::types::PlanDAG) {
    let tasks: Vec<serde_json::Value> = plan
        .tasks
        .iter()
        .map(|t| {
            serde_json::json!({
                "step": t.step,
                "taskId": t.task_id,
                "title": t.title,
                "description": t.description,
                "status": "pending",
                "dependsOn": t.depends_on,
            })
        })
        .collect();
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "plan_generated".into(),
            step: None,
            chunk: None,
            message: None,
            seq: None,
            plan: Some(serde_json::json!({
                "goalSummary": plan.goal_summary,
                "tasks": tasks,
            })),
            intent: None,
            host_output: None,
        },
    );
}

/// 计划审批门禁（Phase 2b-3）：规划完成后、执行前推计划清单，前端渲染「计划确认」弹窗等待决策。
pub fn emit_plan_approval_needed(app: &AppHandle, req: &PlanApprovalRequest) {
    let tasks: Vec<serde_json::Value> = req
        .plan
        .tasks
        .iter()
        .map(|t| {
            serde_json::json!({
                "step": t.step,
                "taskId": t.task_id,
                "title": t.title,
                "description": t.description,
                "dependsOn": t.depends_on,
            })
        })
        .collect();
    emit(
        app,
        EVT_PLAN_APPROVAL_NEEDED,
        &serde_json::json!({
            "goalSummary": req.goal_summary,
            "tasks": tasks,
            // 15007 边审批策略：计划内敏感操作清单（批准=一次授权整清单）
            "sensitiveOps": req.sensitive_ops,
        }),
    );
}

/// 子任务开始：进度条对应步骤置为 running。
pub fn emit_step_started(app: &AppHandle, step: usize, total: usize, title: &str) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "step_started".into(),
            step: None,
            chunk: None,
            message: Some(format!("步骤 {step}/{total}：{title}")),
            seq: None,
            plan: Some(serde_json::json!({
                "step": step,
                "total": total,
                "title": title,
                "status": "running",
            })),
            intent: None,
            host_output: None,
        },
    );
}

/// 子任务结束：进度条对应步骤置为 success / failed / skipped，并携带产物摘要。
pub fn emit_step_finished(
    app: &AppHandle,
    step: usize,
    total: usize,
    title: &str,
    ok: bool,
    summary: &str,
    // 是否已验证：true=有客观依据（声明 success_criteria 且通过校验）；
    // false=暂定（无 criteria 仅模型自报，或失败/跳过）。前端据此渲染「已验证/暂定」角标。
    verified: bool,
    // 验证依据（客观通过时的 evidence 文本，或暂定/失败原因），前端角标 hover 展示。
    evidence: &str,
    // 是否为跳过终态：true 时事件 status 下发 "skipped"（前端画灰「已跳过」），
    // 不再被 ok=true 洗成 success（修复 skip 步在画布误显示绿色「已完成」）。
    skipped: bool,
) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "step_finished".into(),
            step: None,
            chunk: None,
            message: Some(format!(
                "步骤 {step}/{total}：{} {}",
                title,
                if skipped {
                    "已跳过"
                } else if ok {
                    "完成"
                } else {
                    "失败"
                }
            )),
            seq: None,
            plan: Some(serde_json::json!({
                "step": step,
                "total": total,
                "title": title,
                "status": if skipped {
                    "skipped"
                } else if ok {
                    "success"
                } else {
                    "failed"
                },
                "summary": summary,
                "verified": verified,
                "evidence": evidence,
            })),
            intent: None,
            host_output: None,
        },
    );
}

/// 子任务受阻：进入恢复等待（Retry/Skip/Takeover/ChangeApproach/Cancel 等待用户决策）。
/// 进度条对应步骤置为 `blocked`（琥珀「受阻待决策」），与终态 `failed` 区分——画布不再把
/// "等你拍板" 误画成 "这步死了"。
pub fn emit_step_blocked(app: &AppHandle, step: usize, total: usize, title: &str, summary: &str) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "step_blocked".into(),
            step: None,
            chunk: None,
            message: Some(format!("步骤 {step}/{total}：{title} 受阻，等待恢复决策")),
            seq: None,
            plan: Some(serde_json::json!({
                "step": step,
                "total": total,
                "title": title,
                "status": "blocked",
                "summary": summary,
            })),
            intent: None,
            host_output: None,
        },
    );
}

/// 子任务重试中：恢复决策（Retry/Takeover/ChangeApproach）或 never 模式自动接管重试后重新执行。
/// 进度条对应步骤置为 `retrying`（蓝「重试中」），随后 `run_subtask` 的 `step_started` 翻成 `running`，
/// 形成 `blocked/retrying → running` 可见过渡，让"这步已失败过一次、正在自愈"可被观测。
pub fn emit_step_retrying(app: &AppHandle, step: usize, total: usize, title: &str) {
    emit(
        app,
        EVT_AGENT_EVENT,
        &AgentEventPayload {
            event_type: "step_retrying".into(),
            step: None,
            chunk: None,
            message: Some(format!("步骤 {step}/{total}：{title} 重试中")),
            seq: None,
            plan: Some(serde_json::json!({
                "step": step,
                "total": total,
                "title": title,
                "status": "retrying",
            })),
            intent: None,
            host_output: None,
        },
    );
}

/// 子任务产物登记载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCreatedPayload {
    pub step: usize,
    pub artifacts: Vec<ArtifactRef>,
}

/// 子任务成功闭环并登记文件产物后推送，供前端「产物画廊」渲染。
pub fn emit_artifact_created(app: &AppHandle, step: usize, artifacts: &[ArtifactRef]) {
    emit(
        app,
        EVT_ARTIFACT_CREATED,
        &ArtifactCreatedPayload {
            step,
            artifacts: artifacts.to_vec(),
        },
    );
}

/// 步骤级恢复载荷（camelCase）：受阻子任务信息，供前端恢复面板渲染。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNeededPayload {
    pub step: usize,
    pub task_id: String,
    pub title: String,
    pub reason: String,
    pub summary: String,
    /// 异常分档：A=可恢复（3 键：跳过|重试|接管）/ B=高风险歧义（4 键，含改方案）。2a 恒为 "A"。
    pub tier: String,
    /// 失败命令（接管面板展示用，2a 可空）。
    pub failed_command: Option<String>,
    /// 已改动文件（接管面板展示用，2b-2 起真实采集）。
    pub changed_files: Option<Vec<String>>,
    /// 工具栈快照（接管面板展示用，2b-2 新增）。
    pub tool_stack: Option<crate::agent::hitl::recovery::AgentToolStack>,
}

/// 子任务自动重试耗尽仍失败：登记受阻步骤并推前端渲染恢复面板（重试/跳过/接管）。
pub fn emit_recovery_needed(app: &AppHandle, req: &RecoveryRequest) {
    emit(
        app,
        EVT_RECOVERY_NEEDED,
        &RecoveryNeededPayload {
            step: req.step,
            task_id: req.task_id.clone(),
            title: req.title.clone(),
            reason: req.reason.clone(),
            summary: req.summary.clone(),
            tier: req.tier.clone(),
            failed_command: req.failed_command.clone(),
            changed_files: req.changed_files.clone(),
            tool_stack: req.tool_stack.clone(),
        },
    );
}

/// 分支重规划结果：推前端画布「从此步骤分支」的对比横幅（原尾段 vs 新分支）。
pub fn emit_plan_branch(app: &AppHandle, branch: &crate::agent::types::PlanBranchGenerated) {
    emit(app, EVT_PLAN_BRANCH, branch);
}

/// 记忆召回载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecalledPayload {
    pub item: MemoryItem,
}

/// host__exec 增量输出（台账 D5：exec 流式传输）。
/// 长命令执行期间逐块推送 stdout/stderr，前端/轨迹可实时观测；
/// 单命令总推送量由 exec.rs 封顶（默认 64KB），防止 tail -f 类高频流刷屏。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostExecOutputPayload {
    /// 调用唯一标识（前端据此关联到 running 态工具步骤卡片）。
    pub call_id: String,
    pub tool_name: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub server_id: String,
    pub stream: String, // "stdout" | "stderr"
    pub chunk: String,
    /// 该命令累计已推送字节数（封顶判断用）。
    pub streamed_bytes: usize,
    pub truncated: bool,
}

/// host__exec 增量输出：走 `agent-event` 单通道（event_type=host_exec_output，
/// 前端 runtimeStore 一个 case 路由）；`emit()` 内部已落 trace 桶（MCP/评测可断言），
/// 勿再手动 push_event（会双写）。
pub fn emit_host_exec_output(app: &AppHandle, payload: &HostExecOutputPayload) {
    emit(
        app,
        "agent-event",
        &AgentEventPayload {
            event_type: "host_exec_output".into(),
            step: None,
            chunk: None,
            message: None,
            seq: None,
            plan: None,
            intent: None,
            host_output: Some(payload.clone()),
        },
    );
}

/// 记忆被召回（引用计数 +1）后推送，供「记忆宫殿」实时刷新引用计数与热力图。
pub fn emit_memory_recalled(app: &AppHandle, item: &MemoryItem) {
    emit(
        app,
        EVT_MEMORY_RECALLED,
        &MemoryRecalledPayload {
            item: item.clone(),
        },
    );
}

/// 上下文压缩完成载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompactedPayload {
    /// 本次被合并进摘要的历史轮次数。
    pub compacted_rounds: usize,
    /// 压缩后摘要字符长度。
    pub summary_length: usize,
    /// 估算节省的上下文 token（被压缩轮次 raw_messages 总字符 / 4 近似）。
    pub tokens_saved: usize,
    /// 是否成功写出新摘要（false 时仅事件提示，未真正压缩）。
    pub success: bool,
}

/// 滚动压缩完成：推送结构化事件（替代纯 `emit_status` 字符串），供前端结构化展示。
pub fn emit_context_compacted(app: &AppHandle, payload: &ContextCompactedPayload) {
    emit(app, EVT_CONTEXT_COMPACTED, payload);
}

/// 记忆锚定（手动或智能体自动沉淀）后推送，供「记忆宫殿」实时新增/更新卡片（无需重开页面）。
pub const EVT_MEMORY_ANCHORED: &str = "agent-memory-anchored";

/// 记忆锚定载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAnchoredPayload {
    pub item: MemoryItem,
}

/// 记忆被锚定后推送：手动锚定（UI 按钮）与智能体自动沉淀（native__anchor_memory 工具）都走
/// `memory::anchor_memory`，故在此统一发射，前端据此 upsert 卡片网格实现实时刷新。
pub fn emit_memory_anchored(app: &AppHandle, item: &MemoryItem) {
    emit(app, EVT_MEMORY_ANCHORED, &MemoryAnchoredPayload { item: item.clone() })
}

// ============================ 小分队协作（Squad）事件 ============================

/// 小分队协作会话开始（编排式 / 流水线 / 群聊 共用）。
pub const EVT_SQUAD_SESSION_STARTED: &str = "agent-squad-session-started";
/// 协作轮次产出（某成员发言 / 子任务交付 / 最终汇总）。
pub const EVT_SQUAD_ROUND: &str = "agent-squad-round";
/// 小分队协作会话结束（带最终汇总）。
pub const EVT_SQUAD_SESSION_DONE: &str = "agent-squad-session-done";
/// 小分队记忆被锚定后推送：手动锚定（记忆面板 UI）与（未来）智能体自动沉淀都走
/// `memory::anchor_squad_memory`，故在此统一发射，前端记忆面板据此 upsert 卡片实现实时刷新。
pub const EVT_SQUAD_MEMORY_ANCHORED: &str = "agent-squad-memory-anchored";

/// 小分队会话开始载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadSessionStartedPayload {
    pub squad_id: String,
    pub session_id: String,
    /// 协作模式：orchestrator / pipeline / chat。
    pub mode: String,
}

/// 协作轮次载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadRoundPayload {
    pub squad_id: String,
    pub session_id: String,
    /// 发言成员智能体 id（汇总轮次为 None）。
    pub speaker_agent_id: Option<String>,
    /// 该成员承担的角色，如「后端开发」。
    pub role: String,
    /// 轮次类型：delegation（主管委派规划）/ subtask（成员子任务交付）/ summary（最终汇总）。
    pub kind: String,
    pub content: String,
}

/// 小分队会话结束载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadSessionDonePayload {
    pub squad_id: String,
    pub session_id: String,
    pub summary: String,
}

pub fn emit_squad_session_started(app: &AppHandle, payload: &SquadSessionStartedPayload) {
    emit(app, EVT_SQUAD_SESSION_STARTED, payload);
}

pub fn emit_squad_round(app: &AppHandle, payload: &SquadRoundPayload) {
    emit(app, EVT_SQUAD_ROUND, payload);
}

pub fn emit_squad_session_done(app: &AppHandle, payload: &SquadSessionDonePayload) {
    emit(app, EVT_SQUAD_SESSION_DONE, payload);
}

/// 小分队记忆锚定载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadMemoryAnchoredPayload {
    pub item: SquadMemoryItem,
}

pub fn emit_squad_memory_anchored(app: &AppHandle, item: &SquadMemoryItem) {
    emit(
        app,
        EVT_SQUAD_MEMORY_ANCHORED,
        &SquadMemoryAnchoredPayload { item: item.clone() },
    );
}

// ---- S2（§4.11）打断说话生命周期事件：queued（入队）/ delivered（已注入成员下一轮）/ dropped（节点已终态） ----

pub const EVT_SQUAD_INJECT_QUEUED: &str = "agent-squad-inject-queued";
pub const EVT_SQUAD_INJECT_DELIVERED: &str = "agent-squad-inject-delivered";
pub const EVT_SQUAD_INJECT_DROPPED: &str = "agent-squad-inject-dropped";

/// 插话生命周期载荷（camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadInjectEventPayload {
    pub inject_id: String,
    pub squad_id: String,
    pub session_id: String,
    /// 目标键：编排式任务 id / 流水线节点 id / 群聊成员 agent_id。
    pub task_id: String,
    /// soft | hard | pre_talk。
    pub mode: String,
}

fn emit_squad_inject_event(app: &AppHandle, event: &str, payload: &SquadInjectEventPayload) {
    emit(app, event, payload);
}

pub fn emit_squad_inject_queued(app: &AppHandle, payload: &SquadInjectEventPayload) {
    emit_squad_inject_event(app, EVT_SQUAD_INJECT_QUEUED, payload);
}

pub fn emit_squad_inject_delivered(app: &AppHandle, payload: &SquadInjectEventPayload) {
    emit_squad_inject_event(app, EVT_SQUAD_INJECT_DELIVERED, payload);
}

pub fn emit_squad_inject_dropped(app: &AppHandle, payload: &SquadInjectEventPayload) {
    emit_squad_inject_event(app, EVT_SQUAD_INJECT_DROPPED, payload);
}

/// 记忆向量回填进度载荷（#20260918004）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBackfillProgress {
    /// 已处理条数（含失败）。
    pub done: u32,
    /// 存量记忆总条数。
    pub total: u32,
    /// 本批成功条数（累计）。
    pub ok: u32,
    /// 本批失败条数（累计）。
    pub failed: u32,
    /// 是否已结束（最后一批置 true，前端收尾）。
    pub finished: bool,
}

pub fn emit_memory_backfill_progress(app: &AppHandle, p: &MemoryBackfillProgress) {
    emit(app, EVT_MEMORY_BACKFILL, p);
}

/// 知识库索引进度（K1'）。`phase`：upsert=资产完成 / skip=格式跳过 / error=失败 /
/// done=整体收尾（finished=true）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbIndexProgress {
    pub kb_id: String,
    pub phase: String,
    /// 已处理资产数（含跳过/失败）。
    pub done: u32,
    /// 资产总数。
    pub total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 是否已结束（最后一批/整体收尾置 true，前端收尾）。
    pub finished: bool,
}

pub fn emit_kb_index_progress(app: &AppHandle, p: &KbIndexProgress) {
    emit(app, EVT_KB_INDEX_PROGRESS, p);
}

// ============================ #8 per-run 隔离单测 ============================
#[cfg(test)]
mod tests {
    use super::*;

    /// #8 核心不变量：两个并发 run 写入各自的桶，互不串台。
    /// 这正是最初「三个全局单例 + reset」实现的缺陷——并发 run 会互相覆盖。
    #[test]
    fn per_run_trace_isolation() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            reset_trace("runA");
            reset_trace("runB");

            with_run_id_scope("runA".to_string(), async {
                push_event(
                    "agent-event",
                    &serde_json::json!({"type": "status", "message": "from-A"}),
                );
                append_reply("reply-A");
                append_thinking("think-A");
            })
            .await;

            with_run_id_scope("runB".to_string(), async {
                push_event(
                    "agent-event",
                    &serde_json::json!({"type": "status", "message": "from-B"}),
                );
                append_reply("reply-B");
                append_thinking("think-B");
            })
            .await;

            let ta = get_trace("runA");
            let tb = get_trace("runB");

            // 各自桶内容隔离
            assert_eq!(ta["reply"].as_str().unwrap(), "reply-A");
            assert_eq!(tb["reply"].as_str().unwrap(), "reply-B");
            assert_eq!(ta["thinking"].as_str().unwrap(), "think-A");
            assert_eq!(tb["thinking"].as_str().unwrap(), "think-B");

            // 互不包含对方内容
            assert!(!ta["reply"].as_str().unwrap().contains("B"));
            assert!(!tb["reply"].as_str().unwrap().contains("A"));

            // 事件计数各自独立（各 1 条）
            assert_eq!(ta["counts"]["events"].as_u64().unwrap(), 1);
            assert_eq!(tb["counts"]["events"].as_u64().unwrap(), 1);
            assert_eq!(ta["counts"]["reply_chars"].as_u64().unwrap(), 7);
            assert_eq!(tb["counts"]["reply_chars"].as_u64().unwrap(), 7);
        });
    }

    /// #8 边界：查询不存在的 run_id 返回空结构，不报错、不误读其他 run。
    #[test]
    fn unknown_run_returns_empty() {
        let t = get_trace("never-existed");
        assert_eq!(t["events"].as_array().unwrap().len(), 0);
        assert_eq!(t["thinking"].as_str().unwrap(), "");
        assert_eq!(t["reply"].as_str().unwrap(), "");
        assert_eq!(t["counts"]["events"].as_u64().unwrap(), 0);
    }

    /// #8 边界：reset_trace 仅清空指定桶，不动其他 run 的桶。
    #[test]
    fn reset_is_per_run() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            reset_trace("keep");
            with_run_id_scope("keep".to_string(), async {
                append_reply("keep-content");
            })
            .await;
            // reset 另一个 id，不应影响 keep
            reset_trace("other");
            let tk = get_trace("keep");
            assert_eq!(tk["reply"].as_str().unwrap(), "keep-content");
        });
    }


    #[test]
    fn f007_session_stamp_resolves_via_trace_context() {
        // F007：事件归属戳——set_trace_context 注入会话后，run 作用域内 current_session_id
        // 应解析出归属会话；未注入（squad/非会话通道）为 None。
        let rid = "f007-stamp-run".to_string();
        let sid = "f007-stamp-session".to_string();
        reset_trace(&rid);
        set_trace_context(&rid, Some("agent-x".into()), Some(sid.clone()));
        let got = with_run_id_scope(rid.clone(), async {
            let a = current_session_id();
            assert_eq!(a.as_deref(), Some("f007-stamp-session"), "作用域内应解析出归属会话");
            let r = current_run_id();
            assert_eq!(r, rid, "run_id 同源");
        });
        tauri::async_runtime::block_on(got);
        // 作用域外：无 run_id → None
        let outside = CURRENT_RUN_ID.try_with(|_| ()).is_err();
        assert!(outside || current_session_id().is_none(), "作用域外不应有归属会话");
    }
}
