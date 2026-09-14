# 右侧「执行轨迹」改版 · 三路线 UI 规格

> 状态：**已拍板主路线 = 方案 C · Graph-first**（2026 用户选定）  
> 范围：`agent-studio/chat` 右栏 Inspector + 现有 `ArtifactCanvas` 升级  
> **作用域红线：只服务「当前这一轮对话 / 当前 run」，不做 session 级历史回放**  
> 数据源：`useAgentSession`（planSteps / toolSteps / artifacts / planBranch / recovery / intent / tokens）  
> 原则：数据已齐，主改信息架构与叙事密度

---

## 0. 共同底座（三路线共享）

### 0.1 右栏壳重定义

| 现状 | 建议 |
|---|---|
| 四平权 Tab：轨迹 / 产物 / 画布 / 接管 | **Inspector**：主视图 + 投影 + 情境层 |
| 接管常驻 Tab | recovery 出现时才升起（底栏或浮层） |
| 默认关右栏 | 保持；任务开始可自动开（可选） |

### 0.2 推荐共用字段映射

| UI 元素 | 数据 | 备注 |
|---|---|---|
| 运行状态 | `isRunning` / `taskError` / `recovery` | 顶栏三态 |
| 步骤进度 | `planSteps[]` + `status` | `x/y` |
| 当前步骤 | `status==='running'` 的 planStep | now |
| 站台下工具 | `toolSteps.filter(t => t.step === s.step)` | 已有 `step` |
| ±行数 | `linesAdded` / `linesRemoved` | 已有 |
| 思考 | `trace.thinking[]` + `layer` | 按 step 归组需前端聚合 |
| Token | `liveTokenUsage` | 顶栏 |
| 失败行动 | `recovery` + `resolveRecovery` | 底栏 |
| 产物 | `artifacts[]` | 投影 Tab |

### 0.3 共用状态机（顶栏文案）

```text
idle          等待任务
running       运行中 · 步骤 2/5 · edit_file
awaiting_hitl 等待审批 / 选择 / 计划确认
recovery      步骤受阻 · 请选择处置
done          完成 · 5/5 成功
done_partial  完成 · 4/5（1 跳过）
error         异常终止
cancelled     已取消
```

### 0.4 共用尺寸

| Token | 值 |
|---|---|
| 右栏默认宽 | 380px（min 320 / max 720） |
| 顶栏高 | 48px sticky |
| 站台行高 | 40px（运行中 52px） |
| 工具行高 | 30px |
| 脊柱 | 2px，距左 18px |
| 圆角 | 站台 8px / 徽标 999px |
| 色 | 规划紫 / 执行蓝 / 自检橙 / 成功绿 / 失败红 / 待跑灰 |

---

## 1. 路线 A · Run Spine 时间线（推荐主路线）

### 1.1 一句话

**一条脊柱时刻表**：意图 → 规划站台 → 工具叶子 + 思考旁注；失败抬底栏。

### 1.2 线框

见对话内 SVG「方案 A」。

### 1.3 组件树

```
InspectorShell
├ StickyRunHeader          # 状态点/步骤/当前动作/进度/token
├ TraceSpine
│  ├ IntentStation
│  ├ PlanStation[]         # 每步一站
│  │  ├ StationHead        # 序号/标题/状态/耗时
│  │  ├ ToolLeaf[]         # 嵌套工具行
│  │  └ ThinkAside         # 默认折叠「思考 · n」
│  └ SpineTail
└ RecoveryActionBar        # 仅 recovery 非空
```

### 1.4 交互规格

| 行为 | 规则 |
|---|---|
| 默认密度 | 标准：站台 + 工具行；思考折叠 |
| 运行中 | 当前站台高亮；工具 running 转圈；自动滚到当前 |
| 用户上滚 | 出现「回到当前 ↓」胶囊 |
| 点击站台 | 展开/收起该站工具+思考（单开模式可选） |
| 点击工具行 | 预留：展开 args/result 摘要（默认只一行） |
| 失败 | 站台红脊柱打断 + 自动展开错误摘要 + 底栏 3 键 |
| 空态 | 淡脊柱 + 文案「跑一轮任务，这里会变成运行时刻表」 |

### 1.5 字段增量（无后端依赖）

前端本地聚合即可：

```ts
type StationView = {
  step: number
  title: string
  status: PlanStepStatus
  summary?: string
  tools: ToolStep[]          // filter by step
  thinking: ThinkingChunk[]  // 需前端把 thinking 挂到当前 step
  durationMs?: number
}
```

> 注意：`ThinkingChunk` 目前无 `step` 字段。V1 可用「运行中全局思考归当前 step」；若要精确归组，二期可给后端事件补 `step`（小改）。

### 1.6 优劣

| 优 | 劣 |
|---|---|
| 叙事最强，3 秒扫读 | 窄栏一次只适合跟一条链 |
| 复用 step 嵌套，数据零浪费 | 精确思考归组可选依赖小后端补丁 |
| 失败可操作路径清晰 | 不展示 DAG 依赖（依赖交给图投影） |

