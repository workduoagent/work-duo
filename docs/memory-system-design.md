# work-duo 记忆系统 v2 设计稿（统一 LanceDB）

> 版本 v2.0 · 2026-09-17 · 状态：**已拍板（待开工）**
> 前版 v1.0 推荐 SQLite BLOB + 暴力余弦；**v2.0 改为统一 LanceDB**（用户拍板：L1/L2/L3/K1/K2/K3 向量一律进 LanceDB；嵌入/重排模型外接 LLM 模块，不捆绑本地模型）。
> 关联：`需求与问题跟踪-第三期.md`；代码：`memory.rs` / `round_compactor.rs` / `wd_mem.rs` / `runtime.rs::forced_memory_settle` / `fs_helper.rs::migrate_storage_dir`

---

## 0. 背景与动机

当前记忆能力分散在三个互不相通的子系统里，召回均为非语义启发式。真正的问题是架构性的：**三层记忆各自为政、召回与任务内容零相关、会话知识随会话蒸发**；知识库（KB）UI/表/目录齐备但 Rust 侧零消费（RAG 0%）。

### 已拍板架构判断（v2）

1. **不捆绑本地嵌入模型**——LLM 模块（`models` 表）已支持 `embedding` / `rerank`；前端探测已实现 OpenAI `/embeddings`、TEI `/embed`、TEI `/rerank`。嵌入与重排**一律外接**。
2. **向量存储统一 LanceDB**——不再用 SQLite BLOB 扛向量；不引入 Qdrant 等需独立进程的服务。理由：单项目可数千条记忆，多智能体协作后期可达数万~数十万；需要原生向量检索 + 标量过滤（`agent_id` / `project_id` / `scope`）。
3. **SQLite 只做业务元数据**——会话、轮次、模型配置、记忆列表 UI/`ref_count`/`anchored`、KB 目录元数据；**不存 embedding**。
4. **降级链不变**——嵌入可用 → 向量检索；失败/未配置 → 关键词重排 → `ref_count`。向量是增强，不是依赖。
5. **数据目录可迁移**——默认 `$APPDATA/.vectors`，设置项 `vector_path`，复用一期 `migrate_storage_dir` 范式；**不放 `$RESOURCES`**。

---

## 1. 现状盘点

| 层 | 存储 | 写入 | 读取 | 核心问题 |
|---|---|---|---|---|
| **L1 会话级** | `agent_conversation_session` / `agent_conversation_round` | 每轮落库；round_compactor 滚动摘要 | 摘要注入本会话 | 任务结束蒸发；无跨会话语义检索 |
| **L2 项目级** | `.wd_mem/`（清单 / `knowledge/artifacts/`） | `native__archive_artifact` | 仅文件名清单注入 | 无索引，凭文件名猜 |
| **L3 记忆宫殿** | `agent_memories` | 手动锚定 / `native__anchor_memory` / `forced_memory_settle` | `ref_count DESC LIMIT 5` | 非语义、马太效应、与任务零相关 |
| **KB 知识库** | `knowledge_base` / `knowledge_asset` + `$APPDATA/.knowledge_base` | UI 文件管理 | 无 | Rust 零消费，RAG 0% |

小分队黑板 `agent_squad_memory` 与 L3 同构，本设计并入同一 LanceDB 表（`scope=squad`）。

---

## 2. 总架构

```
┌─────────────────────────────────────────────────────────────────┐
│  召回管道（任务开始 · load_config / native__kb_search / unified）  │
│                                                                 │
│  L1 会话摘要（本会话） + [可选] 跨会话摘要检索                       │
│  L2 artifacts 片段  ──┐                                           │
│  L3 记忆宫殿        ──┼──→ EmbeddingProvider(query)               │
│  K1 知识库切块      ──┘         │                                 │
│                                ▼                                 │
│                    LanceDB search(scope filter, k)               │
│                         │                                       │
│              命中 ──────┼──── 未配置/失败                          │
│                │       │         │                               │
│                ▼       │         ▼                               │
│           注入上下文    │    关键词重排 → ref_count 兜底             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  沉淀管道（任务结束 / 压缩 / 文件变更）                              │
│                                                                 │
│  forced/主动锚定 ──→ M0 护栏 ──→ SQLite 元数据 ──→ embed ──→ LanceDB │
│  archive_artifact ──→ 切块 ──→ embed ──→ LanceDB artifacts        │
│  KB 文件变更 ──→ 切块 ──→ embed ──→ LanceDB kb_chunks              │
│  会话压缩 ──→ 蒸馏候选 ──→（确认/forced）──→ 同 L3 路径              │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 核心抽象（Rust）

```rust
/// 嵌入提供者：调用 LLM 模块配置的 embedding 模型（OpenAI / TEI 双协议）
#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String>;
    fn model_id(&self) -> &str;
    fn dims(&self) -> Option<usize>;
}

