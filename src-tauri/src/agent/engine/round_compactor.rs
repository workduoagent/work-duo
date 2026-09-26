//! 轮次滚动压缩器（Rolling Compaction）。
//!
//! 对应《桌面端智能体双表会话持久化与后台滚动压缩设计规范》：
//!  - **双重视图隔离**：轮次表既存人类可读视图（`thinking_content`/`assistant_answer`/
//!    `tool_calls_summary`，由前端写入驱动 UI 渲染），也存协议执行视图
//!    `raw_messages_json`（当前轮完整 ChatMessage 数组，由本模块在 ReAct 循环结束后
//!    回填，多轮恢复时原样反序列化展开，无损、零格式损耗）。
//!  - **零延迟首字响应**：压缩**绝不**在用户提问时同步阻塞。第 N 轮完成后由
//!    `trigger_background_compaction` 派发 Tokio 异步任务静默合并，下一轮直接读已持久化的
//!    `summary`，实现零前置等待。
//!  - **Prompt 缓存友好**：Slot0 固定系统提示词；`tools` 仅作顶层参数传入，绝不序列化进
//!    对话；Slot1 承载滚动 Markdown 摘要快照（`[Workspace Active Context & Historical Summary]`），
//!    最大化命中模型供应商上下文缓存。
//!
//! 装配（读路径）由 `build_request_messages` 完成：system + 摘要 + 活跃窗口轮次(restore) + 当前。
//! 压缩（写路径）由 `trigger_background_compaction` 完成：每 `trigger_threshold`(5) 个未压缩轮次
//! 触发一次，向前滚动合并 `roll_forward_count`(2) 个旧轮次进 `summary`，`summary_round_count`
//! （= last_compact_turn）随之推进。

use serde_json::json;
use serde_json::Value;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_sql::DbInstances;
use tauri_plugin_sql::DbPool;
use tokio::time::sleep;
use tokio::time::timeout;
use tokio::time::Duration;

use crate::agent::events;
use crate::agent::engine::runtime::call_llm;
use crate::agent::engine::runtime::now_ms;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::ArtifactRef;
use crate::agent::knowledge::wd_mem;

/// 单个工具 / Skill 定义占用的上下文 token 估算（与前端 `AVG_TOOL_TOKENS` 保持一致）。
/// 工具/Skill 定义理论固定不变，仅当用户中途移除 Skill 或停用（解绑）MCP 时总占用才会下降。
const AVG_TOOL_TOKENS: i64 = 300;

/// 轮次记录实体（读路径使用；字段仅保留装配/压缩真正需要的列）。
#[derive(Debug, Clone)]
pub(crate) struct ConversationRoundRecord {
    pub round_index: i64,
    pub user_question: Option<String>,
    pub assistant_answer: Option<String>,
    pub tool_calls_summary: Option<String>,
    pub raw_messages_json: String,
}

impl ConversationRoundRecord {
    /// 反序列化还原该轮次产生的所有原始 ChatMessage（协议视图，无损）。
    /// 若 `raw_messages_json` 为空（存量数据 / 尚未回填），回退用 user/assistant 文本重建。
    pub(crate) fn restore_messages(&self) -> Vec<Value> {
        if self.raw_messages_json.trim().is_empty() {
            let mut v = Vec::new();
            if let Some(q) = &self.user_question {
                if !q.trim().is_empty() {
                    v.push(json!({ "role": "user", "content": q }));
                }
            }
            if let Some(a) = &self.assistant_answer {
                if !a.trim().is_empty() {
                    v.push(json!({ "role": "assistant", "content": a }));
                }
            }
            return v;
        }
        serde_json::from_str(&self.raw_messages_json).unwrap_or_default()
    }
}

/// 滚动压缩配置（默认：每 5 轮触发、向前滚动合并 2 轮）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct CompactorConfig {
    pub trigger_threshold: i64,
    pub roll_forward_count: i64,
}

impl Default for CompactorConfig {
    fn default() -> Self {
        Self {
            trigger_threshold: 5,
            roll_forward_count: 2,
        }
    }
}

/// 从 Tauri 托管的 DbInstances 取出 `sqlite:workduo.db` 连接池（与 engine::config_loader::load_config 同机制）。
pub(crate) async fn get_pool(app: &AppHandle) -> Result<SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let guard = instances.0.read().await;
    let pool = match guard
        .get("sqlite:workduo.db")
        .ok_or_else(|| "数据库未连接（sqlite:workduo.db）".to_string())?
    {
        DbPool::Sqlite(p) => p.clone(),
    };
    drop(guard);
    Ok(pool)
}

/// 后台任务初始化前的就绪闸门：轮询确认 SQLite 连接池可用（bounded 超时 30s）。
///
/// 任何后台调度 / 定时任务（滚动压缩、环境预热等）都必须先 `await` 本函数，
/// 确保核心应用上下文（App Context、DB Pool）完全初始化后再执行，杜绝启动早期
/// 组件未就绪导致的空指针或数据库连接断裂。
#[tracing::instrument(skip_all)]
pub(crate) async fn wait_db_ready(app: &AppHandle) -> Result<(), String> {
    let probe = async {
        loop {
            if get_pool(app).await.is_ok() {
                return Ok(());
            }
            sleep(Duration::from_millis(200)).await;
        }
    };
    match timeout(Duration::from_secs(30), probe).await {
        Ok(r) => r,
        Err(_) => Err("等待数据库就绪超时（30s），后台初始化跳过".into()),
    }
}

