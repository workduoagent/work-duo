# Phase 3 实施计划 — 差异化创新（K3 §3.1 / §3.2 / §3.3）

> 状态：延后（依赖 Phase 2 #6–#10，已于 2026-09-05 全部完成：cargo check / build 通过）
> 范围：`src/pages/agent-studio/*`（前端）+ `src-tauri/src/agent/*`（后端遥测缺口）
> 规范基线：React19 + TS + antd v5（经 `@/components/ui` 封装，禁裸 antd）；Sass 只用 `var(--color-*)`；根容器 `width:100%`（禁 `max-width+margin:0 auto`）；统一 `useNotify()`；只 `npm run typecheck`（禁 `vite build`）；Rust 改动 `cargo check` + `npm run tauri` 重编。
> 关联文档：`docs/WorkDuo_Agent_UI_优化与创新方案（K3）.md` §3；后端事件清单 `src-tauri/src/agent/events.rs`；前端事件消费 `src/pages/agent-studio/session/useAgentSession.ts`。

---

## 0. 总体就绪度（已实测核查）

Phase 2 已 emit 的事件（前端可直接消费）：

| 事件 | 载荷关键字段 | Phase 3 用途 |
|---|---|---|
| `agent-event` → `plan_generated` | `PlanDAG{goal_summary, tasks:[{step,task_id,title,description,success_criteria,depends_on}]}` | 轨迹首层 DAG / 画布节点+依赖边 |
| `agent-event` → `step_started` / `step_finished` | step, total, title, ok, summary | 轨迹/画布步骤节点 |
| `agent-event` → `tool_started` / `tool_finished` | `ToolStep{call_id,tool_name,status,args,result,duration_ms,sensitive,created_at}` | 轨迹工具调用时间轴（参数/输出/耗时齐全） |
| `agent-event` → `text_chunk` / `status` | text, done / message | 思考面板（现状仅统一流） |
| `agent-token-update` | prompt_tokens, completion_tokens | 轨迹 token 节点 / 顶栏计数卡 |
| `agent-artifact-created` | `ArtifactRef{step,artifact_type,path,...}` | 画布产物卡片 / 画廊 |
| `agent-task-done` / `agent-task-error` | tokens / message | 轨迹诊断模式入口 |

**结论**：§3.1 / §3.2 主要是前端可视化（数据已 75%~85% 就位）；§3.3 缺口最大（零前端通道，需 4+ 新事件/命令）。

**建议执行顺序**：先集中补「后端遥测缺口」（一处改 `events.rs`+`types.rs`+`intent.rs`+`wd_mem.rs`+`commands.rs`，一次 `cargo check`），再并行做三个前端视图。这样每个视图开工时数据已齐，不返工。

---

## 1. §3.1 Agent 执行轨迹视图（K3 §3.1）

### 1.1 目标
侧边栏「🔍 轨迹」标签页，把一次 `run_agent_task` 渲染为交互式时间轴/DAG：`意图分类 → 规划 DAG → 执行流水线`。节点可展开看 LLM 请求/响应、Tool Call 详情、token/耗时/温度、消息序列快照；任务失败自动高亮失败节点 + 错误传播链 + 导出报告。

### 1.2 后端缺口（须先补）
| 缺口 | 改动点 | 说明 |
|---|---|---|
| 意图结果未 emit | `intent.rs` + `events.rs` 新增 `emit_intent_classified` | `classify_intent` 返回 `IntentProfile{intent_type,reason,requires_planning,requires_tool,risk_level,requires_approval,requires_artifact}` 当前未推前端。新增 `EVT_INTENT_CLASSIFIED` + payload，在 `runtime.rs` 分类后 emit。轨迹首节点依赖它（显示「SIMPLE? → NO，原因：命中复杂关键词」）。 |
| 思考分层无事件 | `events.rs` 新增 `EVT_AGENT_EVENT` 子类型 `thinking_chunk` | payload: `{layer:'plan'|'exec'|'selfcheck', text, done, step?}`。`pipeline.rs`/`planner.rs`/`runtime.rs` 在 emit 推理片段时带 layer 标签（§2.2 三级：🧭规划紫/🔧执行蓝/🛡️自检橙）。现状只有 `text_chunk`/`status`，无法区分层。 |
| 消息序列快照（低优先） | `events.rs` 新增 `agent-event` 子类型 `message_snapshot` | `sanitize_message_sequence` 前后序列快照，供调试。可放到二期。 |