/// 重排提供者：可选，TEI /rerank
#[async_trait]
pub trait RerankProvider: Send + Sync {
    async fn rerank(&self, query: &str, docs: &[String], top_n: usize)
        -> Result<Vec<(usize, f32)>, String>;
}

/// 向量存储：v1 唯一实现 = LanceDB
#[async_trait]
pub trait VectorStore: Send + Sync {
    async fn upsert(&self, rows: Vec<VectorRow>) -> Result<(), String>;
    async fn delete(&self, ids: &[String], table: VectorTable) -> Result<(), String>;
    async fn delete_by_filter(&self, table: VectorTable, filter: &str) -> Result<(), String>;
    async fn search(&self, req: VectorSearchRequest) -> Result<Vec<VectorHit>, String>;
    /// 嵌入缺失时的懒回填扫描
    async fn list_missing_embeddings(&self, table: VectorTable, limit: usize)
        -> Result<Vec<VectorRow>, String>;
}

pub enum VectorTable { Memories, Artifacts, KbChunks, SessionSummaries }

pub struct VectorRow {
    pub id: String,
    pub table: VectorTable,
    pub text: String,                 // 用于嵌入的正文
    pub embedding: Option<Vec<f32>>,
    pub embedding_model: Option<String>,
    pub meta: serde_json::Value,      // 表相关过滤字段（见 §3）
}

pub struct VectorSearchRequest {
    pub table: VectorTable,
    pub query_embedding: Option<Vec<f32>>,
    pub query_text: Option<String>,   // 降级关键词用
    pub filter: Option<String>,       // Lance 谓词，如 "agent_id = 'a1' AND scope = 'palace'"
    pub limit: usize,
}

pub struct VectorHit {
    pub id: String,
    pub score: f32,
    pub text: String,
    pub meta: serde_json::Value,
}
```

### 2.2 降级链（灵魂，不可省）

```
嵌入已配置且调用成功 → LanceDB 向量检索（+ 可选 rerank 精排）
  └─ 未配置 / 调用失败 / LanceDB 打开失败
        → 关键词重排（M0 字符重合度；作用于 SQLite 候选或 LanceDB 纯文本）
              → 全零 / 无候选 → ref_count 序（L3）或 文件名清单（L2）
```

任何一层失效，记忆/知识注入不阻塞任务。

---

## 3. LanceDB 数据设计

### 3.1 目录与配置

| 项 | 值 |
|---|---|
| 配置键 | `app_config.vector_path` |
| 默认 | `$APPDATA/.vectors` |
| 占位符 | `$APPDATA` / `$RESOURCE`（与 skill/workspace/KB 同语义） |
| 打开方式 | 嵌入式 `lancedb::connect(path)`，无服务进程 |
| 迁移 | 设置页「向量库目录」+ `migrate_storage_dir`；**迁移前 close → 拷贝 → 更新配置 → reopen** |

```text
$app_data/.vectors/                 # LanceDB database root
  ├── memories/                     # L3 + 小队黑板 + 蒸馏候选
  ├── artifacts/                    # L2 .wd_mem 分节
  ├── kb_chunks/                    # K1 知识库切块
  └── session_summaries/            # L1 跨会话摘要（可后置）