---

## 2. 路线 B · 时间线 + 迷你缩略条

### 2.1 一句话

在 A 之上加 **8–10px 高步骤 sparkline**，支持一眼总览 + 点跳。

### 2.2 与 A 的差异

```text
┌ StickyRunHeader ──────────────────────┐
│ ● 运行中  2/5  edit_file · 1.2s  12k │
│ [■■▓░░]  ← sparkline 5 段可点        │
└──────────────────────────────────────┘
  （其余同 A 脊柱）
```

### 2.3 Sparkline 规格

| 段状态 | 色 | 交互 |
|---|---|---|
| success | 绿 | 点击滚到该站 |
| running | 蓝 + 微呼吸 | 跟随 |
| failed | 红 | 点击展开失败详情 |
| pending | 灰 | 点击预览标题（tooltip） |
| skipped | 斜纹灰 | 同上 |

宽度：按步骤均分容器宽；步骤 >8 时压缩为 4px 段距。

### 2.4 组件树增量

```
StickyRunHeader
├ ...
└ StepSparkline            # 可点击跳转
```

### 2.5 优劣

| 优 | 劣 |
|---|---|
| 长任务（5 步满配）总览更快 | 多一块视觉噪音；3 步以内略冗余 |
| 失败定位一眼可见 | 实现+状态同步成本略高于 A |

---

## 3. 路线 C · Graph-first（已选定 · 单次对话作用域）

### 3.1 一句话

右栏默认 **本轮 DAG 画布为主**；轨迹降级为「过程摘要条」；**只渲染当前这一轮 run，不加载历史 session 图**。

### 3.2 作用域定义（红线）

| 概念 | 定义 | 右栏是否包含 |
|---|---|---|
| **当前 run** | 一次 `send` → 一次 `run_agent_task` → 一条 `PlanDAG`（或 SIMPLE 直通） | ✅ 唯一数据源 |
| 同会话上一轮 | 用户再发一条消息后的上一次 run | ❌ 发送时清空/替换，不累积 |
| session 历史回放 | 打开会话时回放多轮图 | ❌ 本期明确不做 |
| 跨会话图检索 | `native__query_graph` 全库 | ❌ 不进本面板 |

**生命周期：**

```text
打开会话 / 切换会话     → 右栏空态（未运行）
send 新消息            → reset()：清空图/工具/产物 → 开始填本轮
run 进行中             → 实时节点/边/状态
run 结束               → 保留本轮图（只读），直到下一次 send 或切换会话
历史点击加载旧轮次      → 不自动填右栏；若用户「重新生成」则生成新 run
```

> 与现状一致：`useAgentSession` 本就是 per-run 内存态；Graph-first 只是把默认视图从「轨迹列表」换成「本轮 DAG」。后端 `KnowledgeGraph` 虽按 session 落盘，**UI 不读历史图**。

### 3.3 布局

```text
┌ Inspector（仅本轮） ───────────────────┐
│ [图] [过程] [产物]     ← 3 投影，图默认  │
│ ● 2/5 · edit_file · ▓▓▓░░░ · 12k tok │
├──────────────────────────────────────┤
│         DAG 画布（主区 · 本轮）         │
│  节点：状态色 / 当前呼吸 / 产物角标      │
│  边：depends_on；失败节点红描边         │
│  选中节点 → 右侧/下方详情条             │
│                                      │
│  ── 过程摘要条（默认 1 行，失败展开）──  │
│  ② edit_file 失败：old_str 不匹配      │
│  [重试] [跳过] [接管]                  │
└──────────────────────────────────────┘
```

### 3.4 三态主区（必须都设计，避免简单对话空虚）

| 场景 | 主区内容 |
|---|---|
| **COMPOSITE（有 plan）** | 完整 DAG：节点+边+状态+产物角标 |
| **SIMPLE_CHAT（无 plan）** | 「单点任务卡」：意图徽标 + 本轮工具一行流 + 完成态；**不造假 DAG** |
| **空（未 send）** | 空态插画/文案：「发送任务后，这里显示本轮执行图」 |

### 3.5 「过程」子视图（原轨迹降级）

- 默认折叠为 **1 行摘要**：`步骤 2/5 · 当前 edit_file · 失败 0`  
- 点击展开：仅 **当前站 + 前 2 站** 工具一行流（不全量 dump）  
- 失败/recovery：自动展开失败节点详情 + 行动 3 键  
- 思考：**不进右栏**（中栏 ThoughtPanel 已有）

### 3.6 节点详情条（点选 DAG 节点后）

```text
┌ ② 修改计数逻辑 · 运行中 ────────────────┐
│ 工具：edit_file(+12/−3) · execute_command │
│ 产物：demo.tsx                          │
│ 摘要：…（step_finished 后回填）           │
│ [在对话中定位] [预览产物] [从此处分支]     │
└────────────────────────────────────────┘
```

### 3.7 组件树（落地形态）

