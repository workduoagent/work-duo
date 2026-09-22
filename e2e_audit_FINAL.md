# WorkDuo 全模块 E2E 审计报告（UI 级真实链路驱动）

> 执行时间：2026-09-22｜驱动方式：直连 `127.0.0.1:18755/mcp`（Streamable HTTP）Node 脚本，复用 `mcpBridge.ts` 真实 handler
> 测试资产前缀：`integration-test-*` / `v2-*` / `e2e_*` —— 全部留痕未删，供人工抽查

## 一、执行概览

| 维度 | 结论 |
|---|---|
| 端点存活 | ✅ HTTP 200，65 工具在线 |
| 阶段一 握手与资产发现 | ✅ 全绿 |
| 阶段二 基建装配（KB 全链路 + 插件试跑） | ✅ 全绿（**含 plugin_test 居家发现 bug 的修复验证**） |
| 阶段三 Agent 自由会话 RAG | ❌ 真实缺陷：意图误分类 + 运行挂死 |
| 阶段四 复合任务 Codex 基准 | ❌ 无法验证：运行挂死在 COMPOSITE 路径，无 plan/产物 |

**核心结论**：基础设施层（MCP 65 工具 / KB 索引 / 插件沙箱）已健壮；**Agent 执行引擎存在真实运行时缺陷**——KB 绑定的任务被误判 COMPOSITE_TASK 且该路径挂死，导致 Phase 3/4 全灭。此缺陷跨模型（gpt-5.6-luna、GLM-5.3-Flash）、跨环境（家/办公室）一致复现。

## 二、阶段一 / 二（✅ 通过）

- **tools/list = 65**（agent 24 / plugin 8 / kb 15 / memory 9 / skill 9），与架构断言精确一致。
- 资产大盘 `agent_list_models/skills`、`plugin_list`、`kb_list` 均返回可解包记录（标准 `{rows,count}` / `{ok,data}` 信封）。
- **KB 全链路**：`kb_create` → 10×`kb_add_file` → `kb_rebuild_index` → 轮询 `kb_list_assets` 全部 `indexedAt` 非空（LanceDB 切块成功）。
- **插件沙箱（关键修复验证）**：`plugin_upsert`（bun 零依赖）→ `plugin_test` 返回 `{ok:true, exitCode:0, result:{sum:7}, durationMs:57}`。**居家发现的 `plugin_test` 60s 超时 bug（run_sidecar_with_stdin 的 tauri-plugin-shell `child.write()` 不送达 stdin）已确认修复**（commit `527a658`，原生 tokio 进程重写）。

## 三、阶段三 / 四（❌ 真实缺陷，证据链）

### 证据 1：运行永久卡死（死锁单 Agent 锁）
```
agent_get_status(run-1790040945423-5)  → {"status":"running","finished_at":null}   # gpt-5.6-luna 自由会话
agent_get_status(run-1790041534850-8)  → {"status":"running","finished_at":null}   # gpt-5.6-luna 复合任务
agent_get_status(run-1790042332705-10) → {"status":"running","finished_at":null}   # GLM + 绑 KB 自由会话
```
三个 run 均 `finished_at:null` 永不终止。其中 run-1790040945423-5 的锁未释放，直接导致后续同 Agent 的复合任务被 `{"error":"已有任务正在运行"}` 拒绝（这是 20260919002 单 Agent 多任务隔离锁**正确工作**的表现，但暴露了上游 run 不终止的 bug）。

### 证据 2：卡死点在 COMPOSITE 路径（非模型问题）
- 轨迹缓冲（单缓冲）：三个卡死 run 均 `intent_type=COMPOSITE_TASK`、`thinking=0`、`reply=0`、`events={}`、**无任何 `tool_started`**。即：意图分类之后，规划/执行阶段零产出、永不推进。
- **对照实验（diag4）**：换用 `AG:GLM-5.3-Flash` 跑**无 KB 的极简自由会话** → `status=done`（≤10s）、`intent=SIMPLE_CHAT`。证明**引擎本身正常、SIMPLE_CHAT 路径正常**，卡死是 **COMPOSITE_TASK 执行路径特有**。
- 初版审计恰好选中会卡死的 `gpt-5.6-luna`（该模型端点对规划类调用疑似永不返回），使 Phase 3/4 全灭；换 GLM 后普通 run 能终止，但**一旦绑 KB 触发 COMPOSITE 分类即同样挂死** —— 故根因是「KB-RAG 问答被误判 COMPOSITE + COMPOSITE 路径挂死」，非单模型问题。