```

### 3.2 表 Schema

#### 表 `memories`（L3 / squad / distilled）

| 列 | 类型 | 说明 |
|---|---|---|
| id | string pk | 与 `agent_memories.id` 一致 |
| agent_id | string \| null | 过滤 |
| project_id | string \| null | 过滤 |
| session_id | string \| null | 蒸馏来源 |
| scope | string | `palace` \| `squad` \| `distilled` |
| key | string | 短标题 |
| content | string | 正文（检索文本 = key + content） |
| category | string | decision / code_pattern / … |
| embedding | FixedSizeList\<f32\> \| null | |
| embedding_model | string \| null | 换模型懒失效 |
| updated_at | int64 ms | |

**权威分裂（避免双写腐烂）**：

| 字段 | 权威源 |
|---|---|
| id, agent_id, key, content, category, scope | 写入时双写；**列表 UI / 编辑以 SQLite `agent_memories` 为准** |
| anchored, ref_count, last_recalled | **仅 SQLite**（高频更新，不进 Lance） |
| embedding, embedding_model | **仅 LanceDB** |

召回流程：LanceDB 出 `id` + score → 批量查 SQLite 补 `ref_count`/`anchored` 并 +1 → 注入。

#### 表 `artifacts`（L2）

| 列 | 类型 | 说明 |
|---|---|---|
| id | string | `{path}#{section_index}` |
| project_id | string | |
| path | string | `.wd_mem` 下相对路径 |
| heading | string | 分节标题 |
| content | string | 分节正文 |
| content_digest | string | 文件/节 hash，增量 |
| embedding / embedding_model | 同上 | |
| updated_at | int64 | |

#### 表 `kb_chunks`（K1）

| 列 | 类型 | 说明 |
|---|---|---|
| id | string | `{kb_id}/{asset_id}#{chunk_index}` |
| kb_id | string | |
| asset_id | string | |
| path | string | 相对 KB 根路径 |
| heading | string | md 标题或空 |
| chunk_index | int32 | |
| content | string | |
| content_digest | string | 增量 |
| embedding / embedding_model | | |
| updated_at | int64 | |

#### 表 `session_summaries`（L1 · Phase 可后置）

| 列 | 类型 | 说明 |
|---|---|---|
| id | string | |
| agent_id / session_id | string | |
| project_id | string \| null | |
| summary | string | 滚动摘要快照 |
| embedding / embedding_model | | |
| created_at | int64 | |

用于跨会话「以前做过类似的」；本会话注入仍走 SQLite 滚动摘要（便宜、稳定）。

### 3.3 索引与过滤策略

- 向量列建 ANN 索引（LanceDB 默认 IVF_PQ / HNSW，按版本 SDK 能力选择；v1 可用暴力/默认索引，量级触发再显式建索引）。
- 过滤一律走 **标量谓词先滤再向量**（`agent_id = ? AND scope = 'palace'`），避免多智能体串记忆。
- `embedding_model` 与当前默认模型不一致的行：检索时排除或降权，后台重嵌。

### 3.4 打开失败与空库

| 情况 | 行为 |
|---|---|
| 目录不存在 | 自动 `create_dir_all` + connect + 建表 |
| 连接失败（锁/损坏） | 记 ERROR，`VectorStore` 标记 unavailable → 全链路降级 |
| 迁移中 | 业务侧短暂 unavailable，不 panic |

---

## 4. 嵌入与重排（外接，不改前提）

- **配置来源**：`models` 表 `category='embedding'` 启用项（默认标记或首个启用）；`category='rerank'` 同理可选。
- **调用**：Rust `reqwest`，OpenAI `/embeddings` 与 TEI `/embed` 双协议；批量；超时/重试对齐现有 LLM 约定。
- **存储**：向量只在 LanceDB；`embedding_model` 记录来源。
- **回填**：召回发现缺失 → 后台限速批量 `list_missing_embeddings` + embed + upsert；本次降级不阻塞。
- **隐私**：内容会发往用户配置的 embedding 服务商；设置页状态区明示。
- **成本**：设置页显示调用次数 / 估算 token（M1 埋点）。

---

## 5. 分层改造点

### L3 记忆宫殿（主战场）

- 写入：M0 护栏全量保留（非空/最短长度/模板黑名单/去噪合并/category 白名单）→ SQLite 元数据 → 异步 embed → LanceDB `memories` upsert。
- 召回：`recall_top_memories(app, agent_id, prompt)`：  
  1. embed prompt → LanceDB `search(table=memories, filter=agent_id+scope in (palace,squad), k*4)`  
  2. 可选 rerank → top-K  
  3. 失败：SQLite `LIMIT k*4` → 关键词重排 → 全零 ref_count  
  4. 命中后 SQLite `ref_count+1` + 事件日志（现状保留热力图）。
