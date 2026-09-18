//! 记忆宫殿（Memory Palace）持久化与召回层（§3.3）。
//!
//! 记忆是智能体可长期召回的知识单元：既可由用户/智能体显式「锚定」，
//! 也可在每次任务运行时由 runtime 自动召回 top-K 注入系统提示——召回即累计 `ref_count`（引用计数），
//! 并写 `agent_memory_events` 日志，驱动前端「记忆热力图」。
//!
//! 与既有记忆（wd_mem MEMORY.md 磁盘态）的关系：
//!  - wd_mem 是「工程级长文本记忆」，全量/索引注入系统提示，供模型主动 `read_file` 发现；
//!  - 本模块是「结构化可召回记忆」，带引用计数与热力图，支持按热度自动注入与显性锚定/删除。
//!  二者互补：wd_mem 偏「文档沉淀」，本模块偏「知识点召回」。

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sqlx::Row;
use sqlx::sqlite::SqlitePool;
use tauri::AppHandle;

use crate::agent::embedding;
use crate::agent::events;
use crate::agent::round_compactor;
use crate::agent::vector_store;

/// 自动召回注入的 top-K 记忆条数（运行时注入系统提示的记忆上限）。
const MEMORY_RECALL_TOP: usize = 5;

/// 记忆向量在 LanceDB `memories` 表中的 scope 标识（第三期 M1：agent 记忆统一此值，
/// 与未来 squad/project 域区分；召回谓词按它先滤，防跨域串记忆）。
const MEMORY_SCOPE: &str = "agent";

/// 记忆分类枚举（与前端常量保持一致）。
pub const MEMORY_CATEGORIES: &[&str] = &[
    "decision",
    "code_pattern",
    "user_pref",
    "architecture",
    "fix",
    "other",
];

/// 单条记忆（对应 `agent_memories` 行，camelCase 序列化推前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub key: String,
    pub content: String,
    pub category: String,
    pub ref_count: i64,
    pub anchored: bool,
    pub last_recalled_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 热力图单点（按日聚合的召回次数）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapPoint {
    /// UTC 日期字符串 YYYY-MM-DD。
    pub date: String,
    pub count: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    format!("mem_{}", now_ms())
}

fn row_to_item(row: &sqlx::sqlite::SqliteRow) -> MemoryItem {
    let anchored: i64 = row.try_get("anchored").unwrap_or(0);
    let last: Option<i64> = row.try_get("last_recalled").ok().flatten();
    MemoryItem {
        id: row.try_get("id").unwrap_or_default(),
        agent_id: row.try_get("agent_id").ok().flatten(),
        session_id: row.try_get("session_id").ok().flatten(),
        key: row.try_get("key").unwrap_or_default(),
        content: row.try_get("content").unwrap_or_default(),
        category: row.try_get("category").unwrap_or_else(|_| "other".into()),
        ref_count: row.try_get("ref_count").unwrap_or(0),
        anchored: anchored == 1,
        last_recalled_at: last,
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
    }
}

/// 从 Tauri 托管的 DbInstances 取出连接池（与 commands::load_config / round_compactor 同机制）。
async fn get_pool(app: &AppHandle) -> Result<SqlitePool, String> {
    round_compactor::get_pool(app).await
}

/// 写一条记忆事件日志（best-effort，失败仅日志）。
async fn log_event(pool: &SqlitePool, memory_id: &str, event_type: &str, at: i64) {
    if let Err(e) = sqlx::query(
        "INSERT INTO agent_memory_events (memory_id, event_type, created_at) VALUES (?, ?, ?)",
    )
    .bind(memory_id)
    .bind(event_type)
    .bind(at)
    .execute(pool)
    .await
    {
        tracing::warn!("[memory] 写事件日志失败（{event_type}）：{e}");
    }
}

async fn get_by_id(pool: &SqlitePool, id: &str) -> Result<MemoryItem, String> {
    let row = sqlx::query("SELECT * FROM agent_memories WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取记忆失败：{e}"))?
        .ok_or_else(|| "记忆不存在".to_string())?;
    Ok(row_to_item(&row))
}

/// 列举记忆。
///
/// - `agent_id`：`Some(a)` 时只取「全局(agent_id IS NULL) + 该智能体」的记忆；
///   `None` 时取全部（记忆宫殿页默认全局视图，展示所有已沉淀记忆）。
/// - `category`：`all`/空 不过滤，否则按分类精确过滤。
/// - `query`：非空时按 `key`/`content` LIKE 模糊检索。
/// 结果按 `ref_count` 降序、`updated_at` 降序排序（高频记忆优先）。
pub async fn list_memories(
    app: &AppHandle,
    agent_id: Option<&str>,
    category: Option<&str>,
    query: Option<&str>,
) -> Result<Vec<MemoryItem>, String> {
    let pool = get_pool(app).await?;
    let mut sql = String::from("SELECT * FROM agent_memories WHERE 1=1");
    let mut binds: Vec<String> = Vec::new();

    if let Some(a) = agent_id {
        sql.push_str(" AND (agent_id = ? OR agent_id IS NULL)");
        binds.push(a.to_string());
    }
    if let Some(c) = category {
        if !c.is_empty() && c != "all" {
            sql.push_str(" AND category = ?");
            binds.push(c.to_string());
        }
    }
    if let Some(q) = query {
        let t = q.trim();
        if !t.is_empty() {
            // ESCAPE '\\' 转义用户输入中的 %/_ 通配符，避免误匹配
            let like = format!(
                "%{}%",
                t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
            );
            sql.push_str(" AND (key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
            binds.push(like.clone());
            binds.push(like);
        }
    }
    sql.push_str(" ORDER BY ref_count DESC, updated_at DESC");

    let mut qb = sqlx::query(&sql);
    for b in &binds {
        qb = qb.bind(b.clone());
    }
    let rows = qb
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("查询记忆失败：{e}"))?;
    Ok(rows.iter().map(row_to_item).collect())
}

