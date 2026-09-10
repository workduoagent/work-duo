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

use base64::Engine;
use serde_json::json;
use serde_json::Value;
use sqlx::Row;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::agent::round_compactor::build_request_messages;
use crate::agent::round_compactor::get_pool;
use crate::agent::round_compactor::ConversationRoundRecord;
use crate::agent::graph::KnowledgeGraph;
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

/// 去掉文件名中的路径分隔符与控制字符，只保留安全字符（字母数字 / . _ - 空格）。
fn sanitize_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' || c == ' ' {
            out.push(c);
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 附件分片暂存缓冲：前端 `begin/append/commit_stage_attachment` 命令按块写入，
/// commit 时由 `persist_bytes` 落盘到 `workspace/.attachments/`，避免超大文件经 IPC base64 膨胀。
struct StagedFile {
    name: String,
    mime: String,
    data: Vec<u8>,
}
static STAGING: OnceLock<Mutex<HashMap<String, StagedFile>>> = OnceLock::new();
static STAGE_SEQ: AtomicU64 = AtomicU64::new(0);

fn staging_map() -> &'static Mutex<HashMap<String, StagedFile>> {
    STAGING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_stage_id() -> String {
    let seq = STAGE_SEQ.fetch_add(1, Ordering::SeqCst);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("stg_{}_{}", nanos, seq)
}

/// 把字节落盘到 `workspace/.attachments/`（base64 附件与分片 commit 共用）。
fn persist_bytes(workspace: &Option<String>, name: &str, bytes: &[u8]) -> Result<String, String> {
    let ws = workspace
        .as_ref()
        .ok_or_else(|| "无工作空间，无法保存文件附件".to_string())?;
    if bytes.is_empty() {
        return Err("附件内容为空".to_string());
    }
    let dir = std::path::Path::new(ws).join(".attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 .attachments 目录失败：{e}"))?;
    let safe = sanitize_filename(name);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stamped = format!("{}_{}", ts, safe);
    let path = dir.join(&stamped);
    // 双重校验：最终路径必须仍在 .attachments 内（sanitize 已去分隔符，此处兜底）。
    if !path.starts_with(&dir) {
        return Err("非法文件名".to_string());
    }
    std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 把 base64 文件附件落盘到 `workspace/.attachments/`，返回绝对路径。
/// 无工作空间或内容为空时返回错误（调用方会注入提示文本而非中断）。
fn persist_file(workspace: &Option<String>, name: &str, b64: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 解码失败：{e}"))?;
    persist_bytes(workspace, name, &bytes)
}

/// mime → 扩展名兜底：前端可能传 `blob` 但携带真实 mime（如 image/png）。
/// commit 时若文件名缺扩展名则据此补全，避免落盘文件无类型后缀。
fn ext_from_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        "application/pdf" => Some("pdf"),
        "text/plain" => Some("txt"),
        "text/csv" => Some("csv"),
        "application/json" => Some("json"),
        "application/zip" => Some("zip"),
        "application/msword" => Some("doc"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => Some("docx"),
        "application/vnd.ms-excel" => Some("xls"),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => Some("xlsx"),
        "application/vnd.ms-powerpoint" => Some("ppt"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => Some("pptx"),
        _ => None,
    }
}

/// 开始一个分片暂存会话，返回 stage_id（前端据此分块追加字节）。
pub fn stage_begin(name: String, mime: String) -> String {
    let id = next_stage_id();
    staging_map()
        .lock()
        .unwrap()
        .insert(id.clone(), StagedFile { name, mime, data: Vec::new() });
    id
}

/// 追加一个分片（原始字节，来自前端 `Uint8Array`）。
pub fn stage_append(stage_id: &str, data: &[u8]) -> Result<(), String> {
    let mut m = staging_map().lock().unwrap();
    match m.get_mut(stage_id) {
        Some(f) => {
            f.data.extend_from_slice(data);
            Ok(())
        }
        None => Err("分片会话不存在或已过期".to_string()),
    }
}

/// 提交分片暂存：落盘到 `workspace/.attachments/` 并返回最终路径，清理缓冲。
pub fn stage_commit(stage_id: &str, workspace: &Option<String>) -> Result<String, String> {
    let f = staging_map()
        .lock()
        .unwrap()
        .remove(stage_id)
        .ok_or("分片会话不存在或已过期")?;
    // 文件名缺扩展名时（如 blob），按 mime 兜底补全，保证落盘文件有可用后缀。
    let name = if std::path::Path::new(&f.name).extension().is_none() {
        match ext_from_mime(&f.mime) {
            Some(ext) => format!("{}.{}", f.name, ext),
            None => f.name,
        }
    } else {
        f.name
    };
    persist_bytes(workspace, &name, &f.data)
}

