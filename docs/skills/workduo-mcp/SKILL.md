---
name: workduo-mcp
description: WorkDuo 桌面应用（Tauri2 + React19）内建 MCP Server 的集成指南。面向外部编程工具（AI IDE / Agent 框架等任意支持 MCP 的客户端），说明如何将 127.0.0.1:18755/mcp（Streamable HTTP）注册为标准 MCP Server，并以 UI 级真实链路驱动 WorkDuo 全模块（Agent 对话 / 本地插件 / 知识库 / 记忆宫殿）。覆盖：56 个工具分层、UI 级各模块流程、插件脚本范式（scripts/）、已知坑与根因修复。
agent_created: true
---

# WorkDuo MCP 集成指南（内建 MCP Server + 外部编程工具对接）

## 概览 / 何时使用

WorkDuo 自身就是一个标准 MCP Server，无需任何 sidecar / Node 进程。启动 WorkDuo 后会在
`127.0.0.1:18755/mcp` 暴露 MCP Streamable HTTP 端点。将端点注册到你的编程工具后，即可通过该工具的
MCP 客户端 **UI 级**驱动 WorkDuo 全模块。

**核心设计：所有操作均为「UI 级真实链路」**——MCP 工具经 Tauri 事件 `mcp:intent` 派发到前端
`src/core/mcpBridge.ts` 的**与界面按钮同一个**真实 handler，走完整 Tauri2 流程
（前端校验 → mapper SQL → tauri-plugin-sql / 或 kbFs 落盘 / 或 Rust 命令），副作用与真人点击
**完全一致**，并且：
1. **全部留痕**：数据落到 workduo.db 的同一张表，用户可在 WorkDuo 界面直接抽查（插件列表、知识库详情、
   记忆宫殿、会话历史等）。
2. **可自动化**：外部编程工具拿到真实可选集（模型/技能/MCP/插件/知识库/记忆）后，可自动装配智能体、
   自动编写插件、自动检索知识库、自动沉淀记忆——同一份工具面既支持人工操作，也支持 Agent 驱动的生态迭代。

触发场景：
- 在任意支持 MCP 的编程工具里接入 WorkDuo 的全部能力（核心诉求：把端点信息记进本 skill）。
- 端到端驱动 Agent 对话链路（意图 → 规划 → 工具 → 回复），尤其验证「知识库有没有被检索」。
- 系统化管理三大模块：**本地插件（百宝箱→插件）编写**、**知识库（创建/导入/编辑/移除/重建索引）**、
  **记忆宫殿（设置→记忆，锚定/更新/删除/召回/蒸馏候选）**，全部 UI 级、全部留痕可抽查。
- 外部 Agent 按需选用现有工具、或自行准备内容（如写插件脚本），实现生态自动迭代。

## 架构要点

- 端点：`POST http://127.0.0.1:18755/mcp`（Streamable HTTP；可选 `GET /mcp` SSE）。
- 开关：`app_config.mcp_server_enabled`（默认启用）、`mcp_server_port`（默认 18755）。改端口/开关需重启 WorkDuo。
- 启动位置：`src-tauri/src/mcp_server.rs::start_mcp_server`，在 app setup 中以独立 std 线程监听。
- 工具分层，共 **56** 个：引擎层(5) + 模块发现层(7) + UI 意图层(44，含 Agent/会话 12 + 插件 8 + 知识库 15 + 记忆 9)。
- 引擎层 + 模块发现层由 Rust 直调；UI 意图层经 `mcp:intent` 派发到 `src/core/mcpBridge.ts` 真实 handler，
  前端 `invoke('mcp_resolve_result', {id, ok, data})` 回传。

## 连接器注册（标准 MCP 接入）

WorkDuo 内建 MCP Server 是标准 Streamable HTTP 端点，可注册到**任意支持 MCP 的编程工具**
（如各类 AI IDE / Agent 框架）。注册入口因工具而异，但核心信息一致：

- 传输类型：Streamable HTTP（不同客户端字段名可能为 `http` / `streamable-http` / `sse`，以你的工具为准）。
- URL：`http://127.0.0.1:18755/mcp`
- 鉴权：无（仅本机回环 `127.0.0.1`，无需 `headers` / `env`）。
- 仅本机可用，**需 WorkDuo 处于运行状态**。

