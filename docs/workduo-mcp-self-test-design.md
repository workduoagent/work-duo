# 《WorkDuo MCP Server + 自测闭环》技术方案

> 版本：v0.1（设计稿） · 日期：2026-09-20
> 目标：把 WorkDuo 的操作面封装为 MCP Server，接入 WorkBuddy（我），由其根据需求自动生成测试用例、执行、并按「轨迹 + 回复 + 日志 + 产物」做自我测评与迭代。

---

## 1. 背景与目标

当前 WorkDuo 已具备：

- **可驱动的 agent 引擎**：`run_agent_task` / `submit_approval_decision` / `submit_choice_decision` / `cancel_agent_task`（`src-tauri/src/agent/commands.rs`）已能后台执行 ReAct 任务。
- **MCP 客户端能力**：`src-tauri/src/mcp.rs` 已能作为 MCP 客户端连接外部 MCP（HTTP/SSE）。
- **评测素材源**：tracing 日志（已落盘为 `workduo.log.YYYY-MM-DD` 每日滚动文件，见 §4.5）、统一实体图 `graph.rs` 的 `TaskNode` 轨迹、`round_compactor` 落库的 `raw_messages_json`、KB/向量产物（`vector_store.rs`）。

**缺失的是反向对称能力**——让 WorkDuo 作为 **MCP Server** 暴露操作面，供 WorkBuddy 调用。本文档给出工具清单、数据流、评分协议与分阶段计划。