/* ----------------------------- 读路径：上下文装配 ----------------------------- */

/// 装配发往大模型的完整消息序列（纯函数，不做 IO）：
///   [Slot 0] 静态 System Prompt（+ 工程专属 custom_rules 已在调用方并入 system_prompt）
///   [Slot 1] 项目长期记忆（MEMORY.md，已由 load_config 注入 Slot 0 系统提示；此处传 None 不重复）
///   [Slot 2] 累积状态快照（当 summary 非空时注入，role=system）
///   [Slot 3..M] 活跃窗口轮次无损回填（反序列化 raw_messages_json 原样展开）
///   [Slot M+1] 当前新指令（user）
///
/// 注意：`tools` 由调用方经 ReAct 循环作为顶层参数传入，绝不在此注入，保 prompt-cache 命中。
pub(crate) fn build_request_messages(
    system_prompt: &str,
    project_memory: Option<&str>,
    session_summary: Option<&str>,
    active_rounds: &[ConversationRoundRecord],
    current_query: &str,
) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();

    // [Slot 0] 静态系统提示词（已含工程 custom_rules）
    messages.push(json!({ "role": "system", "content": system_prompt }));

    // [Slot 1] 项目长期记忆（第二轨 .wd_mem/MEMORY.md，已由 load_config 注入 Slot 0）
    if let Some(mem) = project_memory {
        if !mem.trim().is_empty() {
            messages.push(json!({
                "role": "system",
                "content": format!("[Work Duo Project Long-Term Memory]:\n{mem}")
            }));
        }
    }

    // [Slot 2] 累积状态快照（DB summary 或 .wd_mem/sessions/{id}.summary.md）
    if let Some(summary) = session_summary {
        if !summary.trim().is_empty() {
            messages.push(json!({
                "role": "system",
                "content": format!("[Workspace Active Context & Historical Summary]\n{summary}")
            }));
        }
    }

    // [Slot 3..M] 活跃窗口轮次还原；历史轮（除最后一个）压缩 kb_search 结果正文。
    // K3-4 #6（2026-09-20）：SIMPLE_CHAT 的 raw_messages_json 全量含工具结果，无损还原导致
    // 历史轮 kb_search 命中正文逐轮回带（Q1 实证 5 轮 50K、K2 案例 2 session 107K 的根因）。
    // 历史轮正文替换为「chunk id + 位置尾段 + score」摘要，需要原文可重新检索（成本低）。
    let last_idx = active_rounds.len().saturating_sub(1);
    for (ri, round) in active_rounds.iter().enumerate() {
        let mut msgs = round.restore_messages();
        if ri != last_idx {
            compact_history_kb_hits(&mut msgs);
        }
        messages.extend(msgs);
    }

    // [Slot M+1] 当前提问
    messages.push(json!({ "role": "user", "content": current_query }));

    messages
}

/* ----------------------------- 写路径：轮次回填与滚动压缩 ----------------------------- */

/// K3-4 #6：压缩历史轮次中 native__kb_search 的 tool 结果正文。
/// 只处理「assistant.tool_calls 中 function.name=native__kb_search 的 call_id」配对的
/// tool 消息；其余工具结果（write_file 等）语义上不可丢，保持原样。
pub(crate) fn compact_history_kb_hits(messages: &mut [Value]) {
    let mut kb_call_ids: std::collections::HashSet<String> = Default::default();
    for m in messages.iter() {
        if m.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }
        if let Some(tcs) = m.get("tool_calls").and_then(|t| t.as_array()) {
            for tc in tcs {
                let name = tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if name == "native__kb_search" && !id.is_empty() {
                    kb_call_ids.insert(id.to_string());
                }
            }
        }
    }
    if kb_call_ids.is_empty() {
        return;
    }
    for m in messages.iter_mut() {
        if m.get("role").and_then(|r| r.as_str()) != Some("tool") {
            continue;
        }
        let tcid = m
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !kb_call_ids.contains(&tcid) {
            continue;
        }
        let content = m
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let compacted = summarize_kb_hit_content(&content);
        if let Some(obj) = m.as_object_mut() {
            obj.insert("content".into(), Value::String(compacted));
        }
    }
}

/// kb_search 结果文本 → 摘要（chunk id + 位置尾段 + score）。兼容顶层数组与
/// {hits:[...]} 包装两种返回形态；解析失败（如「未找到」提示文本）按短文本保留。
fn summarize_kb_hit_content(content: &str) -> String {
    let parsed: Result<Value, _> = serde_json::from_str(content);
    let hits = parsed.ok().and_then(|v| {
        if let Some(arr) = v.as_array() {
            Some(arr.clone())
        } else {
            v.get("hits").and_then(|h| h.as_array()).cloned()
        }
    });
    match hits {
        Some(arr) if !arr.is_empty() => {
            let mut parts: Vec<String> = Vec::new();
            for h in &arr {
                let id = h.get("id").and_then(|v| v.as_str()).unwrap_or("?").to_string();
                let loc = h
                    .get("breadcrumbs")
                    .and_then(|v| v.as_str())
                    .or_else(|| h.get("path").and_then(|v| v.as_str()))
                    .unwrap_or("");
                let tail = loc.rsplit('>').next().unwrap_or(loc).trim().to_string();
                let score = h.get("score").and_then(|v| v.as_f64()).unwrap_or(-1.0);
                parts.push(format!("{id}[{tail} {score:.2}]"));
            }
            format!(
                "[历史 kb_search 结果已压缩：原 {} 条命中，正文省略，需要原文请重新检索] {}",
                parts.len(),
                parts.join(" | ")
            )
        }
        _ => {
            let n = content.chars().count();
            if n > 200 {
                format!(
                    "{}…[历史结果已截断]",
                    content.chars().take(200).collect::<String>()
                )
            } else {
                content.to_string()
            }
        }
    }
}