标准 `mcpServers` 配置示例（键名以你所用工具为准）：

```json
{
  "mcpServers": {
    "workduo": {
      "url": "http://127.0.0.1:18755/mcp"
    }
  }
}
```

注册后验证端点存活：

```bash
curl -s -X POST http://127.0.0.1:18755/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

应返回含 56 个工具的 `tools` 数组。

> 注意：部分客户端会缓存工具清单。若改过 Rust 后工具数/签名没刷新，**重新加载该 MCP Server 连接**即可；
> 也可直接打上面的 `tools/list` 端点绕过缓存核对。

---

## 工具清单（52 个，按层）

### A. 引擎层（Rust 直调，无需前端）
| 工具 | 作用 | 关键入参 |
|---|---|---|
| `agent_run_task` | 运行 Agent 任务，返回 `run_id`（复用 `run_task_ex`） | `agentId`(主键 id) / `prompt` / `workspace`(=绑定工作空间的绝对路径,不传则自由对话) / `sessionId` / `roundId` / `attachments` 等 |
| `agent_get_status` | 查询 `run_id` 当前状态 / 轨迹快照 | `run_id` |
| `agent_wait_task` | 轮询等待 `run_id` 终态（done/error） | `run_id` / `timeout_ms` |
| `agent_get_run_logs` | 增量读 Rust 运行日志 | `cursor` / `since_ts` / `level` / `limit` |
| `agent_get_run_trace` | 取本 run 轨迹缓冲：`{events, thinking, reply, counts}` | 无（进程级缓冲，最近一次 run） |

### B. 模块发现层（Rust 直读 workduo.db，零业务副作用）
| 工具 | 作用 |
|---|---|
| `agent_list_models` | 模型（含 `config`=默认参数副本；大脑须 `category∈{text,multimodal}` 且 `enabled=1`） |
| `agent_list_skills` | 技能（≤3） |
| `agent_list_mcps` | 已接入 MCP 服务 |
| `agent_list_mcp_tools` | 某 MCP 下工具（入参 `mcp_id`）；`mcpTools` 以 `{mcpId, toolId}` 为最小单元 |
| `agent_list_plugins` | 本地插件（≤10） |
| `agent_list_kbs` | 知识库（绑定后获得 `native__kb_search`） |
| `agent_list_scenarios` | 场景分类（取 `value`） |

### C. UI 意图层 — Agent 与会话（派发前端真实 handler）
| 工具 | 作用 | 关键入参 |
|---|---|---|
| `agent_ui_create` / `agent_ui_update` | 创建/更新 Agent（须先调各 `agent_list_*` 取真实可选集） | `payload`(AgentUpsertInput) |
| `agent_ui_delete` / `agent_ui_get` / `agent_ui_list` | 删除/查询/列出 Agent | `id` / 无 |
| `agent_session_create` | 新建会话（=对话页「新建对话」） | `payload={agentIdentifier, sessionName?, projectId?}` |
| `agent_round_create` | 追加一轮（=对话页「发送」） | `payload={sessionId, llmCode?, roundIndex, userQuestion?, startTime?}` |
| `agent_round_update` | 回填一轮结果到 UI | `payload={roundId, patch?}` |
| `agent_session_update` | 更新会话状态（置 COMPLETED/ERROR） | `payload={id, patch?}` |
| `agent_session_list` / `agent_session_get` / `agent_round_list` | 列会话/查会话/列轮次 | `agentIdentifier` / `id` / `sessionId` |

### D. UI 意图层 — 本地插件模块（百宝箱 → 插件）
| 工具 | 作用 | 关键入参 |
|---|---|---|
| `plugin_list` | 列全部插件（FaaS） | `scenario?` |
| `plugin_get` | 按 id 查插件（含脚本） | `id` |
| `plugin_upsert` | **编写/增/改**插件（id 空=新建） | `name`/`identifier`/`description`/`runtime`(`python`\|`bun`)/`scriptContent`/`parametersSchema` + `dependencies?`/`sampleParams?`/`timeoutSec?`/`scenario?` |
| `plugin_delete` | 真实删除插件（级联清 ref） | `id` |
| `plugin_set_enabled` | 启用/禁用 | `id` / `enabled` |
| `plugin_test` | 端到端试跑（沙箱执行） | `pluginId` / `params?` |
| `plugin_extract_meta` | 从头注释解析元数据（不落库） | `runtime` / `script` |
| `plugin_list_run_logs` | 列执行日志 | `pluginId` / `limit?` |

> ⚠️ 插件 runtime **只有 `python` 与 `bun`**（TypeScript），**没有 `node`**。用户说的「Node」对应 `bun`。
> 脚本范式见本 skill 的 `scripts/` 目录（`plugin.python.template.py` / `plugin.bun.template.ts`）。

### E. UI 意图层 — 知识库模块
| 工具 | 作用 | 关键入参 |
|---|---|---|
| `kb_list` | 列全部知识库 | `scenarioFilter?` |
| `kb_get` | 按 id 查知识库（含 path） | `id` |
| `kb_create` | 新建知识库（建目录+写行+扫资产） | `identifier`/`name`/`description?`/`logo?`/`scenario?` |
| `kb_update` | 编辑元数据（identifier 变则改名目录） | `id`/`identifier?`/`name`/`description?`/`logo?`/`scenario?` |
| `kb_delete` | 删除知识库（级联清向量段+目录） | `id` |
| `kb_list_assets` | 列资产 | `kbId` |
| `kb_add_file` | 新增文本文件 + 触发增量索引 | `kbId`/`relPath`/`content` |
| `kb_import_file` | 导入二进制文件（base64）+ 触发索引 | `kbId`/`relPath`/`base64` |
| `kb_create_folder` | 建文件夹（仅落盘） | `kbId`/`relPath` |
| `kb_remove_file` | 移除文件/目录（删盘+清库+删向量段） | `kbId`/`relPath` |
| `kb_rebuild_index` | 全量重建索引（异步，进度走事件） | `kbId` |
| `kb_add_tag` | **打标签·增**：给资产追加标签（幂等，已存在忽略） | `kbId`/`assetId`/`tag` |
| `kb_remove_tag` | **打标签·删**：从资产移除标签 | `kbId`/`assetId`/`tag` |
| `kb_rename_tag` | **打标签·改**：资产内标签改名（保序） | `kbId`/`assetId`/`from`/`to` |
| `kb_get_tags` | **打标签·查**：读取资产当前全部标签（Agent 判读/检索用） | `kbId`/`assetId` |

> 索引机制：`kb_chunks` 为 LanceDB 向量表，真实 chunk id 格式 = `{asset_id}#{chunk_index}`
> （`knowledge.rs` 构造，非设计文档所述 `kb_id/...`）。移除文件按 `kb_id='..' AND asset_id='..'` 删段；
> 重建索引逐资产 force 重切重嵌。