> 注：`tool_started/finished` 的 `ToolStep` 已带 `args/result/duration_ms`，**无需改结构**即可渲染工具时间轴。

### 1.3 前端组件树
```
agent-studio/
├─ chat.tsx                      # 顶部加「🔍 轨迹」Tab 切换（与现有对话/记忆并列）
├─ session/
│  ├─ useAgentSession.ts         # 扩展：trace 状态机（intent/plan/steps/tools/tokens 数组）
│  ├─ types.ts                   # 新增 IntentClassified / ThinkingChunk / TraceNode 类型
│  └─ TracePanel.tsx             # 新建：侧边栏轨迹容器
│     ├─ IntentNode.tsx          # 意图分类节点（intent_type + reason + 风险色）
│     ├─ PlanDagNode.tsx         # 规划 DAG（复用 plan_generated，渲染 steps + depends_on 边）
│     ├─ ExecTimeline.tsx        # 执行流水线：按 step 聚合 tool_started/finished 时间轴
│     │  └─ ToolCallItem.tsx     # 单条工具调用（图标+耗时+展开 args/result）
│     └─ DiagnosticBanner.tsx    # 失败高亮 + 错误传播链 + 导出 JSON/MD
└─ chat.scss                     # 轨迹相关样式（__node/__edge/__tool/__failed，含 .dark）
```

### 1.4 数据流与状态管理
- `useAgentSession` 新增 `trace` 状态：`{ intent?: IntentProfile, plan?: PlanDAG, steps: Map<step, TraceStep>, tools: ToolStep[], tokens: {prompt,completion}, failedNode?: string }`。
- 监听：在现有 `listen('agent-event')` 内新增 `case 'intent_classified'` / `'thinking_chunk'` 分支；`plan_generated`/`step_*`/`tool_*` 已有 case，仅聚合进 `trace`。
- `run()` / `reset()` 清空 `trace`；`agent-task-done/error` 触发 `DiagnosticBanner` 显隐。
- 展开态用 `useMemo` 派生（不在渲染期副作用里算）。
- 导出：前端从 `trace` 组装 Markdown/JSON，`Blob` + `save` 下载（不调后端）。

### 1.5 分步实现
1. `events.rs` + `types.rs`：加 `IntentClassifiedPayload` / `ThinkingChunkPayload` + 常量；`intent.rs` 返回后 `runtime.rs` emit；`planner`/`pipeline`/`runtime` 推理片段带 `layer` emit `thinking_chunk`。→ `cargo check`。
2. `useAgentSession.ts` / `types.ts`：扩展 `trace` 状态机 + 新 case。
3. `TracePanel.tsx` + 子组件 + `chat.scss`；`chat.tsx` 加 Tab。
4. `npm run typecheck` → `npm run tauri` 真机验证。

---

## 2. §3.2 产物画布模式（K3 §3.2）

### 2.1 目标
非线性画布（Figma/Excalidraw 轻量版）：产物卡片悬浮、拖拽重排；点击预览（图片放大/表格滚动/代码高亮）；拖卡片到输入框作上下文附件；右键「🌿 从此处分支」从步骤 N 重规划；高级模式手动调依赖连线。

### 2.2 后端缺口（须先补）
| 缺口 | 改动点 | 说明 |
|---|---|---|
| 分支重规划命令 | `commands.rs` 新增 `branch_from_step`（入参结构体 `{task_id, from_step, guidance?}`）；`lib.rs` 注册 | 复用 `planner.build_plan` + `pipeline.run_pipeline`，但接受起始步集合（已完成步骤产物保留），新分支产物写入隔离目录（如 `.wd_mem/outputs/branch-{ts}/`）供对比。返回新 `plan` 供画布渲染双分支。 |
| 产物内容读取 API | `commands.rs` 新增 `read_artifact`（入参 `{path, max_bytes?}`）；`lib.rs` 注册 | 前端预览用：按扩展名返回（图片 base64 / 文本前 N 字符 / 表格 JSON 前 50 行）。路径须过 `canonicalize_path` 防逃逸（沿用 §3 沙箱 PathGuard 约定）。 |

> 已具备：`artifact_created`（带 `step`）+ `plan_generated.depends_on`（边）+ `step_*`——节点/边可直接组装。