/// 按日聚合「召回(recall)」事件，返回所有历史日期的召回次数（前端据此补齐连续日历格）。
pub async fn get_memory_heatmap(
    app: &AppHandle,
    agent_id: Option<&str>,
) -> Result<Vec<HeatmapPoint>, String> {
    let pool = get_pool(app).await?;
    // 仅统计全局 + 指定 agent 的记忆事件（与列表视图口径一致）
    let rows = if let Some(aid) = agent_id {
        sqlx::query(
            "SELECT date(e.created_at/1000, 'unixepoch') AS d, COUNT(*) AS c \
             FROM agent_memory_events e \
             JOIN agent_memories m ON m.id = e.memory_id \
             WHERE e.event_type='recall' AND (m.agent_id IS NULL OR m.agent_id = ?) \
             GROUP BY d ORDER BY d ASC",
        )
        .bind(aid)
        .fetch_all(&pool)
        .await
    } else {
        sqlx::query(
            "SELECT date(created_at/1000, 'unixepoch') AS d, COUNT(*) AS c \
             FROM agent_memory_events WHERE event_type='recall' GROUP BY d ORDER BY d ASC",
        )
        .fetch_all(&pool)
        .await
    }
    .map_err(|e| format!("查询记忆热力图失败：{e}"))?;

    Ok(rows
        .iter()
        .map(|r| HeatmapPoint {
            date: r.try_get("d").unwrap_or_default(),
            count: r.try_get("c").unwrap_or(0),
        })
        .collect())
}

/// 锚定（新建或更新）一条记忆：同一 `(agent_id, key)` 已存在则更新 content/category 并保留 ref_count，
/// 否则插入新记录（anchored=1）。写入后写一条 `anchor` 事件日志。
pub async fn anchor_memory(
    app: &AppHandle,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    key: &str,
    content: &str,
    category: &str,
    anchored: bool,
    // 自动路径（forced 引擎沉淀 + native__anchor_memory 工具）= true：走质量护栏
    // （category 强校验丢弃、与同 agent 已有条目去噪合并）；手动 UI 锚定 = false：原行为不拦。
    auto_merge: bool,
) -> Result<MemoryItem, String> {
    let pool = get_pool(app).await?;
    let now = now_ms();
    // M0 质量护栏·category：自动路径强校验丢弃（不再静默回落 other，避免噪音进库）；
    // 手动路径保留原回落 other 行为（用户明确意图，宽松处理）。
    let cat = if auto_merge {
        if category.is_empty() || !MEMORY_CATEGORIES.contains(&category) {
            return Err(format!(
                "非法记忆分类「{}」（允许：{:?}）",
                category, MEMORY_CATEGORIES
            ));
        }
        category
    } else if category.is_empty() || !MEMORY_CATEGORIES.contains(&category) {
        "other"
    } else {
        category
    };

    let existing: Option<String> = if let Some(aid) = agent_id {
        sqlx::query("SELECT id FROM agent_memories WHERE agent_id = ? AND key = ?")
            .bind(aid)
            .bind(key)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<String, _>("id").ok())
    } else {
        sqlx::query("SELECT id FROM agent_memories WHERE agent_id IS NULL AND key = ?")
            .bind(key)
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<String, _>("id").ok())
    };
    // M0 去噪合并（仅自动路径）：精确 key 未命中时，查同 agent 下 content 归一化高度重合的条目，
    // 命中则更新已有条目而非新增，避免复述型条目堆积。手动路径不拦（用户明确意图）。
    let existing = if auto_merge && existing.is_none() {
        find_similar_memory(&pool, agent_id, content).await.unwrap_or(None)
    } else {
        existing
    };

    let id = match existing {
        Some(id) => {
            sqlx::query(
                "UPDATE agent_memories SET content=?, category=?, anchored=?, updated_at=? WHERE id=?",
            )
            .bind(content)
            .bind(cat)
            .bind(anchored)
            .bind(now)
            .bind(&id)
            .execute(&pool)
            .await
            .map_err(|e| format!("更新记忆失败：{e}"))?;
            id
        }
        None => {
            let id = new_id();
            sqlx::query(
                "INSERT INTO agent_memories \
                 (id, agent_id, session_id, key, content, category, ref_count, anchored, last_recalled, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)",
            )
            .bind(&id)
            .bind(agent_id)
            .bind(session_id)
            .bind(key)
            .bind(content)
            .bind(cat)
            .bind(anchored)
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .map_err(|e| format!("写入记忆失败：{e}"))?;
            id
        }
    };
    log_event(&pool, &id, "anchor", now).await;
    let item = get_by_id(&pool, &id).await?;
    // 锚定完成（手动或自动）即推送事件，前端「记忆宫殿」实时新增/更新卡片，无需重开页面。
    events::emit_memory_anchored(app, &item);
    // M1 写路径双写：SQLite 权威落库后，后台异步嵌入并 upsert LanceDB（fire-and-forget，
    // 失败仅日志——该条召回时自动回退关键词链，不打断锚定主流程）。
    spawn_memory_vector_sync(app.clone(), item.clone());
    Ok(item)
}

