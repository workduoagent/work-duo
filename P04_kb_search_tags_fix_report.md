# P-04 修复报告：`native__kb_search` tags 语义错位（验证 + 修复落地）

> 来源：外部测试报告 P-04（2026-09-22 阶段三自由会话实测，模型把 KB identifier 塞进 `tags` → 标签圈定 0 命中 → 静默空）
> 结论：**报告属实，全部关键断言经代码核实**；已按其指导意见 ①~④ + §4.5 捷径完成修复，cargo test 沙箱自验通过。

---

## 一、验证结论（逐条实锤）

| 报告断言 | 代码证据 | 结论 |
|---|---|---|
| tags 0 命中 → 静默空 | `knowledge.rs` 标签圈定 `matched.is_empty()` → 直接返回空（原 986-989 行，仅 INFO 日志） | ✅ 属实 |
| 无按库检索入参 | `kb_search` 签名仅 `(kb_ids, query, top_k, full, tags)`；工具 schema 只有 `query/top_k/tags`（native.rs:3204-3208） | ✅ 属实 |
| schema 文案未警告 tags ≠ 库名 | 原 tags 描述只写「资产标签过滤…」，未写「不是 knowledge_base.identifier」 | ✅ 属实 |
| planner 大纲只写 `kb_search(query)` | `planner.rs:174` 能力大纲无 tags/kb_ids 语义说明 | ✅ 属实 |
| 空返回纯文本无诊断 | `native.rs:3256-3258` `return Ok("知识库中未找到与查询相关的片段。")` | ✅ 属实 |
| 调用方收敛 | `knowledge::kb_search` 全仓仅 native.rs 3 处调用（主路径 + 两个 full 重取通路） | ✅ 改动面可控 |
| 前端兼容性 | `parseKbResult`（KbSearchCitations.tsx:60-72）已兼容 `{hits,notice}` 对象形态 → 新结构化空返回不破坏渲染 | ✅ 无需改前端 |

## 二、修复内容（按报告建议顺序）

### ① `knowledge.rs` — 过滤逻辑（P-04 §4.1/4.2）
- `kb_search` 签名新增 `kb_scope: Option<&[String]>`（已解析校验的库 id 收窄集）；生效范围 = scope 优先、否则全部绑定库（**默认=绑定库，防裸搜**）。tags 与库收窄**正交**（先收库、再筛标签）。
- 新增 `resolve_kb_scope(app, bound, requested)`：值可为 `knowledge_base.id` **或 identifier**（统一入口，模型无需二选一）；未识别 → 明确报错；**∉ 绑定库 → 明确报错（越权不静默）**。
- 新增纯函数 `validate_scope_subset`（越权校验，供单测）。

### ② `native.rs` — 工具 schema / description（P-04 §4.4）
- 新增 `kb_ids` 入参（「库 id 或 identifier，须已绑定，越权直接报错；默认省略=全绑定库。**不要把库名填进 tags**」）。
- `tags` 描述硬化：「**不是知识库名/identifier**（按库限定请用 kb_ids）」。
- 主描述补「默认范围为全部已绑定库（可用 kb_ids 收窄）」。

### ③ `native.rs` — 空结果结构化诊断 + 日志（P-04 §4.3）
- 空返回由纯文本改为结构化 JSON：`{hits:[], diagnostics:{reason,tags,note}, notice}`。
  - `reason=tag_filter_miss`：tags 圈定 0 资产（过滤误杀），note 明确提示「tags 是文档 meta_data.tags 标签而非库名；按库用 kb_ids 或给文档打标签」。
  - `reason=no_match`：过滤正确、语义/关键词真无命中，note 提示「确认文档已导入并重建索引」。
- 空结果 WARN 日志带 `reason + tags + bound_kb`，一眼排障；标签圈定命中/未命中日志均带 `scope_kb`。

### ④ `planner.rs` — 能力大纲文案（P-04 §4.4）
- 大纲改为 `native__kb_search(query, kb_ids?, tags?)`：默认全绑定库 / 按库用 kb_ids（id 或 identifier）/ tags 仅文档级标签非库名。