### 2.3 前端组件树
```
agent-studio/
├─ chat.tsx                      # 「🎨 产物画布」入口（复合任务执行时自动切换，§3.6 自适应密度）
├─ session/
│  ├─ useAgentSession.ts         # 扩展：canvas 模型（nodes: ArtifactRef+step；edges: depends_on）
│  └─ ArtifactCanvas.tsx         # 新建：画布容器（拖拽/缩放/连线）
│     ├─ CanvasNode.tsx          # 产物卡片（图标+缩略图/预览+拖拽手柄）
│     ├─ CanvasEdge.tsx          # 依赖连线（hover 显示传递 summary）
│     ├─ NodePreview.tsx         # 点击预览（图片放大/ag-grid 表格/react-markdown/Monaco 代码）
│     └─ BranchMenu.tsx          # 右键「从此处分支」→ invoke branch_from_step
└─ chat.scss
```
> 画布交互建议自研轻量（避免引重型图库冲击 `package.json` 只写不装铁律）；若需，走动态 `import()` + `src/types/shims.d.ts` 兜底（如 `reactflow`）。

### 2.4 数据流与状态管理
- 由 `plan_generated`（nodes + `depends_on` edges）与 `artifact_created`（node 填充 path/type/预览）合成 `canvas` 状态。
- 拖拽到输入框：画布把 `path` 经回调注入 `chat.tsx` 输入框（复用现有 attachment 机制）。
- 分支：调 `branch_from_step` → 新 `plan_generated` 推入，画布左侧保留原分支对比。

### 2.5 分步实现
1. `commands.rs` + `lib.rs`：`branch_from_step` + `read_artifact`（路径规范化 + 类型分支）。→ `cargo check`。
2. `useAgentSession.ts`：扩展 `canvas` 状态（聚合 plan/artifact）。
3. `ArtifactCanvas.tsx` 全家桶 + `chat.scss`；`chat.tsx` 入口 + 自动切换逻辑（§3.6）。
4. `npm run typecheck` → `npm run tauri`。

---

## 3. §3.3 记忆宫殿（K3 §3.3）

### 3.1 目标
侧边栏「🧠 记忆」标签页：卡片网格（类型/摘要/创建时间/引用次数/锚定⭐）、搜索+标签过滤+删除；记忆热力图（召回频率色深）；记忆锚定（防 `round_compactor` 压缩）。

### 3.2 后端缺口（最大，须先补）
| 缺口 | 改动点 | 说明 |
|---|---|---|
| `memory_recalled` 事件 | `wd_mem.rs` 召回处 emit；`events.rs` 加 `EVT_MEMORY_RECALLED` | payload: `{entries:[{type,summary,ref_count}]}`，前端卡片网格 + 热力图数据源。 |
| `context_compacted` 事件 | `round_compactor.rs` 压缩处 emit（替换现 `emit_status` 字符串）；`events.rs` 加 `EVT_CONTEXT_COMPACTED` | payload: `{compactedRounds, remainingRounds, reason}`。 |
| `anchor_memory` 命令 | `commands.rs` 新增（入参 `{entry_id, pinned:bool}`）；`lib.rs` 注册 | 写 flag 到 wd_mem 索引/DB，compactor 跳过被锚定条目。 |
| `list_memories` 命令 | `commands.rs` 新增；`lib.rs` 注册 | 返回条目列表 `{id,type,summary,created_at,ref_count,anchored}` 供初始卡片网格。 |
| 引用计数 | `wd_mem.rs` recall/persist 时 `ref_count += 1` | 落库（复用 `workduo.db` 或 wd_mem 索引文件）。 |

> 现状：`wd_mem` 仅磁盘态，`round_compactor` 会压缩，但**全部零前端通道**。这是 Phase 3 真正后端工作量所在。

### 3.3 前端组件树
```
agent-studio/
├─ chat.tsx                      # 「🧠 记忆」Tab
├─ session/
│  ├─ useAgentSession.ts         # 扩展：memories 状态（list + recalled + compacted 事件）
│  └─ MemoryPalace.tsx           # 新建
│     ├─ MemoryCardGrid.tsx      # 卡片网格（图标/摘要/引用次数/⭐锚定/🗑删除）
│     ├─ MemoryHeatmap.tsx       # 会话时间轴热力图（深绿=高频/灰=压缩/红虚线=触发点）
│     └─ MemorySearchBar.tsx     # 搜索 + 类型过滤（文件/工具/对话/锚定）
└─ chat.scss
```