### F. UI 意图层 — 记忆宫殿模块（设置 → 记忆宫殿）
| 工具 | 作用 | 关键入参 |
|---|---|---|
| `memory_list` | 列记忆（全局视图） | `agentId?`/`category?`/`query?` |
| `memory_heatmap` | 按日召回热力图 | `agentId?` |
| `memory_anchor` | **锚定/编写**记忆（UPSERT） | `key`/`content`/`category?`(`default 'other'`)/`agentId?`/`sessionId?`/`anchored?` |
| `memory_update` | 编辑记忆（仅更新非空字段） | `id`/`key?`/`content?`/`category?` |
| `memory_delete` | 删除记忆（级联清事件+向量） | `id` |
| `memory_recall` | 手动召回 +1 | `id` |
| `memory_list_candidates` | 列蒸馏候选（pending） | 无 |
| `memory_confirm_candidate` | 采纳候选（转记忆） | `id` |
| `memory_reject_candidate` | 忽略候选 | `id` |

> ⚠️ `agent_memories.category` SQL 默认 `'general'`，但 Rust/前端枚举是 `'other'`。写入务必显式传
> `category`（如 `'other'`），不要依赖默认值，否则存量数据会出现枚举外的 `'general'`。
> 记忆宫殿即 `agent_memories` 表的用户管理台（与 `.wd_mem` 工程记忆是两套存储）。

