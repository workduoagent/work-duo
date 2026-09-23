---
name: workduo-mcp
description: WorkDuo 桌面应用（Tauri2 + React19）内建 MCP Server 的集成指南。面向外部编程工具（AI IDE / Agent 框架等任意支持 MCP 的客户端），说明如何将 127.0.0.1:18755/mcp（Streamable HTTP）注册为标准 MCP Server，并以 UI 级真实链路驱动 WorkDuo 全模块（Agent 对话 / 本地插件 / 知识库 / 记忆宫殿 / 技能中心）。覆盖：65 个工具分层、UI 级各模块流程、插件脚本范式（scripts/）、已知坑与根因修复。
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
- 系统化管理四大模块：**本地插件（百宝箱→插件）编写**、**知识库（创建/导入/编辑/移除/重建索引）**、
  **记忆宫殿（设置→记忆，锚定/更新/删除/召回/蒸馏候选）**、**技能中心（设置→技能中心，创建/编辑/删除/启停/文件读写/导入导出）**，
  全部 UI 级、全部留痕可抽查。
- 外部 Agent 按需选用现有工具、或自行准备内容（如写插件脚本），实现生态自动迭代。

## 架构要点

- 端点：`POST http://127.0.0.1:18755/mcp`（Streamable HTTP；可选 `GET /mcp` SSE）。
- 开关：`app_config.mcp_server_enabled`（默认启用）、`mcp_server_port`（默认 18755）。改端口/开关需重启 WorkDuo。
- 启动位置：`src-tauri/src/mcp_server.rs::start_mcp_server`，在 app setup 中以独立 std 线程监听。
- 工具分层，共 **70** 个：引擎层(9) + 模块发现层(7) + UI 意图层(54，含 Agent/会话 12 + 插件 8 + 知识库 15 + 记忆 9 + 技能 10)。
- 引擎层 + 模块发现层由 Rust 直调；UI 意图层经 `mcp:intent` 派发到 `src/core/mcpBridge.ts` 真实 handler，
  前端 `invoke('mcp_resolve_result', {id, ok, data})` 回传。技能模块同样走此「UI 意图层」——`skill:*` 意图
  由 `mcpBridge` 路由到与 skill-hub 页面**同一个**真实 handler（`skill-mapper` + `skillFs`，落盘先行再入库）。

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

应返回含 70 个工具的 `tools` 数组。

> 注意：部分客户端会缓存工具清单。若改过 Rust 后工具数/签名没刷新，**重新加载该 MCP Server 连接**即可；
> 也可直接打上面的 `tools/list` 端点绕过缓存核对。

---

## 工具清单（70 个，按层）

### A. 引擎层（Rust 直调，无需前端）
| 工具 | 作用 | 关键入参 |
|---|---|---|
| `agent_run_task` | 运行 Agent 任务，返回 `run_id`（复用 `run_task_ex`） | `agentId`(主键 id) / `prompt` / `workspace`(=绑定工作空间的绝对路径,不传则自由对话) / `sessionId` / `roundId` / `attachments` 等 |
| `agent_get_status` | 查询 `run_id` 状态（含审批挂起详情：`waitingApproval`/`pending`）。**终态三态（2026-09-23 起）**：`done`（正常完成）/ `error`（超时或预算耗尽，`error` 字段带 `run_budget_exhausted` 等结构化原因）/ `cancelled`（用户取消，error=`cancelled_by_user`） | `run_id` |
| `agent_wait_task` | 轮询终态；卡在审批时带 `interrupted=true` 提前返回 | `run_id` / `timeout_ms` |
| `agent_submit_approval` | 回传高危工具审批决策（approve/skip/takeover） | `approvalId`/`decision`(+`agentId`/`guidance`/`remember`/`grantKey`) |
| `agent_submit_plan_decision` | 回传计划审批门禁决策（approve/reject/revise） | `decision`(+`agentId`/`guidance`) |
| `agent_submit_recovery_decision` | 回传步骤级恢复决策（子任务失败重试耗尽后的恢复门禁；不回应则 run 永久挂起） | `decision`(retry/skip/takeover/change-approach)+`guidance?`(+`agentId`) |
| `agent_cancel_task` | 取消指定 Agent 的当前任务 | `agentId?` |
| `agent_get_run_logs` | 增量读 Rust 运行日志 | `cursor` / `since_ts` / `level` / `limit` |
| `agent_get_run_trace` | 取**指定 run** 的轨迹缓冲；**返回外层是 `{"run_id":..., "trace":{...}}` 包裹**，取字段须先剥 `trace` 层：`r.trace.{events, thinking, reply, counts}`。#8 per-run：必须传 `run_id`（由 `agent_run_task` 返回的 `run_id`），按 run 取独立桶，**并发 run 互不串台**；不传则返回空桶 | `run_id`（必填，来自 `agent_run_task` 返回） |

