# Work Duo 智能体分层执行引擎 —— 架构与执行逻辑全解

> 适用范围：`src-tauri/src/agent/*`（Rust 引擎）+ `src/pages/agent-studio/*`（前端 UI/事件）
> 整理日期：2026-09-04
> 本文含文件清单、各阶段执行逻辑、关键功能代码片段，以及「按环节针对性测试」的对照表，供逐环节验证功能。

---

## 1. 总览：三层流水线架构

一次 `run_agent_task` 从前端进来后，后端走 **意图分流 → DAG 规划 → 微 ReAct 流水线执行** 三段式链路，彻底废弃了旧版全局大 ReAct 循环。

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 前端 run_agent_task (workspace / prompt / sessionId / roundId / 禁用项)    │
└───────────────────────────────┬──────────────────────────────────────────┘
                                  │ invoke
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ commands.rs::run_agent_task → load_config() 组装 AgentRuntimeConfig        │
│   （从 SQLite 读 agent_info/models/mcp/skill，注入 system_prompt+工作空间） │
└───────────────────────────────┬──────────────────────────────────────────┘
                                  │ spawn 后台
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ runtime.rs::run_task                                                          │
│   ① 回写 tools_tokens                                                        │
│   ② 组装 ToolRegistry = 原生 + Skill + MCP  （能力层单一事实源）            │
│   ③ 阶段一 intent::classify_intent()                                         │
│        ├─ SIMPLE_CHAT → run_simple_chat()（单次流式，0 工具）                │
│        └─ COMPOSITE_TASK ↓                                                   │
│   ④ 阶段二 planner::build_plan() → PlanDAG（强制 temperature=0）            │
│   ⑤ 阶段三 pipeline::run_pipeline() → 顺序执行子任务（每步独立上下文）      │
│        └─ run_subtask() 微 ReAct：工具轮独立计数，汇报轮不计入预算          │
│   ⑥ emit_text_chunk(final) + emit_task_done(token 用量)                      │
│   ⑦ 回填精简 raw_messages_json（user + 规划摘要 + 终态交付）                 │
└───────────────────────────────┬──────────────────────────────────────────┘
                                  │ 事件流
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 前端 useAgentSession 监听 agent-event / agent-awaiting-approval /           │
│ agent-task-done / agent-task-error → 渲染思考面板 / 步骤进度条 / 文件卡片   │
└──────────────────────────────────────────────────────────────────────────┘
```

**设计红线（贯穿全文，测试时务必理解）：**
- **能力层优先**：约束必须落在 `register_native_tools` 注册集合；只写进 system_prompt 必然被模型绕过（实测：沙箱开却仍注册 `execute_command`，模型会去找系统 python 甚至 `winget install`）。
- **消息配对不变量**：每个 assistant 的 `tool_call.id` 必须有对应 tool 结果，否则网关 HTTP 400 `tool result's tool id not found`。发送前与落库前各调一次 `sanitize_message_sequence` 自愈。
- **闭环靠"无进展"而非砍总轮数**：子任务级 `MAX_SUBTASK_ITERATIONS=8`（工具轮），终态汇报轮不计入预算。
- **失败永远降级不崩溃**：意图/规划失败降级，绝不 panic。

---

## 2. 涉及文件清单

