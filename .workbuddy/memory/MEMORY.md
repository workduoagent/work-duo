# work-duo 长期约定（单一事实源 · 校准 2026-09-08）

> 与每日日志冲突以本文件为准；逐日实现细节留 `2026-*.md`，前端规范见仓库根《前端开发规范.md》。只存「决策约定 + 坑 + 模块边界」。

## 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；样式=Sass（只用 `var(--color-*)`）；图标=lucide-react；Monaco 本地 AMD；路由=HashRouter。**只跑 `npm run typecheck`**，禁 `vite build`/`npm run build`；调试 `npm run tauri`；勿改 `vite.config.ts`。文档阅读栈（本地优先）：Monaco/pdfjs+`@react-pdf-viewer`/docx-preview/react-reader/video.js+wavesurfer/xlsx+ag-grid/react-markdown+katex+mermaid。Squad 编排 UI 用 `@xyflow/react`（用户 `pnpm i`）。

## 依赖 / 沙箱 EPERM
- AI 只写 `package.json`，绝不自己装；重型库用动态 `import()`+`src/types/shims.d.ts` 兜底。
- 注入钩子 fail-closed→EPERM。**装/删包**前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；`src/` 删除/改名通常 EPERM→新建合规位置+改 import+typecheck，旧文件用户手动删。

## 数据持久化 / DDL
SQLite `workduo.db`；TS 访问层 `src/core/mapper/*.ts`（禁组件直写 SQL）。**DDL 单一事实源**：`src/assets/sql/init.sql`(CREATE IF NOT EXISTS) + `updater.sql`(ALTER 迁移, **现至 v21**)。引用可能尚不存在列的索引/约束必须进 updater.sql，否则 CREATE 被跳过→列缺失。`isTauri` 布尔常量。Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>`→`sqlx`(0.8 sqlite)；key=`sqlite:workduo.db`，前端须先 `load()`。表族：app_config/models(+iflytek)/skill_info/mcp_info/scenario_category/agent_info/agent_project/agent_conversation_session(+round)/artifacts/knowledge_base/agent_memories(+events)/agent_squad(+member+chat_config+session+round+memory)。wd_mem 双轨：`.wd_mem/`(scripts/data/outputs/sessions/{id}.summary.md/MEMORY.md/artifacts/)；`native__archive_artifact` 归档(RequireApproval)；`load_config` Slot0 注入 MEMORY.md。

## 架构定调（已移除）
知识库向量化已移除；客户端不跑本地重推理。LLM 分类 `models.category` 固定枚举。iflytek 三件套+签名 WS。工作空间绑定 DB 全在 TS mapper，路径规范化用 Rust `canonicalize_path`。

## 全局消息 / 导航 IA
- 统一 `useNotify()`（`App.useApp()` message），禁静态 `import {message}`；`<App message={{top:72}}>` 避让顶栏。`result({ok,error?})` 成功静默失败弹 error。
- 路由：`/`(Dashboard 占位) `/model-settings` `/knowledge`(+`/:id`) `/agent-studio`(+`/new` `/:id/edit` `/:id/chat`) `/squads-workspace` `/skill-hub`(+`/:id`) `/mcp-hub`(+`/:id`) `/sandbox/python` `/sandbox/node` `/settings`(左侧 Tab 含**记忆宫殿**)。记忆宫殿已收进「设置」Tab（2026-09-06）。

## 智能体引擎（src-tauri/src/agent/）
命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（入参结构体，invoke 须包 `input`/`decision`）。**三层流水线**：意图分流(`intent.rs` 规则短路+LLM 轻量，失败降级 COMPOSITE) → SIMPLE_CHAT(单次流式0工具) / COMPOSITE → DAG 规划(`planner.rs`，JSON 失败降级单任务、`temperature=0`、≤5 步) → 执行(`pipeline.rs`，`MAX_SUBTASK_ITERATIONS=8`、连续2错拦截、重试3次中止)。`runtime::run_tool_calls_round` 公共工具轮。取消信号 `cancel_flag:Arc<AtomicBool>` 贯穿。
**LLM 铁律**：每轮仅1次流式 `call_llm_stream`，SSE 聚合 delta→`StreamOutcome`(含 usage)；无 tool_calls→终态；有→思考面板；**空响应回退一次非流式 `call_llm`**。禁「非流式判断+流式输出」双调用。
**四优化（实测省 31.7%，零输出浪费归零）**：①verifier `text_contains` `value.split('|')` 多关键词容错 ②ReAct 上下文压缩 `compress_in_flight_tool_results(keep_recent_full=2)` ③取消信号优先(send 前查 cancel) ④零输出快速重试(`call_llm_stream_once`+外层 retry，双空/网络错重试1次，取消透传不重试)。`recovery.rs`+`verifier.rs`+前端 `RecoveryPanel.tsx`。`raw_messages_json` 入库前 `sanitize_message_sequence`；约束上限 `MAX_MCP_SERVERS=3/MAX_MCP_TOOLS=10/MAX_SKILLS=3`。

## 执行链路红线（架构不变量）
- **能力层优先**：约束落 `register_native_tools` 注册集合，仅写 system_prompt 必被绕过。`allow_sandbox` 唯一真值源。
- **消息序列配对**：每 assistant `tool_call.id` 须有对应结果；发送前+落库前各调 `sanitize_message_sequence`，违反→网关 400 `tool result's tool id not found`，脏数据「一次崩次次崩」。
- **熔断靠"无进展"**：`MAX_SUBTASK_ITERATIONS=8` 仅计工具轮，终态汇报轮不计。
- **计划—执行文件名绑定**：`pipeline.rs::criteria_hint` 把 `success_criteria` 注入子任务 prompt（文件名须一致）。
- **步骤成功必 emit `step_finished(true)`**：`finalizeStuckSteps()` 兜底误标失败。
- **沙箱摩擦=反向诱导绕道**：`native__run_python_sandbox` code 直传+`mamba_manager::run_script_with_selfheal`(ModuleNotFoundError→白名单 micromamba install)。Node/Bun 同构：`native__run_node_sandbox` 落盘 `.wd_mem/scripts/*.mjs`，`bun_manager::run_script_with_selfheal`(Cannot find package→白名单 bun add)；Bun 镜像 `BUN_CONFIG_REGISTRY=npmmirror`/`BUN_INSTALL=bun_root/.bun`。
- **Node 单一环境**：`bun_root/(package.json+node_modules)`，列表恒 default；reset=清空 node_modules。沙箱开→`execute_command` 不注册。详见 `docs/sandbox-architecture.md`。

