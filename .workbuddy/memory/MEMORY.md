# work-duo 长期约定（单一事实源 · 校准 2026-09-11）

> 与每日日志冲突以本文件为准；逐日实现细节留 `2026-*.md`，重大改造见仓库根 `agent-fix-2026091x-*.md`，前端规范见《前端开发规范.md》。本文件只存「决策约定 + 架构边界 + 坑 + 红线」。

## 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；样式=Sass（只用 `var(--color-*)`）；图标=lucide-react；Monaco 本地 AMD；路由=HashRouter。**只跑 `npm run typecheck`**，禁 `vite build`；调试 `npm run tauri`；勿改 `vite.config.ts`。Squad 编排 UI 用 `@xyflow/react`。

## 依赖 / 沙箱 EPERM
- AI 只写 `package.json`，绝不自己装；重型库用动态 `import()`+`src/types/shims.d.ts` 兜底。
- 注入钩子 fail-closed→EPERM。**装/删包**前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；`src/` 删除/改名 EPERM→新建合规位置+改 import+typecheck，旧文件用户手动删。

## 数据持久化 / DDL
SQLite `workduo.db`；TS 访问层 `src/core/mapper/*.ts`（禁组件直写 SQL）。**DDL 单一事实源**：`src/assets/sql/init.sql`(CREATE IF NOT EXISTS)+`updater.sql`(ALTER 迁移, 现至 v21)。`isTauri` 布尔常量。Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>`→`sqlx`(0.8)；key=`sqlite:workduo.db`，前端须先 `load()`。

## 架构分层铁律（L0 基座领域无关 + L2 外部因素定专业）
- L0 `src-tauri/src/agent/**`=ReAct 引擎，只负责「意图分流→规划→执行→校验」通用循环，禁内置领域能力。
- L1 通用接口：沙箱(python/node)、Global Tool、文件/网络。
- L2 领域区分唯一通道=Skill+MCP+Agent 人设。
- 推导：①bug/优化先判层（L0 极克制，L2 动 Skill/MCP/人设）；②Skill 加载是专业落地关键闸门（`skill_adapter.rs` 回声壳曾切断 L0→L2，已修）；③验收看「产出是否符合领域 Skill 门禁」而非「文件存在」。

## 全局消息 / 导航 IA
- 统一 `useNotify()`（`App.useApp()` message），禁静态 `import {message}`；`<App message={{top:72}}>` 避让顶栏。
- 路由：`/`(Dashboard) `/model-settings` `/knowledge`(+`/:id`) `/agent-studio`(+`/new` `/:id/edit` `/:id/chat`) `/squads-workspace` `/skill-hub`(+`/:id`) `/mcp-hub`(+`/:id`) `/sandbox/python` `/sandbox/node` `/settings`(含**记忆宫殿**)。

## 智能体引擎（src-tauri/src/agent/）
- 命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（invoke 须包 `input`/`decision`）。三层流水线：意图分流(`intent.rs` 规则短路+LLM 轻量，失败降级 COMPOSITE) → SIMPLE_CHAT / COMPOSITE → DAG 规划(`planner.rs`，JSON 失败降级单任务、`temperature=0`) → 执行(`pipeline.rs`，`MAX_SUBTASK_RECOVERY_ATTEMPTS=3`、连续2错拦截、重试3次中止)。取消 `cancel_flag:Arc<AtomicBool>` 贯穿。
- LLM 铁律：每轮仅1次流式 `call_llm_stream`，SSE 聚合→`StreamOutcome`(含 usage)；无 tool_calls→终态；空响应回退一次非流式 `call_llm`。禁「非流式判断+流式输出」双调用。
- 并发互斥：`AgentRuntime::running:Arc<AtomicBool>`+`try_acquire_run_lock()` 唯一闸门在 `run_agent_task`（spawn 前）；抢占失败 `Err("已有任务正在运行…")`；前端 catch 命中弹 `modal.warning`，**拦截时不清 isRunning**。

## 执行链路红线（架构不变量）
- 能力层优先：约束落 `register_native_tools`；仅写 system_prompt 必被绕过。`allow_sandbox` 唯一真值源。
- 消息序列配对：每 assistant `tool_call.id` 须有对应结果；发送前+落库前各调 `sanitize_message_sequence`，违反→网关 400 `tool result's tool id not found`。
- 步骤成功必 emit `step_finished(true)`；`finalizeStuckSteps()` 兜底误标失败。
- 沙箱摩擦=反向诱导绕道：`native__run_python_sandbox`/`run_node_sandbox` code 直传+`*_manager::run_script_with_selfheal`（Cannot find package→白名单 bun add）。Bun 镜像 `BUN_CONFIG_REGISTRY=npmmirror`/`BUN_INSTALL=bun_root/.bun`。

## ★ 单 Agent 统一实体图（graph.rs · 2026-09-10 落地）
- 图=运行时数据模型（非索引）：Planner 写图、流水线在图上调度、工具写图、恢复改图；图即持久化。
- 存储 `.wd_mem/graph/`（nodes.jsonl/edges.jsonl 追加写、同 id 后行覆盖；_index.json；sessions/{id}.json 子图快照）。
- 数据模型 `GraphNode{Session/Task/Artifact/FileRef/Memory/Prompt}`+`GraphEdge{TriggeredBy/Contains/DependsOn/Produced/Read/Wrote/Learned/BelongsTo}`；`KnowledgeGraph`(open/plan_to_graph/query/topo_ready/session_tasks/snapshot)。
- pipeline 图驱动：原 4 HashMap 收编进 TaskNode(status/guidance/retryCount/summary)；主循环 `topo_ready(session_id)` 取就绪节点；`run_pipeline` 新签名 `(graph, session_id)`；`run_simple_chat` 不走图。
- §5.9：`context.rs::load_session_background` 聚合本会话 `status∈{completed,obsolete}` 且 summary 非空的 TaskNode，以「【本会话已完成任务】」段并入背景（跨轮感知）。

## ★ 单 Agent 强制串行（2026-09-10 整改）
- `pipeline.rs` `let max_parallel:usize=1;`（无条件串行，`MAX_PARALLEL_SUBTASKS` 标 `#[allow(dead_code)]`）。消除：文件写入冲突、上下文黑域、恢复弹窗风暴、工具步骤归属错乱。
- `types.rs::ToolStep.step:Option<usize>`；`runtime.rs::run_tool_calls_round` 加 `current_step` 透传到 emit_tool_started/finished 三处；前端按 step 精确归属工具卡片。

## ★ Skill 注入方式（2026-09-10 改）
- Skill 不再注册为工具：`runtime.rs`/`squad_orchestrator.rs` 删 `register_skills_into` 调用；`skill_adapter.rs` 的 `impl AgentTool`+`register_skills_into` 标 `#[allow(dead_code)]`（`SkillToolWrapper` 仍传 `cfg.skill_tools`）。
- `pipeline.rs::build_skill_guidance` 在 `run_subtask` user 消息注入：空→不注；多技能→name+description 摘要；单技能→`skill_markdown` 全文截断 2000 字符。

## ★ native 工具链闭环（2026-09-09/10 落地）
- 统一范式：`probe_path(abs)->PathProbe{exists,is_dir,access_err}` 前置校验 **bake 进** read/write/edit/list/archive 执行入口；`native__path_exists`(ReadSafe 始终注册)。`PathExistsTool` description 注「write/edit/read/list 内部已自动探测，无需前置调用」。
- 首梯队工具（沙箱开/关均注册）：`delete_path`/`move_path`/`grep_files`/`zip_create`/`zip_extract`/`regex_replace`/`http_request`。安全边界：删/解压保护 workspace 根与 `.wd_mem/.attachments`；zip 拒越界+跳符号链接+10000 条目/500MB 上限；regex_replace>2MB 拒写回。
- HTTP 硬防护：`HttpRequestTool` 仅 http/https、方法白名单、30s、重定向≤5；`SsrfSafeResolver` 位运算禁环回/私有/链路本地/组播/保留/云元数据；host 白名单 `app_config.http_allowed_hosts`。
- PathGuard 归一：`tools.rs::logical_normalize`（`..` 弹栈、越界 InvalidArgs）；edit_file TOCTOU（verify_opened→set_len(0)→write_all）；read_file `MAX_READ_FILE_BYTES=2MB` 超阈值引导沙箱。
- **edit_file 错误增强（2026-09-11）**：`old_str` 不匹配(count==0 / count>1) 错误信息追加文件前 800 字符+修正指引，破除「未找到→再猜」死循环。
- **沙箱 WORKSPACE 注入（2026-09-11）**：Python 落盘前注入 `WORKSPACE = r"<ws>"`，Node 注入 `const WORKSPACE = "<json 转义>"`；两工具 description 追加 WORKSPACE 用法（拼相对路径）。

## ★ 审批流加固（P0-1 已修）
- `approval.rs::cancel_all()` 清空 pending→drop Sender；`runtime.rs` `rx.await` 包 `timeout(300s)`，三态 `Ok(Ok)=决策`/`Ok(Err)=停止`/`Err=超时自动拒绝`；`commands.rs::cancel_agent_task` 补 `runtime.approval.cancel_all()`。唤醒路径收敛 submit / cancel_all。

## 日志框架（09-09 落地）
- `tracing`+`tracing-subscriber`(env-filter)+`tracing-appender`(DAILY)。落盘 `$RESOURCES/logs` 优先。全仓 `println!/eprintln!`→`tracing::*` 已清零。
- **日志增强（2026-09-11）**：工具完成日志 `tool_round[call_id]: name ok=耗时 step=结果`；LLM 轮次加 `usage=(in,out)`；参数预览 `clip(...,300)`→`800`；`recovery.rs::resolve` 加挂起 step/title；`run_subtask` 闭环日志加 `耗时={ms}ms`（`use std::time::{Duration,Instant}`）。

## 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks 须 early-return 前无条件执行。chat 右栏 `agent-chat__right` 弹性列+Tabs(执行轨迹/画布/产物，可拖拽 300–680)；`useAgentSession` 持 trace/canvas/memories；气泡 `ThoughtPanel`+`PlanToolTimeline` 为持久化真相源，右栏 Tab 为实时内存(刷新清空)。
- 已修 bug：①记忆模式开关保存回默认——`draft.ts::draftToInput` 补 `memoryMode`+`agent-mapper.ts` INSERT 补 `memory_mode` 列+ON CONFLICT。②输入框拖高遮挡右栏——根容器下发 `--input-h`，避让高度 `calc(var(--input-h)+110px)`。

## ★ 图驱动约束铁律（2026-09-11 整改 · 用户点醒）
- 任何「模型行为约束」**必须读图的真实数据**，禁止用 prompt 软约束（往 system/user 塞「必须遵守」让模型别串文件名/别复述历史）兜底——小模型易忽略且不可靠，纯属治标。
- 禁止写死魔法规则（硬编码文件名正则/轮次匹配）限制模型；约束数据来自图节点字段。
- 落地实例：
  - 回复聚合（`pipeline.rs::run_pipeline` 最终 `final_text`）：只读本轮 TaskNode 的 `success_criteria.target`（planner 写进图的真实目标文件，零历史污染），**绝不读模型写的 `summary`**；失败/跳过步用图节点 `status`+`summary`；无文件任务（target 空）才降级 summary。
  - 会话背景（§5.9 `context.rs::load_session_background`）：只注入历史 TaskNode 的 `title`（不含文件名），客观标题「历史步骤（仅供参考）」，去掉一切「严禁复述/严禁引用文件名」命令式 prompt。
  - 遗留（待重构）：`register_artifacts` 仍从模型 `summary` 文本 `candidate_paths` 提取产物，受历史文件名污染；产物/执行层应图驱动（执行层 write_file 校验本步 `success_criteria.target`）。
- 验收标准：回复与产物是否准确，由图数据（target/Produced 边/真实工具返回）决定，而非模型自律。

## Rust 工具链（实测 ✅）
cargo `/d/Rust/cargo/bin/cargo`；CARGO_HOME `/d/Rust/cargo`；RUSTUP_HOME `/d/Rust/rustup`；工具链 `stable-x86_64-pc-windows-msvc`。**`cargo check` 须在 `src-tauri/` 执行**：`cd src-tauri && CARGO_HOME=/d/Rust/cargo RUSTUP_HOME=/d/Rust/rustup RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/Rust/cargo/bin/cargo check`。重编前停 `npm run tauri` 防 `target/` 文件锁 LNK1104。

## Phase 3 三视图 / 附件 / Squad（✅ 已落地）
- 轨迹(TracePanel)：`emit_intent_classified`+`emit_thinking_chunk`(layer 三色)；`finalizeStuckSteps()` 三处收敛残留 running。
- 产物画布(ArtifactCanvas)：`read_artifact`+`branch_from_step`；`handleApplyBranch` 打通 plan_override→run_pipeline 续跑。
- 记忆宫殿(MemoryPalace)：`memory.rs`(list/heatmap/anchor/update/delete/recall/top-K)+`native__anchor_memory`(ReadSafe)。
- 附件三态：image≤20MB / text≤200KB 内联，其余 `stageFile` 落 `workspace/.attachments/`，>500MB 拒绝。
- Squad：orchestrator/pipeline/chat 三模式；成员记忆+团队黑板；`global_mcp_ids`/`global_mcp_tools`(v21) 工具级开关；ReactFlow DAG(`dependsOn`)；chrono cron + TCP HTTP server 已真接线。遗留：cron/api 真调度未做。