/// 第 N 轮 ReAct 循环结束后，把当前轮产生的完整消息序列（`raw_messages_json`）回填进轮次表。
pub(crate) async fn persist_round_raw(app: &AppHandle, round_id: &str, raw_messages_json: &str) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[agent] persist_round_raw: 取池失败：{e}");
            return;
        }
    };
    if let Err(e) = sqlx::query(
        "UPDATE agent_conversation_round SET raw_messages_json = ?, end_time = ? WHERE id = ?",
    )
    .bind(raw_messages_json)
    .bind(now_ms())
    .bind(round_id)
    .execute(&pool)
    .await
    {
        tracing::warn!("[agent] persist_round_raw: 写 raw_messages_json 失败：{e}");
    }
}

/// 终态正文兜底回填（2026-09-21 用户实锤）：经 MCP/无前端链路跑的任务轮次没有调用方
/// 回填 `assistant_answer`，UI 把空正文渲染成「思考中…/未返回文本」，会话历史抽查不到
/// 任何问答内容。引擎在终态持久化 raw 的同时把 final_text 兜底写入——仅当列为空时生效，
/// 不覆盖前端任务结束后更完整的 updateRound 回填（两者值同源，幂等）。
pub(crate) async fn persist_round_answer_if_empty(app: &AppHandle, round_id: &str, answer: &str) {
    if answer.trim().is_empty() {
        return;
    }
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[agent] persist_round_answer: 取池失败：{e}");
            return;
        }
    };
    if let Err(e) = sqlx::query(
        "UPDATE agent_conversation_round SET assistant_answer = ? WHERE id = ? AND (assistant_answer IS NULL OR assistant_answer = '')",
    )
    .bind(answer)
    .bind(round_id)
    .execute(&pool)
    .await
    {
        tracing::warn!("[agent] persist_round_answer: 回填 assistant_answer 失败：{e}");
    }
}

/// 启动时孤儿轮次清扫（20260922 #4）：进程退出/崩溃会遗留 `end_time IS NULL` 的「进行中」
/// 轮次，重启后 UI 永远显示进行中且无任务可终态化。DB 就绪后（此刻必然无在跑任务）统一
/// 标记终态。只补 `end_time`，不动正文/思考列（内容缺失即缺失，诚实呈现）。
pub async fn sweep_orphan_rounds(app: &AppHandle) -> Result<u64, String> {
    let pool = get_pool(app).await?;
    let result = sqlx::query("UPDATE agent_conversation_round SET end_time = ? WHERE end_time IS NULL")
        .bind(now_ms())
        .execute(&pool)
        .await
        .map_err(|e| format!("孤儿轮次清扫失败：{e}"))?;
    Ok(result.rows_affected())
}

/// 终态过程兜底回填（2026-09-21 同策略扩展）：`thinking_content` / `tool_calls_summary`
/// 此前同样只有前端链路上报，MCP 轮次为空导致 UI 思考折叠面板/工具过程缺失。
/// 数据源 = 引擎轨迹缓冲（trace_thinking_snapshot / trace_tool_calls_summary_json），
/// 与前端累计同源；仅当列空时写入，不覆盖前端更完整的 updateRound 回填。
pub(crate) async fn persist_round_process_if_empty(
    app: &AppHandle,
    round_id: &str,
    thinking: &str,
    tool_calls_summary_json: &str,
) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[agent] persist_round_process: 取池失败：{e}");
            return;
        }
    };
    if !thinking.trim().is_empty() {
        if let Err(e) = sqlx::query(
            "UPDATE agent_conversation_round SET thinking_content = ? WHERE id = ? AND (thinking_content IS NULL OR thinking_content = '')",
        )
        .bind(thinking)
        .bind(round_id)
        .execute(&pool)
        .await
        {
            tracing::warn!("[agent] persist_round_process: 回填 thinking_content 失败：{e}");
        }
    }
    if !tool_calls_summary_json.trim().is_empty() && tool_calls_summary_json != "[]" {
        if let Err(e) = sqlx::query(
            "UPDATE agent_conversation_round SET tool_calls_summary = ? WHERE id = ? AND (tool_calls_summary IS NULL OR tool_calls_summary = '')",
        )
        .bind(tool_calls_summary_json)
        .bind(round_id)
        .execute(&pool)
        .await
        {
            tracing::warn!("[agent] persist_round_process: 回填 tool_calls_summary 失败：{e}");
        }
    }
}