### ⑤ tags-as-kb 兼容捷径（P-04 §4.5.1，把实测失败模式直接转为正确行为）
- 当**未传 kb_ids** 且 tags 值**全部**精确命中绑定库的 id/identifier → 视为按库过滤执行，WARN `deprecated: tags-as-kb` 提示改用 kb_ids。
- 实测失败调用 `tags:["integration-test-kb"]` 修复后 → 直接命中该库返回资料（不再空手）。
- 部分命中/全不命中 → 维持文档标签语义（0 命中时由 tag_filter_miss 诊断兜底说明）。

### ⑥ `docs/skills/workduo-mcp/SKILL.md`（P-04 §4.4 第三副本）
- `agent_list_kbs` 行补语义：「检索默认全绑定库，按库用其 kb_ids 入参传库 id/identifier，tags 仅文档级标签、不是库名」；已同步客户端（MD5 `40a65b37…` 一致）。

## 三、与报告建议的偏差说明（1 处）

| 报告建议 | 实际实现 | 理由 |
|---|---|---|
| 新增两个参数 `kbIds[]` + `kbIdentifier[]` | **合并为一个 `kb_ids[]`**，值同时接受 id 与 identifier（引擎内部解析） | 少一个参数就少一分模型选错的机会——本 bug 的根因恰是「语义相近的参数太多」；单一入口 + 明确 description 更防呆，语义完全覆盖两参数 |

## 四、改动清单

| 文件 | 改动 |
|---|---|
| `src-tauri/src/agent/knowledge.rs` | `KbSearchOutcome`/`KbSearchDiag` 结构体；`resolve_kb_scope` + `validate_scope_subset`；`kb_search` 加 `kb_scope` 参数、返回诊断化 Outcome；标签圈定/双通道日志带 scope |
| `src-tauri/src/agent/native.rs` | schema 加 `kb_ids` + tags 语义硬化；execute 解析/越权校验/tags-as-kb 捷径；空结果结构化诊断 + WARN；两处 full 重取通路适配 |
| `src-tauri/src/agent/planner.rs` | 能力大纲补 kb_ids/tags 语义 |
| `docs/skills/workduo-mcp/SKILL.md` | `agent_list_kbs` 行补检索语义（已同步客户端） |

新增单测：`scope_subset_validation_rejects_unbound_kb`（越权明确报错）、`kb_search_diag_serialization_shape`（诊断序列化形态）。

## 五、回归指引（真机，需 `npm run tauri` 重建后执行）

按报告 §4.6（干净数据，**禁止先 kb_add_tag 掩盖**）：
- **R1** 新建 KB + 含「重试策略」md，不打标签
- **R2** Agent 绑定该 KB 问「重试策略规定」→ 期望命中 ≥1、reply 含 [N] 溯源（默认全绑定库即中）
- **R3** 故意 `tags:["库名"]`（=绑定库 identifier）→ 期望**捷径按库命中**（日志有 deprecated: tags-as-kb），不再静默空
- **R4** `tags:["不存在的标签"]` → 期望 `{hits:[],diagnostics:{reason:"tag_filter_miss",…}}` + WARN 日志，**不得纯文本静默空**
- **R5** `kb_ids:["未绑定库"]` → 期望 InvalidArgs 明确报错；多库绑定传单库 → 只搜该库（日志 scope_kb 单库）

评测断言升级（报告 §4.6）：阶段三「RAG 溯源」从「工具出现」升级为「`tool_finished` result 中 hits>0 或 reply 含 [N]/文档路径」——此为驱动侧改造，随下一轮 E2E 重跑时落地。

## 六、DoD 对照

1. 不打标签的新库，绑定 Agent 问库内事实 → 必命中 ✅（默认=绑定库 +捷径双保险）
2. `tags:["某库identifier"]` → 不再静默空 ✅（捷径命中或 tag_filter_miss 诊断）
3. 工具 description / planner / skill 三处明确「tags ≠ 库」 ✅
4. 空结果可区分「无相关」vs「过滤误杀」 ✅（diagnostics.reason + WARN 日志）
5. 评测断言含 hits>0 或 reply 溯源 🔲（驱动侧，随 E2E 重跑落地）