/// M0 去噪合并：查同 agent（或全局 agent_id IS NULL）下与 content 语义重复的已有条目 id。
/// 判定两级：① 归一化（去全部空白）后完全相等 → 直接命中；② 字符 2-gram 重合率 ≥60% → 视为
/// 措辞不同的语义重复（LLM 提炼必换措辞，完全相等挡不住；阈值真机可调）。量级可控（单 agent
/// 通常 < 数千条），M0 作降级地基可接受 O(n) 扫描；向量时代由语义检索取代。
async fn find_similar_memory(
    pool: &SqlitePool,
    agent_id: Option<&str>,
    content: &str,
) -> Result<Option<String>, String> {
    const SIMILAR_THRESHOLD: f64 = 0.6;
    const MIN_CONTENT_CHARS: usize = 6;
    let norm: String = content.chars().filter(|c| !c.is_whitespace()).collect();
    if norm.chars().count() < MIN_CONTENT_CHARS {
        return Ok(None);
    }
    let q_grams = char_bigrams(&norm);
    if q_grams.is_empty() {
        return Ok(None);
    }
    let rows = if let Some(aid) = agent_id {
        sqlx::query("SELECT id, content FROM agent_memories WHERE agent_id = ?")
            .bind(aid)
            .fetch_all(pool)
            .await
    } else {
        sqlx::query("SELECT id, content FROM agent_memories WHERE agent_id IS NULL")
            .fetch_all(pool)
            .await
    }
    .map_err(|e| format!("查相似记忆失败：{e}"))?;
    let mut best_score = 0f64;
    let mut best_id: Option<String> = None;
    for r in &rows {
        let c: String = r.try_get("content").unwrap_or_default();
        let cn: String = c.chars().filter(|ch| !ch.is_whitespace()).collect();
        if cn == norm {
            return Ok(r.try_get::<String, _>("id").ok());
        }
        let c_grams = char_bigrams(&cn);
        if c_grams.is_empty() {
            continue;
        }
        let inter = q_grams.intersection(&c_grams).count();
        let denom = q_grams.len().min(c_grams.len()).max(1);
        let score = inter as f64 / denom as f64;
        if score > best_score {
            best_score = score;
            best_id = r.try_get::<String, _>("id").ok();
        }
    }
    if best_score >= SIMILAR_THRESHOLD {
        tracing::debug!(
            "[memory] 去噪合并：命中语义重复条目（2-gram 重合率={:.2}≥{:.2}）",
            best_score,
            SIMILAR_THRESHOLD
        );
        Ok(best_id)
    } else {
        Ok(None)
    }
}

/// 更新一条记忆的部分字段（仅更新提供的非空字段）。
pub async fn update_memory(
    app: &AppHandle,
    id: &str,
    key: Option<&str>,
    content: Option<&str>,
    category: Option<&str>,
) -> Result<MemoryItem, String> {
    let pool = get_pool(app).await?;
    let now = now_ms();
    if let Some(k) = key.filter(|s| !s.is_empty()) {
        sqlx::query("UPDATE agent_memories SET key=?, updated_at=? WHERE id=?")
            .bind(k)
            .bind(now)
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| format!("更新记忆失败：{e}"))?;
    }
    if let Some(c) = content {
        sqlx::query("UPDATE agent_memories SET content=?, updated_at=? WHERE id=?")
            .bind(c)
            .bind(now)
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| format!("更新记忆失败：{e}"))?;
    }
    if let Some(cat) = category.filter(|s| !s.is_empty() && MEMORY_CATEGORIES.contains(s)) {
        sqlx::query("UPDATE agent_memories SET category=?, updated_at=? WHERE id=?")
            .bind(cat)
            .bind(now)
            .bind(id)
            .execute(&pool)
            .await
            .map_err(|e| format!("更新记忆失败：{e}"))?;
    }
    let item = get_by_id(&pool, id).await?;
    // M1：key/content 变更后向量过期，后台重算 upsert（merge by id 幂等，失败仅日志）。
    spawn_memory_vector_sync(app.clone(), item.clone());
    Ok(item)
}

/// 删除一条记忆（外键 ON DELETE CASCADE 自动清理其事件日志）。
pub async fn delete_memory(app: &AppHandle, id: &str) -> Result<(), String> {
    let pool = get_pool(app).await?;
    sqlx::query("DELETE FROM agent_memories WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| format!("删除记忆失败：{e}"))?;
    // M1 双删：SQLite 删除成功后同步删 LanceDB 向量（best-effort；万一残留，
    // 向量召回取元数据时按 SQLite 为准自然滤除，不会出现幽灵条目）。
    if let Some(vs) = vector_store::get_shared(app).await {
        if let Err(e) = vs.delete_memories(&[id.to_string()]).await {
            tracing::warn!("[memory] 向量双删失败（召回时按 SQLite 滤除兜底）id={id}：{e}");
        }
    }
    Ok(())
}

/// 显式召回一条记忆：ref_count += 1，last_recalled=now，写 `recall` 事件并 emit `memory_recalled`。
/// 用于前端「引用一次」手动埋点，或记忆详情页主动召回。
pub async fn recall_memory(app: &AppHandle, id: &str) -> Result<MemoryItem, String> {
    let pool = get_pool(app).await?;
    let now = now_ms();
    sqlx::query(
        "UPDATE agent_memories SET ref_count = ref_count + 1, last_recalled = ?, updated_at = ? WHERE id = ?",
    )
    .bind(now)
    .bind(now)
    .bind(id)
    .execute(&pool)
    .await
    .map_err(|e| format!("召回记忆失败：{e}"))?;
    log_event(&pool, id, "recall", now).await;
    let item = get_by_id(&pool, id).await?;
    events::emit_memory_recalled(app, &item);
    Ok(item)
}

/// M0 forced_memory_settle 落库前质量校验。通过返回 Ok；不通过返回 Err(跳过原因)。
/// 抽成纯函数便于单测；runtime.rs::forced_memory_settle 解析循环调用，单一事实源。
pub fn validate_forced_entry(key: &str, category: &str, body: &str) -> Result<(), &'static str> {
    const BOILERPLATE_PREFIXES: &[&str] = &[
        "已成功",
        "任务完成",
        "已完成",
        "本次任务",
        "成功完成",
        "执行完成",
        "任务已",
        "本次执行",
    ];
    if key.chars().count() < 2 {
        return Err("短 key（<2字）");
    }
    if body.chars().count() < 10 {
        return Err("短 content（<10字）");
    }
    if BOILERPLATE_PREFIXES.iter().any(|p| body.starts_with(p)) {
        return Err("模板复述句");
    }
    if !MEMORY_CATEGORIES.contains(&category) {
        return Err("非法 category");
    }
    Ok(())
}