### Rust 引擎（`src-tauri/src/agent/`）
| 文件 | 职责 | 关键符号 |
|---|---|---|
| `commands.rs` | Tauri 命令入口 + `load_config` 组装配置 | `run_agent_task` / `submit_approval_decision` / `RunAgentTaskInput` / `load_config` |
| `runtime.rs` | ReAct 调度引擎 + LLM 调用 + 工具轮执行 + 消息自检 | `AgentRuntime::run_task` / `run_simple_chat` / `run_tool_calls_round` / `call_llm` / `call_llm_stream` / `sanitize_message_sequence` |
| `intent.rs` | 阶段一：意图分流（规则短路 + LLM 轻量分类） | `classify_intent` / `IntentProfile` / `COMPOSITE_HINTS` |
| `planner.rs` | 阶段二：DAG 规划（确定性拆分） | `build_plan` / `PlanDAG` / `single_task_fallback` / `capability_outline` |
| `pipeline.rs` | 阶段三：微 ReAct 流水线执行 | `run_pipeline` / `run_subtask` / `SubTaskOutput` |
| `native.rs` | 原生工具注册 + 沙箱 Python 执行工具 | `register_native_tools` / `RunPythonSandboxTool` / `PathGuard` |
| `mamba_manager.rs` | micromamba 沙箱管理 + 缺失库自愈 | `run_script_with_selfheal` / `AUTO_INSTALL_ALLOW` / `missing_modules` |
| `tools.rs` | 工具注册表 / 权限级别 / 执行抽象 | `ToolRegistry` / `AgentTool` / `PermissionLevel` |
| `events.rs` | 前后端事件推送 | `emit_plan_generated` / `emit_step_finished` / `EVT_*` |
| `types.rs` | 共享类型（前后端契约） | `AgentRuntimeConfig` / `IntentProfile` / `PlanDAG` / `PlanSubTask` / `SubTaskOutput` |
| `context.rs` / `round_compactor.rs` / `wd_mem.rs` / `approval.rs` / `mcp_adapter.rs` / `skill_adapter.rs` | 上下文装配 / 会话压缩落库 / 双轨记忆 / 审批 / MCP / Skill 适配 | — |

### 前端（`src/pages/agent-studio/`）
| 文件 | 职责 |
|---|---|
| `session/useAgentSession.ts` | 调 `run_agent_task`、监听全部事件流、更新状态 |
| `session/types.ts` | 前后端事件契约类型（`PlanStep` / `AgentEvent` / `RunAgentTaskInput`） |
| `session/ApprovalNotify.tsx` | 审批弹窗（右下角） |
| `chat.tsx` | 聊天 UI：思考面板、步骤进度条 `PlanStepsBar`、文件路径卡片 `FilePathCards`、输入框 |
| `chat.scss` | 全部样式（含今天优化的输入框居中 / 拖拽手柄 / 侧栏） |

### 能力配置（`src-tauri/capabilities/default.json`）
- `opener:allow-open-path` 带 scope `{"path":"**"}`（文件卡片点击打开所需）

---

## 3. 阶段一：意图分流（intent.rs）

**目标**：极速判定「闲聊」还是「复合任务」。**绝对不挂工具**，防幻觉。

**逻辑**：
1. 规则短路优先（0 成本）：
   - 短消息（≤20 字）且无复杂关键词 → `SIMPLE_CHAT`
   - 命中复杂关键词（`file/code/python/数据/excel/预测…`）且较长（≥30 字）→ `COMPOSITE_TASK`
2. 灰色地带才走一次轻量 LLM 分类（非流式、0 工具）。
3. 分类失败一律降级 `COMPOSITE_TASK`（宁可多规划，不可漏拆解）。

**关键代码：**
```rust
// intent.rs:25
pub async fn classify_intent(cfg: &AgentRuntimeConfig, prompt: &str) -> IntentProfile {
    let trimmed = prompt.trim();
    let len = trimmed.chars().count();
    let lower = trimmed.to_lowercase();
    let has_hint = COMPOSITE_HINTS.iter().any(|k| lower.contains(&k.to_lowercase()));

    if len <= 20 && !has_hint {            // 短路1：明显闲聊
        return IntentProfile { intent_type: "SIMPLE_CHAT".into(), reason: "规则短路：短消息且无复杂关键词".into() };
    }
    if has_hint && len >= 30 {             // 短路2：明显复合任务
        return IntentProfile { intent_type: "COMPOSITE_TASK".into(), reason: "规则短路：命中复杂任务关键词".into() };
    }
    // 灰色地带 → runtime::call_llm(cfg, &messages, &[])  非流式、0 工具
    // 解析失败 → fallback("…") 降级 COMPOSITE_TASK
}
```