---

## 各模块 UI 级流程

### 流程 1：Agent 对话驱动（结果可抽查）
1. `agent_ui_list` → 取目标 Agent 的 `identifier`（给 session_create）与 `id`（给 run_task）。
2. `agent_session_create` `{agentIdentifier, sessionName?}` → 取 `session.id`。
3. `agent_round_create` `{sessionId, roundIndex:0, userQuestion:"..."}` → 取 `round.id`。
4. `agent_run_task` `{agentId:<id 主键>, prompt, sessionId, roundId, workspace}` → `{run_id}`。`workspace` 传**真实目录绝对路径**即把 Agent 绑定到该工作空间（不传则自由对话沙盒）。
5. `agent_wait_task` `{run_id, timeout_ms:120000}`。
6. `agent_get_run_trace` → 查 `events` 有无 `native__kb_search`、`thinking`、`reply`。
7. `agent_round_update` `{roundId, patch:{assistantAnswer, thinkingContent, ...}}`（不回填则 UI 历史看不到正文）。
8. `agent_session_update` `{id, patch:{status:"COMPLETED"}}`。
9. `agent_session_get` / `agent_round_list` 核对持久化。

### 流程 2：插件编写（百宝箱 → 插件）
1. 读本 skill `scripts/plugin.python.template.py` 或 `plugin.bun.template.ts`，复制并改写 `run(params)`。
2. （可选）`plugin_extract_meta` `{runtime, script}` 预览元数据。
3. `plugin_upsert` `{name, identifier, description, runtime('python'|'bun'), scriptContent, parametersSchema, dependencies?, timeoutSec?, scenario?}`。
4. `plugin_test` `{pluginId, params}` 端到端试跑，核对返回的 `result`/`stdout`/`exitCode`。
5. 绑定到 Agent：`agent_ui_update.payload.pluginIds=[<pluginId>]`（≤10）。
6. `plugin_list` / `plugin_get` 核对已落库（前端插件列表可直接抽查）。

### 流程 3：知识库管理
1. `kb_create` `{identifier, name, description?, scenario?}` → 取 `kb.id`。
2. `kb_add_file` `{kbId, relPath:"docs/readme.md", content:"# ..."}` 或 `kb_import_file` `{kbId, relPath, base64}`。
3. 若需整库重嵌：`kb_rebuild_index` `{kbId}`（异步，进度走 `agent-kb-index-progress` 事件）。
4. `kb_list_assets` `{kbId}` 核对资产与 `indexedAt` 已填充。
5. 移除文件：`kb_remove_file` `{kbId, relPath}`（自动同步删向量段）。
6. **打标签（文档级，存 `knowledge_asset.meta_data.tags`）**：
   > 标签归属于**当前文档（资产）**——在 KB 详情页选中文档后打的标签只属于该文档，不是全库共享。
   > 因此 CRUD 必须带 `assetId`（目标文档的资产 id，经 `kb_list_assets` 取），与详情页「选中文件→标签面板」完全一致。
   - 先 `kb_list_assets` `{kbId}` 取目标资产 `id`。
   - 查：`kb_get_tags` `{kbId, assetId}` → `{assetId, tags}`（Agent 判读/检索某文件主题用；也可直接从 `kb_list_assets` 的 `metaData.tags` 读）。
   - 增：`kb_add_tag` `{kbId, assetId, tag}`（已存在幂等忽略，返回 `{ok,existed,tags}`）。
   - 改：`kb_rename_tag` `{kbId, assetId, from, to}`（文档内改名，保序）。
   - 删：`kb_remove_tag` `{kbId, assetId, tag}`（从 tags 过滤，返回 `{ok,removed,tags}`）。
7. `kb_list` / `kb_get` 核对（前端知识库详情页可直接抽查）。

### 流程 4：记忆宫殿管理（设置 → 记忆）
1. `memory_anchor` `{key, content, category?('other'), agentId?, sessionId?}` 新增/更新一条记忆。
2. `memory_list` / `memory_heatmap` 核对。
3. 蒸馏候选：`memory_list_candidates` → `memory_confirm_candidate` / `memory_reject_candidate`。
4. 召回演示：`memory_recall` `{id}`。