### B. 模块发现层（Rust 直读 workduo.db，零业务副作用）
| 工具 | 作用 |
|---|---|
| `agent_list_models` | 模型（含 `config`=默认参数副本；大脑须 `category∈{text,multimodal}` 且 `enabled=1`） |
| `agent_list_skills` | 技能（≤3） |
| `agent_list_mcps` | 已接入 MCP 服务 |
| `agent_list_mcp_tools` | 某 MCP 下工具（入参 `mcp_id`）；`mcpTools` 以 `{mcpId, toolId}` 为最小单元 |
| `agent_list_plugins` | 本地插件（≤10） |
| `agent_list_kbs` | 知识库（绑定后获得 `native__kb_search`；检索默认全绑定库，按库用其 `kb_ids` 入参传库 id/identifier，`tags` 仅文档级标签、不是库名） |
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

### G. UI 意图层 — 技能中心模块（设置 → 技能中心 / skill-hub）
| 工具 | 作用 | 关键入参 |
|---|---|---|
| `skill_list` | **枚举全部技能**（本模块唯一枚举入口，无入参），返回 `{count, rows}`。发现已有技能后再用 `skill_get` / `skill_list_files` 深入；其余模块均有 `*_list`，本工具补齐前技能模块缺失此能力 | 无 |
| `skill_get` | 按 id 查单个技能（含 `skillMarkdown` 正文与 `path`） | `id` |
| `skill_upsert` | **创建/编辑**技能并落盘（SKILL.md + 脚本 + 资源）：`skill` 必填 `identifier`/`name`；可选 `scripts:[{name,language,content}]`、`resources:[{name,dir,base64}]`（dir 为空=根目录）。落盘先行再入库，与 skill-hub 页面完全一致 | `skill` / `scripts?` / `resources?` |
| `skill_delete` | **真实删除**技能（删库行 + 删磁盘目录），不可逆 | `id` |
| `skill_set_status` | 启用/禁用（卡片右上角 Switch；`status`: 1 启用 / 0 禁用） | `id` / `status` |
| `skill_list_files` | 列技能目录下文件树（目录优先、同名排序） | `identifier` / `skillPath?` |
| `skill_read_file` | 读技能目录下某文件，返回 `base64` | `identifier` / `relPath` / `skillPath?` |
| `skill_write_file` | 覆盖写入技能目录下某**文本**文件 | `identifier` / `relPath` / `content` / `skillPath?` |
| `skill_export` | 把技能目录打包为 ZIP，返回 `base64`（导出/备份） | `identifier` / `skillPath?` |
| `skill_import` | **导入**技能并落盘+入库：`identifier`/`name` 必填；可选 `description`/`scenario`/`tags`/`skillMarkdown`/`zipBase64`/`files:[{relPath,base64}]`（与导入弹窗同款：SKILL.md→`skillMarkdown`，`logo.*`→根目录；`instruction` 保持为空、不与 SKILL.md 混用） | `identifier` / `name` / `zipBase64?` / `files?` |