/// M0 关键词重排：取字符串的字符 2-gram（中文友好，无需分词）。
fn char_bigrams(s: &str) -> std::collections::HashSet<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() < 2 {
        return std::collections::HashSet::new();
    }
    (0..chars.len() - 1)
        .map(|i| format!("{}{}", chars[i], chars[i + 1]))
        .collect()
}

/// M0 关键词重排：query 与 candidate 共享的 2-gram 数（绝对值；候选池内相对排序有意义）。
fn overlap_score(query: &str, candidate: &str) -> usize {
    let q = char_bigrams(query);
    if q.is_empty() {
        return 0;
    }
    let c = char_bigrams(candidate);
    q.intersection(&c).count()
}

/// 向量召回文本：key 与 content 拼接（与 M0 关键词重排的候选文本口径一致，key 提供短标题信号）。
fn embed_text_of(key: &str, content: &str) -> String {
    format!("{key}\n{content}")
}

/// LanceDB 标量谓词：仅召回「全局 + 当前 agent」的 agent 记忆（防多智能体串记忆）。
/// agent_id 做单引号转义防谓词注入（id 为系统生成，防御性处理）。
fn scope_filter(agent_id: Option<&str>) -> String {
    match agent_id {
        Some(a) => format!(
            "scope = '{MEMORY_SCOPE}' AND (agent_id IS NULL OR agent_id = '{}')",
            a.replace('\'', "''")
        ),
        None => format!("scope = '{MEMORY_SCOPE}' AND agent_id IS NULL"),
    }
}

/// 写路径向量同步：嵌入 `key+content` 并 upsert 进 LanceDB `memories`（merge by id 幂等）。
/// 嵌入未配置 / 向量库不可用 = Ok 跳过（存量条目等 004「回填向量」补齐）；网络/写入失败 = Err。
async fn sync_memory_vector(app: &AppHandle, item: &MemoryItem) -> Result<(), String> {
    let pool = get_pool(app).await?;
    let Some(cfg) = embedding::load_default_embedding(&pool).await? else {
        return Ok(()); // 未配置嵌入模型：静默跳过，召回自动落关键词降级链
    };
    let Some(vs) = vector_store::get_shared(app).await else {
        return Ok(()); // 向量库不可用：同上降级
    };
    let text = embed_text_of(&item.key, &item.content);
    let vec = embedding::embed_texts(app, &pool, &cfg, &[text])
        .await?
        .into_iter()
        .next()
        .ok_or("嵌入返回空向量")?;
    vs.upsert_memories(&[vector_store::MemoryVectorRow {
        id: item.id.clone(),
        agent_id: item.agent_id.clone(),
        project_id: None,
        session_id: item.session_id.clone(),
        scope: MEMORY_SCOPE.to_string(),
        key: item.key.clone(),
        content: item.content.clone(),
        category: item.category.clone(),
        embedding: Some(vec),
        embedding_model: Some(cfg.model_name.clone()),
        updated_at: item.updated_at,
    }])
    .await
}

/// 后台 fire-and-forget 向量同步：失败仅日志，绝不阻塞/打断锚定与更新主流程（失败=降级信号）。
fn spawn_memory_vector_sync(app: AppHandle, item: MemoryItem) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync_memory_vector(&app, &item).await {
            tracing::warn!(
                "[memory] 向量同步失败（该条暂缺向量，召回时经关键词链兜底）id={}：{e}",
                item.id
            );
        }
    });
}