/// 会话累计轮次 +1（用于后台压缩触发判定）。
pub(crate) async fn bump_session_turns(app: &AppHandle, session_id: &str) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[agent] bump_session_turns: 取池失败：{e}");
            return;
        }
    };
    if let Err(e) = sqlx::query(
        "UPDATE agent_conversation_session \
         SET total_turns = COALESCE(total_turns, 0) + 1, updated_at = ? WHERE id = ?",
    )
    .bind(now_ms())
    .bind(session_id)
    .execute(&pool)
    .await
    {
        tracing::warn!("[agent] bump_session_turns: 失败：{e}");
    }
}

/// 动态重算并回写「工具 / Skill 定义占用的上下文 token」（`tools_tokens`）。
///
/// 每轮 `run_task` 都按**当前已解析**的 MCP 工具数 + Skill 数重新估算并覆盖写入会话表，
/// 因此中途移除 Skill / 停用（解绑）MCP 后，下一轮会自动**下调**；重新绑定则**上调**。
/// 估算公式与前端 `createSession` 时完全一致：`(mcp 工具数 + skill 数) × AVG_TOOL_TOKENS`，
/// 从而保证首次运行时与建会话时的初值一致、不跳变。
pub(crate) async fn persist_tools_tokens(
    app: &AppHandle,
    session_id: &str,
    mcp_count: usize,
    skill_count: usize,
) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::info!("[agent] persist_tools_tokens: 取池失败：{e}");
            return;
        }
    };
    let tokens = (mcp_count as i64 + skill_count as i64) * AVG_TOOL_TOKENS;
    tracing::info!(
        "[agent] persist_tools_tokens: session={} mcp工具={} skill={} → tools_tokens={}",
        session_id, mcp_count, skill_count, tokens
    );
    if let Err(e) = sqlx::query(
        "UPDATE agent_conversation_session SET tools_tokens = ?, updated_at = ? WHERE id = ?",
    )
    .bind(tokens)
    .bind(now_ms())
    .bind(session_id)
    .execute(&pool)
    .await
    {
        tracing::warn!("[agent] persist_tools_tokens: 写 tools_tokens 失败：{e}");
    }
}

/// 累计写回「会话真实 token 用量」（prompt + completion，跨所有 ReAct 轮）。
///
/// 与 `persist_tools_tokens`（覆盖写工具定义占用）不同，这里是**累加**——每次 `run_task`
/// 把本轮 LLM 真实消耗（取自 OpenAI `usage`，由 `runtime::run_task` 统计）加到会话总数上，
/// 从而会话环形图与单条消息的「消耗 tokens」展示的是真实用量，而非前端基于「仅首尾文本」的粗略估算。
pub(crate) async fn persist_session_tokens(
    app: &AppHandle,
    session_id: &str,
    prompt_delta: u64,
    completion_delta: u64,
) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[agent] persist_session_tokens: 取池失败：{e}");
            return;
        }
    };
    tracing::warn!(
        "[agent] persist_session_tokens: session={} prompt+={} completion+={}",
        session_id, prompt_delta, completion_delta
    );
    if let Err(e) = sqlx::query(
        "UPDATE agent_conversation_session \
         SET total_prompt_tokens = COALESCE(total_prompt_tokens, 0) + ?, \
             total_completion_tokens = COALESCE(total_completion_tokens, 0) + ?, \
             updated_at = ? \
         WHERE id = ?",
    )
    .bind(prompt_delta as i64)
    .bind(completion_delta as i64)
    .bind(now_ms())
    .bind(session_id)
    .execute(&pool)
    .await
    {
        tracing::warn!("[agent] persist_session_tokens: 写会话 token 失败：{e}");
    }
}

/// 登记单个文件产物进 `artifacts` 表（best-effort：取池/写库失败仅告警，不影响主流程）。
///
/// 由 `agent::artifacts::register_artifacts` 在子任务成功闭环后逐条调用。
pub(crate) async fn persist_artifact(
    app: &AppHandle,
    session_id: Option<&str>,
    round_id: Option<&str>,
    ar: &ArtifactRef,
) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[agent] persist_artifact: 取池失败：{e}");
            return;
        }
    };
    if let Err(e) = sqlx::query(
        "INSERT INTO artifacts \
         (id, session_id, round_id, task_id, step, artifact_type, path, mime_type, description, version, checksum, size, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&ar.artifact_id)
    .bind(session_id)
    .bind(round_id)
    .bind(&ar.task_id)
    .bind(ar.step as i64)
    .bind(&ar.artifact_type)
    .bind(&ar.path)
    .bind(&ar.mime_type)
    .bind(&ar.description)
    .bind(1i64) // version：覆盖重跑版本自增留待后续扩展，当前固定 1
    .bind(None::<String>) // checksum：预留
    .bind(ar.size as i64)
    .bind(ar.created_at)
    .execute(&pool)
    .await
    {
        tracing::warn!("[agent] persist_artifact: 写库失败（artifact_id={}）：{e}", ar.artifact_id);
    }
}