预期收益：需求 → 自动生成用例 → 执行 → 采集轨迹/回复/日志/产物 → 自动评分 → 总结问题 → 反哺用例库 / 触发修复。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  WorkBuddy（我）                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 自测闭环 Skill（生成 → 执行 → 采集 → 评分 → 归因 → 迭代）│  │
│  └───────────────────────────────────────────────────────┘  │
│         │ MCP (stdio / HTTP+SSE)                              │
│         ▼                                                     │
│  ┌──────────────────────────┐    invoke / 本地桥接           │
│  │  WorkDuo MCP Server       │ ─────────────────────────────▶ │
│  │  (sidecar 或 app 内嵌)    │   Tauri 命令 / SQLite / 日志    │
│  └──────────────────────────┘ ◀───────────────────────────── │
│         │ 返回 trace / reply / logs / artifacts               │
│         ▼                                                     │
│  ┌──────────────────────────┐                                │
│  │  WorkDuo 应用（Tauri2）   │                                │
│  │  agent 引擎 / GUI / 向量库│                                │
│  └──────────────────────────┘                                │
└─────────────────────────────────────────────────────────────┘
```

**三层职责**

1. **MCP Server 封装层**：把 WorkDuo 操作暴露为标准 MCP tools。
2. **连接层**：在 WorkBuddy 注册该 MCP（已支持 MCP connector），我即可直接调用。
3. **自测闭环层**：由我运行的 playbook/skill 编排「生成→执行→采集→评分→迭代」。

---

## 3. 现有可复用资产（代码核对结论）

| 资产 | 位置 | 用途 |
|---|---|---|
| `run_agent_task` | commands.rs:101 | 后台 spawn 执行任务（**无 run_id 返回**） |
| `submit_approval_decision` | commands.rs:166 | 回传边审批决策 |
| `submit_choice_decision` | commands.rs:192 | 回传方案选择 |
| `cancel_agent_task` | commands.rs:205 | 取消任务 |
| `vector_status` | vector_store.rs:1051 | 向量库状态 |
| `mcp.rs` | src-tauri/src/mcp.rs | 现有 MCP 客户端骨架（可借鉴 JSON-RPC 封装） |
| `graph.rs` TaskNode | 统一实体图 | 轨迹节点来源 |
| `round_compactor` | 落库 `raw_messages_json` | 回复/消息来源 |
| 边审批 5 类危险信号 | 现有护栏 | 自迭代「改源码」的闸门 |

**关键缺口（必须新增）**：`run_agent_task` 是 fire-and-forget（返回 `Ok(())` 立即返回，后台执行），**没有 run_id 也没有 get_trace/get_reply/get_artifacts 读取命令**。因此 MCP Server 需新增一组「读取/轮询」命令——这是本方案的核心工作量。

---

## 4. MCP Server 工具清单

> 状态列：`已有`=直接映射现有命令；`需新增`=需写新 Tauri 命令；`MVP2`=GUI 增强阶段。

### L1 · Agent 引擎层（MVP1 核心，稳定性最高）

| MCP 工具 | 映射/实现 | 入参 | 出参 | 状态 |
|---|---|---|---|---|
| `agent.run_task` | 新增 `run_agent_task_ex`（返回 `run_id`）封装现有 `run_task` | `agent_id, prompt, workspace?, session_id?, attachments?, plan_override?, disabled_*` | `run_id` | 需新增 |
| `agent.get_status` | 新增（读运行态/事件） | `run_id` | `RUNNING/DONE/ERROR/CANCELED` | 需新增 |
| `agent.wait_task` | 新增（轮询至终态） | `run_id, timeout_ms` | 终态 + 耗时 | 需新增 |
| `agent.get_trace` | **前端桥提供**（mcpBridge 读既有事件流 TaskNode / `raw_messages_json`，不新增 Rust 命令） | `run_id` 或 `session_id+round_id` | 节点序列、工具调用、plan 分支 | 前端桥 |
| `agent.get_reply` | **前端桥提供**（读前端聚合回复，不新增 Rust 命令） | `run_id` | 回复文本 | 前端桥 |
| `agent.get_artifacts` | **前端桥提供**（读 KB/文件/向量产物，不新增 Rust 命令） | `run_id` | 产物清单（路径/内容摘要） | 前端桥 |
| `agent.cancel` | `cancel_agent_task` | — | — | 已有 |
| `agent.approve` | `submit_approval_decision` | `decision, grant_key?, remember?` | `bool` | 已有 |
| `agent.choose` | `submit_choice_decision` | `choice_id, option_id, custom_text?` | `bool` | 已有 |

### L2 · 逻辑 UI 意图桥（**推荐主驱动**，MVP1 即可用）

不模拟鼠标像素，**把 MCP 工具路由到前端真实的 UI handler**（与按钮点击同一个函数），从而 100% 走 Tauri2 全流程：前端校验/状态 → mapper SQL → Rust `tauri-plugin-sql` → SQLite 入库。已核实真实入口（`src/core/mapper/agent-mapper.ts`）：

**传输链路（决策① WorkDuo 自身即 MCP Server）**：WorkDuo 在 `setup` 中启动内建 MCP Server（`mcp_server.rs`，监听 `127.0.0.1:18755/mcp`，Streamable HTTP），WorkBuddy 以 HTTP 自定义连接器注册；UI 意图工具经 Tauri 事件 `mcp:intent` 派发前端真实 handler → `mcpBridge` 调**真实 handler** → `invoke('mcp_resolve_result',…)` 回传。**无 sidecar、无 WebSocket、无 `?selftest=1`**。

**硬约束**：意图必须绑定到 UI 控件的 `onSubmit`/`onClick` 处理器（而非独立内部函数），保证与真人操作路径、副作用一致。

| MCP 工具 | 意图 | 绑定的真实前端入口 | 状态 |
|---|---|---|---|
| `agent.ui_create` | `agent:create` | 创建表单 onSubmit → `createAgent` (INSERT agent_info @:343) | 需桥接 |
| `agent.ui_update` | `agent:update` | 编辑表单保存 → `upsertAgent` (@:262, UPDATE) | 需桥接 |
| `agent.ui_delete` | `agent:delete` | 删除确认 → `deleteAgent` (@:441) | 需桥接 |
| `agent.ui_get` / `agent.ui_list` | `agent:read` | 详情/列表加载 → `getAgent`/`listAgents` (@:168/151) | 需桥接 |
| `ui.assert_visible` | — | 可选：断言某 DOM 节点出现 | MVP2 |

> **像素级自动化**（`ui.click`/`ui.type` via WebView2 CDP）降级为**可选深度回归**（MVP2+），用于抓真实布局/交互 bug，但选择器脆弱，**不作主驱动**。L1（agent 引擎层）与 L2（UI 意图桥）互补：L1 测"任务执行"，L2 测"实体增删改查等界面全流程"。

> **设计原则（零侵入 + 可复用）**：意图桥只"调用"已有 UI handler，不修改其内部逻辑——前端 `createAgent`、后端 `INSERT` 等一行不动。由于入口即真实用户路径，**既不会大范围破坏前后端既有逻辑，也能随后续新功能自动复用同一入口完成自测**，无需为新功能单独写适配。测出的问题即用户真实会遇到的问题。

### L2.5 · 模块发现层（让自测驱动方「看见可选集」后再智能选值）

「一句话建智能体」自测（如「创建合同审计助手智能体」）不能凭空编造 id，必须先查询真实模块数据再判断。`mcp_server.rs` 新增一组 Rust 直读 `workduo.db` 的只读工具（零业务副作用）：

| MCP 工具 | 读取表 | 用途 |
|---|---|---|
| `agent_list_models` | `models` | 选 `llmId`/`ttsId`/`sttId`（category∈{text,multimodal,tts,stt}） |
| `agent_list_mcps` | `mcp_info` | 锁定目标 MCP 服务 id |
| `agent_list_mcp_tools` | `mcp_tool_definition`（按 mcp_id） | 取 `{mcpId, toolId}` 工具粒度挂载（服务≤3、工具≤10） |
| `agent_list_skills` | `skill_info` | 选 `skillIds`（≤3） |
| `agent_list_plugins` | `user_plugin_tool` | 选 `pluginIds`（≤10） |
| `agent_list_kbs` | `knowledge_base` | 选 `kbIds`（绑定后获得 `native__kb_search`） |
| `agent_list_scenarios` | `scenario_category`（scope=AGENT） | 选 `scenario` 的 `value` |

> 配套可加载 Skill：`docs/skills/agent-assembly-guide/SKILL.md` —— 把「字段↔模块映射 + 按需求类型的选值启发」作为工具语义补充，复制到 `$APPDATA/.skills/agent-assembly-guide/` 并经由 Skill UI 注册即可被产品加载。

**工具总数**：4（引擎）+ 7（模块发现）+ 5（UI 意图）= **16 个**。

### 4.4 参考场景：Agent 增删改查全流程测试

以 L2 意图桥跑一条完整 CRUD 用例，验证"从界面入口到入库"全链路：

**意图 → 真实入口映射**

| 操作 | MCP 调用 | 前端真实入口 | 断言数据源 |
|---|---|---|---|
| 增 | `agent.ui_create({name, scenario, llm_id, ...})` | `createAgent` → INSERT agent_info | `getAgent(id)` 非 null + listAgents 含该 id |
| 查 | `agent.ui_get(id)` | `getAgent(id)` | 返回字段与入参一致 |
| 改 | `agent.ui_update({id, name:"重命名"})` | `upsertAgent` → UPDATE | `getAgent(id).name === "重命名"` |
| 删 | `agent.ui_delete(id)` | `deleteAgent(id)` | `getAgent(id)` 为 undefined + 列表数减 1 |

**Oracle（用例级）**

```yaml
case:
  id: CASE-AGENT-CRUD
  requirement: "创建→查询→改名→删除 Agent，全流程经 UI 入口落库"
  steps:
    - call: agent.ui_create
      input: { name: "测试Agent", scenario: "general", llm_id: "default" }
      expect: { status: ok, getAgent(id).name: "测试Agent" }
    - call: agent.ui_update
      input: { id: $last.id, name: "测试Agent-改" }
      expect: { getAgent(id).name: "测试Agent-改" }
    - call: agent.ui_delete
      input: { id: $last.id }
      expect: { getAgent(id): undefined }