/// 一级语义召回：embed(prompt) → LanceDB 向量检索（scope+agent 谓词先滤再向量）→
/// SQLite 取回元数据并按向量距离序（= 相关度序）重排。已删除条目经 IN 查询自然滤除。
async fn recall_by_vector(
    app: &AppHandle,
    pool: &SqlitePool,
    agent_id: Option<&str>,
    prompt: &str,
    k: usize,
) -> Result<Vec<MemoryItem>, String> {
    let cfg = embedding::load_default_embedding(pool)
        .await?
        .ok_or("未配置嵌入模型")?;
    let vs = vector_store::get_shared(app)
        .await
        .ok_or("向量库不可用")?;
    let query_vec = embedding::embed_texts(app, pool, &cfg, &[prompt.to_string()])
        .await?
        .into_iter()
        .next()
        .ok_or("嵌入返回空向量")?;
    let hits = vs
        .search_memories(&query_vec, Some(&scope_filter(agent_id)), k)
        .await?;
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = hits.iter().map(|h| h.id.clone()).collect();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    // SQL 字符串必须先落局部变量：sqlx::query 借用它直至执行，行内临时值会立刻释放（E0716）。
    let sql = format!("SELECT * FROM agent_memories WHERE id IN ({placeholders})");
    let mut q = sqlx::query(&sql);
    for id in &ids {
        q = q.bind(id);
    }
    let rows = q
        .fetch_all(pool)
        .await
        .map_err(|e| format!("取回召回元数据失败：{e}"))?;
    let mut by_id: std::collections::HashMap<String, MemoryItem> = rows
        .iter()
        .map(|r| {
            let it = row_to_item(r);
            (it.id.clone(), it)
        })
        .collect();
    // 向量序即相关序：按 hits 顺序重排（SQLite 已删的 id 自然被 filter_map 丢弃）。
    Ok(ids
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect())
}

/// 二级关键词降级链（M0）：SQLite 候选（ref_count DESC）→ 字符 2-gram 重排 → top-K。
/// `exclude_ids`：向量链已命中条目（补齐场景防重复）；prompt=None 时退化为 ref_count 序 top-K。
async fn recall_by_keyword(
    pool: &SqlitePool,
    agent_id: Option<&str>,
    k: usize,
    prompt: Option<&str>,
    exclude_ids: &[String],
) -> Vec<MemoryItem> {
    if k == 0 {
        return Vec::new();
    }
    // 有 prompt 时放大候选池到 k×4 供重排（额外容纳剔除量）；无 prompt 时原 k。
    let limit = (if prompt.is_some() { k * 4 } else { k }) + exclude_ids.len();
    let Ok(rows) = sqlx::query(
        "SELECT * FROM agent_memories WHERE agent_id IS NULL OR agent_id = ? \
         ORDER BY ref_count DESC, updated_at DESC LIMIT ?",
    )
    .bind(agent_id.unwrap_or(""))
    .bind(limit as i64)
    .fetch_all(pool)
    .await
    else {
        tracing::warn!("[memory] recall 关键词链: 查询失败");
        return Vec::new();
    };
    let mut items: Vec<MemoryItem> = rows
        .iter()
        .map(row_to_item)
        .filter(|i| !exclude_ids.iter().any(|e| e == &i.id))
        .collect();
    // M0 字符重排：有 prompt 时按 2-gram 重合度排序；stable sort 同分保持原 ref_count 序（全零回落）。
    if let Some(p) = prompt {
        items.sort_by(|a, b| {
            let sa = overlap_score(p, &format!("{} {}", a.key, a.content));
            let sb = overlap_score(p, &format!("{} {}", b.key, b.content));
            sb.cmp(&sa)
        });
    }
    items.truncate(k);
    items
}