**测试点：**
- 输入「你好」→ 应走 SIMPATE_CHAT，日志 `[agent] intent: 规则短路 → SIMPLE_CHAT`。
- 输入「帮我抓取 SOL 近一周价格并生成 Excel」→ 命中 `抓取/excel` 且 ≥30 字 → `COMPOSITE_TASK`。
- 输入边界句（如「分析这个文件」20~30 字）→ 走 LLM 分类，看日志是否调用了一次非流式 LLM。

---

## 4. 阶段二：DAG 规划（planner.rs）

**目标**：把宏观目标拆成 1~5 个**顺序原子子任务**。模型只当"架构师"，只给能力大纲、**不注入工具 JSON Schema**（省 token、防意淫能力）。

**逻辑**：
1. 组装 system prompt：能力大纲（`capability_outline`）+ 工作空间 + 4 条拆解规则（含"同类目标保持一致拆分粒度"）。
2. **规划调用强制 `temperature=0`**（确定性，消除同类任务拆分漂移）。
3. 调 `runtime::call_llm`（非流式）拿 JSON。
4. 解析容错：
   - `extract_content` 优先 `content`，空则回落 `reasoning_content`/`reasoning`（修推理模型把 JSON 放推理通道的 bug）。
   - `extract_json_str` 去 markdown 代码围栏 + 取首 `{`~末 `}`。
   - 解析失败 → `single_task_fallback` 降级为单个巨任务（**不死崩溃**）。
5. 归一化：按 step 排序、截断 `MAX_PLAN_STEPS=5`、重排 step 序号。

**关键代码：**
```rust
// planner.rs:50  —— 确定性规划
let mut plan_cfg = cfg.clone();
match plan_cfg.llm_config.as_object_mut() {
    Some(obj) => { obj.insert("temperature".into(), json!(0)); }
    None => { plan_cfg.llm_config = json!({ "temperature": 0 }); }
}

// planner.rs:153 —— content 为空时回落推理通道（修复点：MiniMax-M3 / DeepSeek-R1）
fn extract_content(resp: &Value) -> String {
    if let Some(c) = resp.get("content").and_then(|c| c.as_str()) {
        if !c.trim().is_empty() { return c.to_string(); }
    }
    for key in ["reasoning_content", "reasoning"] {
        if let Some(r) = resp.get(key).and_then(|v| v.as_str()) {
            if !r.trim().is_empty() { return r.to_string(); }
        }
    }
    String::new()
}

// planner.rs:141 —— 降级兜底（绝不崩溃）
fn single_task_fallback(prompt: &str) -> PlanDAG {
    PlanDAG {
        goal_summary: clip(prompt, 100).to_string(),
        tasks: vec![PlanSubTask {
            step: 1, task_id: "t1".into(),
            title: "完成用户任务".into(), description: prompt.to_string(),
        }],
    }
}
```

**测试点：**
- 用 `MiniMax-M3`（开 reasoning）跑"采集 SOL→生成 Excel→预测" → 日志应出现 `planner: 规划完成 ... 步骤数=3`，且 goal_summary/title 正常（验证 reasoning 回落修复）。
- 用弱模型（如早期 `Deepseek-v4-flash` 只回 1 token）→ 解析失败降级单任务，但任务仍能跑（不崩溃）。
- 对同一句 prompt 跑两次 → 拆分应完全一致（验证 `temperature=0`）。
- 换不同主体（SOL / ETH）同类任务 → 步数结构应一致（验证"同类目标一致拆分"约束）。

---

## 5. 阶段三：微 ReAct 流水线执行（pipeline.rs）