/// 后台非阻塞滚动压缩触发器。
///
/// 读取会话 `total_turns` 与 `summary_round_count`，计算未压缩轮数
/// `pending = total_turns - summary_round_count`；达到 `trigger_threshold` 即派发
/// Tokio 异步任务，向前合并 `[summary_round_count+1 .. +roll_forward_count]` 轮进摘要，
/// 并原子推进 `summary_round_count`。调用方（run_task）在 ReAct 循环结束后立即返回，
/// 真正的压缩 HTTP 请求在后台 Task 中独立运行，**不阻塞用户下一轮提问**。
#[tracing::instrument(skip_all)]
pub(crate) async fn trigger_background_compaction(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    session_id: &str,
) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[agent] trigger_background_compaction: 取池失败：{e}");
            return;
        }
    };

    let meta = sqlx::query(
        "SELECT total_turns, summary_round_count, summary \
         FROM agent_conversation_session WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(&pool)
    .await
    .ok()
    .flatten();

    let total_turns: i64 = meta
        .as_ref()
        .and_then(|r| r.try_get::<Option<i64>, _>("total_turns").ok().flatten())
        .unwrap_or(0);
    let last_compact: i64 = meta
        .as_ref()
        .and_then(|r| r.try_get::<Option<i64>, _>("summary_round_count").ok().flatten())
        .unwrap_or(0);
    let old_summary: Option<String> = meta
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("summary").ok().flatten())
        .filter(|s| !s.trim().is_empty());

    // 每轮触发阈值与滚动步长由 CompactorConfig 默认配置决定（规范：每 5 轮触发、向前合并 2 轮）。
    let compactor = CompactorConfig::default();
    let pending = total_turns.saturating_sub(last_compact);
    tracing::info!(
        "[Compactor] 触发判定：session={} total_turns={} 已压缩至={} 未压缩={} 阈值={}",
        session_id, total_turns, last_compact, pending, compactor.trigger_threshold
    );
    if pending < compactor.trigger_threshold {
        return; // 未达阈值，本次不压缩（零阻塞返回）
    }

    let range_start = last_compact + 1;
    let range_end = last_compact + compactor.roll_forward_count;
    tracing::info!(
        "[Compactor] 达到阈值，派发后台压缩：合并轮次 {}..={}（旧摘要={}）",
        range_start,
        range_end,
        old_summary
            .as_ref()
            .map(|s| format!("{}字符", s.chars().count()))
            .unwrap_or_else(|| "无".into()),
    );

    // 复制到后台 Task 拥有（Send + 'static）。
    let app_bg = app.clone();
    let cfg_bg = cfg.clone();
    let sid = session_id.to_string();

    tauri::async_runtime::spawn(async move {
        let pool = match get_pool(&app_bg).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("[Compactor] 取池失败：{e}");
                return;
            }
        };

        // 提取待压缩区间的轮次（含完整 raw_messages_json + 人类可读摘要）。
        let rows = match sqlx::query(
            "SELECT round_index, user_question, assistant_answer, tool_calls_summary, raw_messages_json \
             FROM agent_conversation_round \
             WHERE session_id = ? AND round_index >= ? AND round_index <= ? \
             ORDER BY round_index ASC",
        )
        .bind(&sid)
        .bind(range_start)
        .bind(range_end)
        .fetch_all(&pool)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("[Compactor] 读取待压缩轮次失败：{e}");
                return;
            }
        };

        let rounds: Vec<ConversationRoundRecord> = rows
            .iter()
            .map(|r| ConversationRoundRecord {
                round_index: r.try_get::<i64, _>("round_index").unwrap_or(0),
                user_question: r.try_get::<Option<String>, _>("user_question").ok().flatten(),
                assistant_answer: r.try_get::<Option<String>, _>("assistant_answer").ok().flatten(),
                tool_calls_summary: r
                    .try_get::<Option<String>, _>("tool_calls_summary")
                    .ok()
                    .flatten(),
                raw_messages_json: r
                    .try_get::<Option<String>, _>("raw_messages_json")
                    .ok()
                    .flatten()
                    .unwrap_or_default(),
            })
            .collect();

        match execute_summary_call(&cfg_bg, old_summary.as_deref(), &rounds).await {
            Ok(new_summary) => {
                tracing::info!(
                    "[Compactor] 压缩调用完成：输入轮次={} 旧摘要={}字符 → 新摘要={}字符",
                    rounds.len(),
                    old_summary.as_ref().map(|s| s.chars().count()).unwrap_or(0),
                    new_summary.chars().count(),
                );
                if let Err(e) = sqlx::query(
                    "UPDATE agent_conversation_session \
                     SET summary = ?, summary_round_count = ?, updated_at = ? WHERE id = ?",
                )
                .bind(&new_summary)
                .bind(range_end)
                .bind(now_ms())
                .bind(&sid)
                .execute(&pool)
                .await
                {
                    tracing::warn!("[Compactor] 写回 summary 失败：{e}");
                    return;
                }
                tracing::info!(
                    "[Compactor] 已滚动压缩 turns {}..{} 进摘要（session={}）",
                    range_start, range_end, sid
                );

                // 双轨落盘：若会话绑定工程，额外将摘要写入 .wd_mem/sessions/{id}.summary.md。
                if let Some(root) = resolve_project_root(&pool, &sid).await {
                    if let Err(e) = wd_mem::write_session_summary(&root, &sid, &new_summary) {
                        tracing::warn!("[Compactor] 写会话摘要文件失败（仅影响文件轨）：{e}");
                    }
                }

                // 被压缩轮次的 raw_messages 总字符（估算节省的上下文 token 量）。
                let compacted_chars: usize = rounds
                    .iter()
                    .map(|r| r.raw_messages_json.chars().count())
                    .sum();
                // 方案B（快速止血）：压缩把旧轮次移出活跃窗口、减小下一轮实际发送量，
                // 但会话表累计 token 此前是 `+=` 纯累加、只增不减，导致顶栏环形图「上下文占比」
                // 永只增不降、且压缩后不回落。这里把估算节省量从累计 prompt token 回退，
                // 使环形图随压缩下降；前端监听 `agent-context-compacted` 事件重读会话表取最新值。
                let saved = (compacted_chars / 4) as i64;
                if let Err(e) = sqlx::query(
                    "UPDATE agent_conversation_session \
                     SET total_prompt_tokens = MAX(0, COALESCE(total_prompt_tokens, 0) - ?), \
                         updated_at = ? \
                     WHERE id = ?",
                )
                .bind(saved)
                .bind(now_ms())
                .bind(&sid)
                .execute(&pool)
                .await
                {
                    tracing::warn!("[Compactor] 回退累计 prompt token 失败：{e}");
                } else {
                    tracing::info!("[Compactor] 回退累计 prompt token -{saved}（session={sid}）");
                }
                events::emit_status(&app_bg, "历史对话已自动压缩进上下文摘要");
                // 结构化压缩完成事件（替代纯字符串 status，供记忆宫殿/上下文健康视图消费）。
                events::emit_context_compacted(
                    &app_bg,
                    &events::ContextCompactedPayload {
                        compacted_rounds: rounds.len(),
                        summary_length: new_summary.chars().count(),
                        tokens_saved: compacted_chars / 4,
                        success: true,
                    },
                );

                // M3 蒸馏（#20260918007）：独立轻量调用从新摘要提炼候选（同调用双段契约在
                // 超长压缩 prompt 下必被模型忽略——真机 111K 字符实测实锤）→
                // forced 直接自动转入（anchor_memory auto_merge=M0 护栏+去噪+向量回写全套）；
                // active 等其余模式落 pending，记忆宫殿「待确认」区等用户处置；off 模式不蒸馏。
                let mut distill_candidates: Vec<(String, String, String)> = Vec::new();
                if cfg_bg.memory_mode != "off" {
                    match execute_distill_call(&cfg_bg, &new_summary).await {
                        Ok(c) => distill_candidates = c,
                        Err(e) => {
                            tracing::warn!("[Compactor] 蒸馏调用失败（本轮跳过蒸馏）：{e}");
                        }
                    }
                }
                if !distill_candidates.is_empty() {
                    let mut confirmed = 0usize;
                    let mut pending = 0usize;
                    for (key, category, content) in &distill_candidates {
                        if cfg_bg.memory_mode == "forced" {
                            match crate::agent::knowledge::memory::anchor_memory(
                                &app_bg,
                                Some(&cfg_bg.agent_id),
                                Some(&sid),
                                key,
                                content,
                                category,
                                false,
                                true,
                            )
                            .await
                            {
                                Ok(_) => confirmed += 1,
                                Err(e) => tracing::debug!(
                                    "[Compactor] 蒸馏候选被护栏拦截（key={key}）：{e}"
                                ),
                            }
                        } else {
                            // 同 agent+key 已有 pending 时跳过（压缩周期性触发，防重复堆积）。
                            let dup = sqlx::query(
                                "SELECT 1 FROM agent_memory_candidates \
                                 WHERE agent_id = ? AND key = ? AND status = 'pending' LIMIT 1",
                            )
                            .bind(&cfg_bg.agent_id)
                            .bind(key)
                            .fetch_optional(&pool)
                            .await
                            .ok()
                            .flatten();
                            if dup.is_some() {
                                continue;
                            }
                            let cid = format!("cand_{}_{}", now_ms(), pending + confirmed);
                            if let Err(e) = sqlx::query(
                                "INSERT INTO agent_memory_candidates \
                                 (id, agent_id, session_id, key, content, category, source, status, created_at) \
                                 VALUES (?, ?, ?, ?, ?, ?, 'distill', 'pending', ?)",
                            )
                            .bind(&cid)
                            .bind(&cfg_bg.agent_id)
                            .bind(&sid)
                            .bind(key)
                            .bind(content)
                            .bind(category)
                            .bind(now_ms())
                            .execute(&pool)
                            .await
                            {
                                tracing::warn!("[Compactor] 蒸馏候选落库失败（key={key}）：{e}");
                                continue;
                            }
                            pending += 1;
                        }
                    }
                    if confirmed > 0 || pending > 0 {
                        tracing::info!(
                            "[Compactor] 蒸馏完成：自动转入 {} 条 / pending {} 条（mode={}）",
                            confirmed,
                            pending,
                            cfg_bg.memory_mode
                        );
                        events::emit_status(
                            &app_bg,
                            format!("会话蒸馏：{confirmed} 条已入记忆宫殿，{pending} 条待确认").as_str(),
                        );
                    }
                }
            }
            Err(err) => {
                tracing::error!("[Compactor] 后台压缩失败：{err}");
            }
        }
    });
}

