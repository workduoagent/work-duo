# work-duo 长期约定（单一事实源 · 校准 2026-09-10）

> 与每日日志冲突以本文件为准；逐日实现细节留 `2026-*.md`（重大改动见仓库根 `agent-fix-20260910-*.md`），前端规范见《前端开发规范.md》。本文件只存「决策约定 + 架构边界 + 坑 + 红线」。

## 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；样式=Sass（只用 `var(--color-*)`）；图标=lucide-react；Monaco 本地 AMD；路由=HashRouter。**只跑 `npm run typecheck`**，禁 `vite build`；调试 `npm run tauri`；勿改 `vite.config.ts`。Squad 编排 UI 用 `@xyflow/react`（用户 `pnpm i`）。

## 依赖 / 沙箱 EPERM
- AI 只写 `package.json`，绝不自己装；重型库用动态 `import()`+`src/types/shims.d.ts` 兜底。
- 注入钩子 fail-closed→EPERM。**装/删包**前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；`src/` 删除/改名通常 EPERM→新建合规位置+改 import+typecheck，旧文件用户手动删。

## 数据持久化 / DDL
SQLite `workduo.db`；TS 访问层 `src/core/mapper/*.ts`（禁组件直写 SQL）。**DDL 单一事实源**：`src/assets/sql/init.sql`(CREATE IF NOT EXISTS) + `updater.sql`(ALTER 迁移, 现至 v21)。引用可能尚不存在列的索引/约束必须进 updater.sql。`isTauri` 布尔常量。Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>`→`sqlx`(0.8)；key=`sqlite:workduo.db`，前端须先 `load()`。表族：app_config/models(+iflytek)/skill_info/mcp_info/scenario_category/agent_info/agent_project/agent_conversation_session(+round)/artifacts/knowledge_base/agent_memories(+events)/agent_squad(+member+chat_config+session+round+memory)。

## 架构分层铁律（领域无关基座 + 外部因素定专业）★用户明确
- **L0 底层基座（领域无关）**：`src-tauri/src/agent/**` = ReAct 引擎，只负责「意图分流→规划→执行→校验」通用循环。**严禁内置任何偏向某一领域的能力**。
- **L1 通用接口（跨工种）**：沙箱（python/node）、Global Tool、文件/网络——任何「用电脑的工种」共用原子能力。
- **L2 领域区分（外部因素 ONLY）**：专业 Agent 区分/约束产出的**唯一通道 = Skill + MCP + Agent 人设**。基座与通用接口对领域一视同仁。
- **由此推导**：①评估 Agent bug/优化先判层（L0 基座极克制、不染领域；L2 动 Skill/MCP/人设才是正道）。②Skill 加载机制是「专业性能否落地」关键闸门（`skill_adapter.rs` 回声壳曾切断 L0→L2 通道，已修）。③验收须看「最终产出是否符合领域 Skill 门禁（build 通过、依赖版本固定、点名库存在）」而非「文件存在」。

## 全局消息 / 导航 IA
- 统一 `useNotify()`（`App.useApp()` message），禁静态 `import {message}`；`<App message={{top:72}}>` 避让顶栏。`result({ok,error?})` 成功静默失败弹 error。
- 路由：`/`(Dashboard) `/model-settings` `/knowledge`(+`/:id`) `/agent-studio`(+`/new` `/:id/edit` `/:id/chat`) `/squads-workspace` `/skill-hub`(+`/:id`) `/mcp-hub`(+`/:id`) `/sandbox/python` `/sandbox/node` `/settings`(左侧 Tab 含**记忆宫殿**)。

## 智能体引擎（src-tauri/src/agent/）
- 命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（invoke 须包 `input`/`decision`）。**三层流水线**：意图分流(`intent.rs` 规则短路+LLM 轻量，失败降级 COMPOSITE) → SIMPLE_CHAT(单次流式0工具) / COMPOSITE → DAG 规划(`planner.rs`，JSON 失败降级单任务、`temperature=0`) → 执行(`pipeline.rs`，`MAX_SUBTASK_RECOVERY_ATTEMPTS=3`、连续2错拦截、重试3次中止)。取消信号 `cancel_flag:Arc<AtomicBool>` 贯穿。
- **LLM 铁律**：每轮仅1次流式 `call_llm_stream`，SSE 聚合 delta→`StreamOutcome`(含 usage)；无 tool_calls→终态；有→思考面板；**空响应回退一次非流式 `call_llm`**。禁「非流式判断+流式输出」双调用。
- **四优化（省 31.7%）**：①verifier `text_contains` `value.split('|')` 多关键词 ②ReAct 上下文压缩 `compress_in_flight_tool_results(keep_recent_full=2)` ③取消信号优先 ④零输出快速重试。
- **并发互斥（P0-2 已修）**：`AgentRuntime::running: Arc<AtomicBool>` + `try_acquire_run_lock()->Option<RunningGuard>` 唯一闸门在 `run_agent_task`（spawn 前）；抢占失败同步 `Err("已有任务正在运行…")`；`RunningGuard` Drop 复位。前端 `useAgentSession.run` catch 命中该文案弹 `modal.warning`，**拦截时不清 isRunning**。

## 执行链路红线（架构不变量）
- **能力层优先**：约束落 `register_native_tools` 注册集合；仅写 system_prompt 必被绕过。`allow_sandbox` 唯一真值源。
- **消息序列配对**：每 assistant `tool_call.id` 须有对应结果；发送前+落库前各调 `sanitize_message_sequence`，违反→网关 400 `tool result's tool id not found`。
- **步骤成功必 emit `step_finished(true)`**：`finalizeStuckSteps()` 兜底误标失败。
- **Node 单一环境**：`bun_root/(package.json+node_modules)`，列表恒 default；reset=清空 node_modules。沙箱开→`execute_command` 不注册。
- **沙箱摩擦=反向诱导绕道**：`native__run_python_sandbox` code 直传+`mamba_manager::run_script_with_selfheal`；Node/Bun 同构 `bun_manager::run_script_with_selfheal`（Cannot find package→白名单 bun add）；Bun 镜像 `BUN_CONFIG_REGISTRY=npmmirror`/`BUN_INSTALL=bun_root/.bun`。

## ★ 单 Agent 统一实体图（graph.rs · 2026-09-10 落地，核心改造）
- **设计原则**：图是 Agent 运行时数据模型，不是事后索引。Planner 写图、流水线在图上调度、工具执行写图、恢复改图；图即持久化，消灭「内存状态+另存一份」双轨。
- **存储**：`.wd_mem/graph/`（`nodes.jsonl`/`edges.jsonl` 追加写、同 id 后行覆盖前行；`_index.json` 轻量索引；`sessions/{id}.json` 子图快照）。`wd_mem.rs` 已加 `graph/ graph/sessions/ knowledge/ runtime/` 目录 + 旧 `scripts/data/outputs`→`runtime/`、`MEMORY.md/artifacts`→`knowledge/` 幂等迁移。
- **数据模型**：`GraphNode{Session/Task/Artifact/FileRef/Memory/Prompt}` + `GraphEdge{TriggeredBy/Contains/DependsOn/Produced/Read/Wrote/Learned/BelongsTo}`；`KnowledgeGraph`(open/plan_to_graph/query/topo_ready/session_tasks/snapshot/JSONL 追加写/_index.json)。
- **pipeline 图驱动**：原 4 个 HashMap（`started`/`completed`/`guidance_map`/`retry_counts`）收编进 TaskNode 字段（`status`/`guidance`/`retryCount`/`summary`）；主循环用 `topo_ready(session_id)` 取就绪节点；产物写图在 `join_all` 后主循环；保留 max_parallel/无人值守/事件/自愈。`run_pipeline` 新签名 `(graph, session_id)`（删 plan/pre_completed/initial_context，统一由图承载）。`run_simple_chat` 不走图。
- **§5.9 已补做**：`context.rs::load_session_background` 在 DB/文件读后开 `KnowledgeGraph::open` 聚合本会话 `status ∈ {completed, obsolete}` 且 summary 非空的 TaskNode，以「【本会话已完成任务】」段并入背景（跨轮感知）。
- **待真机回归**：复合任务节点/边内容、恢复决策反映到图、快照内容（cargo check 已 EXIT=0）。

## ★ 单 Agent 强制串行执行（2026-09-10 整改）
- `pipeline.rs::run_pipeline` 内 `let max_parallel: usize = 1;`（无条件串行，`MAX_PARALLEL_SUBTASKS` 标 `#[allow(dead_code)]` 废弃）。消除：文件写入冲突、上下文黑域、恢复面板弹窗风暴、工具调用步骤归属错乱。
- `types.rs::ToolStep` 加 `step: Option<usize>`；`runtime.rs::run_tool_calls_round` 加 `current_step: usize` 透传到 `emit_tool_started/finished` 三处；`pipeline.rs` 调用点传 `task.step`。前端按 step 精确归属工具卡片（Option 反序列化无碍，未改前端）。

## ★ Skill 注入方式（2026-09-10 改）
- **Skill 不再注册为工具**：删 `runtime.rs`/`squad_orchestrator.rs` 两处 `register_skills_into` 调用；`skill_adapter.rs` 的 `impl AgentTool`+`register_skills_into` 标 `#[allow(dead_code)]`（`SkillToolWrapper` 仍用于 `cfg.skill_tools` 传递）。
- `pipeline.rs::build_skill_guidance` 在 `run_subtask` user 消息注入技能指引：空→不注入；多技能→仅 name+description 摘要；单技能→附 `skill_markdown` 全文截断 2000 字符。省 1~2 轮 LLM，模型不再误调 `skill__xxx`。

## ★ native 工具链闭环（2026-09-09/10 落地）
- **统一闭环范式**：`native.rs` 共享 `probe_path(abs)->PathProbe{exists,is_dir,access_err}`（metadata 区分 NotFound/权限/类型，裸 os error 翻译结构化）；新增 `native__path_exists`(ReadSafe, 始终注册)；`probe_path` 前置校验 **bake 进** read_file/write_file/edit_file/list_directory/archive_artifact 执行入口（运行时强保证，不依赖 LLM 自觉）。各工具 description 提示「先调 path_exists」。`PathExistsTool` description 末尾注「write/edit/read/list 内部已自动探测，无需前置调用」。
- **首梯队工具**（沙箱开/关均注册）：`native__delete_path`/`move_path`/`grep_files`/`zip_create`/`zip_extract`/`regex_replace`/`http_request`。安全边界：删/解压保护 workspace 根与 `.wd_mem/.attachments`；zip 拒越界条目+跳符号链接+10000 条目/500MB 上限；regex_replace 结果>2MB 拒写回。
- **HTTP 请求硬防护**：`HttpRequestTool` 仅 http/https、方法白名单(GET/POST/PUT/DELETE/PATCH)、30s 超时、重定向≤5；`SsrfSafeResolver`(自定义 DNS 解析，每次跳点过 `is_blocked_ip` 位运算禁环回/私有/链路本地/组播/保留/云元数据)；host 白名单 `app_config.http_allowed_hosts`（空=不限制，非空=仅放行命中主机含子域）——前端 `SecurityPanel.tsx`「HTTP 请求主机白名单」列表式增删，`settings-file.ts` 加 `httpAllowedHosts`。**铁律：凡多 Edit 同 .ts 文件务必逐条发并 Read 确认**（批量写曾虚报成功未落盘）。
- **PathGuard 归一**：`tools.rs::logical_normalize`（`..` 弹栈、越界逃逸 InvalidArgs）；edit_file TOCTOU（verify_opened→set_len(0)→write_all）；execute_command 无 ws 直接 `PermissionDenied`；read_file `MAX_READ_FILE_BYTES=2MB` 超阈值引导用沙箱。

## ★ 审批流加固（P0-1 已修）
- `approval.rs::cancel_all()` 清空 pending Map→drop 全部 Sender；`runtime.rs` 把 `rx.await` 包 `tokio::time::timeout(300s)`，三态 `Ok(Ok)=决策`/`Ok(Err)=停止`/`Err=超时自动拒绝`；`commands.rs::cancel_agent_task` 补 `runtime.approval.cancel_all()`。唤醒路径收敛两条（前端 submit / cancel_all），不用 `select!+cancel_flag`。

## 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks `useMemo`/`useState` 须 early-return 前无条件执行；派生 state 须在 useMemo 前。Popover/Dropdown 逃逸 `position:fixed`+`getBoundingClientRect`。Tauri capabilities scope `https://*`。chat 右栏 `agent-chat__right` 弹性列+Tabs(执行轨迹/画布/产物，可拖拽 300–680)；`useAgentSession` 持 trace/canvas/memories；气泡内 `ThoughtPanel`+`PlanToolTimeline` 为持久化真相源(落库 m.thought/m.toolSteps/m.planSteps)，右栏 Tab 为实时内存(刷新清空)。**已知前端 bug 已修**：①记忆模式开关保存后回默认——`draft.ts::draftToInput` 漏 `memoryMode` + `agent-mapper.ts` INSERT 漏 `memory_mode` 列（已补 + ON CONFLICT）。②输入框拖高遮挡右栏——根容器下发 `--input-h`，避让高度改 `calc(var(--input-h)+110px)`。

## Rust 工具链（实测校正 ✅）
cargo `/d/Rust/cargo/bin/cargo`；CARGO_HOME `/d/Rust/cargo`；rustup `/d/Rust/cargo/bin/rustup`，RUSTUP_HOME `/d/Rust/rustup`；工具链 `stable-x86_64-pc-windows-msvc`。**Cargo.toml 在 `src-tauri/`，`cargo check` 须在该目录执行**：`cd src-tauri && CARGO_HOME=/d/Rust/cargo RUSTUP_HOME=/d/Rust/rustup RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/Rust/cargo/bin/cargo check`。真机重编前停 `npm run tauri` 防 `target/` 文件锁 LNK1104。

## Phase 3 三视图（✅ 已落地）
- **轨迹视图(TracePanel)**：`emit_intent_classified`+`emit_thinking_chunk`(layer:plan/exec/selfcheck 三色)；`finalizeStuckSteps()` 在 done/error/20min 三处收敛残留 running。
- **产物画布(ArtifactCanvas)**：`read_artifact`(PathGuard+按扩展名)+`branch_from_step`；拖拽/缩放/右键分支/对比横幅。`handleApplyBranch` 打通 plan_override→run_pipeline 续跑。
- **记忆宫殿(MemoryPalace)**：`memory.rs`(list/heatmap/anchor/update/delete/recall/top-K 自动召回+引用计数)+2 表+事件。`memory_mode` 三档(off/active/forced)；`native__anchor_memory`(ReadSafe) 自动沉淀；`agent-memory-anchored` 事件实时刷新。

## 附件持久化三态
路由(image≤20MB 内联 / text≤200KB 内联 / 其余 `stageFile` 分片落盘，>500MB 拒绝)；落盘 `workspace/.attachments/`(Rust `persist_bytes`)；内联随 `raw_messages_json` 入 SQLite；跨会话恢复仅 image。

## Squad 协作层（✅ 已落地，含 Node 沙箱）
三种模式 orchestrator/pipeline/chat；成员记忆=个人+团队黑板(`agent_squad_memory`)；与 `agent_project` 解耦。工作空间默认 `.wd_mem/squads/{squad_id}/{agent_id}/`，可配 `agent_squad.workspace_dir`(v20)。全局能力 `global_mcp_ids` 强制并入；`global_mcp_tools`(v21) 工具级开关(`{mcpId:[禁用toolId]}`)。群聊「汇总主笔」/编排「主管」独立 Select；流水线独有 ReactFlow DAG(`dependsOn`)；定时/API 调度器(chrono cron + TCP HTTP server)已真接线 `setup()`。遗留：cron/api 真调度未做(仅字段+接口)。

## 日志框架（09-09 落地）
`tracing`+`tracing-subscriber`(env-filter)+`tracing-appender`(DAILY 滚动)。格式 `[时间][包/模块][函数][文件:行]-[等级]-[内容]`；落盘 `$RESOURCES/logs` 优先（只读降级 app_log_dir/./logs）。全仓 `println!/eprintln!`→`tracing::*` 已清零。**坑（复用必记）**：tracing 0.3 无 `boxed` 特性→改单 `fmt()` 订阅器；`FormatEvent` 用具名 struct；`Writer<'_>`=`&'a mut (dyn io::Write+'a)` 须 `write_line<'a>(Writer<'a>)`。