> ⚠️ **`instruction` 与 `skillMarkdown` 是两个独立字段**：`skillMarkdown` 落盘为 `<identifier>/SKILL.md`；
> `instruction` 仅入库、不写文件、可选。导入/编写时请分别维护，不要用 SKILL.md 内容去填 `instruction`。
> ⚠️ 本模块与插件/KB/记忆同源走「UI 意图层」：`skill_*` 经 `mcp:intent` 派发到 `mcpBridge` 的 `skill:*` 分支，
> 复用 `src/core/mapper/skill-mapper.ts` + `src/core/file/skillFs.ts` 真实 handler，副作用与在 skill-hub 界面操作完全一致、可抽查。

---

## 各模块 UI 级流程

### 流程 1：Agent 对话驱动（结果可抽查）
1. `agent_ui_list` → 取目标 Agent 的 `identifier`（给 session_create）与 `id`（给 run_task）。
2. `agent_session_create` `{agentIdentifier, sessionName?}` → 取 `session.id`。
3. `agent_round_create` `{sessionId, roundIndex:0, userQuestion:"..."}` → 取 `round.id`。
4. `agent_run_task` `{agentId:<id 主键>, prompt, sessionId, roundId, workspace}` → `{run_id}`。`workspace` 传**真实目录绝对路径**即把 Agent 绑定到该工作空间（不传则自由对话沙盒）。
5. `agent_wait_task` `{run_id, timeout_ms:120000}`。
6. `agent_get_run_trace` `{run_id}` → 返回 `{"run_id":..., "trace":{events,thinking,reply,counts}}`（**先剥 `trace` 层**再取字段）；查 `trace.events` 有无 `native__kb_search`、`trace.reply` 是否非空。#8 per-run 后**必须传 `run_id`**，否则取空桶。
7. `agent_round_update` `{roundId, patch:{assistantAnswer, thinkingContent, ...}}`（不回填则 UI 历史看不到正文）。
8. `agent_session_update` `{id, patch:{status:"COMPLETED"}}`。
9. `agent_session_get` / `agent_round_list` 核对持久化。

### 流程 1.1：挂起与放行（HITL，外部 Agent 自主应答）
> **门禁策略（`planAutoApproveMode`，装配 Agent 时显式指定）**：`'always'`=每次计划都人工确认（默认，最严格）｜`'sensitive'`=仅含敏感操作的计划需确认｜`'never'`=计划自动放行、全自动执行（**外部无人值守驱动推荐**——否则每轮复合任务都会卡计划门禁）。注意：计划门禁只是三层挂起之一，选 `never` 后高危工具审批与恢复门禁仍独立生效。
触发条件：`agent_wait_task` 返回 `interrupted=true` 且 `waitingApproval=true`，或 `agent_get_status` 出现 `pending`/`recoveryWaiting`（任务卡在高危工具审批、计划门禁或恢复门禁）。此时**不要重试 run_task**，而是按 `pending.kind` 应答：
1. 读 `pending`：`{kind:"tool", request:{approvalId, toolName, description, args, kind, hint}}`、`{kind:"plan", goal, stepCount}` 或 `{kind:"recovery", request:{step, title, reason, summary, tier, …}}`。
2. 高危工具审批（kind=tool）→ `agent_submit_approval` `{approvalId, decision}`（`approve`/`skip`/`takeover`，takeover 带 `guidance`；同信号想免重复询问可加 `remember:true`+`grantKey`）。
3. 计划门禁（kind=plan）→ `agent_submit_plan_decision` `{decision}`（`approve`/`reject`/`revise`，revise 带 `guidance`）。
4. 恢复门禁（kind=recovery，`recoveryWaiting=true`）→ `agent_submit_recovery_decision` `{decision}`（`retry`/`skip`/`takeover`/`change-approach`，takeover 与 change-approach 带 `guidance`；reason 已含失败摘要，判断不了就 `skip` 让流水线继续）。
5. 应答后再次 `agent_wait_task` / `agent_get_status` 继续轮询，直到 `status` 变 `done`/`error`（同一挂起可能多次出现：每步都可能触发）。
6. 卡死/想中止 → `agent_cancel_task` `{agentId}`。
> 说明：MCP 决策与前端弹窗**同源**（同一 Hub），UI 点「允许/跳过」和外部 Agent 调 `agent_submit_*` 效果一致、幂等。恢复门禁在 `get_status` 以 `recoveryWaiting=true` + `pending.kind='recovery'` 透出（2026-09-22 起支持）。

