//! 统一向量存储（设计稿 v2.0 §3）：LanceDB 嵌入式实现。
//!
//! - 目录：`app_config.vector_path`（默认 `$APPDATA/.vectors`，占位符在 Rust 侧解析）；
//! - 四张表：`memories`（L3/小队/蒸馏）/ `artifacts`（L2）/ `kb_chunks`（K1）/
//!   `session_summaries`（L1，可后置）；按首次写入时的向量维度建表；
//! - **失败语义**：open / 建表 / 读写任何一步失败 → 上层降级（关键词重排），不阻塞任务；
//! - SQLite 只存业务元数据；`embedding` / `embedding_model` 权威在本模块。
//!
//! 暂时性 dead_code 允许：本模块为基建层，消费方在 #20260918003（召回管道化）/
//! #20260918005（rerank）/#20260918006（artifacts）/#20260918008（K1）接入；届时移除本 allow。
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use arrow_array::{Array, FixedSizeListArray, Float32Array, Int64Array, RecordBatch, StringArray};
use arrow_buffer::NullBuffer;
use arrow_schema::{DataType, Field, Fields, Schema, SchemaRef};
use lancedb::query::{ExecutableQuery, QueryBase};
use sqlx::Row;
use tauri::{AppHandle, Manager};

/* ---------------- 表枚举与 Schema ---------------- */

/// 向量域四张表（设计稿 §3.2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VectorTable {
    Memories,
    Artifacts,
    KbChunks,
    SessionSummaries,
}

impl VectorTable {
    pub fn name(&self) -> &'static str {
        match self {
            VectorTable::Memories => "memories",
            VectorTable::Artifacts => "artifacts",
            VectorTable::KbChunks => "kb_chunks",
            VectorTable::SessionSummaries => "session_summaries",
        }
    }
}

/// 构建各表 Schema：向量列 = FixedSizeList<f32>(dim)，dim 由首次写入的嵌入决定。
/// 换嵌入模型维度变化 → 由上层 drop 表重建（数据可经关键词模式重嵌，见设计稿 §7）。
pub fn schema_for(table: VectorTable, dim: usize) -> SchemaRef {
    let f32list = DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim as i32);
    let f32list_nullable = true;
    let common_tail = vec![
        Field::new("embedding", f32list.clone(), f32list_nullable),
        Field::new("embedding_model", DataType::Utf8, true),
        Field::new("updated_at", DataType::Int64, false),
    ];
    let mut fields: Vec<Field> = match table {
        VectorTable::Memories => vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("agent_id", DataType::Utf8, true),
            Field::new("project_id", DataType::Utf8, true),
            Field::new("session_id", DataType::Utf8, true),
            Field::new("scope", DataType::Utf8, false),
            Field::new("key", DataType::Utf8, false),
            Field::new("content", DataType::Utf8, false),
            Field::new("category", DataType::Utf8, false),
        ],
        VectorTable::Artifacts => vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("project_id", DataType::Utf8, false),
            Field::new("path", DataType::Utf8, false),
            Field::new("heading", DataType::Utf8, true),
            Field::new("content", DataType::Utf8, false),
            Field::new("content_digest", DataType::Utf8, false),
        ],
        VectorTable::KbChunks => vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("kb_id", DataType::Utf8, false),
            Field::new("asset_id", DataType::Utf8, false),
            Field::new("path", DataType::Utf8, false),
            Field::new("heading", DataType::Utf8, true),
            Field::new("chunk_index", DataType::Int32, false),
            Field::new("content", DataType::Utf8, false),
            Field::new("content_digest", DataType::Utf8, false),
        ],
        VectorTable::SessionSummaries => vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("agent_id", DataType::Utf8, true),
            Field::new("session_id", DataType::Utf8, false),
            Field::new("project_id", DataType::Utf8, true),
            Field::new("summary", DataType::Utf8, false),
        ],
    };
    fields.extend(common_tail);
    Arc::new(Schema::new(Fields::from(fields)))
}

/* ---------------- 行模型（memories） ---------------- */

/// `memories` 表一行（与 `agent_memories` 元数据一一对应，向量仅在 Lance）。
#[derive(Debug, Clone)]
pub struct MemoryVectorRow {
    pub id: String,
    pub agent_id: Option<String>,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    /// palace / squad / distilled
    pub scope: String,
    pub key: String,
    pub content: String,
    pub category: String,
    pub embedding: Option<Vec<f32>>,
    pub embedding_model: Option<String>,
    pub updated_at: i64,
}