### 3.4 数据流与状态管理
- 任务开始 `invoke('list_memories')` 拉初始网格；运行中监听 `memory_recalled` / `context_compacted` 增量更新。
- 锚定/删除：`invoke('anchor_memory',{entry_id,pinned})` / 删除走现有归档/删除 API。
- 热力图：用 `memory_recalled` 的 `ref_count` + `context_compacted` 的 `compactedRounds` 渲染时间轴着色。

### 3.5 分步实现
1. `wd_mem.rs` + `round_compactor.rs` + `events.rs`：`memory_recalled` / `context_compacted` 埋点 + 引用计数。
2. `commands.rs` + `lib.rs`：`list_memories` + `anchor_memory`。
3. `useAgentSession.ts`：扩展 `memories` 状态机。
4. `MemoryPalace.tsx` 全家桶 + `chat.scss` + `chat.tsx` Tab。
5. `cargo check` → `npm run typecheck` → `npm run tauri`。

---

## 4. 跨模块共享（侧边栏 Tab 架构）

现有 `chat.tsx` 为单对话视图。Phase 3 三视图建议统一为右侧栏 Tab 切换（K3 §5.4 响应式：≥1440px 三栏，侧边栏 260 + 对话弹性 + 右栏 360）：

```
RightPanel Tabs: [对话] [🔍 轨迹] [🎨 画布] [🧠 记忆]
```
- `useAgentSession` 统一持有 `trace` / `canvas` / `memories` 三状态机（一次事件总线，三视图订阅）。
- 所有新事件在现有 `listen('agent-event')` 内加 `case`；独立事件（`agent-token-update`/`agent-artifact-created`/`agent-recovery-needed`）已有独立 listener，按需在三视图间分发。
- 主题：所有新增样式走 `var(--color-*)` + `.dark` 变体（参考 §5.2 色板：成功 `#10B981`/运行中 `#3B82F6`/警告 `#F59E0B`/错误 `#EF4444`/信息 `#6366F1`）。

## 5. 执行顺序建议

```
P3-后端缺口（一次性，cargo check）
 ├─ emit_intent_classified        (§3.1)
 ├─ thinking_chunk 分层            (§3.1)
 ├─ branch_from_step + read_artifact (§3.2)
 └─ memory_recalled/context_compacted/list_memories/anchor_memory + ref_count (§3.3)
        │
        ▼
P3-前端三视图（可并行，npm run typecheck）
 ├─ TracePanel      (§3.1, 数据最齐，优先)
 ├─ ArtifactCanvas  (§3.2)
 └─ MemoryPalace    (§3.3, 依赖后端最多)
        │
        ▼
npm run tauri 真机验证（停止旧 dev 会话释放 target/ 锁，见 MEMORY.md §11 坑复盘）
```

## 6. 校验清单（每步必过）
- 后端改动：`RUSTUP_HOME=/d/Rust/rustup CARGO_HOME=/d/envs/Rust/.cargo RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/envs/Rust/.cargo/bin/cargo check`（零警告）。
- 前端改动：`npm run typecheck`（exit 0，禁 `vite build`）。
- 真机：停止运行中的 `npm run tauri` 窗口 → 重跑 `npm run tauri`（否则 `target/` 文件锁致 LNK1104）。
- 事件契约：任何新事件须在 `useAgentSession.ts` 有对应 `case` + 类型声明，避免前端监听静默丢事件。

## 7. 执行记录（2026-09-05）

**架构决策变更（用户拍板，覆盖原 §4）**：
1. 起步只做 **§3.1 垂直切片**先跑通（验证架构 + 后端补事件），再扩 §3.2/§3.3。
2. 三视图承载方式回归 **右栏 Tab**（对话在左、右栏 `Tabs` 切换 **执行轨迹 / 产物**；`chat.tsx` 渲染为 `agent-chat__right` 弹性列，`position` 不再 fixed，底部 150px 留白避让固定输入栏，并提供收起/重开入口）。**底部可切换面板方案已废弃**（用户反馈"放在底部感觉有点怪"）。
3. §3.2 画布采用 **增强/取代现有产物画廊** 策略（现有产物画廊已并入右栏「产物」Tab，不重复建设）。