### 流程 2：插件编写（百宝箱 → 插件）
1. 读本 skill `scripts/plugin.python.template.py` 或 `plugin.bun.template.ts`，复制并改写 `run(params)`。
2. （可选）`plugin_extract_meta` `{runtime, script}` 预览元数据。
3. `plugin_upsert` `{name, identifier, description, runtime('python'|'bun'), scriptContent, parametersSchema, dependencies?, timeoutSec?, scenario?}`。
4. `plugin_test` `{pluginId, params}` 端到端试跑，核对返回的 `result`/`stdout`/`exitCode`。
5. 绑定到 Agent：`agent_ui_update.payload.pluginIds=[<pluginId>]`（≤10）。
6. `plugin_list` / `plugin_get` 核对已落库（前端插件列表可直接抽查）。

### 流程 2.1：产物契约（xlsx / 图表类硬约定，2026-09-23 L2 实测补）
> 用户要 `.xlsx` / 走势图等**二进制产物**时：**禁止让 Agent 手写二进制**（L2 实测 A-M2 产物 0%）。
> 必须经 `plugin_upsert` 装配官方模板（或复用已绑定插件）→ `plugin_test` → Agent 调用生成：
> - **Excel**：`scripts/plugin.xlsx_writer.template.py`——入参 `{outPath, sheets: {sheetName: [["cell",...],...]}}`（支持 `{headers:[...], rows:[...]}` 形态）；
> - **图表 PNG**：`scripts/plugin.chart_png.template.py`——入参 `{outPath, kind:'line'|'bar'|'scatter', ys, xs?, title?, xLabel?, yLabel?}`（Agg 后端，无显示环境可用）。
>
> 硬约定：输出路径必须是 **workspace 相对路径**；文件名与用户要求**逐字一致**；缺依赖走 Runner exit 42 自愈（`dependencies` 头注释已声明 openpyxl / matplotlib）。

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

### 流程 5：技能中心管理（设置 → 技能中心）
0. **先发现**：`skill_list`（无入参）枚举全部技能，取 `rows[].identifier` / `id` 后再深入——`skill_get` 等都需要已知 id/identifier，没有列表入口时外部无法起步。
1. `skill_upsert` `{skill:{identifier,name,description?,scenario?,tags?,skillMarkdown?}, scripts?, resources?}` 新建/编辑技能（自动落盘 `<identifier>/SKILL.md` + 脚本 + 资源）。
2. 核对：`skill_get` `{id}` 看 `skillMarkdown` / `path`；`agent_list_skills` 看是否已进可选集（装配 Agent 时 `enabledSkillIds` 引用）。
3. 文件级微调：`skill_list_files` `{identifier}` 看结构 → `skill_read_file` `{identifier, relPath}` 取内容（base64）→ `skill_write_file` `{identifier, relPath, content}` 改后回写。
4. 启停：`skill_set_status` `{id, status:0|1}`（禁用后该技能不进引擎工具集）。
5. 导入/导出：`skill_import` `{identifier, name, zipBase64|files}` 从包导入；`skill_export` `{identifier}` 取 ZIP base64 备份。
6. 删除（红线，真实不可逆）：`skill_delete` `{id}`（删库行 + 删磁盘目录）；必须显式传 `id`，不批量/静默删。

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

本 skill 的 `scripts/` 目录提供可循环利用的标准驱动（纯 Node 标准库，无需依赖，直连 `127.0.0.1:18755/mcp`）：

