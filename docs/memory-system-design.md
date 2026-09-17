# work-duo 记忆系统 v2 设计稿

> 版本 v1.0 · 2026-09-17 · 状态：**待评审（未开工）**
> 关联任务：`20260915010` 记忆质量护栏（本设计 Phase 0）；关联代码：`memory.rs` / `round_compactor.rs` / `wd_mem.rs` / `runtime.rs::forced_memory_settle`

---

## 0. 背景与动机

当前记忆能力分散在三个互不相通的子系统里，且召回均为非语义启发式。15010（记忆护栏）只能止痛——真正的问题是**架构性的：三层记忆各自为政、召回与任务内容零相关、会话知识随会话蒸发**。

关键前提（用户拍板的架构判断）：

1. **不捆绑本地嵌入模型**——0.x B 的向量模型也要几百 MB，对 LLM 是零头、对软件本体是重负；
2. **嵌入能力的「接入」已经存在**——LLM 模块（models 表）早已支持 `embedding` / `rerank` 两大类模型配置，前端探测逻辑（`modelTest.ts`）已实现 OpenAI `/embeddings`、TEI `/embed`、TEI `/rerank` 三种协议；
3. **缺的只是中间一环**：本地向量存储选型 + Rust 侧调用链路 + 记忆系统对它们的消费。

因此本设计的核心命题：**把记忆召回做成「能力可选、逐级降级」的统一管道**——配了向量模型就走语义检索，没配就落回关键词启发式，始终可用、永不阻塞。

## 1. 现状盘点（三层记忆）

| 层 | 存储 | 写入路径 | 读取路径 | 核心问题 |
|---|---|---|---|---|
| **L1 会话级** | `agent_conversation_session` / `agent_conversation_round` | 每轮落库；round_compactor 每 5 轮触发，LLM 把旧摘要+待压缩轮合并为滚动摘要（state-compaction prompt，保留文件/代码变更/环境/目标） | 摘要注入本会话上下文 | 摘要只服务本会话，**任务结束即蒸发**——没有升入长期记忆的管道 |
| **L2 项目级（.wd_mem）** | 工作空间文件（复用清单 / `knowledge/artifacts/` / `runtime/`） | `native__archive_artifact` 沉淀设计蓝图 Markdown；引擎注入复用清单 | system prompt 注入清单**文件名列表** | 无索引无检索——模型只能凭文件名猜内容，沉淀越多越靠猜 |
| **L3 长期知识点（记忆宫殿）** | `agent_memories`（key/content/category/ref_count/anchored） | 三路：手动锚定（UI）/ 主动工具（`native__anchor_memory`）/ 引擎强制沉淀（`forced_memory_settle`，任务成功后 LLM 总结落库） | `recall_top_memories`：`ref_count DESC LIMIT 5` | ① 非语义、马太效应（召回即 +1 自我强化）；② 噪音无护栏（15010 三痛点）；③ 与当前任务零相关 |

附：`agent_squad_memory`（小分队黑板）与 L3 同构，未来同管道升级；`knowledge_base` / `knowledge_asset`（知识库模块）远期可纳入统一检索，本期不展开。

## 2. 设计总纲：统一记忆检索管道

```
任务开始（组装上下文）
  L1 会话摘要      ← 现状原样
  L2 项目记忆      ← 复用清单注入（现状保留）+ [P2] artifacts 语义检索 top-k 片段
  L3 长期记忆      ← 召回管道：候选池 → 语义/关键词重排 → （rerank 可用？精排）→ top-K

任务结束（沉淀管道）
  forced/主动沉淀 → 质量护栏（15010）→ [P1] 向量化（嵌入可用时）→ 入库
  会话压缩时      → [P3] 长期记忆候选蒸馏 → 确认/自动入 L3
```

两个核心抽象（Rust trait，各只有一个 v1 实现，为未来换核留缝）：

```rust
/// 嵌入提供者：调 LLM 模块配置的 embedding 模型（OpenAI /embeddings 与 TEI /embed 双协议）
trait EmbeddingProvider { async fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>>; }
/// 向量存储：v1 = SQLite BLOB + 暴力余弦；未来可换 sqlite-vec 而不动上层
trait VectorStore { async fn upsert(&self, id, vec); async fn search(&self, query_vec, k, filter) -> Vec<(id, score)>; }
```

**降级链（本设计的灵魂）**：

```
嵌入模型已配置且调用成功 → 向量余弦重排
  └─ 未配置 / 调用失败 → 关键词重排（15010 的字符重合度启发式）
        └─ 重合度全零 → ref_count 序（现状兜底）
```

向量是**增强，不是依赖**——任何一层失效，记忆系统照常工作。

## 3. 本地向量库选型（决策项）

| 方案 | 体积 | 依赖 | 适配量级 | 结论 |
|---|---|---|---|---|
| **SQLite BLOB + 暴力余弦（v1 推荐）** | 0 | 0（复用现有 sqlx/SQLite） | ≤1 万条无压力：1536 维 f32 ≈ 6KB/条，1 万条全量扫描 <50ms | ✅ 零成本起步 |
| sqlite-vec（SQLite 扩展） | ~1MB | 随包分发单个 .dll/.so，虚表 API | 十万~百万级 | Phase 远期备选，trait 兼容 |
| usearch / hnswlib | 数 MB | FFI 绑定 | 千万级 | 过度设计，不采 |
| LanceDB / Qdrant 嵌入式 | 几十 MB+ | 重运行时 | 百万级+ | 不采（软件变重，违背初衷） |