/// 检索命中（id + 距离；上层回 SQLite 补元数据）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorHit {
    pub id: String,
    /// LanceDB `_distance`（L2 距离，越小越相似）
    pub score: f32,
}

/* ---------------- 实现 ---------------- */

pub struct LanceDbVectorStore {
    conn: lancedb::Connection,
}

impl LanceDbVectorStore {
    /// 打开（或创建）LanceDB 数据库根目录。
    pub async fn open(path: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(path).map_err(|e| format!("创建向量目录失败：{e}"))?;
        let conn = lancedb::connect(path.to_string_lossy().as_ref())
            .execute()
            .await
            .map_err(|e| format!("连接 LanceDB 失败：{e}"))?;
        Ok(Self { conn })
    }

    /// 已存在的表名列表。
    pub async fn table_names(&self) -> Result<Vec<String>, String> {
        self.conn
            .table_names()
            .execute()
            .await
            .map_err(|e| format!("列出 LanceDB 表失败：{e}"))
    }

    /// 惰性建表：不存在时按 dim 创建空表（幂等）。
    pub async fn ensure_table(&self, table: VectorTable, dim: usize) -> Result<(), String> {
        let names = self.table_names().await?;
        if names.iter().any(|n| n == table.name()) {
            return Ok(());
        }
        self.conn
            .create_empty_table(table.name(), schema_for(table, dim))
            .execute()
            .await
            .map_err(|e| format!("创建 LanceDB 表 {} 失败：{e}", table.name()))?;
        tracing::info!("[vector] 已创建 LanceDB 表 {}（dim={dim}）", table.name());
        Ok(())
    }

    async fn table_ref(&self, table: VectorTable) -> Result<lancedb::table::Table, String> {
        self.conn
            .open_table(table.name())
            .execute()
            .await
            .map_err(|e| format!("打开 LanceDB 表 {} 失败：{e}", table.name()))
    }

    /// upsert `memories`（按 id merge：存在则更新，不存在则插入）。
    /// 维度不一致 / Lance 失败返回 Err，上层降级并记日志。
    pub async fn upsert_memories(&self, rows: &[MemoryVectorRow]) -> Result<(), String> {
        let Some(dim) = rows.iter().find_map(|r| r.embedding.as_ref().map(|v| v.len())) else {
            return Ok(()); // 全部无向量：本批无内容可写（元数据在 SQLite），跳过
        };
        self.ensure_table(VectorTable::Memories, dim).await?;
        let table = self.table_ref(VectorTable::Memories).await?;

        let mut flat: Vec<f32> = Vec::with_capacity(rows.len() * dim);
        let mut nulls: Vec<bool> = Vec::with_capacity(rows.len());
        for r in rows {
            match &r.embedding {
                Some(v) if v.len() == dim => {
                    flat.extend_from_slice(v);
                    nulls.push(true);
                }
                _ => {
                    flat.extend(std::iter::repeat(0.0f32).take(dim));
                    nulls.push(false);
                }
            }
        }
        let values = Float32Array::from(flat);
        let embedding = FixedSizeListArray::new(
            Arc::new(Field::new("item", DataType::Float32, true)),
            dim as i32,
            Arc::new(values),
            Some(NullBuffer::from(nulls)),
        );

        let batch = RecordBatch::try_new(
            schema_for(VectorTable::Memories, dim),
            vec![
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.agent_id.as_deref()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.project_id.as_deref()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.session_id.as_deref()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.scope.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.content.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.category.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(embedding),
                Arc::new(StringArray::from(
                    rows.iter()
                        .map(|r| r.embedding_model.as_deref())
                        .collect::<Vec<_>>(),
                )),
                Arc::new(Int64Array::from(
                    rows.iter().map(|r| r.updated_at).collect::<Vec<_>>(),
                )),
            ],
        )
        .map_err(|e| format!("构建 memories 记录批失败：{e}"))?;

        let schema = batch.schema();
        let reader = arrow_array::RecordBatchIterator::new(vec![Ok(batch)], schema);
        let mut merge = table.merge_insert(&["id"]);
        merge
            .when_matched_update_all(None)
            .when_not_matched_insert_all();
        merge
            .execute(Box::new(reader))
            .await
            .map_err(|e| format!("LanceDB upsert memories 失败：{e}"))?;
        Ok(())
    }