/// 取消分片暂存（失败 / 超时清理，避免缓冲泄漏）。
pub fn stage_abort(stage_id: &str) {
    staging_map().lock().unwrap().remove(stage_id);
}

/// 把当前轮附件注入最后一条 user 消息，按三类路由：
/// - `image`：多模态 `image_url` 数组（需多模态模型）。
/// - `text`：提取文本直接内联进 prompt（任意模型可用）。
/// - `file`：base64 落盘到 `workspace/.attachments/`，注入本地路径提示，由 agent 用 `native__read_file`/沙箱解析（任意模型可用）。
///
/// 设计要点：text/file 附件统一拼回纯文本块——仅当存在图片时才改写为多模态数组，
/// 从而**非多模态模型也能消费文本/文件附件**（纯字符串 content 兼容）。
fn inject_attachments(
    messages: &mut Vec<Value>,
    attachments: &[AttachmentInput],
    workspace: &Option<String>,
) {
    if attachments.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(|v| v.as_str()) != Some("user") {
            return;
        }
        let base_text = last
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let image_parts: Vec<Value> = attachments
            .iter()
            .filter(|a| a.kind == "image" && !a.data_url.is_empty())
            .map(|a| json!({ "type": "image_url", "image_url": { "url": a.data_url } }))
            .collect();
        // 文本 / 文件附件统一拼回纯文本块（兼容非多模态模型）。
        let mut text_blocks: Vec<String> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        for a in attachments {
            match a.kind.as_str() {
                "text" => {
                    if let Some(c) = &a.content {
                        let label = a.name.clone().unwrap_or_else(|| "<文本内容>".into());
                        text_blocks.push(format!("\n\n[附件：{}]\n```\n{}\n```", label, c));
                        names.push(label);
                    }
                }
                "file" => {
                    let name = a.name.clone().unwrap_or_else(|| "未命名文件".into());
                    // 已分片落盘的附件直接复用暂存路径，避免重复写盘；否则由 base64 解码落盘。
                    let landed = if let Some(p) = &a.path {
                        Ok(p.clone())
                    } else {
                        persist_file(workspace, &name, a.content.as_deref().unwrap_or(""))
                    };
                    match landed {
                        Ok(path) => {
                            let mime = a
                                .mime
                                .clone()
                                .unwrap_or_else(|| "application/octet-stream".into());
                            text_blocks.push(format!(
                                "\n\n[附件文件：{}（{}，{} 字节）已保存到本地路径：{} ]\n请按需使用 native__read_file 或沙箱 Python（pdfplumber / python-docx / openpyxl 等）解析该文件后再回答用户问题。",
                                name, mime, a.size.unwrap_or(0), path
                            ));
                            names.push(name);
                        }
                        Err(e) => {
                            tracing::info!("[agent] context: 文件附件落盘失败（{}）：{}", name, e);
                            text_blocks.push(format!(
                                "\n\n[附件文件：{} 落盘失败：{} ]\n无法读取该文件内容。",
                                name, e
                            ));
                            names.push(name);
                        }
                    }
                }
                _ => {}
            }
        }
        if image_parts.is_empty() && text_blocks.is_empty() {
            return;
        }
        if image_parts.is_empty() {
            // 纯文本模型兼容：保持字符串 content。
            let mut combined = base_text;
            for b in &text_blocks {
                combined.push_str(b);
            }
            last["content"] = json!(combined);
        } else {
            let mut combined = base_text;
            for b in &text_blocks {
                combined.push_str(b);
            }
            let mut parts = vec![json!({ "type": "text", "text": combined })];
            parts.extend(image_parts.clone());
            last["content"] = json!(parts);
        }
        tracing::info!(
            "[agent] context: 已注入 {} 个附件（图片{}张 / 文本·文件{}个）：[{}]",
            attachments.len(),
            image_parts.len(),
            text_blocks.len(),
            names.join(", ")
        );
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
            tracing::info!("[agent] context: 无 session_id，仅装配 [system + 当前提问]（不含历史）");
            let mut m = build_request_messages(&cfg.system_prompt, None, None, &[], prompt);
            inject_attachments(&mut m, &cfg.attachments, &cfg.workspace);
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
    inject_attachments(&mut messages, &cfg.attachments, &cfg.workspace);

    // 装配链路日志：各 Slot 体量 + 最终规模，便于排错时确认上下文构成。
    tracing::info!(
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

/// P2-1 滚动会话背景摘要：仅提取「会话背景」用于子任务 prompt 注入，**不组装完整历史轮次**
/// （保持微 ReAct 隔离——工具型子任务只能感知「用户说过什么 / 已确认什么结论」，不感知工具报文）。
///
/// 读取三块：① 滚动摘要（复用 `build_context_messages` 的读取逻辑：工程绑定优先
/// `.wd_mem/sessions/{id}.summary.md`，回退 DB `summary`）；② 最近 1~2 条 `user_question`
/// （`round_index > last_compact`，取最新两条），便于子任务理解用户偏好/约束；
/// ③ 图聚合（§5.9）：若本会话统一实体图中有已完成 / 历史任务节点，把其 summary 并入背景，
/// 让跨轮子任务感知「本会话此前已完成过什么」。图非唯一真相源，仅在确有已落地摘要时追加。
///
/// 约束：
/// - `session_id` 为 None（squad 成员路径）直接返回 `None`，调用方跳过注入，不 panic；
/// - 超 800 字符截断，避免摘要膨胀破坏微 ReAct 干净上下文；
/// - 仅返回背景文本本身，注入时的「【会话背景摘要】」段头由 pipeline 负责拼接。
pub(crate) async fn load_session_background(
    app: &AppHandle,
    cfg: &AgentRuntimeConfig,
) -> Option<String> {
    let sid = cfg.session_id.as_ref()?;
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::info!("[agent] context: 背景摘要读取失败（DB 未连接）：{e}");
            return None;
        }
    };
    let meta = sqlx::query(
        "SELECT summary, summary_round_count, project_id \
         FROM agent_conversation_session WHERE id = ?",
    )
    .bind(sid)
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
    // 工程根路径（用于读取 .wd_mem 本地摘要文件）。
    let project_id: Option<String> = meta
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("project_id").ok().flatten())
        .filter(|s| !s.trim().is_empty());
    let project_root: Option<String> = match &project_id {
        Some(pid) => sqlx::query("SELECT root_path FROM agent_project WHERE id = ?")
            .bind(pid)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<Option<String>, _>("root_path").ok().flatten())
            .filter(|s| !s.trim().is_empty()),
        None => None,
    };

    // [Slot 2] 会话滚动摘要：工程绑定优先本地 .wd_mem 文件，否则回退 DB summary。
    let session_summary: Option<String> = match &project_root {
        Some(root) => wd_mem::read_session_summary(root, sid).or(db_summary),
        None => db_summary,
    };

    // 最近 1~2 条用户原话（round_index > last_compact，取最新两条）。
    let recent_user: Vec<String> = sqlx::query(
        "SELECT user_question FROM agent_conversation_round \
         WHERE session_id = ? AND round_index > ? \
         ORDER BY round_index DESC LIMIT 2",
    )
    .bind(sid)
    .bind(last_compact)
    .fetch_all(&pool)
    .await
    .ok()
    .map(|rows| {
        rows.iter()
            .filter_map(|r| r.try_get::<Option<String>, _>("user_question").ok().flatten())
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();

    let mut bg = String::new();
    if let Some(s) = &session_summary {
        bg.push_str(s.trim());
    }
    for q in &recent_user {
        if !bg.is_empty() {
            bg.push('\n');
        }
        bg.push_str(&format!("（用户原话）{q}"));
    }

    // [Slot 3b] 图聚合（§5.9 会话背景从图读）：本会话已在统一实体图中有「已完成 / 历史任务」节点时，
    // 把其 summary 并入背景，让跨轮子任务感知「本会话此前已完成过什么」。
    // 注意：跨轮重跑时 `plan_to_graph` 会把上一轮 completed 节点置 `obsolete`（summary 字段保留），
    // 故过滤 `status ∈ {completed, obsolete}` 且 summary 非空，才能捞出历史已完成摘要。
    // 图非唯一真相源：无 workspace / 图不可打开 / 无已落地摘要时静默跳过，不改既有 DB/文件读取逻辑。
    if let Some(ws) = cfg.workspace.as_deref() {
        if let Ok(g) = KnowledgeGraph::open(Some(ws)) {
            let mut graph_lines: Vec<String> = Vec::new();
            for n in g.session_tasks(sid) {
                let st = n.props.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let summary = n.props.get("summary").and_then(|v| v.as_str()).unwrap_or("").trim();
                if (st == "completed" || st == "obsolete") && !summary.is_empty() {
                    graph_lines.push(format!("- {summary}"));
                }
            }
            if !graph_lines.is_empty() {
                if !bg.is_empty() {
                    bg.push_str("\n\n");
                }
                bg.push_str("【本会话已完成任务】\n");
                bg.push_str(&graph_lines.join("\n"));
            }
        }
    }

    if bg.trim().is_empty() {
        return None;
    }
    // 截断 800 字符，避免摘要膨胀破坏微 ReAct 干净上下文。
    let bg = if bg.chars().count() > 800 {
        let truncated: String = bg.chars().take(800).collect();
        format!("{truncated}…")
    } else {
        bg
    };
    Some(bg)
}