/// 召回收尾（两链共用）：逐条 ref_count+1 / last_recalled / recall 事件 / emit，并拼系统提示块。
async fn bump_and_block(
    pool: &SqlitePool,
    app: &AppHandle,
    mut items: Vec<MemoryItem>,
) -> (Vec<MemoryItem>, String) {
    let now = now_ms();
    let mut block = String::from(
        "### 记忆宫殿 · 召回的长期记忆\n以下是你此前沉淀、本次自动召回的关键记忆，处理任务时应优先参考：\n",
    );
    for item in &mut items {
        if let Err(e) = sqlx::query(
            "UPDATE agent_memories SET ref_count = ref_count + 1, last_recalled = ?, updated_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(now)
        .bind(&item.id)
        .execute(pool)
        .await
        {
            tracing::warn!("[memory] recall: 计数更新失败 {}：{e}", item.id);
        }
        log_event(pool, &item.id, "recall", now).await;
        item.ref_count += 1;
        item.last_recalled_at = Some(now);
        events::emit_memory_recalled(app, item);
        block.push_str(&format!("- [{}] {}\n", item.key, item.content));
    }
    (items, block)
}

/// 运行时自动召回（M1 三级降级链 + M2 可选精排）：
/// ① 向量语义粗排（prompt 存在且嵌入已配置：embed query → LanceDB 检索 top-k×4）；
/// ② 关键词降级链兜底/补齐（未配置/失败/粗排不足：SQLite ref_count 候选 + 2-gram 重排）；
/// ③ ref_count 裸排序（无 prompt 时的基础序）；
/// ④ M2 rerank 精排（可选级：配置了 rerank 模型时对粗排池精排取 top-K，失败/未配置保持粗排序）。
/// 命中统一走 `bump_and_block` 累计引用计数并拼「记忆宫殿 · 召回」系统提示块。
///
/// 由 `commands::load_config` 在组装系统提示的尾部注入，使记忆宫殿真正参与任务上下文，
/// 且每次运行自然累积引用计数（驱动热力图）。
pub async fn recall_top_memories(
    app: &AppHandle,
    agent_id: Option<&str>,
    k: usize,
    // 本轮 prompt：Some 时先走向量语义召回，失败/不足自动落关键词链；None 时保持原 ref_count 序。
    prompt: Option<&str>,
) -> (Vec<MemoryItem>, String) {
    if k == 0 {
        return (Vec::new(), String::new());
    }
    let pool = match get_pool(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[memory] recall_top_memories: 取池失败：{e}");
            return (Vec::new(), String::new());
        }
    };

    // ① 向量语义粗排（prompt 存在时）。候选池放大到 k×4（M2：为 rerank 精排留料）。
    // 嵌入/向量库任一环失败 → 整体落降级链，绝不打断任务。
    let mut items: Vec<MemoryItem> = Vec::new();
    let coarse_k = k * 4;
    if let Some(p) = prompt {
        match recall_by_vector(app, &pool, agent_id, p, coarse_k).await {
            Ok(hit) => items = hit,
            Err(e) => {
                tracing::info!("[memory] recall_top_memories: 向量召回未用上，降级关键词链：{e}")
            }
        }
    }
    // ② 关键词降级链兜底/补齐（排除向量已命中防重复），补到粗排池大小。
    if items.len() < coarse_k {
        let exclude: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
        let extra =
            recall_by_keyword(&pool, agent_id, coarse_k - items.len(), prompt, &exclude).await;
        items.extend(extra);
    }
    // ③ M2 rerank 精排（可选级）：未配置跳过、失败保持粗排序——管道任意一环故障不放大。
    // 粗排命中数 ≤ k 时精排无收益，直接跳过。
    if let Some(p) = prompt {
        if items.len() > k {
            match embedding::load_default_rerank(&pool).await {
                Ok(Some(rc)) => {
                    let docs: Vec<String> = items
                        .iter()
                        .map(|i| format!("{} {}", i.key, i.content))
                        .collect();
                    match embedding::rerank(app, &pool, &rc, p, &docs, k).await {
                        Ok(pairs) if !pairs.is_empty() => {
                            // 日志打 key 而非 id：用户真机验证时能直接看出「哪条被排前」
                            let before: Vec<String> = items
                                .iter()
                                .take(k)
                                .map(|i| crate::agent::runtime::clip(&i.key, 24))
                                .collect();
                            items = pairs
                                .iter()
                                .filter_map(|(idx, _)| items.get(*idx).cloned())
                                .collect();
                            let after: Vec<String> = items
                                .iter()
                                .map(|i| crate::agent::runtime::clip(&i.key, 24))
                                .collect();
                            if before != after {
                                tracing::info!(
                                    "[memory] rerank 精排生效：top-{k} 顺序调整 [{}] → [{}]",
                                    before.join(" | "),
                                    after.join(" | ")
                                );
                            }
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::info!("[memory] rerank 失败，保持粗排序：{e}")
                        }
                    }
                }
                Ok(None) => {}
                Err(e) => tracing::info!("[memory] rerank 配置读取失败，保持粗排序：{e}"),
            }
        }
    }
    // ④ 截断至 k 并收尾（ref_count+1 / 事件 / 系统提示块）。
    items.truncate(k);
    if items.is_empty() {
        return (Vec::new(), String::new());
    }
    bump_and_block(&pool, app, items).await
}

// ============================ 存量记忆向量回填（#20260918004） ============================

/// 回填结果汇总（camelCase 序列化推前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillReport {
    pub total: u32,
    pub ok: u32,
    pub failed: u32,
    /// 语义：finished=false 时是中途失败中断（前端提示），true 为正常跑完。
    pub finished: bool,
}

/// 回填重入保护：同一时刻只允许一个回填任务（命令级防连点/双开）。
static BACKFILL_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// tauri 命令（lib.rs 注册）：存量记忆批量向量化（带进度事件）。
#[tauri::command]
pub async fn backfill_memory_vectors(app: AppHandle) -> Result<BackfillReport, String> {
    backfill_memory_inner(&app).await
}

/// 存量记忆批量向量化：全量拉 SQLite 记忆 → 分批（每批 16 条）嵌入 → 逐批 upsert LanceDB。
/// upsert 为 merge by id 幂等——已有向量的条目会被重算覆盖，因此本命令同时承担
/// 「未配置嵌入前的存量补齐」与「换模型后全量重算」（003 挪入的懒重算语义）两种场景。
/// 进度经 `agent-memory-backfill` 事件逐批推送；失败条目跳过不中断（降级语义）。
async fn backfill_memory_inner(app: &AppHandle) -> Result<BackfillReport, String> {
    use std::sync::atomic::Ordering;
    if BACKFILL_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有回填任务在进行中，请等待完成".into());
    }
    let _guard = BackfillGuard;
    let pool = get_pool(app).await?;
    let Some(cfg) = embedding::load_default_embedding(&pool).await? else {
        return Err("未配置嵌入模型（LLM 模块需有「向量模型」分类且已启用的模型）".into());
    };
    let Some(vs) = vector_store::get_shared(app).await else {
        return Err("向量库不可用（请检查设置页「向量库存储目录」或查看日志）".into());
    };
    let rows = sqlx::query("SELECT * FROM agent_memories ORDER BY created_at ASC")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("读取存量记忆失败：{e}"))?;
    let items: Vec<MemoryItem> = rows.iter().map(row_to_item).collect();
    let total = items.len() as u32;
    if total == 0 {
        return Ok(BackfillReport { total: 0, ok: 0, failed: 0, finished: true });
    }

    const BATCH: usize = 16;
    let mut ok: u32 = 0;
    let mut failed: u32 = 0;
    let mut done: u32 = 0;
    for chunk in items.chunks(BATCH) {
        let texts: Vec<String> = chunk
            .iter()
            .map(|it| embed_text_of(&it.key, &it.content))
            .collect();
        let vecs = match embedding::embed_texts(app, &pool, &cfg, &texts).await {
            Ok(v) => v,
            Err(e) => {
                // 整批嵌入失败（网络/鉴权）：计失败并继续下一批（下一批大概率同样失败，
                // 但保持「跳过不中断」语义，最终汇报真实失败数）。
                tracing::warn!("[memory] 回填：一批 {} 条嵌入失败：{e}", chunk.len());
                failed += chunk.len() as u32;
                done += chunk.len() as u32;
                events::emit_memory_backfill_progress(
                    app,
                    &events::MemoryBackfillProgress { done, total, ok, failed, finished: done >= total },
                );
                continue;
            }
        };
        let mut batch_rows: Vec<vector_store::MemoryVectorRow> = Vec::new();
        for (it, v) in chunk.iter().zip(vecs) {
            batch_rows.push(vector_store::MemoryVectorRow {
                id: it.id.clone(),
                agent_id: it.agent_id.clone(),
                project_id: None,
                session_id: it.session_id.clone(),
                scope: MEMORY_SCOPE.to_string(),
                key: it.key.clone(),
                content: it.content.clone(),
                category: it.category.clone(),
                embedding: Some(v),
                embedding_model: Some(cfg.model_name.clone()),
                updated_at: it.updated_at,
            });
        }
        match vs.upsert_memories(&batch_rows).await {
            Ok(()) => ok += batch_rows.len() as u32,
            Err(e) => {
                tracing::warn!("[memory] 回填：一批 {} 条 upsert 失败：{e}", batch_rows.len());
                failed += batch_rows.len() as u32;
            }
        }
        done += chunk.len() as u32;
        events::emit_memory_backfill_progress(
            app,
            &events::MemoryBackfillProgress { done, total, ok, failed, finished: done >= total },
        );
    }
    tracing::info!(
        "[memory] 回填完成：总 {total}，成功 {ok}，失败 {failed}（模型={}）",
        cfg.model_name
    );
    Ok(BackfillReport { total, ok, failed, finished: true })
}