/// 解析会话所绑定工程的规范化根路径（无绑定 / 无工程记录返回 None）。
async fn resolve_project_root(pool: &SqlitePool, session_id: &str) -> Option<String> {
    let pid = sqlx::query("SELECT project_id FROM agent_conversation_session WHERE id = ?")
        .bind(session_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<Option<String>, _>("project_id").ok().flatten())
        .filter(|s| !s.trim().is_empty())?;
    sqlx::query("SELECT root_path FROM agent_project WHERE id = ?")
        .bind(pid)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<Option<String>, _>("root_path").ok().flatten())
        .filter(|s| !s.trim().is_empty())
}

/// 解析蒸馏候选行（`key | category | content`）；NONE/空行/标题行/列表符/缺字段行跳过。
fn parse_candidate_lines(text: &str) -> Vec<(String, String, String)> {
    let mut candidates = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with('#')
            || line.starts_with('-')
            || line.starts_with('*')
            || line.eq_ignore_ascii_case("none")
        {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, '|').map(|s| s.trim()).collect();
        if parts.len() < 3 || parts[0].is_empty() || parts[2].is_empty() {
            continue;
        }
        candidates.push((
            parts[0].to_string(),
            parts[1].to_string(),
            parts[2].to_string(),
        ));
    }
    candidates
}