- 删除/改写：SQLite 与 LanceDB 双删/双更；Lance 失败仅打日志，启动期可做对账任务（远期）。

### L2 `.wd_mem` artifacts

- `native__archive_artifact` 成功后：按标题分节 → digest 未变跳过 → embed → `artifacts` 表。
- `load_config`：复用清单注入**保留**；叠加 prompt 相关 top-k 分节片段（filter=`project_id`）。

### L1 会话压缩

- 滚动摘要机制原样保留。
- 蒸馏：压缩 prompt 追加「值得升入长期记忆的候选」→ pending → 记忆宫殿确认 / forced 自动入 L3（走护栏 + Lance）。
- 远期：摘要快照入 `session_summaries` 做跨会话检索。

### K1 知识库 RAG

- 解析：首批 `.md` / `.txt`；md 按标题分节，txt 滑窗（~512 token、10% 重叠）。
- 写入钩子：KB 文件增删改 → 重切块 → `kb_chunks` 增量（digest）。
- 嵌入未配置：先存 content 与 digest，向量列 null，懒回填。
- 手动「重建索引」命令 + 进度事件。

### K2 检索工具

- `native__kb_search(query, kb_ids?)`：统一管道，filter=`kb_id IN (...)`；RequireApproval=否。
- `agent_kb_ref` 绑定；未绑定不注册工具；planner 能力大纲补条目。

### K3 统一检索

- `unified_retrieve(prompt, scopes)`：一次 embed，多表/多 scope 并行 search，合并排序。
- 自动注入与工具调用共用；前端引用标记可跳转。

---

## 6. 实施步骤（一步步完成）

> 原则：每步可独立验收；向量失败永不阻塞主路径；DDL 双写必查 mapper。

### Step 0 — M0 记忆质量护栏（约 0.5 天）

**不依赖 LanceDB**，先做，作为降级地基。

- [ ] `forced_memory_settle` / `anchor_memory` 自动路径：非空、key≥2、content≥10、模板句黑名单、category 白名单、去噪合并。
- [ ] `recall_top_memories`：候选 `LIMIT k×4` + 字符重合度重排 + 全零回落 `ref_count`。
- [ ] 验收：forced 跑 N 任务无复述型条目；「ref_count 高无关 / 低相关」能召回相关条。

### Step 1 — 基础设施（约 1–1.5 天）

- [ ] `Cargo.toml` 增加 `lancedb`（及官方 SDK 所需 arrow 等传递依赖）；**评估编译时长与二进制增量**，记录在验收备注。
- [ ] `app_config.vector_path` 默认 `$APPDATA/.vectors`；`settings-file` + 设置页「向量库目录」行；接入 `migrate_storage_dir`（close→move→reopen）。
- [ ] 新建 `agent/vector_store.rs`：`VectorStore` trait + `LanceDbVectorStore`（connect / 建表 / upsert / search / delete）。
- [ ] 新建 `agent/embedding.rs`：`EmbeddingProvider` 双协议 + 从 `models` 取默认；`RerankProvider` 可先 trait + TEI 实现骨架。
- [ ] Tauri managed state 或等价单例持有 DB 连接；启动 init、失败降级标记。
- [ ] 验收：空库自动建表；设置页改路径能迁移；embedding 探测连通。

### Step 2 — L3 记忆进 LanceDB（约 1 天）

- [ ] 写路径：`anchor_memory` / forced settle 成功后异步 upsert `memories`（scope=palace）。
- [ ] 召回改造：`recall_top_memories(..., prompt)` 走向量优先降级链；`load_config` 传入 prompt。
- [ ] 删除/更新双写；启动后可选「向量对账」（SQLite 有行 Lance 无 → 补齐）。
- [ ] 设置页：语义召回状态 + 调用统计 +「立即回填向量」。
- [ ] 验收：相关/无关对照用例；未配置嵌入自动关键词模式；回填按钮跑通。

### Step 3 — K1 知识库切块入库（约 1–1.5 天）