    /// 向量检索（标量谓词先滤再向量，防多智能体串记忆）。
    /// 返回 (id, _distance)，按距离升序。失败 = Err（上层降级）。
    pub async fn search_memories(
        &self,
        query: &[f32],
        filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<VectorHit>, String> {
        let table = self.table_ref(VectorTable::Memories).await?;
        let mut vq = table
            .query()
            .nearest_to(query.to_vec())
            .map_err(|e| format!("构建向量查询失败：{e}"))?;
        if let Some(f) = filter {
            vq = vq.only_if(f);
        }
        let batches = vq
            .limit(limit)
            .execute()
            .await
            .map_err(|e| format!("LanceDB 向量检索失败：{e}"))?;

        let mut hits = Vec::new();
        use futures_util::StreamExt;
        let mut stream = batches;
        while let Some(batch) = stream.next().await {
            let batch = batch.map_err(|e| format!("读取检索结果失败：{e}"))?;
            let ids = batch
                .column_by_name("id")
                .ok_or("检索结果缺 id 列")?
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or("id 列类型异常")?;
            let dist = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
                .map(|a| a.values().to_vec());
            for i in 0..ids.len() {
                let score = dist
                    .as_ref()
                    .and_then(|d| d.get(i).copied())
                    .unwrap_or(f32::MAX);
                hits.push(VectorHit {
                    id: ids.value(i).to_string(),
                    score,
                });
            }
        }
        Ok(hits)
    }

    /// 按向量 id 集合删除（`id IN (...)`）。
    pub async fn delete_memories(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let list = ids
            .iter()
            .map(|i| format!("'{}'", i.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(", ");
        let table = self.table_ref(VectorTable::Memories).await?;
        table
            .delete(&format!("id IN ({list})"))
            .await
            .map(|_| ())
            .map_err(|e| format!("LanceDB 删除失败：{e}"))
    }

    /// 通用按谓词删除（表内全量清理 / 级联删除用）。
    pub async fn delete_by_filter(&self, table: VectorTable, filter: &str) -> Result<(), String> {
        let t = self.table_ref(table).await?;
        t.delete(filter)
            .await
            .map(|_| ())
            .map_err(|e| format!("LanceDB 按谓词删除失败：{e}"))
    }
}

/* ---------------- 全局单例（懒连接 + 迁移重开） ---------------- */

static SHARED: tokio::sync::RwLock<Option<Arc<LanceDbVectorStore>>> =
    tokio::sync::RwLock::const_new(None);

/// 解析 `vector_path`：读取 app_config 并解析 `$APPDATA` / `$RESOURCE` 占位符
/// （与前端 storage-path.ts 同语义；已为真实路径时原样返回）。
pub async fn resolve_vector_path(app: &AppHandle) -> Result<PathBuf, String> {
    let pool = crate::agent::round_compactor::get_pool(app).await?;
    let raw: Option<String> =
        sqlx::query("SELECT value FROM app_config WHERE key = 'vector_path'")
            .fetch_optional(&pool)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|r| r.try_get::<Option<String>, _>("value").ok().flatten());
    let raw = raw.unwrap_or_else(|| "$APPDATA/.vectors".to_string());
    resolve_placeholder(app, &raw).await
}

async fn resolve_placeholder(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
    if raw.contains("$APPDATA") {
        let base = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("解析应用数据目录失败：{e}"))?;
        return Ok(PathBuf::from(raw.replace("$APPDATA", &base.to_string_lossy())));
    }
    if raw.contains("$RESOURCE") {
        let base = app
            .path()
            .resource_dir()
            .map_err(|e| format!("解析资源目录失败：{e}"))?;
        return Ok(PathBuf::from(raw.replace("$RESOURCE", &base.to_string_lossy())));
    }
    Ok(PathBuf::from(raw))
}

/// 取全局共享连接（首用懒初始化；失败返回 None = 降级模式）。
pub async fn get_shared(app: &AppHandle) -> Option<Arc<LanceDbVectorStore>> {
    {
        let g = SHARED.read().await;
        if let Some(s) = g.as_ref() {
            return Some(s.clone());
        }
    }
    let path = match resolve_vector_path(app).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("[vector] 解析 vector_path 失败，向量检索降级：{e}");
            return None;
        }
    };
    match LanceDbVectorStore::open(&path).await {
        Ok(s) => {
            tracing::info!("[vector] LanceDB 已连接：{}", path.display());
            let arc = Arc::new(s);
            *SHARED.write().await = Some(arc.clone());
            Some(arc)
        }
        Err(e) => {
            tracing::error!("[vector] LanceDB 打开失败（{}），向量检索降级：{e}", path.display());
            None
        }
    }
}