/// RAII 守卫：无论提前 return 还是 panic 都复位重入标志。
struct BackfillGuard;
impl Drop for BackfillGuard {
    fn drop(&mut self) {
        BACKFILL_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

// ============================ 小分队协作记忆（Squad Blackboard） ============================
//
// 结构照搬上方 agent 记忆：归属维度换成 squad_id + 可选 agent_id（NULL=团队共享记忆）。
// 团队黑板（§12 Phase 6）在 `load_squad` 召回 top-K 注入成员 system_prompt；本段补齐「写入」路径，
// 使记忆可被显式锚定并随运行累积引用计数。返回 camelCase 序列化结构，便于前端直接消费。

/// 小分队记忆单条（对应 `agent_squad_memory` 行，camelCase 序列化推前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SquadMemoryItem {
    pub id: String,
    pub squad_id: String,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub key: String,
    pub content: String,
    pub category: String,
    pub ref_count: i64,
    pub anchored: bool,
    pub last_recalled_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_to_squad_item(row: &sqlx::sqlite::SqliteRow) -> SquadMemoryItem {
    let anchored: i64 = row.try_get("anchored").unwrap_or(0);
    let last: Option<i64> = row.try_get("last_recalled").ok().flatten();
    SquadMemoryItem {
        id: row.try_get("id").unwrap_or_default(),
        squad_id: row.try_get("squad_id").unwrap_or_default(),
        agent_id: row.try_get("agent_id").ok().flatten(),
        session_id: row.try_get("session_id").ok().flatten(),
        key: row.try_get("key").unwrap_or_default(),
        content: row.try_get("content").unwrap_or_default(),
        category: row.try_get("category").unwrap_or_else(|_| "general".into()),
        ref_count: row.try_get("ref_count").unwrap_or(0),
        anchored: anchored == 1,
        last_recalled_at: last,
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
    }
}

async fn get_squad_memory_by_id(pool: &SqlitePool, id: &str) -> Result<SquadMemoryItem, String> {
    let row = sqlx::query("SELECT * FROM agent_squad_memory WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询小分队记忆失败：{e}"))?
        .ok_or_else(|| "小分队记忆不存在".to_string())?;
    Ok(row_to_squad_item(&row))
}

/// 锚定一条小分队记忆（写入 / 更新）。
///
/// 去重键：`squad_id + agent_id + key`。命中已有记录则更新 content / category，并将
/// `ref_count += 1`（每次锚定视为一次强化）；否则插入新记录。锚定完成即推送
/// `agent-squad-memory-anchored` 事件，前端记忆面板据此实时刷新。
pub async fn anchor_squad_memory(
    app: &AppHandle,
    squad_id: &str,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    key: &str,
    content: &str,
    category: &str,
    anchored: bool,
) -> Result<SquadMemoryItem, String> {
    let pool = get_pool(app).await?;
    let now = now_ms();
    let cat = if category.is_empty() { "general" } else { category };

    let existing: Option<String> = if let Some(aid) = agent_id {
        sqlx::query(
            "SELECT id FROM agent_squad_memory WHERE squad_id = ? AND agent_id = ? AND key = ?",
        )
        .bind(squad_id)
        .bind(aid)
        .bind(key)
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<String, _>("id").ok())
    } else {
        sqlx::query(
            "SELECT id FROM agent_squad_memory WHERE squad_id = ? AND agent_id IS NULL AND key = ?",
        )
        .bind(squad_id)
        .bind(key)
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<String, _>("id").ok())
    };

    let id = match existing {
        Some(id) => {
            sqlx::query(
                "UPDATE agent_squad_memory SET content=?, category=?, anchored=?, ref_count=ref_count+1, updated_at=? WHERE id=?",
            )
            .bind(content)
            .bind(cat)
            .bind(anchored)
            .bind(now)
            .bind(&id)
            .execute(&pool)
            .await
            .map_err(|e| format!("更新小分队记忆失败：{e}"))?;
            id
        }
        None => {
            let id = new_id();
            sqlx::query(
                "INSERT INTO agent_squad_memory \
                 (id, squad_id, agent_id, session_id, key, content, category, ref_count, anchored, last_recalled, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)",
            )
            .bind(&id)
            .bind(squad_id)
            .bind(agent_id)
            .bind(session_id)
            .bind(key)
            .bind(content)
            .bind(cat)
            .bind(anchored)
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .map_err(|e| format!("写入小分队记忆失败：{e}"))?;
            id
        }
    };

    let item = get_squad_memory_by_id(&pool, &id).await?;
    events::emit_squad_memory_anchored(app, &item);
    Ok(item)
}