---

## 外部 Agent 如何自助驱动（生态迭代）

本工具面的设计目标之一：**让外部 Agent 也能像人类一样 UI 级驱动 WorkDuo，实现生态自助迭代**。
建议顺序：

1. **先看清可选集**：调模块发现层（`agent_list_*` / `plugin_list` / `kb_list` / `memory_list`）
   读取 workduo.db 真实状态——这是「看到能做什么、有哪些可选值」的唯一权威来源。
2. **按需选用或自助准备**：
   - 装配智能体 → 走流程 1 的 `agent_ui_create`（先 list 再组装 `payload`）。
   - 需要新能力 → 用 `plugin_upsert` 编写插件（参考 `scripts/` 范式），再绑到 Agent。
   - 需要知识 → 用 `kb_*` 建库/导文件/重建索引，再绑到 Agent 获得 `native__kb_search`。
   - 需要长期记忆 → 用 `memory_anchor` 沉淀。
3. **操作后必回填验证**：每次写操作后，重新调用对应的 list/get 工具核对变更已落到同一张表
   （即 UI 读取的表），确保**留痕可抽查**。例如 `plugin_upsert` 后 `plugin_get` 确认、`kb_add_file`
   后 `kb_list_assets` 确认 `indexedAt` 非空。
4. **删除的纪律（红线）**：`plugin_delete` / `kb_delete` / `memory_delete` 都是**真实不可逆删除**。
   - 必须**显式传入 id**，绝不批量/静默删除。
   - 示例数据清理请**故意、显式**地进行，以便人工抽查留痕；不允许「随意删除示例数据」。
   - 不确定时优先用「新增一条带 `demo_` 前缀的标记数据 + 事后再显式删」的方式，而非就地覆盖/抹除。

---

## 前端日志透传（前端操作统一留存到后端日志）

WorkDuo 的知识库等模块大量逻辑在**前端 TS** 完成（kbFs 落盘、索引钩子、mapper 聚合）。为让后端排错时也能看到前端链路，
新增**前端 → 后端日志透传**：

- Rust 命令 `logging::log_frontend(level, module, message)`（`src-tauri/src/logging.rs`）把前端日志以与 `tracing`
  **完全一致**的格式落同一份每日滚动文件：
  `[时间][模块][fe][web:0]-LEVEL-内容`
  因此 `agent_get_run_logs` 的 `since_ts` / `level` 过滤对前端日志同样生效。
- 前端桥 `src/core/logBridge.ts` 暴露 `fe.info/warn/error/debug(module, msg)`，内部 `invoke('log_frontend', …)`，
  **fire-and-forget（失败静默，绝不影响业务）**。
- 已埋点模块：`kbFs`（写/删/扫）、`kb-index`（sync/remove 触发点）、`knowledge-mapper`（create/delete/syncAssets）、
  `mcpBridge`（`kb:*` 意图入口）；前端日志的模块字段形如 `kbFs` / `kb-index` / `kb` / `mcpBridge.kb`。

**用法**：跑完 UI 级操作后，调 `agent_get_run_logs`（或直接看 `workduo.log.YYYY-MM-DD`）即可一并看到 `[fe]` 前端行，
与 Rust 原生日志交叉比对定位「前端做了什么、Rust 侧索引是否跟上」。

## 标准驱动脚本

本 skill 的 `scripts/kb_driver.mjs`（纯 Node 标准库，无需依赖）直连 `127.0.0.1:18755/mcp`，覆盖
`kb_create → kb_add_file → kb_rebuild_index（轮询 indexedAt）→ kb_list_assets → agent_get_run_logs`，
并打印最近 60 行后端日志（含 `[fe]` 前端透传行）。用法（在 skill 目录下执行）：

```bash
node scripts/kb_driver.mjs
```

> 注意：UI 级工具（如 `kb_*` / `plugin_*` / `memory_*` / `agent_ui_*`）经 `dispatch_ui` 统一回包 **`{ok,data}` 信封**，
> 驱动解析时务必 `unwrap .data` 才是真实载荷（首版驱动曾因未拆 data 取不到 `kb_create` 的 `id`）。