**目标**：顺序执行每个子任务，每步**完全独立 messages**（0 历史包袱），靠"产物管道"（前序纯文本摘要）单向传信息，中间几万字工具报文随作用域销毁。

**`run_pipeline` 逻辑：**
1. 遍历 `plan.tasks`，每步 `emit_step_started`。
2. 单步失败**重试最多 3 次**（`MAX_SUBTASK_RETRIES`）；仍败 → 立即 `return` 中止流水线，向用户报告"步骤 X 受阻" + 已完成产物。
3. 成功则把 `output.summary` 推入 `pipeline_context_summary`（只传纯文本摘要给下一步）。
4. 全部成功 → 合并全局执行视图 + `emit_text_chunk(final)`。

**`run_subtask` 微 ReAct 循环（核心修复点）：**
```rust
// pipeline.rs:28
const MAX_SUBTASK_ITERATIONS: usize = 8;   // 工具轮上限（非总轮）
const MAX_SUBTASK_CONSECUTIVE_ERRORS: usize = 2;

loop {
    round += 1;
    sanitize_message_sequence(&mut messages);            // 每次调用前配对自检
    let mut outcome = call_llm_stream(...).await;          // 每轮只 1 次 HTTP
    // 流式空响应兜底：回退一次非流式 call_llm
    // ...
    // 终态：无 tool_calls → 结算（不计入工具预算！）
    if outcome.tool_calls.is_empty() {
        let summary = outcome.content.trim().to_string();
        let success = !summary.is_empty();
        return (SubTaskOutput { step, title, summary, success }, usage);
    }
    // 工具轮：计入预算；超 8 轮仍未收敛 → 判受阻（但终态汇报轮在上一分支已放行）
    tool_iterations += 1;
    if tool_iterations > MAX_SUBTASK_ITERATIONS { /* 返回未闭环 */ }

    // 推送思考面板（reasoning / content）
    run_tool_calls_round(...).await;                      // 执行本轮全部工具
    // 连续 2 轮工具全失败 → 判受阻
}
```

**关键修复（本轮排查重点）：** 旧代码 `for iteration in 1..=5` 把"汇报轮"和"工具轮"混在同一预算。Excel 第 5 轮刚生成成功，预算耗尽被踢出 → 误判"未闭环"。现在 **`tool_calls` 为空的终态汇报轮不计入 `tool_iterations`**，产物已生成的任务必能正常闭环。

**测试点：**
- 多步任务（采集→Excel→预测）→ 步骤 2 生成 Excel 后应正常 `step_finished success`，步骤 3 接着执行（不再"已完成的步骤产物为空"）。
- 故意让某步工具连错 2 轮 → 日志 `连续 2 轮工具全失败，判定受阻`，流水线中止并报"步骤 X 受阻"。
- 单步死循环调用工具 → 第 9 个工具轮触发 `超过 8 轮工具调用仍未闭环`。
- 看日志 `子任务 step=X 闭环（总轮 N，工具轮 M）`：M ≤ 8，N 可 > M（含汇报轮）。

---

## 6. 公共运行时（runtime.rs）

### 6.1 `run_task` 入口（三段调度）
```rust
// runtime.rs:58
pub async fn run_task(&self, app, cfg, prompt) {
    // ① 回写 tools_tokens（按当前 MCP/Skill 数）
    // ② 组装 registry：register_native_tools(allow_sandbox) + register_skills + register_mcp
    // ③ 阶段一 intent
    if intent.is_simple_chat() { self.run_simple_chat(app, &cfg, &prompt).await; return; }
    // ④ 阶段二 build_plan → emit_plan_generated
    // ⑤ 阶段三 run_pipeline
    // ⑥ emit_text_chunk(final) + emit_task_done(task_usage)
    // ⑦ 回填精简 raw_messages_json（sanitize 后）
}
```