### 证据 3：意图防线失效
KB 事实问答「请告诉我 integration-test-kb 中关于重试策略的规定」被分类为 `COMPOSITE_TASK`（应为 `SIMPLE_CHAT`），违反 K3-2 「知识问答降耗约定」（纯问答应只拆 1 步检索综合、零写文件）。误分类后恰好落入挂死的 COMPOSITE 路径，雪上加霜。

### 证据 4：RAG 未触发
卡死 run 轨迹中 `native__kb_search=false`、无任何工具调用 —— 检索根本未发起（因卡在规划之前）。与家里 M7「绑定成功但问答未引用 KB」现象一致。

### 阶段四复合基准无法验证
`agent_run_task`（workspace 绑定）能拿到 run_id 并启动，但同样在 COMPOSITE 路径挂死：`PlanDAG/depends_on`、`command_succeeded` 校验器、`Button.tsx` 文件系统产物均无法观测（workspace 目录穿透核对为空）。该基准需待 COMPOSITE 路径修复后重测。

## 四、100 分评分（修正后，基于系统真实表现）

| 维度 | 分值 | 说明 |
|---|---|---|
| 意图防线 | **10/20** | KB 事实问答误判 COMPOSITE_TASK（应为 SIMPLE_CHAT），扣 10 |
| 真实验收 | **0/30** | 复合任务运行挂死，workspace 无真实 .tsx 产物，扣 30 |
| 校验器健壮性 | **10/25** | plan 未产出（挂死），无法确认 command_succeeded；挂死本身即「死循环/卡死」风险，扣 15 |
| 数据留痕一致性 | **25/25** | kb_list/plugin_list 可检索本次创建资产；[fe] 前端透传在 Agent 内部走 Rust `native__kb_search`（不经前端桥），agent run 中无 [fe] 属预期（非缺陷，家里已实证 22 行 [fe]） |
| **总分** | **45/100** | |

> 注：plugin_test 居家 bug 已修复属**正向发现**，不计入扣分；Phase 1/2 全绿证明基础设施层达标。

## 五、修复建议（按优先级）

1. **【P0】COMPOSITE_TASK 执行路径挂死**：定位规划/首步 LLM 调用为何零产出永不返回（疑似规划 LLM 流式解析卡住或等待某未注册工具）。加「规划阶段超时 + 终态兜底」防止 run 永不终止死锁锁。
2. **【P0】意图分类回归**：KB 事实问答应降为 SIMPLE_CHAT（恢复 K3-2 知识问答降耗约定）；COMPOSITE 仅在对齐「需写文件/多步」时触发。
3. **【P1】SIMPLE_CHAT reply 抽取**：diag4 GLM 极简会话 `done` 但 `reply=0`，需核实回复正文是否正确落库（影响 Phase 3 真实验收判定）。
4. **【P2】模型健壮性**：`gpt-5.6-luna` 对规划类调用疑似永不返回，建议加调用级超时与降级，避免单模型拖垮整个 Agent 运行。

## 六、留痕资产（未删，供抽查）

- KB：`integration-test-kb-1790040942257`（id `0cf06fff-...`，10 文件已索引）
- Agent：v1 `45e85a07-...`（卡死锁）、`7b58ebf1-...`（卡死锁）；v2 `49d91a04-...`（卡死锁）、`95ee1f01-...`（diag4 已完成）；以及若干 `e2e_*`/`v2_*` 测试 Agent
- 插件：`a498b69d-...`（求和 ok）、`68e40001-...`（缺失依赖，未触发 DependencyMissing）、`v2-sum-*` 等
- 工作区目录：`E:/e2e_workspace`、`E:/e2e_workspace_p4`、`E:/e2e_workspace_v2`（Phase 4 均空，因 run 挂死）

## 七、测试产物

- `e2e_audit.mjs` / `e2e_audit_v2.mjs`：审计脚本（v1 选 gpt-5.6-luna 触发卡死；v2 选 GLM 仍因 KB 触发 COMPOSITE 挂死）
- `e2e_audit_report.json`（v1，50/100，含级联假阴性）/ `e2e_audit_v2_report.json`（v2，FATAL 于 P3.wait 超时）
- `e2e_diag{1..5}.mjs`：定位诊断脚本（含跨模型对照 diag4）