| 脚本 | 作用 |
|---|---|
| `agent_task_driver.mjs` | **标准驱动库**（ESM import 复用）：MCP 客户端 / 终态轮询 + 三类挂起自动应答（计划审批·工具审批·恢复门禁）/ 轨迹解包 `traceInner` / KB 事件提取 / 增量日志。**新驱动一律 import 本库，禁止复刻客户端逻辑** |
| `agent_e2e_audit.mjs` | **全模块四阶段评分审计**（100 分制：P1 发现 → P2 KB+插件装配 → P3 RAG 快路径/捷径/诊断 → P4 复合产物磁盘穿透 + 留痕一致性），报告写 cwd `e2e_audit_report.json` |
| `agent_intent_probe.mjs` | **意图探针**：KB 事实问答核验「SIMPLE_CHAT 快路径 + 检索命中」（`PROBE_KB_ID` 指定已索引 KB，exit 0 = PASS） |
| `tool_contract_probe.mjs` | **工具契约边界防御探针**（L2 pillar②）：轰「坏入参」断言快速结构化拒绝——缺必填 / 非法枚举(node) / 越界引用 / 空标识 / 未知审批 / 超大文本；含 `memory_anchor` 缺 category 漂移观测（已知坑#7，记 WARN）。exit 0=全拒绝 / 1=有违反(挂死或静默接受) / 2=含已知漂移 | `node tool_contract_probe.mjs`（**无需模型**，坏入参在校验层拒绝） |
| `kb_driver.mjs` | KB 全链路回归（create→add_file→rebuild→list_assets→logs） |
| `l2_eval_harness.mjs` | **L2 生态测评编排**（并发+故障注入+三维评分）：`env` / `run --cases A-M1,B-M1 [--concurrency N]` / `inject --fault F-1` / `score`。案例目录 A/B×M/H 覆盖爬取/ETL/全栈/MCP聚合器。工作空间默认 `E:/Codes/ABC/work-duo/eval-workspace/`。**run 预算（2026-09-23 已修复）**：默认 1800s + 预算前 30s 软窗口（停止发起新步骤、在途收尾）；超时终态 `error` + `error=run_budget_exhausted` + reply 含已产出文件表；取消为独立终态 `cancelled`。超时判据看终态与产物，不用「慢=死」 |

驱动约定（详见 `scripts/README.md`）：驱动只做参数编排与断言，**能力缺口回流 SKILL+MCP 层**；`agent_get_run_trace` 用 `traceInner()` 剥 `{"trace":…}` 层；无人值守装配 Agent 用 `planAutoApproveMode:'never'` + `autoToolExecMode:true`；复合任务 `agent_run_task` 必须传 `workspace` 绝对路径。

### kb_driver 用法（在 skill 目录下执行）

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

- [ ] `tools/list` 返回 70 个工具（引擎 9 + 发现 7 + UI 54）。
- [ ] 端口 18755 有监听；外部编程工具已成功连上该 MCP Server。
- [ ] 绑定 KB 的 Agent 跑「kb_chunks 的 id 字段格式是什么？」→ trace events 出现 `native__kb_search`，reply 引用 KB。
- [ ] `plugin_upsert` 编写插件后 `plugin_test` 返回 `ok:true`；前端插件列表可见。
- [ ] `kb_create`+`kb_add_file`+`kb_rebuild_index` 后 `kb_list_assets` 的 `indexedAt` 非空。
- [ ] `memory_anchor` 后 `memory_list` 可见该记忆；`category` 为显式传入值。
- [ ] `skill_upsert` 后 `skill_get` 可见 `skillMarkdown` / `path`，`agent_list_skills` 已含该技能；技能磁盘目录生成 SKILL.md。
- [ ] `skill_import` 后 `skill_get` 可见导入的 `skillMarkdown` 与资源文件（经 `skill_list_files` 核对目录结构）。
- [ ] 所有写操作均可经对应 list/get 工具或 WorkDuo 界面抽查（留痕）。