## 已知坑与根因修复（改完需 `npm run tauri` 重新构建才生效）

1. **意图分类 100% 失准（SIMPLE_CHAT）**：`intent.rs::extract_content` 旧逻辑按 LLM envelope
   （`choices[0].message.content`）解析，但 `call_llm` 运行时返回**已归一化的 message 对象**（无 `choices`
   键）→ 取空 → 一律 SIMPLE_CHAT。**修复**：改读 `resp["content"]`。
2. **KB 从不检索**：`run_simple_chat` 传 `&[]` 空工具集 → `native__kb_search` 永不调用。**修复**
   （`runtime.rs`）：Agent 绑定 KB 且 intent==SIMPLE_CHAT 时强制 COMPOSITE_TASK + requires_tool/planning。
3. **HTTP 响应被截断**：早期手写 HTTP 在 body 前多写一行 `\r\n` → `Content-Length` 错 → 严格客户端截断。
   **修复**：严格单 `\r\n\r\n` 分隔。
4. **`agent_run_task` 入参命名**：Rust `RunAgentTaskInput` 是 `camelCase`，MCP schema 须暴露 `agentId`
   （非 `agent_id`）。
5. **`agentId` 取值**：`run_task_ex` 内部 `WHERE id = ?`，故 `agentId` 必须传**主键 `id`**（来自
   `agent_ui_list` 的 `id`），不是 `identifier`；而 `agent_session_create.agentIdentifier` 才是 `identifier`。
6. **插件 runtime 无 `node`**：只 `python`/`bun`；外部 Agent 设 `node` 会校验失败，TS 脚本用 `bun`。
7. **记忆 category 默认不一致**：SQL 默认 `'general'`，枚举是 `'other'`；`memory_anchor` 必须显式传 `category`。
8. **`kb_chunks.id` 真实格式** = `{asset_id}#{chunk_index}`（`knowledge.rs` 构造），与设计文档
   `kb_id/...` 描述不符；引用知识库内容时以此为准。
9. **squad_orchestrator.rs 有同类 envelope 解析 bug**（同源 #1），squad 模式不在本 skill 范围，暂未修。
10. **UI 级工具回包统一 `{ok,data}` 信封**：`kb_*` / `plugin_*` / `memory_*` / `agent_ui_*` 经 `dispatch_ui` 返回
   `{ok,data}`，驱动须 `unwrap .data`；引擎层工具（agent_run_task 等）直返原始结构，不套信封。
11. **前端日志已透传到后端**：`kbFs`/`kb-index`/`knowledge-mapper`/`mcpBridge(kb:*)` 的关键操作会经 `log_frontend`
   落到同一份 Rust 日志（`[时间][模块][fe][web:0]-LEVEL-内容`），`agent_get_run_logs` 可一并回看——排 KB 问题优先看
   这些 `[fe]` 行确认「前端写盘/触发索引」是否真发生。KB 驱动见 `scripts/kb_driver.mjs`。
12. **`agent_run_task.workspace` = 绑定工作空间**：传真实目录绝对路径即把 Agent 绑定到该工作空间（不传=自由对话沙盒）。外部工具按需在调用时带上即可。

## 集成核对清单

- [ ] `tools/list` 返回 56 个工具（引擎 5 + 发现 7 + UI 44）。
- [ ] 端口 18755 有监听；外部编程工具已成功连上该 MCP Server。
- [ ] 绑定 KB 的 Agent 跑「kb_chunks 的 id 字段格式是什么？」→ trace events 出现 `native__kb_search`，reply 引用 KB。
- [ ] `plugin_upsert` 编写插件后 `plugin_test` 返回 `ok:true`；前端插件列表可见。
- [ ] `kb_create`+`kb_add_file`+`kb_rebuild_index` 后 `kb_list_assets` 的 `indexedAt` 非空。
- [ ] `memory_anchor` 后 `memory_list` 可见该记忆；`category` 为显式传入值。
- [ ] 所有写操作均可经对应 list/get 工具或 WorkDuo 界面抽查（留痕）。