/// 执行压缩大模型调用（按规范 SummaryPrompt 契约生成结构化状态摘要）。
/// M3 修订：蒸馏候选改为**独立轻量调用**（execute_distill_call）——真机实测超长压缩
/// prompt（111K 字符）下模型注意力全在摘要 schema，同调用内追加第二产出段必被忽略。
async fn execute_summary_call(
    cfg: &AgentRuntimeConfig,
    old_summary: Option<&str>,
    rounds: &[ConversationRoundRecord],
) -> Result<String, String> {
    let mut prompt = String::new();
    prompt.push_str("### Previous Summary State:\n");
    prompt.push_str(old_summary.unwrap_or("None (First Compaction Cycle)"));
    prompt.push_str("\n\n### Conversation Rounds to Compact:\n");
    for round in rounds {
        prompt.push_str(&format!(
            "\n--- Round {} ---\nUser: {}\nAssistant Final: {}\nTool Call Digest: {}\nMessages JSON Trace:\n{}\n",
            round.round_index,
            round.user_question.as_deref().unwrap_or(""),
            round.assistant_answer.as_deref().unwrap_or(""),
            round.tool_calls_summary.as_deref().unwrap_or("None"),
            round.raw_messages_json
        ));
    }

    let system_compress_rule = r#"You are a state-compaction engine for an IDE Coding Agent.
Your job is to merge the Existing Summary and the Target Conversation Rounds into an updated system snapshot.

[RETENTION DIRECTIVES]:
1. File Tracking: Record all files read, modified, or created (use relative/absolute paths).
2. Code Changes: Record exact configuration parameters, function additions, and refactored logic.
3. System Environment: Record the active sandbox environment (e.g., Python sandbox 'default'), CLI commands executed, and non-zero exit codes/diagnostics.
4. Active Objectives: Keep track of unfinished user requirements and explicit constraints.
5. Strict Filtering: Exclude conversational filler, pleasantries, and full raw code dumps. Format strictly in concise Markdown bullet points.

[OUTPUT SCHEMA]:
### Environment State
- Workspace: <workspace path>
- Python Sandbox: <env name>

### File Modifications & State
- `<path>`: <exact changes made or current function>

### Executed Commands & Diagnostics
- `<command>`: [Exit Code <N>] <concise result>

### Pending Objectives & User Constraints
- <Remaining task details>"#;

    let messages = vec![
        json!({ "role": "system", "content": system_compress_rule }),
        json!({ "role": "user", "content": prompt }),
    ];
    tracing::info!(
        "[Compactor] 准备调用摘要 LLM：轮次={} prompt={}字符 system_rule={}字符 old_summary={}字符",
        rounds.len(),
        prompt.chars().count(),
        system_compress_rule.chars().count(),
        old_summary.map(|s| s.chars().count()).unwrap_or(0),
    );

    // 复用智能体绑定的 LLM（客户端一律走云端 API；如需更轻量模型可后续配置 summary_model）。
    let (choice, _usage) = call_llm(cfg, &messages, &[], None).await?; // 后台压缩：无用户取消语义
    let summary = choice
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if summary.is_empty() {
        tracing::info!("[Compactor] 摘要 LLM 返回空内容，压缩失败");
        return Err("压缩结果为空".into());
    }
    tracing::info!(
        "[Compactor] 摘要内容预览（前500字符）：{}",
        crate::agent::engine::runtime::clip(&summary, 500)
    );
    Ok(summary)
}