/// 列出某小分队的全部记忆（团队共享 + 成员个人），按引用计数降序、更新时间倒序。
pub async fn list_squad_memories(
    app: &AppHandle,
    squad_id: &str,
) -> Result<Vec<SquadMemoryItem>, String> {
    let pool = get_pool(app).await?;
    let rows = sqlx::query(
        "SELECT * FROM agent_squad_memory WHERE squad_id = ? ORDER BY ref_count DESC, updated_at DESC",
    )
    .bind(squad_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询小分队记忆失败：{e}"))?;
    Ok(rows.iter().map(row_to_squad_item).collect())
}

/// 删除一条小分队记忆（含其事件日志，如有）。
pub async fn delete_squad_memory(app: &AppHandle, id: &str) -> Result<(), String> {
    let pool = get_pool(app).await?;
    sqlx::query("DELETE FROM agent_squad_memory WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| format!("删除小分队记忆失败：{e}"))?;
    let _ = app;
    Ok(())
}

/// 暴露自动召回条数常量给调用方（load_config 注入用）。
pub const fn recall_top() -> usize {
    MEMORY_RECALL_TOP
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_forced_entry ──
    #[test]
    fn validate_rejects_short_key() {
        assert!(validate_forced_entry("a", "decision", "这是一段足够长的记忆内容").is_err());
    }

    #[test]
    fn validate_rejects_short_content() {
        assert!(validate_forced_entry("合法key", "fix", "太短").is_err());
    }

    #[test]
    fn validate_rejects_boilerplate() {
        assert!(validate_forced_entry("任务结果", "other", "已成功完成本次任务的全部步骤").is_err());
        assert!(validate_forced_entry("任务结果", "other", "任务完成，无异常").is_err());
    }

    #[test]
    fn validate_rejects_invalid_category() {
        assert!(validate_forced_entry("合法key", "bogus_cat", "这是一段足够长的记忆内容").is_err());
    }

    #[test]
    fn validate_accepts_legitimate_entry() {
        assert!(validate_forced_entry("用户偏好深色主题", "user_pref", "用户在多次对话中明确表示偏好深色 UI 主题").is_ok());
        assert!(validate_forced_entry("auth-flow", "architecture", "采用 JWT + 刷新令牌双令牌方案，access 15min / refresh 7d").is_ok());
    }

    // ── char_bigrams / overlap_score（recall 字符重排降级链核心）──
    #[test]
    fn bigrams_empty_for_short_string() {
        assert!(char_bigrams("").is_empty());
        assert!(char_bigrams("a").is_empty());
    }

    #[test]
    fn overlap_high_for_related_cjk() {
        // 「用户偏好」与「用户的偏好设定」共享「用户」「户的」「偏好」相关 2-gram，重合高
        let s = overlap_score("用户偏好深色主题", "用户的偏好设定为深色");
        assert!(s >= 2, "相关条应有重合，实际 {s}");
    }

    #[test]
    fn overlap_zero_for_unrelated() {
        let s = overlap_score("认证鉴权流程", "数据库备份策略");
        assert_eq!(s, 0, "无关条应零重合");
    }

    #[test]
    fn overlap_ranks_relevant_above_popular() {
        // 模拟 recall 场景：ref_count 高的无关条 vs ref_count 低的相关条
        // 字符重排后相关条应排在前面（score 更高）
        let prompt = "用户偏好深色主题";
        let popular_unrelated = "数据库索引优化方案"; // 假装 ref_count 高
        let rare_relevant = "用户偏好深色 UI 主题设置";
        let s_unrel = overlap_score(prompt, popular_unrelated);
        let s_rel = overlap_score(prompt, rare_relevant);
        assert!(
            s_rel > s_unrel,
            "相关条 score {s_rel} 应 > 无关条 score {s_unrel}"
        );
    }

    // ── M1 向量召回：scope 谓词 / 嵌入文本 ──
    #[test]
    fn scope_filter_scopes_and_escapes() {
        assert_eq!(scope_filter(None), "scope = 'agent' AND agent_id IS NULL");
        assert_eq!(
            scope_filter(Some("ag1")),
            "scope = 'agent' AND (agent_id IS NULL OR agent_id = 'ag1')"
        );
        // 单引号转义防谓词注入
        assert_eq!(
            scope_filter(Some("a'b")),
            "scope = 'agent' AND (agent_id IS NULL OR agent_id = 'a''b')"
        );
    }

    #[test]
    fn embed_text_joins_key_and_content() {
        assert_eq!(embed_text_of("偏好", "深色主题"), "偏好\n深色主题");
    }
}
