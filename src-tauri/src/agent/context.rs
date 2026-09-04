//! 上下文组装（读路径，对应规范「上下文拼装协议与报文槽位定义」）。
//!
//! 负责把「系统提示(+工程专属规则) + 项目长期记忆 + 滚动摘要(slot) + 活跃窗口轮次(slot, 原样 restore) + 当前输入」
//! 装配为发送给 LLM 的 `messages`。**本函数只做读路径装配，不在此同步压缩**——
//! 压缩由 `round_compactor::trigger_background_compaction` 在每轮结束后后台异步完成，
//! 以保证用户下一轮提问零前置等待（零延迟首字响应）。
//!
//! 工具定义不在此注入：由 ReAct 循环作为顶层 `tools` 参数一次传入，保 prompt-cache 命中。
//! 活跃窗口判定：`round_index > session.summary_round_count`（已合并进摘要的旧轮次不进入上下文）。
//!
//! 分层记忆装配（对应《双轨持久化与分层记忆》上下文流水线）：
//!  - [Slot 0] 静态系统提示 + 工程 `custom_rules`（若有工程绑定且非空）
//!  - [Slot 0] 项目长期记忆 `.wd_mem/MEMORY.md` 已由 `load_config` 全量注入系统提示（仅工程绑定时存在）
//!  - [Slot 1] 会话滚动摘要：工程绑定时优先读 `.wd_mem/sessions/{id}.summary.md`，否则回退 DB `summary`
//!  - [Slot 3..M] 活跃窗口轮次（raw_messages_json 原样还原）
//!  - [Slot M+1] 当前提问

use serde_json::json;
use serde_json::Value;
use sqlx::Row;
use tauri::AppHandle;

use crate::agent::round_compactor::build_request_messages;
use crate::agent::round_compactor::get_pool;
use crate::agent::round_compactor::ConversationRoundRecord;
use crate::agent::types::AgentRuntimeConfig;
use crate::agent::types::AttachmentInput;
use crate::agent::wd_mem;

/// 统计消息序列的总字符数（日志用，粗估上下文体量）。
fn messages_chars(messages: &[Value]) -> usize {
    messages
        .iter()
        .map(|m| {
            m.get("content")
                .map(|c| match c {
                    Value::String(s) => s.chars().count(),
                    other => other.to_string().chars().count(),
                })
                .unwrap_or(0)
        })
        .sum()
}

/// 把当前轮多模态附件（图片）注入最后一条 user 消息：
/// content 由纯文本改写为 OpenAI 多模态数组 `[{type:text},{type:image_url}...]`。
/// 无附件时原样返回（content 保持字符串，兼容纯文本模型）。
fn inject_attachments(messages: &mut Vec<Value>, attachments: &[AttachmentInput]) {
    let image_parts: Vec<Value> = attachments
        .iter()
        .filter(|a| a.kind == "image" && !a.data_url.is_empty())
        .map(|a| json!({ "type": "image_url", "image_url": { "url": a.data_url } }))
        .collect();
    if image_parts.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(|v| v.as_str()) == Some("user") {
            let text = last
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let names: Vec<&str> = attachments
                .iter()
                .filter(|a| a.kind == "image" && !a.data_url.is_empty())
                .map(|a| a.name.as_deref().unwrap_or("<未命名>"))
                .collect();
            let mut parts = vec![json!({ "type": "text", "text": text })];
            parts.extend(image_parts);
            last["content"] = json!(parts);
            println!(
                "[agent] context: 已注入 {} 张图片到当前轮 user 消息（多模态）：[{}]",
                names.len(),
                names.join(", "),
            );
        }
    }
}

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
            println!("[agent] context: 无 session_id，仅装配 [system + 当前提问]（不含历史）");
            let mut m = build_request_messages(&cfg.system_prompt, None, None, &[], prompt);
            inject_attachments(&mut m, &cfg.attachments);
            return Ok(m);
        }
    };

    let pool = get_pool(app).await.map_err(|e| format!("数据库未连接：{e}"))?;

    // 读取会话元信息（已有摘要 + 已覆盖轮数 summary_round_count = last_compact_turn + 所属工程）。
    let meta = sqlx::query(
        "SELECT summary, summary_round_count, project_id \
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
    let db_summary: Option<String> = meta
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("summary").ok().flatten())
        .filter(|s| !s.trim().is_empty());
    let project_id: Option<String> = meta
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("project_id").ok().flatten())
        .filter(|s| !s.trim().is_empty());

    // 解析工程绑定：root_path + custom_rules（无工程则全部为 None，走通用模式）。
    let (custom_rules, project_root): (Option<String>, Option<String>) = if let Some(pid) = &project_id {
        let p = sqlx::query("SELECT root_path, custom_rules FROM agent_project WHERE id = ?")
            .bind(pid)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten();
        let root = p
            .as_ref()
            .and_then(|r| r.try_get::<Option<String>, _>("root_path").ok().flatten())
            .filter(|s| !s.trim().is_empty());
        let rules = p
            .as_ref()
            .and_then(|r| r.try_get::<Option<String>, _>("custom_rules").ok().flatten())
            .filter(|s| !s.trim().is_empty());
        (rules, root)
    } else {
        (None, None)
    };

    // [Slot 0] 系统提示词 + 工程专属规则注入。
    let mut system_prompt = cfg.system_prompt.clone();
    if let Some(rules) = &custom_rules {
        if !rules.trim().is_empty() {
            system_prompt.push_str("\n\n### Project Specific Rules:\n");
            system_prompt.push_str(rules);
        }
    }

    // 注：项目长期记忆 MEMORY.md 已在 load_config 注入 Slot 0（系统提示），本读路径不再重复，
    // 仅负责「会话滚动摘要」+ 活跃窗口轮次，避免重复注入爆上下文。

    // [Slot 2] 会话滚动摘要：工程绑定优先读 .wd_mem/sessions/{id}.summary.md，否则回退 DB summary。
    let session_summary: Option<String> = match &project_root {
        Some(root) => wd_mem::read_session_summary(root, &sid).or(db_summary),
        None => db_summary,
    };

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

    let mut messages = build_request_messages(
        &system_prompt,
        None,
        session_summary.as_deref(),
        &records,
        prompt,
    );
    inject_attachments(&mut messages, &cfg.attachments);

    // 装配链路日志：各 Slot 体量 + 最终规模，便于排错时确认上下文构成。
    println!(
        "[agent] context: 装配完成 session={} | Slot0 系统提示={}字符(custom_rules={}) | Slot1 项目记忆={} | Slot2 摘要={} | 活跃轮次={}(起始round_index={}) | 当前提问={}字符 附件={} | 最终 messages={}条/约{}字符",
        sid,
        system_prompt.chars().count(),
        custom_rules.as_ref().map(|r| r.chars().count()).unwrap_or(0),
        "已并入Slot0(系统提示)".to_string(),
        session_summary.as_ref().map(|s| format!("{}字符", s.chars().count())).unwrap_or_else(|| "无".into()),
        records.len(),
        last_compact + 1,
        prompt.chars().count(),
        cfg.attachments.len(),
        messages.len(),
        messages_chars(&messages),
    );

    Ok(messages)
}