### 6.2 LLM 调用
- `call_llm`（非流式）：用于意图分类、规划、流式兜底。注入 `cfg.llm_config`（temperature/max_tokens），`reasoning=true` 归一化为 `{}`（部分网关要求 dict 而非 bool）。
- `call_llm_stream`（流式）：SSE 聚合，`delta.tool_calls` 按 `index` 归并，`usage` 取自最后一个 chunk（`stream_options.include_usage=true`）。每轮**只 1 次 HTTP**（非"非流式判断+流式输出"双调用）。

### 6.3 工具轮执行 `run_tool_calls_round`
固定环节：解析参数（JSON 解析失败 → 把错误回传给模型自愈）→ 注册表查找 → 敏感工具审批挂起（`auto_tool_exec_mode` 时跳过）→ 执行 → `truncate_tool_output(15000)` 物理截断 → emit `tool_started/finished`。

### 6.4 消息配对自检（防 HTTP 400）
```rust
// runtime.rs:945
pub(crate) fn sanitize_message_sequence(messages: &mut Vec<Value>) {
    // ① 收集每个 assistant 声明的 tool_call id
    // ② 收集已存在结果的 tool_call_id
    // ③ 缺失结果 → 补占位（内容引导模型改道，而非崩溃）
    // ④ 丢弃孤儿 tool 消息（找不到发起它的 assistant）
}
// trim_history：滑动窗口，切点逐条前移直到配对安全，极端回退保留最后一条非 tool 消息
```
**测试点：** 故意砍掉一条 tool 结果 → 日志 `补齐 N 条缺失的 tool 结果占位`；并行工具调用被裁切 → 不应出现 `tool result's tool id not found`（HTTP 400）。

---

## 7. 工具层与沙箱自愈

### 7.1 能力层注册（native.rs）—— 沙箱开关是单一真值源
```rust
// native.rs:732
pub fn register_native_tools(registry, app, sandbox_enabled: bool) {
    registry.register(Arc::new(ReadFileTool));      // ReadSafe
    registry.register(Arc::new(WriteFileTool));     // RequireApproval
    registry.register(Arc::new(ArchiveArtifactTool));
    registry.register(Arc::new(EditFileTool));      // RequireApproval
    registry.register(Arc::new(ListDirectoryTool)); // ReadSafe
    if !sandbox_enabled {
        registry.register(Arc::new(ExecuteCommandTool)); // 沙箱开则不注册！
    }
    registry.register(Arc::new(RunPythonSandboxTool::new(app.clone()))); // RequireApproval
}
```
> **关键**：`allow_sandbox=true` 时 `execute_command` 不注册，同时 `load_config` 的 system_prompt 也不教 cmd/sh 语法——能力层与提示层同源，模型无法绕道。

### 7.2 沙箱 Python 执行（native.rs + mamba_manager.rs）
- `native__run_python_sandbox` 支持 `code` 直传（内部落盘 `.wd_mem/scripts/` 再执行）→ 消除"先 write_file 再传 script_path + 每次审批"的摩擦，避免模型改用 `execute_command` 跑系统 python。
- 落盘后仍过 `PathGuard` 防路径穿越。

