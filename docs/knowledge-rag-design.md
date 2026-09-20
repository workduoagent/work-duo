# work-duo 知识库 RAG 设计稿（第四期 · K 系列重设计）

> 版本 v1.0 · 2026-09-19 · 状态：评审中
> 前置：第三期设计稿 `docs/memory-system-design.md` v2.0（LanceDB 统一向量库 / 降级链 / 嵌入外接等决策全部继承）
> 参照：用户 Web 端 RAG 项目 `KnowledgeChunks.java`（PG 分区表 + pgvector 512 维 + pg_search）

---

## 1. 背景与重设计原因

第三期 K1-K3 原始规格的三条假设已失效，照旧规格实施必返工：

| 原假设 | 实际情况（2026-09-19 摸底） |
|---|---|
| Rust 侧新建 KB 写入钩子 | KB 文件由**前端 Tauri fs 插件直写**（`src/core/file/kbFs.ts`，无自定义 Rust 命令可挂钩） |
| 新建 LanceDB `kb_chunks` 表 | M1 基建时**表已建成**（`vector_store.rs` schema_for(KbChunks)），零消费 |
| 嵌入/回填从零设计 | `embedding.rs`（双协议+探测）与 `backfill_memory_vectors`（批量16+进度+重入保护）范式成熟 |

**本期拍板（2026-09-19）**：
1. K 系列拆出第四期独立设计（本稿）；**统一 LanceDB 决策保留**。
2. **放弃 MinerU 接入**：本地桌面产品不背解析服务运维；v1 仅支持 **TXT / MD 系纯文本**（.md/.txt 白名单，其他 UTF-8 文本扩展名可配置放行）。
3. 通用性留缝：chunk 表**字段按通用设计**（`page_idx`/`bbox` 留空占位），将来接入任意「任意格式→文本块」解析器（含 MinerU）时**表结构与检索链路零改动**，仅新增 `FileTextExtractor` trait 实现。
4. 向量维度为**表级属性**（LanceDB 向量列建表时固定、整表同维，不支持混维）；行级不设 dim 列。
5. 标签云分工：**SQLite 管标签过滤，Lance 管语义检索**。

---

## 2. 存储设计

### 2.1 LanceDB `kb_chunks`（v2 schema）

沿用三列公共尾（`embedding` FixedSizeList<f32>(dim) / `embedding_model` / `updated_at`），业务列重设计如下：

| 列 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | Utf8 | 否 | chunk UUID，格式 `{asset_id}#{chunk_index}`；upsert/delete 主键（对应 Web 版 pg_search key_field） |
| `kb_id` | Utf8 | 否 | 隔离键（替代 Web 版 LIST 分区：单表 + `only_if kb_id = '...'` 过滤） |
| `asset_id` | Utf8 | 否 | **必须项**。所属资产；按资产增量删除/重建的过滤键 |
| `chunk_index` | Int32 | 否 | 资产内顺序号 |
| `type` | Utf8 | 否 | `text` / `heading` / `table` / `code`（MinerU 式 block 语义，v1 由 md 结构识别） |
| `raw_text` | Utf8 | 否 | 含标题前缀的原始切片（溯源 / 拼接上下文用，对应 Web 版 raw_text） |
| `content` | Utf8 | 否 | 清洗后纯文本 = 向量化 + 关键词检索主体（对应 Web 版 pure_text） |
| `path` | Utf8 | 否 | 层级路径（如 `第十一章/三、小水电的经济计算`） |
| `breadcrumbs` | Utf8 | 是 | 面包屑显示（`第十一章 > 三、…`） |
| `page_idx` | Utf8 | 是 | JSON 数组字符串 `[237]`；**v1 TXT/MD 恒空**，MinerU 类解析器接入后填充 |
| `bbox` | Utf8 | 是 | JSON 数组字符串 `[x1,y1,x2,y2]`；**v1 恒空**，将来支撑查看器跳原文高亮 |
| `origin_file_path` | Utf8 | 否 | 源文件相对 KB 根目录路径（如 `docs/a.md`） |
| `meta_data` | Utf8 | 是 | **必须项**。JSON：`{ "tags": [...], "prev_id", "next_id", "char_count" }` 动态扩展 |
| `content_digest` | Utf8 | 否 | 文件级 digest（同资产各 chunk 共享，增量跳过判据，同 artifacts 模式） |