## 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`（禁 max-width+margin:0 auto）；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks `useMemo`/`useState` 须 early-return 前无条件执行；派生 state 须在 useMemo 前。Popover/Dropdown 逃逸 `position:fixed`+`getBoundingClientRect`。Tauri capabilities scope `https://*`。chat 右栏 `agent-chat__right` 弹性列+Tabs(执行轨迹/画布/产物，可拖拽 300–680)；`useAgentSession` 持 trace/canvas/memories；气泡内 `ThoughtPanel`+`PlanToolTimeline` 为持久化真相源(落库 m.thought/m.toolSteps/m.planSteps)，右栏 Tab 为实时内存(刷新清空)。

## Rust 工具链（实测校正 ✅）
cargo 二进制 `/d/envs/Rust/.cargo/bin/cargo`（**已核验存在**）；CARGO_HOME `/d/envs/Rust/.cargo`；rustup `/d/Rust/rustup`。**Cargo.toml 在 `src-tauri/`，`cargo check` 须在该目录执行**。编译：`cd src-tauri && RUSTUP_HOME=/d/Rust/rustup CARGO_HOME=/d/envs/Rust/.cargo RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/envs/Rust/.cargo/bin/cargo check`。增量数秒~十几秒；真机重编前停掉运行中的 `npm run tauri` 窗口防 `target/` 文件锁 LNK1104。**⚠️ 2026-09-07 日志误记路径为 `/d/Rust/cargo/bin/cargo`（该路径不存在），以本行为准。**