**结论：v1 用 BLOB + 暴力余弦**。单智能体记忆量级（几十~几百条）距离暴力扫描瓶颈差三个数量级；等真到十万条再换 sqlite-vec，上层零改动（trait 已隔离）。

## 4. 嵌入调用设计

- **配置来源**：`models` 表 `category='embedding'` 的启用模型（URL/Key/参数字段现成）；默认策略 = 标记默认者或首个启用项；
- **调用**：Rust reqwest POST，双协议兼容（OpenAI `/embeddings`：`{model, input:[...]}`；TEI `/embed`：`{inputs:[...]}`），批量 input 摊薄请求数；超时/重试对齐现有 LLM 调用约定；
- **存储**：`agent_memories` 加列 `embedding BLOB` + `embedding_model TEXT`（记录来源模型；换模型后旧向量按 model 不匹配**懒失效重算**）——`init.sql` + `updater.sql` 双写；
- **回填**：召回时发现 NULL embedding 且嵌入可用 → 后台限速批量回填，不阻塞召回（本次按关键词模式）；
- **成本量级**：每条记忆 ~几十 token，写入批量一次；召回每次仅 embed 当前 prompt（1 次调用）。设置页状态展示：「记忆语义召回：已启用（模型 xxx）/ 未配置（关键词模式）」。

## 5. 三层改造点

### L3 记忆宫殿（Phase 1 主战场）
- 写入：**15010 护栏全量保留**（非空/最短长度/模板句黑名单/去噪合并/category 白名单）——护栏就是降级模式的质量地基，无论有无向量都必须做；
- 召回管道化（§2 降级链）；候选池取 `LIMIT k×4` 再重排。

### L2 .wd_mem（Phase 2）
- `knowledge/artifacts/*.md` 入向量域：按标题分节切块 → 嵌入 → 统一向量表（`scope='wd_mem'`，ref=path#section）；
- 召回注入：任务相关时检索 top-k 片段随上下文注入（增强现状的文件名清单注入，清单保留——便宜且稳定）。

### L1 会话压缩（Phase 3）
- 滚动摘要机制**原样保留**（本会话工作记忆）；
- 新增「蒸馏管道」：压缩 LLM 调用顺带输出「值得升入长期记忆的候选条目」→ 存 pending 候选 → 记忆宫殿确认（或 forced 模式自动转入）——**会话知识不再蒸发**；
- 远期：历史会话摘要入向量域，跨会话检索「以前做过类似的」。

## 6. 分阶段路线图

| 阶段 | 内容 | 体量 | 依赖 |
|---|---|---|---|
| **Phase 0 = 15010 护栏**（建议先行） | 非空/最短长度校验、模板句黑名单、去噪合并、召回关键词重排——**它同时是 Phase 1 的降级实现**，不是丢弃而是成为地基 | 半天 | 无 |
| **Phase 1 嵌入向量召回** | EmbeddingProvider（双协议）+ embedding BLOB 列 + 写入向量化 + 召回向量重排 + 降级链 + 设置页状态 + 懒回填 | 1~1.5 天 | Phase 0 |
| **Phase 2 rerank + .wd_mem 索引** | TEI /rerank 精排（top-20 → 5）；artifacts 分节入向量域 + 检索注入 | 1 天 | Phase 1 |
| **Phase 3 会话蒸馏** | 压缩时长期记忆候选提取 + 记忆宫殿确认流 | 1 天 | Phase 1 |
| 远期 | sqlite-vec 换核（量级触发）；知识库统一检索；小分队黑板同构升级 | 按需 | — |

## 7. 待拍板决策点

1. **向量库**：v1 暴力余弦 + BLOB（推荐，零依赖零体积）——是否同意？
2. **嵌入模型选择**：全局默认一个（推荐 Phase 1）还是智能体级可覆盖（远期）？
3. **降级链**：嵌入失败 → 关键词重排 → ref_count，三层兜底——是否同意？
4. **节奏**：先做 Phase 0（15010），再上 Phase 1？还是直接合并做？
5. **成本可见性**：设置页显示 embedding 调用统计（Phase 1 顺手做？）

## 8. 验收标准

| 阶段 | 验收 |
|---|---|
| Phase 0 | forced 跑 N 个任务后记忆宫殿无明显复述型/重复条目；召回重排生效（15010 原验收） |
| Phase 1 | 配置 embedding 模型后：构造「ref_count 高但语义无关 / ref_count 低但语义相关」两条记忆，召回选中相关条；未配置模型时自动落关键词模式，功能不中断；设置页状态正确 |
| Phase 2 | 问「项目里 auth-flow 的设计决策」能召回对应 artifact 分节片段；rerank 配置后 top-5 顺序优于纯向量序 |
| Phase 3 | 连续多轮会话压缩后，记忆宫殿出现蒸馏候选，确认后入库可被召回 |