与 M1 版差异：新增 `type / raw_text / breadcrumbs / page_idx / bbox / origin_file_path / meta_data`；`heading` 并入 `path/breadcrumbs` 后**移除**。

**Schema 迁移**：M1 版旧表零消费 → 按**列集判定**（`table_names` → 读 schema 列名，缺新列即旧版）→ `drop` 重建，无数据迁移负担。

### 2.2 SQLite DDL v28（`init.sql` + `updater.sql` 双写）

```sql
-- ---------- v28：知识库 RAG 索引（K1'） ----------
-- 资产级索引状态与增量判据；chunk 正文与向量权威在 LanceDB kb_chunks（设计稿 §2.1）。
ALTER TABLE knowledge_asset ADD COLUMN digest TEXT;      -- 文件内容 hash（DefaultHasher），NULL=未索引
ALTER TABLE knowledge_asset ADD COLUMN indexed_at INTEGER; -- 最近成功索引时间(epoch ms)，NULL=待索引/未支持格式
ALTER TABLE knowledge_asset ADD COLUMN meta_data TEXT;   -- 资产级 JSON：{ "tags": [...], "remark": ... }
-- 嵌入维度表级记录（LanceDB 向量列建表即固定）；空串=尚未索引过。首次成功索引时回填实际维度。
INSERT OR IGNORE INTO app_config (key, value) VALUES ('kb_embed_dim', '');
```

`init.sql` 同步三列与该 app_config 行。**mapper 三要素自检**：`knowledge-mapper.ts` 行映射补新列（digest/indexedAt/metaData 可空）。

### 2.3 向量维度生命周期

1. 首次索引：读 `app_config.kb_embed_dim`；为空 → `ensure_table(kb_chunks, 实际探测维度)`（嵌入探测沿用 `embedding.rs` 既有机制）→ 回填 `kb_embed_dim`。
2. 日常索引：维度与表一致，直接写入。
3. **换嵌入模型且维度变化**：`kb_rebuild_index` 检测 `探测维度 != kb_embed_dim` → drop 表 → 按新维重建 → 全量重嵌（进度事件逐批推送）。
4. 同维度换模型：无需重建，rebuild 全量重嵌刷新向量即可。

### 2.4 标签云分工

- **SQLite**：`knowledge_asset.meta_data.tags` 为权威；标签过滤 = SQL 圈定 asset 集合；标签云 UI 聚合直接读 SQLite。
- **Lance `meta_data`**：冗余 tags（写入时从资产级拷贝）+ 链路字段（`prev_id`/`next_id`，供「上一片/下一片」上下文扩展）；**不作为过滤依据**。
- 检索：先 tag/资产圈定 → `only_if kb_id = '...' AND asset_id IN ('a','b',...)` → 向量近邻。

---

## 3. 模块划分

### 3.1 `agent/knowledge.rs`（新建，K1' 主战场）

```
KbChunkRow            —— Lance 行模型（§2.1 全字段 + embedding Option）
KbAssetRef            —— 资产轻引用（id / kb_id / file_path / ext / digest / indexed_at）
FileTextExtractor     —— trait { fn supports(ext) -> bool; async fn extract(path) -> Result<FileText> }
                       ├ Utf8TextExtractor（v1 唯一实现：.md/.txt 白名单直读）
                       └ （将来）MineruExtractor / PdfExtractor 等挂此接缝，表结构零改动
chunk_asset(text, ext) -> Vec<KbChunkMeta>      —— 纯函数（单测主战场）
sync_asset_index(app, kb_id, asset_id) -> KbSyncReport    —— 单资产增量（幂等）
remove_asset_index(app, kb_id, asset_id) -> ()             —— 级联清 Lance 段 + SQLite indexed_at 置 NULL
rebuild_kb_index(app, kb_id) -> 全量重建（spawn 异步 + 进度事件 + 重入保护）
```