## 七、生效条件与并行性

- **纯 Rust 改动，需 `npm run tauri` 重建生效**；与你正在写的审批类 P0 改动无文件交集（我未动 mcp_server.rs / commands.rs / events.rs），可同批重建。
- 原报告遗留微缺陷（`events.rs push_event` 判据 `eventType` vs 实际 `type`）未动，仍建议随 P0 批次顺带修。

---

## 八、真机回归结果（2026-09-22 13:14~13:33，重建后）：R1-R5 全 PASS ✅

用户重建上线（MCP 工具 65→68，含其 P0 审批工具）后，经 MCP 驱动全新 Agent（`autoToolExecMode:true`，绑定 KB A+B）实测：

| # | 场景 | 实测证据 | 判定 |
|---|---|---|---|
| R1 | 干净建库+索引（不打标签） | KB A/B 各 1 文件，`资产已索引 chunks=1 embedded=true`，indexedAt 非空 | ✅ |
| R2 | 默认范围事实问答 | 模型仅传 `{"query":…,"top_k":8}`（无过滤）→ 命中 KB A（d0ac8350）→ reply 192 字答「最大 5 次」 | ✅ |
| R3 | **tags 塞库名（原失败模式）** | `native.rs:3268 WARN: kb_search deprecated: tags-as-kb tags=["p04a-…"] → 已按库过滤 scope=["5973be2e-…"]` → 按库命中 + reply 含 `[1]` 引标 | ✅ |
| R4 | tags 不存在 → 误杀诊断 | `knowledge.rs:1077 标签圈定无命中… scope_kb=[B,A] → 返回空（tag_filter_miss）` + `native.rs:3293 WARN kb_search 空结果 reason=tag_filter_miss`；工具返回结构化 `{"diagnostics":{reason,note,tags},"hits":[]}`，模型原文转述 | ✅ |
| R5a | kb_ids 越权 | `ok=false：kb_ids 指定了未绑定到当前智能体的知识库：["b90fd9c2-…"]（已绑定：[…]）` —— identifier→id 解析 + 绑定校验全对 | ✅ |
| R5b | kb_ids 收窄反证 | `kb_ids=[A]` 查 B 库独有内容 → `scope_kb=[5973be2e-…]`（单库！）→ `no_match` 结构化诊断；未误搜 B 库 | ✅ |

**结论：P-04 修复真机闭环，5/5 全绿。** 原静默失败路径（tags 塞库名）已转化为正确行为（捷径按库命中）+ 可观测诊断（误杀/无命中分流）+ 越权明确报错。

### 回归中顺带发现（P0 / 后续，非 P-04 范围）
1. **意图分类仍把 KB 事实问答判为 COMPOSITE_TASK**（P0 意图回归未落地）；当前 COMPOSITE 在 `autoToolExecMode:true` 下可全自跑（plan→exec→done ≈30-60s），外部驱动可经 `agent_submit_plan_decision` 自动放行（本回归即此方式）。
2. **工具 `ok=false` 后 run 卡住不放锁**：R5a 步骤失败后 run 卡 ~6 分钟未到终态（最后流式调用后无下文），需 `agent_cancel_task` 才释放——建议随 P0 排查「失败步骤后的恢复/收尾路径」。
3. **trace 单缓冲并行串台实锤**：两会话并行 run 时 events/reply 混入对方数据（进程级单缓冲已知限制），建议 per-run 缓冲。
4. `agent_wait_task` 存在提前返回 `running` 的情况，外部驱动以 `agent_get_status` 轮询更可靠（本回归即此方式）。

### 回归产物
`p04_verify.mjs` / `p04_verify2.mjs` / `p04_verify3.mjs` / `p04_verify_r5b.mjs` / `p04_logs.mjs`（仓库根，可复用）；留痕资产：KB `p04a/b/c-1790054061922`、Agent `39516822`（v2）/ `dfd3bac2`（v3）及各 session/round。