- [ ] `agent/knowledge.rs`：md/txt 解析与切块；`knowledge_asset.indexed_at`（或等价状态）。
- [ ] KB 增删改钩子 → `kb_chunks`；手动重建索引 + 进度。
- [ ] 验收：拖入 md 自动入库；改文件增量；无嵌入时 chunk 仍在、向量空。

### Step 4 — L2 artifacts 索引（约 0.5–1 天）

- [ ] `archive_artifact` 钩子分节入 `artifacts`；`load_config` 片段注入。
- [ ] 验收：问「auth-flow 设计决策」能注入对应分节。

### Step 5 — K2 检索工具与绑定（约 1 天）

- [ ] `native__kb_search`；`agent_kb_ref` DDL + mapper + 向导绑定 + load_config 装配。
- [ ] planner 大纲条目。
- [ ] 验收：绑定后能引用 KB 片段；未绑定不可见工具。

### Step 6 — M2 rerank 精排（约 0.5 天）

- [ ] TEI `/rerank` 接入召回管道（向量/关键词之后）；未配置跳过。
- [ ] 验收：top-k 顺序优于纯向量（构造边界）。

### Step 7 — M3 会话蒸馏（约 1 天）

- [ ] round_compactor 增加候选输出 → pending → 确认/forced 入 L3（含 Lance upsert）。
- [ ] 验收：压缩后出现候选；确认后可召回；拒绝不再出现。

### Step 8 — K3 统一检索与引用（约 1 天，收官）

- [ ] `unified_retrieve`；消息流引用标记与跳转。
- [ ] 验收：一次任务日志可见多源检索；前端可点引用。

### 远期池（不阻塞）

- ANN 索引显式调参（量级触发）
- `session_summaries` 跨会话检索
- 小分队黑板 UI 与 scope 隔离打磨
- 智能体级 embedding 模型覆盖
- Lance ↔ SQLite 启动对账与修复工具

### 建议排期

```text
Step0 (0.5d) → Step1 (1~1.5d) → Step2 (1d) → Step3 (1~1.5d)
  → Step4 (0.5~1d) → Step5 (1d) → Step6 (0.5d) → Step7 (1d) → Step8 (1d)
合计约 8~10 人日（含真机验收）
```

---

## 7. 风险与限制

| 风险 | 缓解 |
|---|---|
| `lancedb` 编译体积/时间 | Step1 先落地并记录增量；过大则评估 feature 裁剪 |
| 双写不一致（SQLite ↔ Lance） | 字段权威表（§3.2）；删除双删；远期对账 |
| 迁移中并发写 | 迁移序列 close→move→reopen；失败回滚旧路径 |
| 换 embedding 模型 | `embedding_model` 懒失效重算 |
| 隐私（外发内容） | 设置页明示；仅用户配置的服务商 |
| 中文关键词降级粗糙 | M0 接受 n-gram；不引分词库 |
| PDF/office | K1 首批 md/txt |

---

## 8. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| 1 | 向量库 | **LanceDB 统一**（否决 SQLite BLOB；否决需独立进程的 Qdrant） |
| 2 | 数据目录 | `$APPDATA/.vectors` + `vector_path` 可迁移；否决 `$RESOURCES` |
| 3 | 嵌入/重排 | 外接 LLM 模块配置；不捆绑本地模型 |
| 4 | SQLite 职责 | 业务元数据与 `ref_count`；不存向量 |
| 5 | L3 量级假设 | 单项目数千；多智能体数万+，必须 ANN+过滤 |
| 6 | 降级链 | 向量 → 关键词 → ref_count/清单，保留 |
| 7 | 节奏 | Step0 护栏先行，再上 Lance 基建与各层 |

---

## 9. 验收总表

| 阶段 | 验收 |
|---|---|
| Step0 | 记忆质量与关键词重排生效（原 M0） |
| Step1 | 依赖编译通过；路径可配可迁；空库可开；嵌入探测通 |
| Step2 | 语义召回选中相关条；无嵌入不中断；回填可用 |
| Step3 | KB md 自动/增量入库 |
| Step4 | artifacts 分节可召回注入 |
| Step5 | `native__kb_search` + 绑定生效 |
| Step6 | rerank 改善 top 序 |
| Step7 | 会话蒸馏候选闭环 |
| Step8 | 统一检索 + 前端引用 |