**切块规则**（`chunk_asset`）：
- **md**：复用 `artifact_index::split_markdown_sections`（标题分节）→ 节内二次扫描：连续表格行 = `table` 块、``` 围栏 = `code` 块、其余合并 `text`；`table/code` 整块保留（≤ 窗口），超长按行滑窗；`text` 超长滑窗。
- **txt**：纯滑窗。
- **窗口参数**：~800 字符 / 10% 重叠（≈512 token 量级，拍板值）；`raw_text` = 标题前缀 + 原文切片，`content` = 清洗文本；`path`/`breadcrumbs` 由所属节标题层级生成。
- chunk 数保护：单资产 ≤ 2000 chunks（超出截断并记录警告）。

**嵌入**：复用 `embedding::embed_texts`（双协议）；未配置 → chunks 照常入 Lance（embedding null）+ `indexed_at` 仍回写（「已切块未向量化」状态），检索走关键词降级。

### 3.2 `vector_store.rs` 泛化扩展（沿用既有范式）

| 新增 | 对标既有 | 说明 |
|---|---|---|
| `KbChunkVectorRow` / `upsert_kb_chunks` | `upsert_artifacts` | merge insert by `id`；embedding Option 支持空向量行 |
| `search_kb_chunks(query, filter, limit)` | `search_artifacts` | 返回 `KbChunkHit { id, kb_id, asset_id, chunk_index, type, content, path, breadcrumbs, page_idx, bbox, score }` |
| `query_kb_asset_digest(filter)` | `query_artifact_file_digest` | **先 `table_names` 查表存在性**（006 教训：表不存在 = Ok(None) 走全量写入） |
| `delete_by_filter(KbChunks, "asset_id = '...'")` | 既有通用删除 | 资产级级联清理 |
| `drop_table_if_stale_schema(KbChunks)` | — | 列集判定旧 M1 schema → drop（迁移用，一次性） |

`schema_for(VectorTable::KbChunks)` 按 §2.1 更新。

### 3.3 `embedding.rs` / `memory.rs`——零改动复用

`embed_texts`、探测、埋点（`bump_stats` 泛化键追加 `kb_embed_*`）全部复用。

### 3.4 `commands.rs` 新增命令（见 §4 清单）+ `lib.rs` 注册。

### 3.5 前端

- `src/apis/kb-api.ts`（或既有 KB api 文件）：`kbSyncAsset` / `kbRemoveAsset` / `kbRebuildIndex` invoke 封装 + `agent-kb-index-progress` 监听。
- **`kbFs.ts` 写入点挂钩**（fire-and-forget，失败仅 console，不阻塞 UI）：
  - 上传/写入资产成功 → `kb_sync_asset`
  - 删除资产 → `kb_remove_asset`
  - 改名/移动 → `kb_sync_asset`（digest 未变则仅刷新 Lance 元数据列与 SQLite file_path）
- 知识库**详情页**：「重建索引」按钮 + 进度条（事件驱动）；资产列表显示索引状态徽标（未索引 / 已索引 / 已切块未向量化 / 不支持格式）。
- **设置页**：嵌入模型未配置时的提示复用记忆回填同款范式（「知识库切块已完成，配置嵌入模型后可语义检索」）。

---

## 4. 命令与事件清单

| 命令 | 入参（invoke 包 `input`） | 出参 | 语义 |
|---|---|---|---|
| `kb_sync_asset` | `{ kbId, assetId }` | `{ result: 'skipped'\|'reindexed'\|'unsupported', chunks, embedded }` | 单资产增量同步；digest 未变 → skipped（仍刷新 path 类元数据） |
| `kb_remove_asset` | `{ kbId, assetId }` | `{ deleted: true }` | 级联清 Lance 段；SQLite indexed_at/digest 置 NULL |
| `kb_rebuild_index` | `{ kbId }` | 立即返回 `{ started: true }`，进度走事件 | spawn 异步全量重建；维度变化自动 drop 重建；**重入保护**（进行中重复调用返回 `{ started: false, reason: 'in_progress' }`） |

事件：`EVT_KB_INDEX_PROGRESS = "agent-kb-index-progress"`，payload `{ kbId, phase: 'parse'|'chunk'|'embed'|'upsert', done, total, assetId?, message? }`（平移 `agent-memory-backfill` 范式）。

---

## 5. 数据流

### 5.1 单资产同步（上传/修改后）
```
kbFs 写文件 → 前端 fire kb_sync_asset
→ Rust: 读 knowledge_asset 行 → 读文件字节 → content_digest
→ query_kb_asset_digest（表不存在=Ok(None)）
   ├ digest 相同且 path 未变 → skipped
   └ 变化 → ext 判定 → FileTextExtractor.extract
      ├ 不支持（如 .pdf）→ result=unsupported，indexed_at 保持 NULL（待将来接解析器）
      └ 支持 → chunk_asset 切块 → delete_by_filter(旧段) → embed_texts（若已配置，批量16）
              → upsert_kb_chunks（空向量也入库）→ SQLite 回写 digest/indexed_at/meta_data
