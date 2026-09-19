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
        // K1'（第四期设计稿 §2.1）：kb_chunks v2 通用 chunk 表。
        // 相比 M1 版新增 type/raw_text/breadcrumbs/page_idx/bbox/origin_file_path/meta_data；
        // heading 并入 path/breadcrumbs 后移除。page_idx/bbox 为 JSON 数组字符串
        // （v1 TXT/MD 恒空占位，将来接入 MinerU 类解析器直接填充，表结构零改动）。
        VectorTable::KbChunks => vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("kb_id", DataType::Utf8, false),
            Field::new("asset_id", DataType::Utf8, false),
            Field::new("chunk_index", DataType::Int32, false),
            Field::new("type", DataType::Utf8, false),
            Field::new("raw_text", DataType::Utf8, false),
            Field::new("content", DataType::Utf8, false),
            Field::new("path", DataType::Utf8, false),
            Field::new("breadcrumbs", DataType::Utf8, true),
            Field::new("page_idx", DataType::Utf8, true),
            Field::new("bbox", DataType::Utf8, true),
            Field::new("origin_file_path", DataType::Utf8, false),
            Field::new("meta_data", DataType::Utf8, true),
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

/// `artifacts` 表一行：L2 `.wd_mem/artifacts` 分节片段（#20260918006）。
/// 与 memories 不同——内容权威就在 Lance（无 SQLite 对应表），检索结果直接取列。
/// id = `{path}#{section_index}`；content_digest = 文件级摘要（同文件各节共享，
/// 用于「digest 未变跳过重嵌」的增量判定）。
#[derive(Debug, Clone)]
pub struct ArtifactVectorRow {
    pub id: String,
    /// 隔离键：工程绑定的工作空间路径（同 workspace 多 agent 共享知识资产）。
    pub project_id: String,
    /// `.wd_mem` 下相对路径（如 `.wd_mem/artifacts/auth-flow.md`）。
    pub path: String,
    /// 分节标题（无标题文件 = None）。
    pub heading: Option<String>,
    pub content: String,
    pub content_digest: String,
    pub embedding: Option<Vec<f32>>,
    pub embedding_model: Option<String>,
    pub updated_at: i64,
}

/// artifacts 检索命中：id/距离之外直接带内容列（Lance 内联，无需回查元数据）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHit {
    pub id: String,
    pub path: String,
    pub heading: Option<String>,
    pub content: String,
    /// LanceDB `_distance`（越小越相似）
    pub score: f32,
}

/// `kb_chunks` 表一行（K1' 第四期设计稿 §2.1）：知识库资产切块的向量域行。
/// id = `{asset_id}#{chunk_index}`；content_digest = 文件级摘要（同资产各 chunk 共享）。
/// `chunk_type` 对应 Lance 列名 `type`（Rust 关键字回避）；page_idx/bbox 为 JSON 数组
/// 字符串占位（v1 TXT/MD 恒空，MinerU 类解析器接入后填充）。
#[derive(Debug, Clone)]
pub struct KbChunkVectorRow {
    pub id: String,
    pub kb_id: String,
    pub asset_id: String,
    pub chunk_index: i32,
    pub chunk_type: String,
    pub raw_text: String,
    pub content: String,
    pub path: String,
    pub breadcrumbs: Option<String>,
    pub page_idx: Option<String>,
    pub bbox: Option<String>,
    pub origin_file_path: String,
    pub meta_data: Option<String>,
    pub content_digest: String,
    pub embedding: Option<Vec<f32>>,
    pub embedding_model: Option<String>,
    pub updated_at: i64,
}

/// kb_chunks 检索命中（K2' `native__kb_search` 消费；内容列 Lance 内联直接取）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbChunkHit {
    pub id: String,
    pub kb_id: String,
    pub asset_id: String,
    pub chunk_index: i32,
    pub chunk_type: String,
    pub content: String,
    pub path: String,
    pub breadcrumbs: Option<String>,
    pub origin_file_path: String,
    /// LanceDB `_distance`（越小越相似）
    pub score: f32,
}

/// 资产级索引信息（增量判定用）：Lance 中该资产任一 chunk 的文件 digest 与源路径。
#[derive(Debug, Clone)]
pub struct KbAssetIndexInfo {
    pub digest: String,
    pub origin_file_path: String,
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