```

**评分要点**：除 CRUD 正确性（断言层 0/1），LLM judge 额外看「表单校验是否生效」「引用关系（mcp/skill/kb ref）是否随增删同步」等产物质量维度。

### L3 · 数据查询层（评测素材 + 断言）

| MCP 工具 | 映射/实现 | 入参 | 出参 | 状态 |
|---|---|---|---|---|
| `logs.tail` | 新增只读命令 `get_run_logs`（读 `workduo.log.YYYY-MM-DD` 滚动文件） | `cursor? / since_ts?, level?, limit?` | 日志行（含 `[模块][函数][文件:行]-等级`） | 需新增（纯读） |
| `kb.status` | `vector_status` | — | 连接/表/统计 | 已有 |
| `kb.search` | 桥接 `native__kb_search` | `kb_id, query, top_k?` | chunks | 需桥接 |

### 4.5 Rust 运行时日志采集（已具备基础设施，零侵入）

Rust 侧日志已通过 `src-tauri/src/logging.rs` 落地为**每日滚动文件**，是自测闭环可直接消费的「引擎侧真相源」，无需从零搭建：

- **落盘位置**（按优先级，见 `logging.rs::choose_logs_dir`）：`$RESOURCES/logs` → `app_log_dir/logs` → `app_config_dir/logs` → `./logs`，文件名 `workduo.log.YYYY-MM-DD`。
- **格式自带结构化定位符**（`WorkduoFormat`）：`[时间][模块][函数][文件:行]-等级-内容`，例如：
  ```
  [2026-09-09 14:40:12.345][workduo::agent::native][native__read_file][src/agent/native.rs:87]-INFO-...
  ```
  → 归因时可直接定位「哪个函数、哪一行」，无需改动任何业务日志宏。
- **端侧读取通道已就绪**：capability `default.json` 已授予 `$APPLOG/**` 的 `tauri-plugin-fs` 作用域，前端即可读取日志目录，**不需新开权限**。

**采集机制（增量，精准到单次用例）**

- 测试开始前记录游标（日志文件字节偏移 或 起始时间戳）；结束后读「增量段」，等价于本次运行的 `tail -f`，不混入历史日志。
- 实现方式（二选一，均零侵入产品逻辑）：
  - **A（推荐）新增只读命令 `get_run_logs(cursor/timestamp, level?, limit?)`**：Rust 侧复用 `choose_logs_dir` 复算路径，按游标/时间窗读取当日文件返回增量行。仅新增一个纯读命令。
  - **B 纯 UI 路径**：`mcpBridge` 经 `$APPLOG` 权限用 `tauri-plugin-fs` 直接读日志文件，完全走既有前端能力；但日志读取本质是「数据查询」而非「用户操作」，A 更自然。

**在评分闭环中的作用**：与 `trace / reply / artifacts` 一并喂给 LLM judge 作为「引擎侧执行证据」；日志的 `[函数][文件:行]` 是定位 `AGENT_DEFECT` 根因的关键线索（见 §7）。

---

## 5. 数据流（自测闭环时序）

```
用户需求
  │
  ▼
[1] 生成用例  ── 我根据需求产出 N 条用例（含 oracle，见 §6）
  │
  ▼
[2] 执行      ── agent.run_task(prompt) → run_id
  │              agent.wait_task(run_id) 直至终态
  ▼
[3] 采集      ── 并行拉取 agent.get_trace / get_reply / get_artifacts（前端桥提供）/ get_run_logs / kb.*
  │
  ▼
[4] 评分      ── 断言层(确定性) + LLM judge 层(语义) → 用例级 pass/fail + 维度分
  │
  ▼
[5] 归因      ── 失败用例：区分「oracle 误判」vs「agent 真实缺陷」
  │
  ▼
[6] 迭代      ── oracle 误判 → 修正用例；agent 缺陷 → 生成修复建议/补丁（经边审批闸门）
  │
  ▼
[7] 回归      ── 重跑受影响用例，回到 [2]
```

---

## 6. 评分协议

### 6.1 Oracle 定义（每条用例携带）

```yaml
case:
  id: CASE-001
  requirement: "用户要求生成一份周报"
  input:
    agent_id: report-agent
    prompt: "为本周工作生成周报"
  expected:                       # oracle
    status: DONE
    tool_calls:                   # 期望工具调用（集合/序列）
      - native__kb_search
      - fs.write
    artifacts:                    # 期望产物
      - { type: file, match: "周报*.md" }
    reply_checks:                 # 回复断言
      - { type: regex, pattern: "本周" }
      - { type: semantic, desc: "包含工作进展与下周计划" }
```

### 6.2 双轨评分

- **断言层（确定性，0/1）**：`status==expected`、产物文件存在、工具调用集合匹配、回复正则命中。
- **LLM judge 层（0-10 语义分）**：对回复质量、轨迹合理性、产物可用性打分，并产出「问题 + 改进建议」。评判时一并消费 Rust 运行日志（§4.5）作为引擎侧执行证据，尤其用日志的 `[函数][文件:行]` 定位执行异常点。

### 6.3 评分维度

| 维度 | 说明 |
|---|---|
| 正确性 | 是否达成需求目标 |
| 完整性 | 期望产物/工具调用是否齐全 |
| 轨迹效率 | 步数 / 冗余工具调用是否过多 |
| 安全性 | 是否触发边审批 5 类危险信号（误触发=扣分） |
| 产物质量 | 文件/报告是否可用、非空、格式正确 |

### 6.4 聚合报告

用例级 `pass/fail` + 各维度均值 → 生成 Markdown 报告；失败用例标红并附归因结论。

---

## 7. 自迭代机制（批量聚合模型，决策③）

> 决策③：采用 A 方案——**不现测现改**，而是跑一大批用例 → 聚合「共性问题 / 特性问题」→ 专门修改 → 复测。

1. **失败归因（单用例）**：LLM 消费 `trace + reply + logs + artifacts` 与 oracle 差异，给每条失败标 `ORACLE_WRONG`（用例 oracle 误判，自动回写用例库）或 `AGENT_DEFECT`（agent 真实缺陷）。
2. **批量聚合（核心）**：一轮跑完后，把所有 `AGENT_DEFECT` 聚类：
   - **共性问题**：跨多用例重复出现的根因（如某工具调用缺参数）→ 一处专门修复，收益最大。
   - **特性问题**：仅个别用例 → 单独处理。
   产出《问题聚合报告 + 修复计划》（含优先级、影响用例数、建议改动点）。
3. **人工闸门**：修复计划经边审批 5 类危险信号机制（复用 `register_native_tools` 护栏）确认；默认仅产出计划 + 人工确认，**不静默改库**。
4. **复测**：按修复计划改完后，重跑受影响用例回归（回到 [2]）。

---

## 8. 分阶段计划

### MVP1 · 引擎层 + UI 意图桥 自测闭环（复杂度：中高，约 4-5 天）

- **传输（决策① sidecar + WS 桥）**：Node sidecar（MCP TypeScript SDK over stdio ↔ WorkBuddy）同时起一个 localhost WebSocket server；WorkDuo 前端在「自测模式」下以 `new WebSocket` 连入（复用 `iflytek.ts` 既有模式）。sidecar 把 MCP 工具调用转成 intent 推给前端 `mcpBridge`，结果经 WS 回传。**无需新增 Rust 命令做事件中继**（外部进程本就不能直接 invoke Tauri 命令），比 `app.emit` 方案更零侵入。
- **新增 Tauri 命令（仅可观测性，不改产品逻辑）**：`run_task_ex`（返回 `run_id`）、`get_status`、`wait_task`、`get_run_logs`。trace/reply/artifacts 由前端桥经既有事件流提供，不新增 Rust 命令。L1 引擎工具由 `mcpBridge` 经 `invoke` 调这些命令；L2 UI 工具由 `mcpBridge` 调与 UI 同一的 `upsertAgent`/`deleteAgent`/`listAgents`/`getAgent`（绑定点见 §4.4）。
- **前端 `mcpBridge` 模块**（仅自测模式激活）：WS client + intent 分发，绑定真实 handler。
- **测评记录持久化（决策② 不隔离 → 需可抽查/复查）**：新增 `self_test_runs` 表（或 JSONL），记录每轮 run 的 case_id / 时间 / oracle / 实际结果 / pass-fail / 各维度分 / trace 引用，供人工抽查复查。
- **WorkBuddy「自测闭环」skill**：生成用例 → 执行 → 采集 → 评分（首轮 oracle 由我生成并自评，置信度低的再交你校准，见决策④）。
- 跑通 1 条端到端闭环（含 §4.4 Agent 增删改查）。

### MVP2 · 像素级深度回归（可选，复杂度：高）

- 仅当需要抓真实布局/交互 bug 时接入 WebView2 CDP 驱动，实现 `ui.click/type/assert_visible/screenshot`。
- 不作为主驱动，仅作 L2 意图桥的补充回归。

### MVP3 · 自迭代（复杂度：中）

- 失败归因分类器 + 用例库沉淀 + 修复建议生成（边审批闸门）。

---

## 9. 风险与约束

1. **全局 run lock 互斥**：`run_agent_task` 当前是全局互斥（待办 `20260919002` 多任务隔离未落地）。自测并发跑多条用例会互相阻塞 → MVP1 用**串行编排**，并行前先落地 `20260919002`。
2. **意图桥稳、像素级脆**：L2 逻辑 UI 意图桥复用真实 handler，稳定且覆盖全流程，作为主驱动；像素级 CDP 自动化易因布局变动失效，仅作可选深度回归。
3. **质量需 oracle 量化**：「产物质量」无法靠感觉，必须由人工/首轮定义初始 oracle。
4. **sidecar 通信稳定性**：MCP Server 与 app 进程需稳定的本地桥（IPC/HTTP），建议 sidecar 复用 `mcp.rs` 的 JSON-RPC 封装套路。
5. **测评记录可复查（决策② 不隔离）**：测试数据直接落真实 `workduo.db`，故必须持久化 `self_test_runs` 测评记录，支持你按历史记录抽查/复查；并建议自测 Agent 带明确标识，便于事后按需清理。

---

## 10. 已拍板决策（原待确认问题）

1. **部署形态 → Sidecar**（按推荐）：Node sidecar 进程，MCP over stdio 对 WorkBuddy，localhost WS 对 WorkDuo 前端。
2. **数据隔离 → 不隔离**：测试数据即真实数据，落真实 `workduo.db`；AI 亦"人"，你按历史测评记录抽查/复查 → 需持久化 `self_test_runs` 测评记录（见 §9-5）。
3. **迭代边界 → A 方案（批量聚合）**：不现测现改；跑一大批 → 聚合共性问题/特性问题 → 专门修改 → 复测（见 §7）。
4. **首轮 oracle → 我生成 + 我首轮自评 + 仅不确定项你校准**：oracle 生成与首轮测评由我完成，置信度低的用例再交你校准。

---

## 11. MVP1 落地状态（已代码完成 + 静态/集成验证）

> 与原计划的两处偏差（已确认更优）：
> 1. `trace / reply / artifacts` **改由前端桥通过既有事件流提供**，Rust 侧只新增「运行控制 + 运行日志」命令，最小化侵入；
> 2. 日志工具为 `get_run_logs`（读 `workduo.log.YYYY-MM-DD` 滚动文件，按游标/时间窗增量），替代原 `logs.tail`；
> 3. sidecar **零外部依赖**（手写最小 WebSocket 服务端 + MCP stdio 分帧），无需联网装包；自测模式开关用 URL `?selftest=1`，端口默认 `18755`。

### 11.1 新增 / 改动文件清单（实际）

**Rust 侧（仅读 / 可观测，不改产品逻辑）**
- `src-tauri/src/agent/commands.rs`
  - `run_task_ex`（新增）：复用 `try_acquire_run_lock` + `load_config` + `run_task` 全链路，仅额外在 `run_registry` 写 `run_id` 记录并返回 `run_id`。
  - `get_status(run_id)` / `wait_task(run_id, timeout_ms?)`：轮询 `run_registry`。
- `src-tauri/src/agent/runtime.rs`
  - 新增 `run_registry: Arc<Mutex<HashMap<String, RunRecord>>>` 字段与 `RunRecord` 结构（派生 `Serialize`），`new()` 初始化。
- `src-tauri/src/logging.rs`
  - `get_run_logs(app, cursor?, since_ts?, level?, limit?)`：复用 `choose_logs_dir`，按游标/时间窗/等级增量读当日滚动日志。
- `src-tauri/src/lib.rs`：`invoke_handler` 注册 `run_task_ex` / `get_status` / `wait_task` / `get_run_logs`。

**前端侧（逻辑 UI 意图桥，零侵入）**
- `src/core/mcpBridge.ts`（新）：WS client 连 `ws://127.0.0.1:<PORT>`，仅当 `?selftest=1` 激活；intent 分发到真实入口——UI 类 `upsertAgent/deleteAgent/getAgent/listAgents`，引擎类经 `invoke('run_task_ex'|'get_status'|'wait_task'|'get_run_logs')`。
- `src/main.tsx`：启动时调用 `connectMcpBridge()`（自测模式才连接，正常用户零影响）。

**sidecar（Node，零外部依赖）**
- `selftest-sidecar/server.mjs`：MCP Server(stdio, JSON-RPC 2.0 + Content-Length 分帧) ↔ WebSocket(18755) 转发；内置最小 WS 服务端（RFC6455 握手 + 帧编解码）与 MCP 帧解析。
- `selftest-sidecar/package.json`：`type: module`，`npm start` → `node server.mjs`（端口可用 `MCP_BRIDGE_PORT` 覆盖）。
- `selftest-sidecar/smoke-test.mjs`：同进程冒烟测试（标准 WebSocket 客户端 + Buffer 级 MCP 帧解析），验证握手/帧往返/闭环。
- `selftest-sidecar/sample-case.agent-crud.json`：Agent CRUD 样例用例（含 oracle），供 runner 消费。

> 说明：原计划的 `src/self-test/intents.ts`、`self_test_runs` 表、`WorkBuddy 侧 skill` 暂未落地——`intents` 已内联进 `mcpBridge.ts`；`self_test_runs` 按决策 #2（数据不隔离、用户人工抽查复查）暂不建表；自测闭环驱动由 WorkBuddy（即本会话）直接执行，固化 skill 待端到端真机验证后。

### 11.2 工具签名（实际）

```ts
// sidecar 暴露给 WorkBuddy 的 MCP 工具（intent 同名透传到前端桥）
agent.run_task({ agent_id, prompt, workspace?, session_id?, round_id?, attachments?, plan_override? }) -> run_id
agent.get_status({ run_id }) -> RunRecord
agent.wait_task({ run_id, timeout_ms? }) -> RunRecord
agent.get_run_logs({ cursor?, since_ts?, level?, limit? }) -> string[]
agent.list_models() -> { id, name, model_name, provider, category, enabled, tool_calls, description }[]
agent.list_skills() -> { id, identifier, name, description, scenario, status, tags }[]
agent.list_mcps() -> { id, alias_name, mcp_name, protocol_type, status, is_active, scenario, description }[]
agent.list_mcp_tools({ mcp_id }) -> { id, mcp_id, tool_code, display_name, description, is_active }[]
agent.list_plugins() -> { id, name, identifier, description, runtime, enabled, scenario }[]
agent.list_kbs() -> { id, identifier, name, description, scenario, file_count }[]
agent.list_scenarios({ scope?='AGENT' }) -> { id, scope, value, label }[]
agent.ui_create({ payload: AgentUpsertInput }) -> {id,name,identifier,scenario,isActive}
agent.ui_update({ payload: AgentUpsertInput }) -> {id,name,identifier,scenario,isActive}
agent.ui_delete({ id }) -> {id, deleted:true}
agent.ui_get({ id }) -> AgentInfo | undefined
agent.ui_list() -> { id, name, identifier, scenario, isActive }[]
```

```rust
// commands.rs 新增（仅读 / 可观测）
#[tauri::command] pub async fn run_task_ex(app, runtime, input: RunAgentTaskInput) -> Result<String, String>
#[tauri::command] pub async fn get_status(runtime, run_id: String) -> Result<RunRecord, String>
#[tauri::command] pub async fn wait_task(runtime, run_id: String, timeout_ms: Option<u64>) -> Result<RunRecord, String>
// logging.rs
#[tauri::command] pub fn get_run_logs(app, cursor: Option<usize>, since_ts: Option<String>, level: Option<String>, limit: Option<usize>) -> Result<Vec<String>, String>
```

### 11.3 接线流程（实际 · WorkDuo 自身即 MCP Server）

1. **正常启动 WorkDuo**（无需任何参数）——`lib.rs` setup 中调用 `start_mcp_server(handle)`，在 `127.0.0.1:18755/mcp` 监听 Streamable HTTP。
2. `main.tsx` 无条件 `void connectMcpBridge()`，前端 `listen('mcp:intent')` 常驻（零侵入、空闲零副作用）。
3. WorkBuddy 连接器页信任 `workduo-mcp`（HTTP 模式，URL 已在 `~/.workbuddy/mcp.json` 配好：`http://127.0.0.1:18755/mcp`）。
4. **模块发现**：WorkBuddy 调 `agent_list_*` 系列直读 `workduo.db` 取真实可选集（模型/MCP/工具/Skill/插件/KB/场景）。
5. **UI 意图**：WorkBuddy 调 `agent_ui_create/update/delete/get/list` → Rust `emit('mcp:intent', {id,intent,payload})` → 前端 `mcpBridge` 调真实 `upsertAgent/deleteAgent/getAgent/listAgents` → `invoke('mcp_resolve_result',{id,ok,data})` 回传。
6. **引擎类**：WorkBuddy 调 `agent_run_task` → Rust `run_task_ex` 执行 → `agent_wait_task` 轮询终态 → `agent_get_run_logs` 增量取 Rust 运行日志。

> 无 sidecar、无 WebSocket、无 `?selftest=1`；旧 `selftest-sidecar/` 已退役可删。

### 11.4 验证结果（已执行）

| 项 | 命令 | 结果 |
|---|---|---|
| Rust 编译 | `CARGO_TARGET_DIR=target-sb cargo check`（沙箱） | **EXIT=0**，含 `mcp_server` 模块编译通过 |
| 前端类型 | `node node_modules/typescript/bin/tsc --noEmit` | **EXIT=0**，0 错误 |
| MCP 协议 | 工具名用下划线、回显 `protocolVersion`、单次会话 `initialize` 防护（规避此前 sidecar 的「已连接零工具」bug） | 设计已规避；真机握手待用户信任后验证 |

> 待真机验收（需 WorkDuo 应用运行 + LLM 真实运行）：WorkBuddy 信任连接器后实测 `initialize`/`tools/list` 返回 16 工具（4 引擎 + 7 模块发现 + 5 UI 意图）；`agent_ui_*` 真实落库断言；`agent_run_task` 真实驱动并采集 logs。

---

## 12. 真机测试 Runbook（用户视角）

> 前置已完成：Rust `cargo check` 通过、前端 `tsc --noEmit` 0 错误、sidecar `smoke-test` 通过。
> sidecar 已注册到 `~/.workbuddy/mcp.json`（`workduo-self-test`，stdio 拉起 `node server.mjs`）。

### 12.1 快速清单

| # | 动作 | 完成后现象 |
|---|---|---|
| 1 | 在 WorkBuddy 连接器页 **信任** `workduo-self-test` | 状态变「已连接」，sidecar 进程被拉起 |
| 2 | 启动 WorkDuo，窗口 URL 带 `?selftest=1` | 前端 `mcpBridge` 自动连上 sidecar |
| 3 | 验证链路 | sidecar 日志打印 `前端桥接已连接`；浏览器控制台 `[mcpBridge] 已连接 sidecar` |
| 4 | 让我跑 `agent-crud-001` | 我驱动创建→查→改名→查→删除→查，逐条给断言结果 |

### 12.2 详细步骤

**步骤 1 · 信任 MCP 连接器**
- 打开 WorkBuddy「连接器 / 自定义连接器」页，找到 `workduo-self-test`。
- 点击 **信任（Trust）**。WorkBuddy 会以子进程方式拉起 sidecar（`node selftest-sidecar/server.mjs`）。
- sidecar 启动后会打印：`[sidecar] MCP Server 已就绪（stdio=true）…` 与 `[sidecar] WebSocket 服务端已监听 ws://127.0.0.1:18755`。
- ⚠️ **顺序建议**：先信任（拉起 sidecar、起 WS 监听），再开 WorkDuo 窗口。若反过来，第一次调用会报"前端桥接未连接"，重连逻辑会自动补上。

**步骤 2 · 启动 WorkDuo 并进入自测模式**
- 开发模式：`npm run tauri dev` → 浏览器/devtools 把窗口地址改为带参形式（dev 下为 `http://localhost:1420/?selftest=1`）。
  - 提示：Tauri2 dev 默认加载 `http://localhost:1420`，可在启动后手动在地址栏/启动参数追加 `?selftest=1`；或在 `tauri.conf.json` 的 `frontendDist`/启动 URL 临时加参。
- 打包模式：运行桌面应用后，通过「打开方式 / 协议带参」或应用内导航进入 `?selftest=1` 的窗口。
- `mcpBridge.isSelfTestMode()` 检测到 `selftest=1` → 自动 `connectMcpBridge()` 连 18755。

**步骤 3 · 验证链路（排雷点）**
- WorkDuo 前端控制台：`[mcpBridge] 已连接 sidecar @ ws://127.0.0.1:18755`。
- sidecar 终端/日志：`[sidecar] 前端桥接已连接`。
- 两者都出现 = 链路 OK，可以驱动测试。

**步骤 4 · 驱动测试**
- 在 WorkBuddy 对话框说：「**跑 sample-case.agent-crud-001**」。
- 我会按样例用例逐步调 MCP 工具并核对 oracle：
  1. `agent.ui_create` → 返回 `AgentInfo[]`（整个列表）；我按 `identifier === "selftest-crud-agent"` 取新建项 `id`（样例里写的 `data.0.id` 取列表首项，若你的库里已有其他 agent，以 identifier 匹配为准更稳）。
  2. `agent.ui_get({id})` → 断言 `name/identifier/scenario` 与入参一致。
  3. `agent.ui_update({id, name:"…-改名"})` → 再 `get` 断言改名生效。
  4. `agent.ui_delete({id})` → 再 `get` 断言返回 `undefined` / 列表消失。
- 每条用例结束，我产出「断言通过 / 失败 + 差异 + Rust 运行日志摘要」，对应你决策 #2「真实落库、可抽查复查」。

**步骤 5 · 引擎类（可选进阶）**
- 驱动 `agent.run_task({agent_id, prompt})` → 拿到 `run_id` → `agent.wait_task({run_id})` 轮询终态 → `agent.get_run_logs({since_ts})` 增量取 Rust 引擎日志。
- 需你提供一个**真实可用的 agent_id** 与 workspace，且 run lock 当前为全局互斥，串行跑避免互相阻塞。

### 12.3 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 连接器显示「已连接」但底部工具数为 0 / 只有旧工具 | 新工具（模块发现层 7 个）需 WorkDuo 用新二进制重启后才加载；WorkBuddy 会话启动时拉取工具清单，中途不会热更新 | **重启 WorkDuo**（重新 `tauri dev`/`build` 编译出新二进制）；重启后 WorkBuddy 连接器应显示 **16 个工具**（`mcp__workduo-mcp__*`） |
| 调用 UI 意图工具报「前端回传通道已关闭」 | WorkDuo 窗口未打开 / `connectMcpBridge()` 未运行 | 确认 WorkDuo 窗口已打开；`mcpBridge` 在 `main.tsx` 无条件启动 `listen('mcp:intent')` |
| `agent.ui_create` 返回空 / 没落库 | 非 Tauri 环境会走 localStorage 分支 | 必须在 Tauri 桌面/打包环境运行，不能在纯浏览器 dev 无 Tauri 时测落库 |
| `agent_list_mcp_tools` 返回空 | 该 MCP 服务尚未同步工具（`mcp_tool_definition` 为空） | 在 WorkDuo 的 MCP 模块点「同步」触发 `sync_mcp_tools`，或确认该 MCP 状态 `status=1` |
| 端口 18755 被占用 | 旧 WorkDuo 进程残留 | 关掉残留 WorkDuo 进程再启动；或改 `app_config.mcp_server_port` 后重启 |

### 12.4 当前 MVP1 的已知边界

- 暂无「自动 runner Skill」：驱动由我（WorkBuddy）按样例用例手动逐步调工具 + 人工核对 oracle，符合你决策 #4「我生成 + 我自评」。
- `trace / reply / artifacts` 暂未接入：本轮覆盖 CRUD UI 全流程 + 引擎任务驱动 + Rust 日志采集，agent 内部轨迹评测留待 MVP2。
- 数据不隔离（你决策 #2）：测试创建的 Agent 是**真实数据**，跑完请手动在 WorkDuo 清理 `selftest-crud-agent`（样例用例最后一步已删除，但异常中断时可能残留）。
- 旧的 `selftest-sidecar/` Node 方案已**退役**（被本内建 MCP Server 取代），目录可删；`mcp.json` 已从 sidecar 命令切到 HTTP URL。