```
InspectorShell                    # 替换右栏四 Tab 壳
├ ProjectionTabs                  # 图(默认) | 过程 | 产物
├ StickyRunHeader                 # 本轮状态条（非 session）
├ GraphMain                       # 升级 ArtifactCanvas
│  ├ DagNodes/DagEdges
│  ├ SimpleChatFallbackCard       # 无 plan 时
│  └ EmptyRunState
├ ProcessStrip                    # 折叠过程摘要
├ NodeDetailBar                   # 选中节点
└ RecoveryActionBar               # recovery 情境升起
```

### 3.8 与「单次对话」对齐的交互

| 行为 | 规则 |
|---|---|
| 发送新消息 | 右栏图立即 reset 为本轮 |
| 切换左侧会话 | 右栏清空（不加载该会话历史图） |
| 任务结束 | 图保留只读，供分支/预览 |
| 分支重跑 | 仍是新 run：head 标完成 + 新 tail，整图替换 |
| 接管 | 不进常驻 Tab；recovery 时升起 |
| 宽度 | 默认 400px（图需要空间），可拖 320–720 |

### 3.9 优劣（在「仅本轮」约束下）

| 优 | 劣 |
|---|---|
| 与画布合并，少一个心智入口 | 过程叙事弱（靠过程条+节点详情补） |
| 本轮依赖关系一等公民 | SIMPLE_CHAT 需独立降级卡 |
| 作用域清晰，实现可控 | 历史想看图只能重跑/未来二期再做 session 视图 |
| 不碰后端历史加载 | ArtifactCanvas 需升级状态/选中/详情 |

---

## 4. 三路线对比决策表

| 维度 | A 脊柱 | B 脊柱+缩略 | C 图优先 |
|---|---|---|---|
| 扫读速度 | 高 | 最高（长任务） | 中（结构快、过程慢） |
| 实现成本 | 低-中 | 中 | 中-高（画布增强） |
| 后端改动 | 可无 | 可无 | 可无（若加节点点击回中栏则纯前端） |
| 与画布关系 | 投影切换，不打架 | 同 A | 合并，减少重复 |
| 失败处置 | 底栏清晰 | 同 A | 摘要条 |
| 简单对话场景 | 有意图+文本即可 | 同 A | 空虚风险 |
| 差异化记忆点 | 「运行时刻表」 | 「一眼五步」 | 「任务即图」 |
| 建议 | **默认主路线** | A 的增强包 | 二期可选主题 |

---

## 5. 已拍板决策（2026）

| 项 | 决定 |
|---|---|
| 主路线 | **C · Graph-first** |
| 作用域 | **仅当前一轮 run**，不做 session 级 |
| 右栏 Tab | 图（默认）/ 过程 / 产物；**接管改情境升起** |
| 思考 | 不进右栏，保留中栏 ThoughtPanel |
| Sparkline | 本期不做（图本身即结构总览） |
| 历史图回放 | **明确不做**（二期若做再单开） |

### 5.1 建议补齐拍板（实现前再确认）

| 问题 | 建议默认 |
|---|---|
| 任务开始自动打开右栏 | **是**（Graph-first 需要可见才有价值） |
| SIMPLE_CHAT 右栏 | 显示单点卡，不造假 DAG |
| 右栏默认宽 | **400px** |

---

## 6. V1 验收清单（Graph-first · 单轮）

- [ ] 发送后右栏出现本轮 DAG；再发送则整图替换，不残留上轮  
- [ ] 节点状态色正确：pending/running/success/failed/skipped  
- [ ] 当前运行节点有明确高亮（呼吸或描边）  
- [ ] 点节点出详情条：工具行 / 产物 / 摘要 / 分支入口  
- [ ] SIMPLE_CHAT 显示单点任务卡，无假边  
- [ ] 未运行空态文案清晰  
- [ ] recovery 时升起 3 键，不依赖常驻「接管」Tab  
- [ ] 切换左侧会话 → 右栏清空  
- [ ] 明暗主题可读；320/400/720 三档不破版  
- [ ] 「过程」默认一行，失败可展开最近工具  

---

## 7. 明确不做（V1）

- session / 跨轮历史图回放  
- 轨迹脊柱主视图（已被图取代；过程仅摘要条）  
- 轨迹内嵌计划编辑  
- 全量 args/result 默认展开  
- 重型动画 / 粒子  
- Thinking 进右栏  

---

## 8. V1 实施切片（仍不改代码，供排期）

| 切片 | 内容 | 依赖 |
|---|---|---|
| S1 壳 | 四 Tab → 图/过程/产物 + 接管情境化 | 无 |
| S2 图主区 | ArtifactCanvas 升级为 Inspector 主视图（状态/选中/详情条） | S1 |
| S3 降级 | SIMPLE_CHAT 单点卡 + 空态 | S2 |
| S4 过程条 | 折叠摘要 + 失败展开 3 键 | S2 |
| S5 生命周期 | send/切换会话 reset；结束保留只读 | S2 |