    /// upsert `artifacts`（按 id merge：`{path}#{section_index}` 幂等）。
    pub async fn upsert_artifacts(&self, rows: &[ArtifactVectorRow]) -> Result<(), String> {
        let Some(dim) = rows.iter().find_map(|r| r.embedding.as_ref().map(|v| v.len())) else {
            return Ok(()); // 全部无向量：无内容可写，跳过
        };
        self.ensure_table(VectorTable::Artifacts, dim).await?;
        let table = self.table_ref(VectorTable::Artifacts).await?;

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
            schema_for(VectorTable::Artifacts, dim),
            vec![
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.project_id.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.heading.as_deref()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.content.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter()
                        .map(|r| r.content_digest.as_str())
                        .collect::<Vec<_>>(),
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
        .map_err(|e| format!("构建 artifacts 记录批失败：{e}"))?;

        let schema = batch.schema();
        let reader = arrow_array::RecordBatchIterator::new(vec![Ok(batch)], schema);
        let mut merge = table.merge_insert(&["id"]);
        merge
            .when_matched_update_all(None)
            .when_not_matched_insert_all();
        merge
            .execute(Box::new(reader))
            .await
            .map_err(|e| format!("LanceDB upsert artifacts 失败：{e}"))?;
        Ok(())
    }

    /// artifacts 向量检索：标量谓词（project_id）先滤再向量；返回内容列（Lance 内联）。
    pub async fn search_artifacts(
        &self,
        query: &[f32],
        filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<ArtifactHit>, String> {
        let table = self.table_ref(VectorTable::Artifacts).await?;
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
            .map_err(|e| format!("LanceDB artifacts 检索失败：{e}"))?;

        let mut hits = Vec::new();
        use futures_util::StreamExt;
        let mut stream = batches;
        while let Some(batch) = stream.next().await {
            let batch = batch.map_err(|e| format!("读取检索结果失败：{e}"))?;
            let col_str = |name: &str| -> Option<Vec<Option<String>>> {
                batch
                    .column_by_name(name)
                    .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                    .map(|a| {
                        // heading 等列可空：null 必须显式判（StringArray::value 对 null 行是未定义行为）
                        (0..a.len())
                            .map(|i| (!a.is_null(i)).then(|| a.value(i).to_string()))
                            .collect()
                    })
            };
            let ids = col_str("id").ok_or("检索结果缺 id 列")?;
            let paths = col_str("path").ok_or("检索结果缺 path 列")?;
            let headings = col_str("heading");
            let contents = col_str("content").ok_or("检索结果缺 content 列")?;
            let dist = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
                .map(|a| a.values().to_vec());
            for i in 0..ids.len() {
                let score = dist
                    .as_ref()
                    .and_then(|d| d.get(i).copied())
                    .unwrap_or(f32::MAX);
                hits.push(ArtifactHit {
                    // col_str 产 Vec<Option<String>>（null 列显式 None）：get(i).cloned() 得
                    // Option<Option<String>>，flatten 后 unwrap_or_default 回落到空串。
                    id: ids.get(i).cloned().flatten().unwrap_or_default(),
                    path: paths.get(i).cloned().flatten().unwrap_or_default(),
                    heading: headings.as_ref().and_then(|h| h.get(i).cloned()).flatten(),
                    content: contents.get(i).cloned().flatten().unwrap_or_default(),
                    score,
                });
            }
        }
        Ok(hits)
    }

    /// 无向量条件查询：取命中过滤条件的任意一行 `content_digest`。
    /// artifacts 按文件级 digest 增量：所有节共享同一文件 digest，取一行即知整文件是否变更。
    /// 表不存在 / 无命中 = Ok(None)（调用方据此走全量写入路径，表由 upsert 惰性创建）。
    pub async fn query_artifact_file_digest(
        &self,
        filter: &str,
    ) -> Result<Option<String>, String> {
        // 先查表存在性：新库 / 首次索引时 artifacts 表尚不存在，必须视为 Ok(None)
        // 走全量写入（此前直接 open 表返回 Err，导致首次归档索引链整体断裂——006 真机首测实锤）。
        let names = self.table_names().await?;
        if !names.iter().any(|n| n == VectorTable::Artifacts.name()) {
            return Ok(None);
        }
        let table = self.table_ref(VectorTable::Artifacts).await?;
        let batches = table
            .query()
            .only_if(filter)
            .limit(1)
            .execute()
            .await
            .map_err(|e| format!("LanceDB artifacts digest 查询失败：{e}"))?;
        use futures_util::StreamExt;
        let mut stream = batches;
        while let Some(batch) = stream.next().await {
            let batch = batch.map_err(|e| format!("读取 digest 查询结果失败：{e}"))?;
            if batch.num_rows() == 0 {
                continue;
            }
            let digest = batch
                .column_by_name("content_digest")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .and_then(|a| (a.len() > 0).then(|| a.value(0).to_string()));
            return Ok(digest);
        }
        Ok(None)
    }

    /// upsert `kb_chunks`（K1'：按 id merge，`{asset_id}#{chunk_index}` 幂等）。
    /// `dim` 由调用方提供（嵌入探测值或 `app_config.kb_embed_dim` 表级记录）：
    /// - 行携带向量 → 校验维度一致（不一致 = 模型已换而表未重建，显式 Err 提示走 rebuild）；
    /// - 行全部无向量（嵌入未配置的占位写入）→ 直接复用传入 dim 建表/写 null 向量行。
    pub async fn upsert_kb_chunks(
        &self,
        rows: &[KbChunkVectorRow],
        dim: usize,
    ) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        for r in rows {
            if let Some(v) = &r.embedding {
                if v.len() != dim {
                    return Err(format!(
                        "kb_chunks 向量维度不匹配（期望 {dim}，实得 {}）——嵌入模型已更换，请执行知识库重建索引",
                        v.len()
                    ));
                }
            }
        }
        self.ensure_table(VectorTable::KbChunks, dim).await?;
        let table = self.table_ref(VectorTable::KbChunks).await?;

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
            schema_for(VectorTable::KbChunks, dim),
            vec![
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.kb_id.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.asset_id.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(arrow_array::Int32Array::from(
                    rows.iter().map(|r| r.chunk_index).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.chunk_type.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.raw_text.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.content.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.breadcrumbs.as_deref()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.page_idx.as_deref()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.bbox.as_deref()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter()
                        .map(|r| r.origin_file_path.as_str())
                        .collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter().map(|r| r.meta_data.as_deref()).collect::<Vec<_>>(),
                )),
                Arc::new(StringArray::from(
                    rows.iter()
                        .map(|r| r.content_digest.as_str())
                        .collect::<Vec<_>>(),
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
        .map_err(|e| format!("构建 kb_chunks 记录批失败：{e}"))?;

        let schema = batch.schema();
        let reader = arrow_array::RecordBatchIterator::new(vec![Ok(batch)], schema);
        let mut merge = table.merge_insert(&["id"]);
        merge
            .when_matched_update_all(None)
            .when_not_matched_insert_all();
        merge
            .execute(Box::new(reader))
            .await
            .map_err(|e| format!("LanceDB upsert kb_chunks 失败：{e}"))?;
        Ok(())
    }

    /// kb_chunks 向量检索：标量谓词（kb_id / asset_id 集合）先滤再向量，内容列内联返回。
    pub async fn search_kb_chunks(
        &self,
        query: &[f32],
        filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<KbChunkHit>, String> {
        let table = self.table_ref(VectorTable::KbChunks).await?;
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
            .map_err(|e| format!("LanceDB kb_chunks 检索失败：{e}"))?;

        let mut hits = Vec::new();
        use futures_util::StreamExt;
        let mut stream = batches;
        while let Some(batch) = stream.next().await {
            let batch = batch.map_err(|e| format!("读取检索结果失败：{e}"))?;
            let col_str = |name: &str| -> Option<Vec<Option<String>>> {
                batch
                    .column_by_name(name)
                    .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                    .map(|a| {
                        (0..a.len())
                            .map(|i| (!a.is_null(i)).then(|| a.value(i).to_string()))
                            .collect()
                    })
            };
            let ids = col_str("id").ok_or("检索结果缺 id 列")?;
            let kb_ids = col_str("kb_id").ok_or("检索结果缺 kb_id 列")?;
            let asset_ids = col_str("asset_id").ok_or("检索结果缺 asset_id 列")?;
            let idx = batch
                .column_by_name("chunk_index")
                .and_then(|c| c.as_any().downcast_ref::<arrow_array::Int32Array>())
                .map(|a| a.values().to_vec());
            let types = col_str("type").ok_or("检索结果缺 type 列")?;
            let contents = col_str("content").ok_or("检索结果缺 content 列")?;
            let paths = col_str("path").ok_or("检索结果缺 path 列")?;
            let breadcrumbs = col_str("breadcrumbs");
            let origin_paths = col_str("origin_file_path");
            let dist = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
                .map(|a| a.values().to_vec());
            for i in 0..ids.len() {
                let score = dist
                    .as_ref()
                    .and_then(|d| d.get(i).copied())
                    .unwrap_or(f32::MAX);
                hits.push(KbChunkHit {
                    id: ids.get(i).cloned().flatten().unwrap_or_default(),
                    kb_id: kb_ids.get(i).cloned().flatten().unwrap_or_default(),
                    asset_id: asset_ids.get(i).cloned().flatten().unwrap_or_default(),
                    chunk_index: idx.as_ref().and_then(|v| v.get(i).copied()).unwrap_or(0),
                    chunk_type: types.get(i).cloned().flatten().unwrap_or_default(),
                    content: contents.get(i).cloned().flatten().unwrap_or_default(),
                    path: paths.get(i).cloned().flatten().unwrap_or_default(),
                    breadcrumbs: breadcrumbs
                        .as_ref()
                        .and_then(|b| b.get(i).cloned())
                        .flatten(),
                    origin_file_path: origin_paths
                        .as_ref()
                        .and_then(|o| o.get(i).cloned())
                        .flatten()
                        .unwrap_or_default(),
                    score,
                });
            }
        }
        Ok(hits)
    }

    /// 无向量条件查询：取该资产任一 chunk 的（文件 digest, origin_file_path）。
    /// 增量判定：digest 相同且路径相同 → 跳过；路径变化（改名/移动）→ 重写刷新元数据。
    /// 表不存在 / 无命中 = Ok(None)（调用方据此走全量写入路径，表由 upsert 惰性创建；
    /// 006 教训：必须先把「表不存在」当空结果，否则首次索引链整体断裂）。
    pub async fn query_kb_asset_digest(
        &self,
        filter: &str,
    ) -> Result<Option<KbAssetIndexInfo>, String> {
        let names = self.table_names().await?;
        if !names.iter().any(|n| n == VectorTable::KbChunks.name()) {
            return Ok(None);
        }
        let table = self.table_ref(VectorTable::KbChunks).await?;
        let batches = table
            .query()
            .only_if(filter)
            .limit(1)
            .execute()
            .await
            .map_err(|e| format!("LanceDB kb_chunks digest 查询失败：{e}"))?;
        use futures_util::StreamExt;
        let mut stream = batches;
        while let Some(batch) = stream.next().await {
            let batch = batch.map_err(|e| format!("读取 digest 查询结果失败：{e}"))?;
            if batch.num_rows() == 0 {
                continue;
            }
            let read_str = |name: &str| -> Option<String> {
                batch
                    .column_by_name(name)
                    .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                    .and_then(|a| (a.len() > 0).then(|| a.value(0).to_string()))
            };
            return Ok(Some(KbAssetIndexInfo {
                digest: read_str("content_digest").unwrap_or_default(),
                origin_file_path: read_str("origin_file_path").unwrap_or_default(),
            }));
        }
        Ok(None)
    }

    /// 关键词降级查询（K2 检索管道通道二）：无向量、纯标量谓词（LIKE 由调用方拼入 filter）。
    /// 表不存在 = Ok(空)（幂等）。score 恒 -1.0（无距离语义）。
    pub async fn query_kb_chunks_by_keyword(
        &self,
        filter: &str,
        limit: usize,
    ) -> Result<Vec<KbChunkHit>, String> {
        let names = self.table_names().await?;
        if !names.iter().any(|n| n == VectorTable::KbChunks.name()) {
            return Ok(Vec::new());
        }
        let table = self.table_ref(VectorTable::KbChunks).await?;
        let batches = table
            .query()
            .only_if(filter)
            .limit(limit)
            .execute()
            .await
            .map_err(|e| format!("LanceDB kb_chunks 关键词查询失败：{e}"))?;

        let mut hits = Vec::new();
        use futures_util::StreamExt;
        let mut stream = batches;
        while let Some(batch) = stream.next().await {
            let batch = batch.map_err(|e| format!("读取关键词查询结果失败：{e}"))?;
            let col_str = |name: &str| -> Option<Vec<Option<String>>> {
                batch
                    .column_by_name(name)
                    .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                    .map(|a| {
                        (0..a.len())
                            .map(|i| (!a.is_null(i)).then(|| a.value(i).to_string()))
                            .collect()
                    })
            };
            let ids = col_str("id").ok_or("查询结果缺 id 列")?;
            let kb_ids = col_str("kb_id").ok_or("查询结果缺 kb_id 列")?;
            let asset_ids = col_str("asset_id").ok_or("查询结果缺 asset_id 列")?;
            let idx = batch
                .column_by_name("chunk_index")
                .and_then(|c| c.as_any().downcast_ref::<arrow_array::Int32Array>())
                .map(|a| a.values().to_vec());
            let types = col_str("type").ok_or("查询结果缺 type 列")?;
            let contents = col_str("content").ok_or("查询结果缺 content 列")?;
            let paths = col_str("path").ok_or("查询结果缺 path 列")?;
            let breadcrumbs = col_str("breadcrumbs");
            let origin_paths = col_str("origin_file_path");
            for i in 0..ids.len() {
                hits.push(KbChunkHit {
                    id: ids.get(i).cloned().flatten().unwrap_or_default(),
                    kb_id: kb_ids.get(i).cloned().flatten().unwrap_or_default(),
                    asset_id: asset_ids.get(i).cloned().flatten().unwrap_or_default(),
                    chunk_index: idx.as_ref().and_then(|v| v.get(i).copied()).unwrap_or(0),
                    chunk_type: types.get(i).cloned().flatten().unwrap_or_default(),
                    content: contents.get(i).cloned().flatten().unwrap_or_default(),
                    path: paths.get(i).cloned().flatten().unwrap_or_default(),
                    breadcrumbs: breadcrumbs
                        .as_ref()
                        .and_then(|b| b.get(i).cloned())
                        .flatten(),
                    origin_file_path: origin_paths
                        .as_ref()
                        .and_then(|o| o.get(i).cloned())
                        .flatten()
                        .unwrap_or_default(),
                    score: -1.0,
                });
            }
        }
        Ok(hits)
    }

    /// 删除整张表（K1' schema 迁移 / 维度变化重建用）。表不存在时幂等 Ok。
    pub async fn drop_table(&self, name: &str) -> Result<(), String> {
        let names = self.table_names().await?;
        if !names.iter().any(|n| n == name) {
            return Ok(());
        }
        self.conn
            .drop_table(name, &[])
            .await
            .map_err(|e| format!("LanceDB 删除表 {name} 失败：{e}"))
    }

    /// 通用按谓词删除（表内全量清理 / 级联删除用）。
    /// 表不存在 = 幂等 Ok（006 教训推广：新库首次索引链中「先删旧段」不得因表未建而断裂——
    /// 2026-09-19 真机实锤：重建 force 路径跳过 digest 查询直接删除，表刚被 schema 迁移
    /// 清除时 here 崩溃导致整轮重建失败）。
    pub async fn delete_by_filter(&self, table: VectorTable, filter: &str) -> Result<(), String> {
        let names = self.table_names().await?;
        if !names.iter().any(|n| n == table.name()) {
            return Ok(());
        }
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
        // K1' v2 通用 chunk 表：必须包含用户拍板的必备列（asset_id / meta_data / type 等）
        for col in [
            "id",
            "kb_id",
            "asset_id",
            "chunk_index",
            "type",
            "raw_text",
            "content",
            "path",
            "breadcrumbs",
            "page_idx",
            "bbox",
            "origin_file_path",
            "meta_data",
            "content_digest",
            "embedding",
            "embedding_model",
            "updated_at",
        ] {
            assert!(
                names2.iter().any(|n| n == col),
                "kb_chunks v2 缺列 {col}，实得：{names2:?}"
            );
        }
    }
}