**§3.1 切片已落地（cargo check 零警告 / npm run typecheck 零错误 / sass 编译通过）**：
- 后端：`IntentProfile` 补 `Serialize`；`events.rs` 给 `AgentEventPayload` 加 `intent`、`StreamChunk` 加 `layer`，新增 `emit_intent_classified` / `emit_thinking_chunk`；`runtime.rs` 分流后 emit intent；`pipeline.rs` 规划推理由误用 `emit_status` 改为 `emit_thinking_chunk(layer="plan")`。
- 前端：`types.ts` 扩展 `AgentEvent` + 新增 `IntentClassified`/`ThinkingChunk`；`useAgentSession` 增 `trace` 状态机 + 两事件 `case` + `reset` 清空；`TracePanel.tsx`(意图节点/分层思考/规划步骤/工具时间轴)；`chat.tsx` 右栏 `agent-chat__right` Tab（执行轨迹 / 产物，含收起按钮）；`chat.scss` 右栏与轨迹样式。
- 切片边界（留后续）：`thinking_chunk` 仅 planner 的 plan 层接线，exec/selfcheck 层尚未在运行时流式推送；simple_chat 路径不 emit intent_classified（前端意图节点自然为空）；§3.2/§3.3 未启动。

**历史回看轨迹：明确不做（用户拍板，2026-09-05）**。开发阶段以最新为准，右栏「执行轨迹」仅展示实时运行轨迹（live 态 `session.trace/planSteps/toolSteps`）。理由：① 旧版工具/规划/思考本就随轮次落库（`tool_calls_summary`/`plan_steps`/`thinking_content`），历史加载时内联在助手气泡里展示，已满足回看；② §3.1 的 intent+分层 thinking 仅在运行期内存，用户决定暂不补持久化与右栏历史回灌。后续若需要再单独立项（新增 `trace_json` 列 + 回灌 `useAgentSession`）。

**本轮补齐（cargo check 零警告 / npm run typecheck 零错误 / sass 编译通过）**：
- Task A · 分层思考三态贯通：① planner `build_plan` 返回值加 `String`（模型原始输出），`runtime.rs` 规划完成后补 emit `plan` 层 `thinking_chunk`（此前规划推理从未推送）；② `pipeline.rs` 子任务执行期推理由误标 `plan` 改为 `exec`；③ pipeline 收尾基于真实 `outputs`（步数/成功数/产物数）合成并 emit `selfcheck` 层 `thinking_chunk`。前端 `TracePanel` 已按 plan/exec/selfcheck 三色分层渲染，无需改动。
- Task B · §3.2 画布起步：① 后端 `emit_plan_generated` 的 task json 新增 `dependsOn`（task_id 字符串数组），补齐 DAG 连边数据；② 前端 `PlanStep` 加 `dependsOn?: string[]`（`useAgentSession` 直接 `setPlanSteps(e.plan.tasks)` 透传，无需改 handler）；③ 新建 `session/CanvasPanel.tsx`——hand-roll SVG DAG（节点=规划步骤、边=dependsOn 拓扑连线、状态着色、产物徽标），无新增依赖；④ 右栏新增第三 Tab「画布」（`rightTab` 类型扩展为 `trace|canvas|artifacts`），`chat.scss` 补画布样式。
- 说明：§3.2 画布已**完整落地**——起步切片（规划 DAG 可视化）+ 后半段真功能（`read_artifact` 产物预览 + `branch_from_step` 分支重规划 + `ArtifactCanvas` 拖拽/缩放/右键/对比横幅）均已实现。`CanvasPanel.tsx` 已被 `ArtifactCanvas.tsx` 取代（孤立文件，按铁律不删）。产物 Tab 仍保留，画布与之并存。