/// 关闭并清空共享连接（目录迁移后由 set_vector_path 调用，随后重新 get_shared 重开）。
pub async fn reset_shared() {
    *SHARED.write().await = None;
}

/* ---------------- Tauri 命令（设置页消费） ---------------- */

/// 向量库状态（设置页展示：路径 / 连接态 / 表清单 / 嵌入模型摘要）。
/// 嵌入调用统计（app_config 计数，embedding.rs 埋点写入）。
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingStats {
    pub calls: u64,
    pub texts: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorStatus {
    pub path: String,
    pub connected: bool,
    pub tables: Vec<String>,
    pub embedding: Option<crate::agent::embedding::EmbeddingConfig>,
    /// 嵌入调用累计统计（#20260918004 设置页展示）。
    pub stats: EmbeddingStats,
}

/// 读取 app_config 计数键（best-effort：缺失/非数字一律 0）。
async fn read_stat(pool: &sqlx::SqlitePool, key: &str) -> u64 {
    match sqlx::query("SELECT value FROM app_config WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
    {
        Ok(Some(r)) => r
            .try_get::<String, _>("value")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0),
        _ => 0,
    }
}

#[tauri::command]
pub async fn vector_status(app: AppHandle) -> Result<VectorStatus, String> {
    let pool = crate::agent::round_compactor::get_pool(&app).await?;
    let path = resolve_vector_path(&app).await?;
    let (connected, tables) = match get_shared(&app).await {
        Some(s) => (true, s.table_names().await.unwrap_or_default()),
        None => (false, Vec::new()),
    };
    let embedding = crate::agent::embedding::load_default_embedding(&pool).await?;
    // 统计键 best-effort 读取（未埋点过=默认 0）
    let calls = read_stat(&pool, "embedding_call_count").await;
    let texts = read_stat(&pool, "embedding_text_count").await;
    let stats = EmbeddingStats { calls, texts };
    Ok(VectorStatus {
        path: path.to_string_lossy().to_string(),
        connected,
        tables,
        embedding,
        stats,
    })
}

/// 变更向量库目录（设置页迁移）：close → move → 更新配置 → reopen。
/// 前端传入的是用户选择并补齐 `.vectors` 后的真实路径。
#[tauri::command]
pub async fn set_vector_path(
    app: AppHandle,
    new_path: String,
) -> Result<crate::fs_helper::MigrateReport, String> {
    let old_real = resolve_vector_path(&app).await?;
    let new_real = PathBuf::from(new_path.trim().replace('\\', "/"));
    // close：先弃用共享连接，避免文件占用
    reset_shared().await;
    let report = crate::fs_helper::migrate_storage_dir(
        old_real.to_string_lossy().to_string(),
        new_real.to_string_lossy().to_string(),
    )?;
    // 更新 app_config（存真实路径，与 Skill/KB 目录行的落库口径一致）
    let pool = crate::agent::round_compactor::get_pool(&app).await?;
    sqlx::query("INSERT INTO app_config (key, value) VALUES ('vector_path', ?) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(new_real.to_string_lossy().to_string())
        .execute(&pool)
        .await
        .map_err(|e| format!("写入 vector_path 失败：{e}"))?;
    // reopen：立即验证新目录可用（失败则标记降级，不回滚旧目录——数据已搬）
    match LanceDbVectorStore::open(&new_real).await {
        Ok(s) => {
            *SHARED.write().await = Some(Arc::new(s));
            tracing::info!("[vector] 向量库目录已迁移并重连：{}", new_real.display());
        }
        Err(e) => {
            tracing::error!("[vector] 迁移后重连失败，向量检索降级：{e}");
        }
    }
    Ok(report)
}

/* ---------------- 单测：临时目录端到端（open → upsert → search → filter → delete） ---------------- */
#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    fn row(
        id: &str,
        agent_id: Option<&str>,
        scope: &str,
        key: &str,
        content: &str,
        v: Option<Vec<f32>>,
    ) -> MemoryVectorRow {
        MemoryVectorRow {
            id: id.into(),
            agent_id: agent_id.map(|s| s.into()),
            project_id: None,
            session_id: None,
            scope: scope.into(),
            key: key.into(),
            content: content.into(),
            category: "decision".into(),
            embedding_model: v.as_ref().map(|_| "test-model".into()),
            embedding: v,
            updated_at: 1,
        }
    }

    #[tokio::test]
    async fn lance_e2e_upsert_search_delete() {
        let dir = std::env::temp_dir().join(format!(
            "workduo-vtest-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = LanceDbVectorStore::open(&dir).await.expect("open");

        // 空库：table_names 不含 memories
        assert!(!store
            .table_names()
            .await
            .unwrap()
            .iter()
            .any(|n| n == "memories"));

        // upsert：agent-a 两条正交向量，agent-b 一条
        let va = vec![1.0, 0.0, 0.0];
        let vb = vec![0.0, 1.0, 0.0];
        store
            .upsert_memories(&[
                row("m1", Some("agent-a"), "palace", "偏好", "用户偏好 Rust", Some(va.clone())),
                row(
                    "m2",
                    Some("agent-a"),
                    "palace",
                    "架构",
                    "架构分层 L0/L2",
                    Some(vec![0.0, 0.0, 1.0]),
                ),
                row("m3", Some("agent-b"), "palace", "偏好", "用户偏好 Go", Some(vb)),
            ])
            .await
            .expect("upsert");
        // merge 幂等：重复 upsert 不产生新行
        store
            .upsert_memories(&[row(
                "m1",
                Some("agent-a"),
                "palace",
                "偏好",
                "用户偏好 Rust",
                Some(va.clone()),
            )])
            .await
            .expect("upsert2");

        // 向量检索：query=va 且过滤 agent-a → 最近邻应为 m1（正交向量中与 va 同向）
        let hits = store
            .search_memories(
                &va,
                Some("agent_id = 'agent-a' AND scope = 'palace'"),
                5,
            )
            .await
            .expect("search");
        assert!(!hits.is_empty(), "应有命中");
        assert_eq!(
            hits[0].id,
            "m1",
            "最近邻应为 m1，实际 {:?}",
            hits.iter().map(|h| h.id.clone()).collect::<Vec<_>>()
        );
        assert!(
            hits.iter().all(|h| h.id != "m3"),
            "过滤 agent-b 后不应命中 m3"
        );

        // 无向量行的 upsert：仅元数据更新，向量列置 null（dim 取自已建表的首批写入）
        store
            .upsert_memories(&[row(
                "m1",
                Some("agent-a"),
                "palace",
                "偏好",
                "用户偏好 Rust（更新）",
                None,
            )])
            .await
            .expect("upsert-null-vec");

        // 删除 + 过滤检索为空
        store
            .delete_memories(&["m1".into(), "m2".into()])
            .await
            .expect("delete");
        let hits2 = store
            .search_memories(&va, Some("agent_id = 'agent-a'"), 5)
            .await
            .expect("search2");
        assert!(hits2.iter().all(|h| h.id != "m1" && h.id != "m2"));

        // 清理临时目录
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schemas_have_expected_columns() {
        let s = schema_for(VectorTable::Memories, 4);
        let names: Vec<_> = s.fields.iter().map(|f| f.name().to_string()).collect();
        assert_eq!(
            names,
            vec![
                "id",
                "agent_id",
                "project_id",
                "session_id",
                "scope",
                "key",
                "content",
                "category",
                "embedding",
                "embedding_model",
                "updated_at"
            ]
        );
        let s2 = schema_for(VectorTable::KbChunks, 4);
        let names2: Vec<_> = s2.fields.iter().map(|f| f.name().to_string()).collect();
        assert!(
            names2.contains(&"kb_id".to_string())
                && names2.contains(&"chunk_index".to_string())
        );
    }
}