### 7.3 缺失库自动安装自愈（本轮修复重点）
```
纯净环境 default（Python 3.11，不预装第三方库）
  → 脚本 import pandas 失败 ModuleNotFoundError
  → missing_modules() 解析缺失模块名
  → 命中 AUTO_INSTALL_ALLOW 白名单（pandas/numpy/openpyxl/scipy/sklearn…）
  → install_packages_silent() micromamba install
  → 自动重试一次 run_script_with_selfheal
```
```rust
// mamba_manager.rs:45 白名单
const AUTO_INSTALL_ALLOW: &[&str] = &[
    "requests","numpy","pandas","openpyxl","xlsxwriter","scipy","statsmodels",
    "matplotlib","seaborn","yfinance","ccxt","scikit-learn","sklearn","pyyaml",
    "yaml","json5","tqdm",
];
// mamba_manager.rs:558 —— 自愈闭环
async fn run_script_with_selfheal(app, mgr, mamba_root, rc, env, tmp_path, cwd) {
    let (stdout, stderr, code) = run_sidecar(...).await?;
    if code != Some(0) {
        if let Some(mods) = missing_modules(&stderr) {       // 仅白名单内触发
            install_packages_silent(app, mgr, env, &mods).await?;
            let (o2,_,c2) = run_sidecar(...).await?;          // 重试一次
            return match c2 { Some(0) => Ok(o2), _ => Err(...) };
        }
    }
    // 非库缺失类错误（语法/网络）原样返回，不触发安装
}
```
**测试点：**
- 第一次跑需要 `pandas` 的脚本 → 首跑会因 `ModuleNotFoundError` 失败，日志 `检测到缺失库 ["pandas"]，尝试自动安装后重试一次`，二跑成功（首次较慢，走清华镜像）。
- 脚本语法错误 → 不会触发安装，直接返回 stderr（避免死循环安装）。
- 想关闭自愈：从 `AUTO_INSTALL_ALLOW` 移除对应包即可。

---

## 8. 前端事件接入（前后端契约）

**事件名（events.rs）：** `agent-event` / `agent-awaiting-approval` / `agent-task-done` / `agent-task-error`

**`agent-event` 的 `type` 枚举（types.ts）：** `tool_started` `tool_finished` `text_chunk` `text_done` `status` `error` `plan_generated` `step_started` `step_finished`

**前端监听（useAgentSession.ts:328）：**
```ts
const offEvent = await listen<AgentEvent>('agent-event', (ev) => {
  const e = ev.payload
  switch (e.type) {
    case 'plan_generated': if (e.plan?.tasks) setPlanSteps(e.plan.tasks); break
    case 'step_started':  setPlanSteps(p => p.map(t => t.step===e.plan!.step ? {...t,status:'running'}:t)); break
    case 'step_finished': setPlanSteps(p => p.map(t => t.step===e.plan!.step ? {...t,status:e.plan!.status??'success',summary:e.plan!.summary}:t)); break
    case 'text_chunk':    if (e.chunk?.text) setStreamingText(p => p + e.chunk!.text); ... break
    case 'tool_started':  upsertStep({...e.step, toolLabel: labelOf(e.step.toolName)}); break
    case 'tool_finished': upsertStep(...); break
    // status / error 归入思考面板或状态提示
  }
})
```

**前端入参（RunAgentTaskInput，types.ts:128）：** `agentId` `prompt` `workspace?` `sessionId?` `roundId?` `attachments?` `disabledSkillIds?` `disabledMcpIds?` `disabledMcpToolIds?` `enabledSkillIds?` `enabledMcpIds?`

> `@` 提及 = 本轮"临时硬包含"：前端把 `mentionTags` 解析为 `enabledSkillIds`/`enabledMcpIds` 传入；Rust `load_config` 据此把**智能体未绑定**的技能/MCP 临时并入工具集（与 `disabled*` 对称的反向开关），受 `MAX_SKILLS=3`/`MAX_MCP_SERVERS=3` 兜底。`enabled` 优先于 `disabled`（本轮显式 @ 启用即覆盖临时移除）。

> 注意：Tauri 命令 `run_agent_task` 的入参是名为 `input` 的结构体，`submit_approval_decision` 是 `decision`——前端 invoke 必须包这层键（useAgentSession.ts:252/285）。

---

## 9. 前端 UI（chat.tsx / chat.scss）今天优化点