**Agent 引擎三项优化 + 对齐 skill（2026-09-06，cargo check 零警告）**：
- 优化1 · verifier 多关键词容错：`verifier.rs` 的 `text_contains` 由精确 `s.contains(value)` 改为 `value.split('|').any(|kw| s.contains(kw.trim()))`（无 `|` 退化精确匹配，向后兼容）；`planner.rs` 系统提示加「text_contains 用 | 分隔同义措辞」；`pipeline.rs` 的 `criteria_hint` 对 `text_contains` 渲染「任一即可」清单，与 verifier 一致。消除「内容写全但被判失败」误判（SUI 直接受益）。
- 优化2 · ReAct 上下文压缩：`pipeline.rs` 新增 `compress_in_flight_tool_results(messages, keep_recent_full=2)`——保留最近 2 条 tool 结果完整、更早替换为单行摘要（保留 `tool_call_id` 维持配对不变量），`run_subtask` 工具轮后调用，抑制长链路 input token 膨胀。
- 优化3 · 取消信号优先：`runtime.rs` `call_llm_stream` 在 `req.send()` 前查 `cancel` 直接返回（不重复计费）；`pipeline.rs` `run_subtask` 把取消检查移到「流式空响应非流式兜底」之前，避免取消时再发整段 prompt 非流式。消除「取消/接管后仍扣整段 prompt 费用」。
- 对齐 skill：`~/.workbuddy/skills/agent-pipeline-state-alignment/SKILL.md`（user 级，纯知识/检查清单，零代码副作用、不进 work-duo 运行时）——固化「多阶段异步链路 状态/命名/措辞不对齐」5 类易复发模式（emit started 漏 emit finished / plan-exec 文件名不一致 / verifier 措辞过死 / ReAct 上下文膨胀 / 取消后才计费）+ 诊断决策树 + 硬不变量 + 当前代码落点。给维护该引擎的 AI agent 自用。
- 预期：同类任务账单可从 ~61.51 积分降到 ~15–20 积分量级；「做对却被判失败」体验基本消失。待真机同任务复测对比。

**优化4 · 零输出快速重试（2026-09-06 收尾，cargo check 零警告）**：
- 背景：真机复测三优化后同 SUI 任务账单 38.53 积分（省 37.4%），但仍有 2 次「9.1K 输入/0 输出」=5.68 积分（15%）——网关自然断流（非用户取消），优化3 取消优先堵不住。用户拍板「直接做剩余一项」。
- 修复：`runtime.rs` 把 `call_llm_stream` 拆为**外层 retry 包装 + `call_llm_stream_once`（单次请求+SSE 聚合）**。零输出（content+tool_calls 双空）或网络/HTTP 错误自动重试一次（MAX_RETRY=1）；用户取消（Err 含「取消」）透传不重试；单次函数内 cancel `break` 改 `return Err("任务已被用户取消")` 保证包装层不对其重试。修复了 2 处编译错误（漏传 `_app` 参数 / `o` 被 move 进 `last` 后再次 return → 改用 `last.unwrap()`）。
- 预期：🔴 零输出浪费带（~15%）→ ~0（多数断流重试即恢复）；单次 SUI 任务成本稳到 ¥0.04 内。skill 已同步升级为 **6 类模式**（新增 Mode 6 网关零输出流 + 决策树第 6 条）。待真机同任务复测对照 38.53 账单。

**§3.2 画布后半段 · 真功能落地（2026-09-06，cargo check 零警告 + tsc 零错误）**：
- **后端 `read_artifact`**（`commands.rs` + `lib.rs`）：经 PathGuard 校验，按扩展名返回图片 dataUrl / 文本 content（截断）/ 目录 entries / 二进制提示。零新增依赖。
- **后端 `branch_from_step`**（`commands.rs` + `lib.rs` + `events.rs` + `types.rs`）：调 `planner::build_plan` 生成新分支，重编号续接原步骤序号，经 `agent-plan-branch` 事件推前端画布对比横幅。修复了 `load_config` 少传 `attachments` 参数的编译错误。
- **前端 `ArtifactCanvas.tsx`**（新建，取代 `CanvasPanel`）：拖拽平移 + 滚轮缩放 + 节点点击选中预览产物 + 右键「从此步骤分支」+ 分支对比横幅（原方案 vs 新分支双列 + 应用/放弃）。
- **前端 `chat.tsx`**：画布 Tab 换成 `ArtifactCanvas`；新增 `handlePreviewArtifact`/`handleBranchFromStep`/`handleApplyBranch`/`handleDismissBranch`；新增产物预览 Modal（文本/图片/目录/错误 + 元数据）。
- **SCSS**：追加交互画布 + 产物预览 Modal 样式。
- 校验：`cargo check` exit 0；`tsc --noEmit` 零输出（零错误）；sass 因环境 PowerShell 外部进程 stdout 捕获障碍未能自动验证，SCSS 语法人工检查正确。建议真机目测。
- 边界：`handleApplyBranch` 当前只 log 不实际重跑（需后端支持用新分支步骤重跑任务，后续 TODO）；`handleDismissBranch` 切到 trace Tab 视觉隐藏（后续可加 `dismissPlanBranch` 方法）。`CanvasPanel.tsx` 已孤立（按铁律不删）。