## Phase 3 三视图（✅ 已落地 2026-09-06）
- **轨迹视图(TracePanel)**：`emit_intent_classified`+`emit_thinking_chunk`(layer:plan/exec/selfcheck 三色)；`finalizeStuckSteps()` 在 done/error/20min 三处收敛残留 running。`run()` 须清 `traceIntent/traceThinking`。
- **产物画布(ArtifactCanvas)**：`read_artifact`(PathGuard+按扩展名)+`branch_from_step`；拖拽/缩放/右键分支/对比横幅。取代 `CanvasPanel.tsx`(孤立不删)。`handleApplyBranch` 已打通 plan_override→run_pipeline 续跑。
- **记忆宫殿(MemoryPalace)**：`memory.rs`(list/heatmap/anchor/update/delete/recall/top-K 自动召回+引用计数)+2 表+事件。`memory_mode` 三档(off/active/forced，默认 off)；`native__anchor_memory`(ReadSafe) 自动沉淀；`agent-memory-anchored` 事件实时刷新。

## 附件持久化三态（2026-09-05）
路由(image≤20MB 内联 dataUrl / text≤200KB 内联 / 其余 `stageFile` 分片落盘，>500MB 拒绝)；落盘走 `workspace/.attachments/`(Rust `persist_bytes`)；内联随 `raw_messages_json` 入 SQLite；跨会话恢复仅 image(file 型历史卡片未恢复)。

## Squad 协作层（✅ 已落地，含 Node 沙箱同期）
三种模式 orchestrator/pipeline/chat；成员记忆=个人+团队黑板(`agent_squad_memory`)；与 `agent_project` 解耦。工作空间默认 `.wd_mem/squads/{squad_id}/{agent_id}/`，**可配 `agent_squad.workspace_dir`(v20)**：选中绝对路径为团队根，成员 `{workspace_dir}/{agent_id}`，留空回退。全局能力 `global_mcp_ids` 强制并入；**`global_mcp_tools`(v21) 工具级开关**(`{mcpId:[禁用toolId]}`)→`load_squad` 合并 `disabled_mcp_tool_ids`。logo 存 base64。群聊「汇总主笔」/编排「主管」独立 Select；流水线独有 ReactFlow DAG(`dependsOn`)；定时/API 调度器(chrono cron + 极简 TCP HTTP server)已真接线 `setup()`。遗留：cron/api 真调度未做(仅字段+接口)。

## 新增坑（2026-09-07/08 实测）
- **Squad 编辑器成员 Select(antd)**：受控 `value` 在 `options` 找不到对应项时把 value 当纯文本渲染并出现光标（用户看到「光标/残留 Label」）。彻底解法=**`labelInValue`**：`options` 统一 `allAgentOptions.filter(o=>!usedAgentIds.has(o.value))`（已选彻底剔除），`value={agentValue(id)}={value:id,label:name}`，加 `allowClear`；用统一 `usedAgentIds`（成员+leader+summarizer）收敛全部下拉，杜绝跨角色重复选。禁 `showSearch`（搜索框输入态是光标主因）。
- **LLM 连通性测试 `modelTest.ts`（已二次修正 09-08）**：根因不是 stream 字段，而是探针**手写 `max_tokens:1`** 与智能体实际请求脱节（`call_llm_stream_once` 从 DB `config` 列注入模型分类参数 `maxTokens/temperature/...`，camelCase，且带 `Accept:text/event-stream`）。探针 400、挂载后正常=假阴性。修正：`testModelConnection` 入参改为 `ModelConfig`，`chatBody(model, config)` 从 `model[model.category]` 取参数并注入（跳过 model/messages/stream/stream_options，reasoning 归一化同 runtime.rs）；`buildHeaders` 补 `Accept`。**铁律：探测请求体必须与 `runtime.rs::call_llm_stream_once` 完全对齐，禁止手拍固定值。**
- **ArtifactCanvas 拖拽崩溃**：`setState` updater 内读 `dragRef.current` 竞态→改 mousedown 快照 `viewBox.w/h` 进 `dragRef`，move 用快照普通对象传 `setViewBox`，依赖 `[]`。
- **mapper 时间字段裸转崩溃（09-08）**：`agent-mapper` 等 7 个 mapper 对 `r.created_at`/`r.updated_at` 直接 `new Date(x).toISOString()`，存量库时间字段若以字符串/空串落库 → `RangeError: Invalid time value` 整页列表崩溃（`listAgents` 读即炸）。**铁律：DB 时间值一律经 `safeIso()` 转换**（`src/core/mapper/safeTime.ts` 已抽出，兼容 number/纯数字字符串/ISO 串，非法值兜底当前时间）；禁止裸 `new Date(r.x).toISOString()`。批量替换已覆盖 agent/model/knowledge/mcp/squad/skill/agent-session 七处。