| 功能 | 实现 | 测试 |
|---|---|---|
| 步骤汇报折叠 | `PlanStepsBar`：标题常显，summary 默认折叠，点"查看汇报/查看异常"展开 | 跑多步任务，看步骤 2 的汇报是否默认收起 |
| 对话文件路径卡片 | `FilePathCards` 正则识别 Windows/Unix/相对路径，按扩展名图标，点击 `openPath` | 任务输出含 `C:\...\btc_forecast.md` → 出现卡片，点击可打开（需 `opener:allow-open-path` scope） |
| 输入框居中 | `.agent-chat__input` fixed 铺满窗口底部；`.input-box` 全屏 50% 居中，窄屏 `left:270px` 避让侧栏 | 全屏/缩窗分别验证 |
| 输入框拖拽 | 顶部 `.agent-chat__input-resizer` 手柄，`resize:none` + `inputHeight` state（48~320px，发送复位） | 向上拖拽增大高度，发送后复位 |
| 去除顶部分割线 | 移除 `.agent-chat__input` 的 `border-top` | — |
| 左侧栏风格 | 220px 圆角卡片，hover 平移 + active 左侧指示条，对齐知识库/首页 | — |

---

## 10. 今日修复 ↔ 测试对照表

| # | 问题 | 根因 | 修复文件 | 验证方法 |
|---|---|---|---|---|
| 1 | 任务降级"完成用户任务"失败 | 规划器只读 `content`，推理模型把 JSON 放 `reasoning_content` | `planner.rs` `extract_content` 回落 reasoning | 用 MiniMax-M3 跑多步任务，日志应正常拆 3 步 |
| 2 | 沙箱空库白耗轮次 | `default` 纯净环境但提示谎称"内置库" | `planner.rs` 能力描述 + `mamba_manager.rs` 自愈 | 首次跑 pandas 脚本自动安装 |
| 3 | 步骤 2 生成成功却判"未闭环" | 汇报轮计入 5 轮预算 | `pipeline.rs` 汇报轮不计入 + `MAX=8` | 多步任务步骤 2/3 依次成功 |
| 4 | 同类任务拆分不同 | 规划未固定 temperature | `planner.rs` 强制 `temperature=0` | 同一 prompt 两次结果一致 |
| 5 | 打开文件失败 | `opener:allow-open-path` 未配 scope | `default.json` 加 `{"path":"**"}` | 点击对话文件卡片可打开 |
| 6 | 输入框只能向下拉 | 原生 `resize:vertical` | `chat.tsx/scss` 顶部拖拽手柄 | 向上拖拽增大 |

---

## 11. 分环节测试建议（按链路顺序）

1. **配置校验**：先确认智能体已绑 LLM（base_url/model_name 非空），否则 `call_llm` 直接报错 `未绑定有效的 LLM`。
2. **意图分流**：用极短闲聊 + 明显复合句，看日志 `intent: 规则短路 → …` 是否符合预期。
3. **规划**：用 MiniMax-M3 跑"采集→Excel→预测"类任务，确认 `planner: 规划完成 … 步骤数=3`，且两次同 prompt 拆分一致。
4. **流水线闭环**：观察 `pipeline: 子任务 step=X 闭环（总轮 N，工具轮 M）`，确认 M≤8 且步骤 2/3 连续成功。
5. **工具执行**：让任务写文件/跑 Python；首次需 pandas 时等待自动安装（日志 `自动安装依赖…重试执行`）。
6. **审批**：关掉 `auto_tool_exec_mode` → 写文件/执行命令应弹审批窗（`agent-awaiting-approval`），拒绝后模型收到"已拒绝"。
7. **前端**：看步骤进度条实时更新、汇报默认折叠、对话文件卡片可点开、输入框全屏居中且可上拉。
8. **token 展示**：任务结束看 `agent-task-done` 携带的 `promptTokens/completionTokens`，应替代前端估算（含 system/工具定义/中间往返）。

---

> 附：本文所有 `file:line` 均对应 2026-09-04 当前 `src-tauri/src/agent/*` 实现，重编后端（`npm run tauri`）后生效。前端 UI 改动需 `npm run tauri` 一并重编（capability 变更）。