/// 独立蒸馏调用（M3）：输入压缩后的摘要（数 K 字符级，专注度高），提炼值得升入
/// 长期记忆的候选行。含 few-shot 示例保格式遵守率。失败 = Err（上层降级跳过蒸馏）。
async fn execute_distill_call(
    cfg: &AgentRuntimeConfig,
    summary: &str,
) -> Result<Vec<(String, String, String)>, String> {
    let system_rule = r#"你是长期记忆提炼器。从会话状态摘要中提炼「可跨会话复用的稳定知识」候选。

只提炼这些：
- 用户明确表达的偏好或约束
- 已确认的技术决策 / 架构约定
- 踩过的坑与规避方式
- 可复用的代码 / 脚本模式

绝不提炼：一次性任务步骤、临时文件内容、当轮琐碎状态、单纯的文件清单。

输出格式（严格每行一条，无其他文本）：
关键词 | 分类 | 内容
其中分类取 decision（决策）/ code_pattern（代码模式）/ user_pref（用户偏好）/ architecture（架构）/ fix（避坑）/ other（其他）之一。

示例：
script-dir-convention | user_pref | Python 工具脚本统一放 .wd_mem/runtime/scripts/，文件名 snake_case
api-timeout-decision | decision | 对外 API 超时统一 30 秒、重试不超过 3 次
concurrent-refresh-pitfall | fix | 并发刷新令牌会互踢，客户端需 single-flight 加锁

若摘要中没有任何值得沉淀的内容，只输出一个词：NONE"#;

    let messages = vec![
        json!({ "role": "system", "content": system_rule }),
        json!({ "role": "user", "content": format!("会话状态摘要：\n{summary}") }),
    ];
    let (choice, _usage) = call_llm(cfg, &messages, &[], None).await?; // 后台压缩：无用户取消语义
    let raw = choice
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let candidates = parse_candidate_lines(&raw);
    tracing::info!(
        "[Compactor] 蒸馏调用完成：提炼候选 {} 条（原始输出预览：{}）",
        candidates.len(),
        crate::agent::engine::runtime::clip(&raw, 200)
    );
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::{compact_history_kb_hits, parse_candidate_lines};
    use serde_json::json;

    #[test]
    fn parse_basic_candidate_lines() {
        let raw = "jwt-choice | decision | 登录采用 JWT 双 token\nrefresh-lock | fix | 并发刷新需 single-flight 加锁";
        let cands = parse_candidate_lines(raw);
        assert_eq!(cands.len(), 2);
        assert_eq!(cands[0].0, "jwt-choice");
        assert_eq!(cands[0].1, "decision");
        assert!(cands[0].2.contains("双 token"));
        assert_eq!(cands[1].0, "refresh-lock");
    }

    #[test]
    fn parse_skips_none_and_bad_lines() {
        let raw = "NONE\n\n只有两个字段 | decision\nok-key | fix | 合法内容";
        let cands = parse_candidate_lines(raw);
        assert_eq!(cands.len(), 1, "NONE 与缺字段行跳过，实得：{cands:?}");
        assert_eq!(cands[0].0, "ok-key");
    }

    #[test]
    fn parse_tolerates_decorated_lines() {
        let raw = "### 标题跳过\n- 带列表符的行跳过\n* 星号列表也跳过\ngood | other | 内容";
        let cands = parse_candidate_lines(raw);
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].0, "good");
    }

    #[test]
    fn parse_empty_and_none_only() {
        assert!(parse_candidate_lines("").is_empty());
        assert!(parse_candidate_lines("NONE").is_empty());
    }

    #[test]
    fn compact_history_kb_hits_only_kb_pairs() {
        let mut msgs = vec![
            json!({ "role": "user", "content": "q" }),
            json!({ "role": "assistant", "tool_calls": [
                { "id": "c1", "type": "function", "function": { "name": "native__kb_search", "arguments": "{}" } },
                { "id": "c2", "type": "function", "function": { "name": "native__write_file", "arguments": "{}" } }
            ]}),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "[{\"id\":\"a#41\",\"breadcrumbs\":\"A > B > 3.3 骨架\",\"score\":0.77},{\"id\":\"a#42\",\"breadcrumbs\":\"A > B > 3.1 网格\",\"score\":0.81}]" }),
            json!({ "role": "tool", "tool_call_id": "c2", "content": "已写入 100 字节到 x.md" }),
        ];
        compact_history_kb_hits(&mut msgs);
        let c1 = msgs[2]["content"].as_str().unwrap();
        assert!(
            c1.contains("已压缩") && c1.contains("a#41") && c1.contains("3.3 骨架") && c1.contains("0.77"),
            "实际压缩结果：{c1}"
        );
        // 非 kb_search 的工具结果语义上不可丢，保持原样
        assert_eq!(msgs[3]["content"], "已写入 100 字节到 x.md");
    }

    #[test]
    fn compact_kb_short_notice_text_kept() {
        let mut msgs = vec![
            json!({ "role": "assistant", "tool_calls": [
                { "id": "c1", "type": "function", "function": { "name": "native__kb_search", "arguments": "{}" } }
            ]}),
            json!({ "role": "tool", "tool_call_id": "c1", "content": "知识库中未找到与查询相关的片段。" }),
        ];
        compact_history_kb_hits(&mut msgs);
        assert_eq!(msgs[1]["content"], "知识库中未找到与查询相关的片段。");
    }

    #[test]
    fn compact_kb_long_non_json_truncated() {
        let long = "x".repeat(500);
        let mut msgs = vec![
            json!({ "role": "assistant", "tool_calls": [
                { "id": "c1", "type": "function", "function": { "name": "native__kb_search", "arguments": "{}" } }
            ]}),
            json!({ "role": "tool", "tool_call_id": "c1", "content": long }),
        ];
        compact_history_kb_hits(&mut msgs);
        let c = msgs[1]["content"].as_str().unwrap();
        assert!(c.chars().count() < 300 && c.ends_with("[历史结果已截断]"));
    }
}