# 《WorkDuo MCP Server + 自测闭环》技术方案

> 版本：v0.1（设计稿） · 日期：2026-09-20
> 目标：把 WorkDuo 的操作面封装为 MCP Server，接入 WorkBuddy（我），由其根据需求自动生成测试用例、执行、并按「轨迹 + 回复 + 日志 + 产物」做自我测评与迭代。

---

## 1. 背景与目标

当前 WorkDuo 已具备：

- **可驱动的 agent 引擎**：`run_agent_task` / `submit_approval_decision` / `submit_choice_decision` / `cancel_agent_task`（`src-tauri/src/agent/commands.rs`）已能后台执行 ReAct 任务。
- **MCP 客户端能力**：`src-tauri/src/mcp.rs` 已能作为 MCP 客户端连接外部 MCP（HTTP/SSE）。
- **评测素材源**：tracing 日志、统一实体图 `graph.rs` 的 `TaskNode` 轨迹、`round_compactor` 落库的 `raw_messages_json`、KB/向量产物（`vector_store.rs`）。

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
| `agent.get_trace` | 新增（读 `graph.rs` TaskNode / `raw_messages_json`） | `run_id` 或 `session_id+round_id` | 节点序列、工具调用、plan 分支 | 需新增 |
| `agent.get_reply` | 新增（读最终聚合文本） | `run_id` | 回复文本 | 需新增 |
| `agent.get_artifacts` | 新增（读 KB/文件/向量产物） | `run_id` | 产物清单（路径/内容摘要） | 需新增 |
| `agent.cancel` | `cancel_agent_task` | — | — | 已有 |
| `agent.approve` | `submit_approval_decision` | `decision, grant_key?, remember?` | `bool` | 已有 |
| `agent.choose` | `submit_choice_decision` | `choice_id, option_id, custom_text?` | `bool` | 已有 |

### L2 · 逻辑 UI 意图桥（**推荐主驱动**，MVP1 即可用）

不模拟鼠标像素，**把 MCP 工具路由到前端真实的 UI handler**（与按钮点击同一个函数），从而 100% 走 Tauri2 全流程：前端校验/状态 → mapper SQL → Rust `tauri-plugin-sql` → SQLite 入库。已核实真实入口（`src/core/mapper/agent-mapper.ts`）：

**传输链路**：MCP Server(sidecar) → 新增 Tauri 命令 `mcp_dispatch_intent` → Rust `app.emit("mcp:intent", {intent, payload})` → 前端 `mcpBridge` 监听并调用**真实 handler** → 结果经事件回传 sidecar。

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
| `logs.tail` | 新增（读 tracing 输出） | `lines?, since?` | 日志文本 | 需新增 |
| `kb.status` | `vector_status` | — | 连接/表/统计 | 已有 |
| `kb.search` | 桥接 `native__kb_search` | `kb_id, query, top_k?` | chunks | 需桥接 |

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
[3] 采集      ── 并行拉取 agent.get_trace / get_reply / get_artifacts / logs.tail / kb.*
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
- **LLM judge 层（0-10 语义分）**：对回复质量、轨迹合理性、产物可用性打分，并产出「问题 + 改进建议」。

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

## 7. 自迭代机制

1. **失败归因**：LLM 消费 `trace + reply + logs + artifacts` 与 oracle 的差异，输出「根因类别」：
   - `ORACLE_WRONG`：用例 oracle 写错（如正则过严）→ 自动修正用例。
   - `AGENT_DEFECT`：agent 真实缺陷（漏调用工具、回复质量差）→ 进入修复流程。
2. **用例库反哺**：`ORACLE_WRONG` 直接回写用例库，下次不再误判。
3. **源码修复闸门**：`AGENT_DEFECT` 若需改 WorkDuo 源码，**必须走现有边审批 5 类危险信号机制**（复用 `register_native_tools` 护栏），默认仅产出补丁建议 + 人工确认，不静默改库。

---

## 8. 分阶段计划

### MVP1 · 引擎层 + UI 意图桥 自测闭环（复杂度：中高，约 3-4 天）

- 新增 Tauri 命令：`run_agent_task_ex`（返回 `run_id`）、`get_status`、`wait_task`、`get_trace`、`get_reply`、`get_artifacts`、`logs.tail`、`mcp_dispatch_intent`（Rust 事件中继 → 前端 `mcpBridge`）。
- 实现 MCP Server（sidecar，stdio 或 HTTP+SSE），桥接 L1 引擎命令 + L2 UI 意图（`agent.ui_create/update/delete/get`）。
- 前端 `mcpBridge`：监听 `mcp:intent`，分发到与真实 UI 控件**同一个** onSubmit/onClick handler。
- WorkBuddy 侧写「自测闭环」skill：生成用例 → 执行 → 采集 → 评分。
- 跑通 1 条端到端闭环（含 §4.4 Agent 增删改查参考场景）。

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
5. **数据隔离**：评测是否走真实 `workduo.db` 还是独立测试库，需在实现前确定（建议测试库，避免污染用户数据）。

---

## 10. 待确认问题

1. **部署形态**：MCP Server 用 sidecar 进程，还是 app 内嵌 HTTP server？
2. **数据隔离**：评测走真实库还是独立测试库？
3. **迭代边界**：自迭代是否允许「自动改 WorkDuo 源码」，还是仅产出修复建议？
4. **首轮 oracle**：是否先由人工提供 5-10 条标杆用例，还是我全自动生成后人工校准？
