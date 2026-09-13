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

use crate::agent::events;
use crate::agent::round_compactor;

/// 自动召回注入的 top-K 记忆条数（运行时注入系统提示的记忆上限）。
const MEMORY_RECALL_TOP: usize = 5;

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
) -> Result<MemoryItem, String> {
    let pool = get_pool(app).await?;
    let now = now_ms();
    let cat = if category.is_empty() || !MEMORY_CATEGORIES.contains(&category) {
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
    Ok(item)
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
    get_by_id(&pool, id).await
}

/// 删除一条记忆（外键 ON DELETE CASCADE 自动清理其事件日志）。
pub async fn delete_memory(app: &AppHandle, id: &str) -> Result<(), String> {
    let pool = get_pool(app).await?;
    sqlx::query("DELETE FROM agent_memories WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|e| format!("删除记忆失败：{e}"))?;
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

/// 运行时自动召回：从「全局 + 当前 agent」记忆中选取 top-K（ref_count 降序、updated_at 降序），
/// 逐条 ref_count += 1、last_recalled=now、写 `recall` 事件并 emit `memory_recalled`，
/// 然后拼成「记忆宫殿 · 召回」系统提示块返回（无记忆则返回空串）。
///
/// 由 `commands::load_config` 在组装系统提示的尾部注入，使记忆宫殿真正参与任务上下文，
/// 且每次运行自然累积引用计数（驱动热力图）。
pub async fn recall_top_memories(
    app: &AppHandle,
    agent_id: Option<&str>,
    k: usize,
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
    let now = now_ms();
    let rows = match sqlx::query(
        "SELECT * FROM agent_memories WHERE agent_id IS NULL OR agent_id = ? \
         ORDER BY ref_count DESC, updated_at DESC LIMIT ?",
    )
    .bind(agent_id.unwrap_or(""))
    .bind(k as i64)
    .fetch_all(&pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("[memory] recall_top_memories: 查询失败：{e}");
            return (Vec::new(), String::new());
        }
    };
    if rows.is_empty() {
        return (Vec::new(), String::new());
    }

    let mut items: Vec<MemoryItem> = Vec::new();
    let mut block = String::from(
        "### 记忆宫殿 · 召回的长期记忆\n以下是你此前沉淀、本次自动召回的关键记忆，处理任务时应优先参考：\n",
    );
    for row in &rows {
        let id: String = row.try_get("id").unwrap_or_default();
        let key: String = row.try_get("key").unwrap_or_default();
        let content: String = row.try_get("content").unwrap_or_default();
        if let Err(e) = sqlx::query(
            "UPDATE agent_memories SET ref_count = ref_count + 1, last_recalled = ?, updated_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(now)
        .bind(&id)
        .execute(&pool)
        .await
        {
            tracing::warn!("[memory] recall_top_memories: 计数更新失败 {id}：{e}");
        }
        log_event(&pool, &id, "recall", now).await;
        let mut item = row_to_item(row);
        item.ref_count += 1;
        item.last_recalled_at = Some(now);
        events::emit_memory_recalled(app, &item);
        block.push_str(&format!("- [{}] {}\n", key, content));
        items.push(item);
    }
    (items, block)
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
