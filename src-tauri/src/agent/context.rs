//! 上下文组装（读路径，对应规范「上下文拼装协议与报文槽位定义」）。
//!
//! 负责把「系统提示 + 滚动摘要(slot1) + 活跃窗口轮次(slot2..M，原样 restore) + 当前输入(slot M+1)」
//! 装配为发送给 LLM 的 `messages`。**本函数只做读路径装配，不在此同步压缩**——
//! 压缩由 `round_compactor::trigger_background_compaction` 在每轮结束后后台异步完成，
//! 以保证用户下一轮提问零前置等待（零延迟首字响应）。
//!
//! 工具定义不在此注入：由 ReAct 循环作为顶层 `tools` 参数一次传入，保 prompt-cache 命中。
//! 活跃窗口判定：`round_index > session.summary_round_count`（已合并进摘要的旧轮次不进入上下文）。

use serde_json::Value;
use sqlx::Row;
use tauri::AppHandle;

use crate::agent::round_compactor::build_request_messages;
use crate::agent::round_compactor::get_pool;
use crate::agent::round_compactor::ConversationRoundRecord;
use crate::agent::types::AgentRuntimeConfig;

/// 组装发送给 LLM 的 `messages`（纯读路径；压缩在后台异步进行，不在此阻塞）。
pub(crate) async fn build_context_messages(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
    prompt: &str,
) -> Result<Vec<Value>, String> {
    // 无会话 id：无法回溯历史，直接装配 [system + 当前 user] 返回。
    let sid = match &cfg.session_id {
        Some(s) => s.clone(),
        None => {
            return Ok(build_request_messages(&cfg.system_prompt, None, &[], prompt));
        }
    };

    let pool = get_pool(app).await.map_err(|e| format!("数据库未连接：{e}"))?;

    // 读取会话元信息（已有摘要 + 已覆盖轮数 summary_round_count = last_compact_turn）。
    let meta = sqlx::query(
        "SELECT summary, summary_round_count \
         FROM agent_conversation_session WHERE id = ?",
    )
    .bind(&sid)
    .fetch_optional(&pool)
    .await
    .ok()
    .flatten();
    let last_compact: i64 = meta
        .as_ref()
        .and_then(|r| r.try_get::<Option<i64>, _>("summary_round_count").ok().flatten())
        .unwrap_or(0);
    let summary: Option<String> = meta
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("summary").ok().flatten())
        .filter(|s| !s.trim().is_empty());

    // 读取活跃窗口轮次：round_index > last_compact（已压缩的轮次不进入上下文）。
    let rows = sqlx::query(
        "SELECT round_index, user_question, assistant_answer, tool_calls_summary, raw_messages_json \
         FROM agent_conversation_round \
         WHERE session_id = ? AND round_index > ? \
         ORDER BY round_index ASC",
    )
    .bind(&sid)
    .bind(last_compact)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("读取轮次失败：{e}"))?;

    let records: Vec<ConversationRoundRecord> = rows
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

    Ok(build_request_messages(
        &cfg.system_prompt,
        summary.as_deref(),
        &records,
        prompt,
    ))
}
