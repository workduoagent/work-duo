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
use crate::agent::runtime::call_llm;
use crate::agent::runtime::now_ms;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::ArtifactRef;
use crate::agent::wd_mem;

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

/// 从 Tauri 托管的 DbInstances 取出 `sqlite:workduo.db` 连接池（与 commands::load_config 同机制）。
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

    // [Slot 3..M] 活跃窗口轮次无损还原
    for round in active_rounds {
        messages.extend(round.restore_messages());
    }

    // [Slot M+1] 当前提问
    messages.push(json!({ "role": "user", "content": current_query }));

    messages
}

/* ----------------------------- 写路径：轮次回填与滚动压缩 ----------------------------- */

/// 第 N 轮 ReAct 循环结束后，把当前轮产生的完整消息序列（`raw_messages_json`）回填进轮次表。
pub(crate) async fn persist_round_raw(app: &AppHandle, round_id: &str, raw_messages_json: &str) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::info!("[agent] persist_round_raw: 取池失败：{e}");
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
        tracing::info!("[agent] persist_round_raw: 写 raw_messages_json 失败：{e}");
    }
}

/// 会话累计轮次 +1（用于后台压缩触发判定）。
pub(crate) async fn bump_session_turns(app: &AppHandle, session_id: &str) {
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::info!("[agent] bump_session_turns: 取池失败：{e}");
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
        tracing::info!("[agent] bump_session_turns: 失败：{e}");
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
        tracing::info!("[agent] persist_tools_tokens: 写 tools_tokens 失败：{e}");
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
            tracing::info!("[agent] persist_session_tokens: 取池失败：{e}");
            return;
        }
    };
    tracing::info!(
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
        tracing::info!("[agent] persist_session_tokens: 写会话 token 失败：{e}");
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
            tracing::info!("[agent] persist_artifact: 取池失败：{e}");
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
        tracing::info!("[agent] persist_artifact: 写库失败（artifact_id={}）：{e}", ar.artifact_id);
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
            tracing::info!("[agent] trigger_background_compaction: 取池失败：{e}");
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
                tracing::info!("[Compactor] 取池失败：{e}");
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
                tracing::info!("[Compactor] 读取待压缩轮次失败：{e}");
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
                    tracing::info!("[Compactor] 写回 summary 失败：{e}");
                    return;
                }
                tracing::info!(
                    "[Compactor] 已滚动压缩 turns {}..{} 进摘要（session={}）",
                    range_start, range_end, sid
                );

                // 双轨落盘：若会话绑定工程，额外将摘要写入 .wd_mem/sessions/{id}.summary.md。
                if let Some(root) = resolve_project_root(&pool, &sid).await {
                    if let Err(e) = wd_mem::write_session_summary(&root, &sid, &new_summary) {
                        tracing::info!("[Compactor] 写会话摘要文件失败（仅影响文件轨）：{e}");
                    }
                }

                // 被压缩轮次的 raw_messages 总字符（估算节省的上下文 token 量）。
                let compacted_chars: usize = rounds
                    .iter()
                    .map(|r| r.raw_messages_json.chars().count())
                    .sum();
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

/// 执行压缩大模型调用（按规范 SummaryPrompt 契约生成结构化状态摘要）。
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
    let (choice, _usage) = call_llm(cfg, &messages, &[]).await?;
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
        crate::agent::runtime::clip(&summary, 500)
    );
    Ok(summary)
}