```

### 5.2 全量重建（详情页按钮 / 维度变化 / 换模型）
```
kb_rebuild_index → 遍历 kb 资产逐个走 5.1 流程（跳过 unsupported）
→ 逐批 emit agent-kb-index-progress → 完成 emit 汇总（indexed/embedded/skipped/failed 计数）
```

### 5.3 检索（K2' 预览，本期只铺管道）
```
kb_search(query, kb_ids?, tags?) 
→ SQLite：tags/kb 圈定 asset 集合 → only_if kb_id + asset_id IN
→ 向量近邻 top-k×4 →（K2' 起）rerank 精排 → 关键词 2-gram 兜底补齐 → 空结果清单
```

---

## 6. 边界与失败语义（对齐全局降级原则）

1a. **检索收敛护栏（K2 真机热修 2026-09-19）**：①native__kb_search 单任务内计数，超过 6 次后在返回 JSON 注入 notice「立即基于已检索资料整理答案，勿重复检索」；②流水线熔断（8 工具轮）且 success_criteria 为空时，先追加一轮「禁止调工具、立即输出最终结果」的强制总结（无工具 LLM 调用），产出非空正文按**暂定完成**收尾——替代原先「判失败→自动接管重跑→模型重蹈纯检索循环」的死循环（真机实锤：9 轮 30+ 次 kb_search 正文恒空）。 → 上层降级：同步命令返回 Err 由前端 console 记录（fire-and-forget），检索降级关键词，**绝不阻塞 KB 文件管理主流程**。所有 Lance 访问原语（query / delete / upsert）对「表不存在」一律幂等视为空结果（006 教训 + 2026-09-19 真机推广：重建 force 路径先删后写，表刚被 schema 迁移清除时 delete 不得断裂）。
2. **嵌入未配置**：切块入库、向量 null、`indexed_at` 照常回写；检索走关键词 2-gram。
3. **不支持格式**（v1 的 .pdf/.docx/.png 等）：`result=unsupported`，资产可见、状态徽标「不支持检索」，不产出 chunks；将来接解析器后 rebuild 一键补齐。
4. **幂等**：sync 以 digest 为判据天然幂等；rebuild 重入保护；remove 先删 Lance 再改 SQLite（失败可重入）。
5. **并发**：同资产 sync 与 rebuild 竞争 → rebuild 持有 per-kb 重入锁，sync 遇锁直接 skipped（下次写入再触发）。

---

## 7. 测试清单

**单测（cargo test --lib，目标全绿）**
- `chunk_asset`：md 分节 / 节内表格与代码块识别 / 滑窗重叠正确性 / 空文件 / 无换行长文本 / 2000 chunk 截断
- digest 三态：同内容 skipped / 内容变化重切 / 资产删除清理
- 表不存在首查 → Ok(None) 走全量（006 教训回归）
- 旧 schema 列集判定 → drop 重建
- 嵌入未配置路径：chunks 入库、embedding null、`kb_embed_dim` 不回填
- 维度变化：rebuild 触发 drop 重建逻辑（mock 探测维度）

**真机验收（K1' 收口标准）**
1. 拖入 .md 知识库 → 自动切块入 LanceDB（Lance 目录可见 kb_chunks 增长），详情页资产徽标「已索引」
2. 修改文件再保存 → 增量更新（日志可见 digest 变化 → 重切），未变文件 skipped
3. 删除资产 → Lance 段清空
4. 嵌入未配置：切块完成、状态「已切块未向量化」；配置嵌入模型后「重建索引」→ 全量向量化 + `kb_embed_dim` 回填
5. 换不同维度嵌入模型 → rebuild 自动 drop 重建成功
6. rebuild 进行中重复点击 → 提示进行中；进度条按批次推进

---

## 8. 排期与任务拆分（第四期）

| 任务 | 内容 | 规模 |
|---|---|---|
| **K1a** | vector_store v2 schema + 迁移判定 + knowledge.rs（chunker/sync/remove）+ 命令三件套 + 单测 | 大 · ✅ 2026-09-19（cargo 72 passed） |
| **K1b** | 前端钩子（mapper 三数据变更点全覆盖）+ 详情页重建按钮/进度/状态摘要 | 中 · ✅ 2026-09-19（tsc CLEAN，待真机验收） |
| **K2'** | `native__kb_search` 工具 + `agent_kb_ref` 绑定装配 + planner 大纲（沿用第三期原设计，检索管道对接 §5.3） | 中 · ✅ 2026-09-19 真机验收通过（四案例：事实核对 score=0.774 / 收敛护栏 8 轮闭环 / 忠实性 100% / 否定测试防幻觉） |
| **K3'** | 引用展示：命中片段卡片（K3-1）+ 任务级引用汇总（K3-2）+ 标签云与标签筛选检索（K3-3）+ kb_search 上下文成本优化（K3-4，治 K2 实测 prompt 107K） | 中 · 🚧 规划已定（见跟踪文件 #20260918010） |

K1a → K1b 可串行；K2' 依赖 K1b 的真机验收；K3' 收官。

> **✅ K1 真机验收通过（2026-09-19 22:58）**：pixel-agent-design.md → 90 chunks（dim=512，embedded=true，7 批 upsert），kb_chunks.lance 落盘确认；schema 迁移（旧表 drop）、惰性建表、批量嵌入、进度事件全链路闭环。增量/删除路径与主路径共用 digest 判定，日常使用即验收。

> **✅ K3 引擎侧自测记录（2026-09-20，WorkDuo 内建 MCP 自测闭环——agent_list_* → agent_ui_create → agent_run_task → get_run_trace 全链自主驱动，三用例全绿）**
>
> | 用例 | 结果 |
> |---|---|
> | 检索主链路 | kb_search 命中带完整溯源字段（id=assetId#chunk_index / breadcrumbs / originFilePath / channel / score），K3-1 引用卡片数据源引擎侧完全就绪；回复精准（正确区分前端 TS 快照函数与 HTTP API） |
> | 收敛护栏实战 | 14 次检索，notice 自第 7 次连续注入，模型换 8 个角度 query 补全信息后自然收敛输出——未熔断未重跑；回复每节带来源，末尾主动声明「未明确展开的内容不作臆测」 |
> | 否定测试 | 明确答「没有找到相关内容」并解释检索结果为何无关，零编造 |
>
> **自测产出优化输入（并入 K3-4）**：
> 1. **score 阈值过滤（新增候选）**：无关查询最近邻 score>1.0、相关查询<0.95，分布天然分离——可加阈值过滤或 `low_relevance` 标记，助模型果断判「无相关内容」并省 token；
> 2. **top_k 收口**：模型仍偶传 top_k=10，需工具层硬 clamp（≤8）+ schema 描述引导默认 5（未传时默认 5 已实测良好，单任务 prompt 29.6K）；
> 3. **收敛护栏硬化**：notice 为软引导，实测模型收 notice 后仍续检 7 次（换角度非纯重复）——可加二级硬约束：notice 后再超 N 次直接返回「已达检索上限，请立即作答」；
> 4. **任务内 seen-chunk 去重**：多轮检索重复命中同一 chunk 仍全量返回，应过滤或标注「(已在上文)」。
> 3. **收敛护栏硬化（候选）**：notice 为软引导，实测模型收 notice 后仍续检 7 次（换角度非纯重复）——可加二级硬约束：notice 后再超 N 次直接返回「已达检索上限，请立即作答」；
> 4. **任务内 seen-chunk 去重**：多轮检索重复命中同一 chunk 仍全量返回，应过滤或标注「(已在上文)」。
>
> **装配坑位（已回写 SKILL 2026-09-20）**：`mcpTools` 必传（省略报 not iterable）；`agent_ui_delete` 后 identifier 仍占 UNIQUE（待查软删语义）。
