# work-duo 长期约定（单一事实源 · 校准 2026-09-14）

> 与每日日志冲突以本文件为准；逐日实现细节留 `2026-*.md`，重大改造见仓库根 `agent-fix-2026091x-*.md`，前端规范见《前端开发规范.md》。**需求/问题/完成/待办统一记仓库根 `需求与问题跟踪.md`**（2026-09-12 起用户要求的单一跟踪源），本文件只存「决策约定 + 架构边界 + 坑 + 红线」。

## 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；样式=Sass（只用 `var(--color-*)`）；图标=lucide-react；Monaco 本地 AMD；路由=HashRouter。**只跑 `npm run typecheck`**（用 `node node_modules/typescript/bin/tsc --noEmit`，因本 bash 环境缺 coreutils、npm 生命周期脚本会报 `/usr/bin/env: bash`），禁 `vite build`；调试 `npm run tauri`；勿改 `vite.config.ts`。Squad/执行图 UI 用 `@xyflow/react` v12。

## 依赖 / 沙箱 EPERM
- AI 只写 `package.json`，绝不自己装；重型库用动态 `import()`+`src/types/shims.d.ts` 兜底。
- 注入钩子 fail-closed→EPERM。**装/删包**前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；`src/` 删除/改名 EPERM→新建合规位置+改 import+typecheck，旧文件用户手动删。

## 🔴 内部数据不外露红线（用户不可见 · 2026-09-14）
- `.wd_mem/**`（运行时实体图/会话子图/记忆/产物登记）与 `.workbuddy/memory/**`（项目级 AI 记忆）均为**内部私有数据**，绝不可出现在用户可见 UI，也绝不可经 `present_files` 当交付物展示（类比 WorkBuddy 不把 `.workbuddy` 亮给用户）。
- 只对自己读写；对用户只呈现其明确需求的工作产出。记忆文件更新是静默后台动作，收尾**不要 `present_files`**；仅用户主动要求看时才读。

## 数据持久化 / DDL
SQLite `workduo.db`；TS 访问层 `src/core/mapper/*.ts`（禁组件直写 SQL）。**DDL 单一事实源**：`src/assets/sql/init.sql`(CREATE IF NOT EXISTS)+`updater.sql`(ALTER 迁移)。`isTauri` 布尔常量。Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>`→`sqlx`(0.8)；key=`sqlite:workduo.db`，前端须先 `load()`。
- **🔴 DDL 变更必查 mapper（重复犯过）**：任何 `ALTER TABLE ADD COLUMN` 后，必须 `grep "INSERT INTO <表>"` 全项目，逐一核对每个 INSERT 的 **三要素对齐**：①列清单 ②`VALUES` 占位符 `?` 数 ③参数数组长度——三者相等且顺序一致。`tsc` 不查 SQL 占位符，须人工核对。通常只有 `agent-mapper.ts` 一处 upsert 同时管新建+编辑。

## 架构分层铁律（L0 基座领域无关 + L2 外部因素定专业）
- L0 `src-tauri/src/agent/**`=ReAct 引擎，只负责「意图分流→规划→执行→校验」通用循环，禁内置领域能力。
- L1 通用接口：沙箱(python/node)、Global Tool、文件/网络。L2 领域区分唯一通道=Skill+MCP+Agent 人设。
- 推导：①bug/优化先判层（L0 极克制，L2 动 Skill/MCP/人设）；②Skill 加载是专业落地关键闸门（`skill_adapter.rs` 回声壳曾切断 L0→L2，已修）；③验收看「产出是否符合领域 Skill 门禁」而非「文件存在」。

## 智能体引擎 / 执行链路红线（架构不变量）
- 命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（invoke 须包 `input`/`decision`）。流水线：意图分流(`intent.rs` 规则短路+LLM 轻量，失败降级 COMPOSITE) → SIMPLE_CHAT/COMPOSITE → DAG 规划(`planner.rs`，JSON 失败降级单任务、`temperature=0`) → 执行(`pipeline.rs`，`MAX_SUBTASK_RECOVERY_ATTEMPTS=3`、连续2错拦截、重试3次中止)。取消 `cancel_flag:Arc<AtomicBool>` 贯穿。
- LLM 铁律：每轮仅1次流式 `call_llm_stream`，SSE 聚合→`StreamOutcome`(含 usage)；无 tool_calls→终态；空响应回退一次非流式 `call_llm`。禁「非流式判断+流式输出」双调用。
- 并发互斥：`AgentRuntime::running:Arc<AtomicBool>`+`try_acquire_run_lock()` 唯一闸门在 `run_agent_task`（spawn 前）；抢占失败 `Err("已有任务正在运行…")`；前端 catch 命中弹 `modal.warning`，**拦截时不清 isRunning**。
- 能力层优先：约束落 `register_native_tools`；仅写 system_prompt 必被绕过。`allow_sandbox` 唯一真值源。
- 消息序列配对：每 assistant `tool_call.id` 须有对应结果；发送前+落库前各调 `sanitize_message_sequence`，违反→网关 400 `tool result's tool id not found`。步骤成功必 emit `step_finished(true)`；`finalizeStuckSteps()` 兜底误标失败。
- 审批流加固（P0-1）：`approval.rs::cancel_all()` 清空 pending→drop Sender；`runtime.rs` `rx.await` 包 `timeout(300s)` 三态；`cancel_agent_task` 补 `runtime.approval.cancel_all()`。

## ★ 单 Agent 统一实体图（graph.rs）
- 图=运行时数据模型=持久化：Planner 写图、流水线在图上调度、工具写图、恢复改图。存储 `.wd_mem/graph/`（nodes/edges.jsonl 追加写、同 id 后行覆盖；_index.json；sessions/{id}.json 子图快照）。
- 模型 `GraphNode{Session/Task/Artifact/FileRef/Memory/Prompt}`+`GraphEdge{TriggeredBy/Contains/DependsOn/Produced/Read/Wrote/Learned/BelongsTo}`；`KnowledgeGraph`(open/plan_to_graph/query/topo_ready/session_tasks/snapshot)。
- pipeline 图驱动：原 4 HashMap 收编进 TaskNode(status/guidance/retryCount/summary)；主循环 `topo_ready`/`run_pipeline`；`run_simple_chat` 不走图。`context.rs::load_session_background` 聚合本会话 completed/obsolete 且 summary 非空的 TaskNode 标题并入背景（跨轮感知）。

## ★ 图驱动约束铁律（2026-09-11 用户点醒）
- 模型行为约束**必须读图的真实数据**，禁 prompt 软约束；禁硬编码魔法规则，约束数据来自图节点字段。
- 落地：回复聚合只读本轮 TaskNode `success_criteria.target`（planner 写的真实目标文件，零历史污染），**绝不读模型 `summary`**；失败/跳过步用节点 `status`+`summary`；无文件任务才降级 summary。会话背景只注入历史 TaskNode `title`（不含文件名），客观标题「历史步骤（仅供参考）」去命令式。
- 遗留：`register_artifacts` 仍从模型 `summary` 文本 `candidate_paths` 提取产物（受污染），应图驱动（执行层 write_file 校验本步 `success_criteria.target`）。验收由图数据(target/Produced 边/真实工具返回)决定，而非模型自律。

## ★ Skill 注入 / 强制串行（2026-09-10）
- Skill 不再注册为工具：`register_skills_into` 已删（`skill_adapter.rs` 相关标 `#[allow(dead_code)]`）。`pipeline.rs::build_skill_guidance` 在 `run_subtask` user 消息注入：空→不注；多技能→name+description 摘要；单技能→`skill_markdown` 全文截断 2000 字符。
- `pipeline.rs` `let max_parallel:usize=1;`（无条件串行）。`runtime.rs::run_tool_calls_round` 透传 `current_step` 到 emit；前端按 step 归属工具卡片。

## ★ native 工具链闭环（2026-09-09/10/11）
- 统一范式：`probe_path(abs)->PathProbe{exists,is_dir,access_err}` 前置校验 **bake 进** read/write/edit/list/archive；`native__path_exists`(ReadSafe 始终注册)。
- 首梯队工具（沙箱开/关均注册）：`delete_path`/`move_path`/`grep_files`/`zip_create`/`zip_extract`/`regex_replace`/`http_request`。安全边界：删/解压保护 workspace 根与 `.wd_mem/.attachments`；zip 拒越界+跳符号链接+10000 条目/500MB 上限；regex_replace>2MB 拒写回。
- HTTP 硬防护：`HttpRequestTool` 仅 http/https、方法白名单、30s、重定向≤5；`SsrfSafeResolver` 位运算禁环回/私有/链路本地/组播/保留/云元数据；host 白名单 `app_config.http_allowed_hosts`。
- PathGuard：`logical_normalize`(`..` 弹栈、越界 InvalidArgs)；edit_file TOCTOU(verify_opened→set_len(0)→write_all)；read_file `MAX_READ_FILE_BYTES=2MB` 超阈值引导沙箱。`edit_file` 错误增强：`old_str` 不匹配追加文件前 800 字符+修正指引。沙箱 WORKSPACE 注入：Python `WORKSPACE=r"<ws>"`、Node `const WORKSPACE="<json>"`。
- 沙箱摩擦=反向诱导绕道：`native__run_python_sandbox`/`run_node_sandbox` code 直传+`*_manager::run_script_with_selfheal`（Cannot find package→白名单 bun add）。Bun 镜像 `BUN_CONFIG_REGISTRY=npmmirror`/`BUN_INSTALL=bun_root/.bun`。
- **🔴 沙箱同目录 import 失效（20260914011 已修）**：两沙箱曾把脚本复制到 `run_tmp/` 后执行，致 Python `sys.path[0]`/Bun 相对导入按临时目录解析→`import calc` 找不到同目录模块。**Python 用注入 `PYTHONPATH=原始目录[;工作空间根]`**（`pythonpath_env()`）；**Bun 改为原地执行 + `NODE_PATH=bun_root/node_modules`**（Bun 官方确认支持 NODE_PATH）。复现：多文件脚本 `import` 兄弟模块报 ModuleNotFoundError/相对导入找不到。
- **🔴 pytest 在沙箱永远跑不通（20260914014 已修）**：根因同上（白名单不含 pytest + selfheal 接不住 CLI 缺失 + skill 引导死用）。已修：彻底删除 mamba/bun 两侧 `AUTO_INSTALL_ALLOW` 常量，`missing_modules()` 不再白名单过滤，任何缺包名都进自愈安装队列（沙箱自由装依赖）；HTTP 主机白名单 `app_config.http_allowed_hosts`（SSRF 红线）保留不动。配合 #20260914013 的 never 自愈升级，pytest 等依赖在重试时自动装好、测试真跑通。
- **🔴 计划审批≠步骤恢复（20260914013 已修）**：`plan_auto_approve_mode=never` 只关 Phase 2b 计划确认窗，步骤级 recovery 窗（`pipeline.rs` `recovery.wait()` 手动永久阻塞）独立；设 never 仍弹窗。已修：never 时 `pipeline.rs` 失败步**自动接管重试（带诊断回灌）**——改 `pending`+`retryCount`+`guidance`（注入上次失败原因）回主循环自愈，达 `MAX_TASK_RECOVERY_ATTEMPTS` 上限才 `skipped`；不弹 recovery-needed、不阻塞。配合 #20260914014 放开依赖白名单，自愈能装上缺失依赖（如 pytest），任务真闭环。
- **🔴 LLM 把多步合并进首步→后续步孤立校验假「skipped」（20260914016 已修）**：calc 场景 planner 拆 3 步，LLM 在 step1 就把建文件+跑 pytest 全做了（"21 passed" 证据在 step1 stdout）；step3「运行测试」的 `success_criteria` 是 `stdout_contains:OK/passed`，但 step3 自身未跑工具→`tool_outputs` 空→校验器判"无工具输出流"→未闭环→重试×3→标 `skipped`（任务其实已通过）。已修：`pipeline.rs` 新增会话级 `Arc<Mutex<Vec<String>>>` 累积所有子任务 `tool_outputs`，校验时把**本步+会话累积**合并传入 `verify_task`，使早步已跑出的 passed 证据被后续步复用，step3 首轮即闭环、不再假跳过。`stdout_contains` 跨步骤复用属合理泛化；step 专属判定应让 planner 用更具体关键字。

## 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks 须 early-return 前无条件执行。chat 右栏 `agent-chat__right` 三投影 Tab（图/过程/产物，图默认）+ recovery 情境升起条；`useAgentSession` 持 planSteps/toolSteps/recovery/trace/memories；气泡 `ThoughtPanel`+`ToolStepLine` 为持久化真相源，右栏 Tab 为实时内存(刷新清空)。执行图=RunDagCanvas 复合 DAG（PlanStep 节点 + ToolStep 子节点；三态：空态 / 完整 DAG / SIMPLE_CHAT 单点卡）；左栏活动会话项加 loading（运行中）+ 待确认 徽标（挂起）。交互态 hover 禁用 `transform: translateX/scale` 等位移/缩放（曾致左侧会话栏 X 轴滚动条），只做背景/颜色过渡，列表容器加 `overflow-x:hidden` 兜底。
- **前端坑（20260914 真机点验）**：①antd `Modal` 内容过长顶出视口——`.ant-modal-content` 设 `max-height:calc(100vh-48px);display:flex;column` + `.ant-modal-body{flex:1;min-height:0;overflow-y:auto}` 安全网；`agent-task-error` 的 `<pre>` 必须自带 `max-height+overflow+pre-wrap`。②右下角 antd `Notification` 弹窗（recovery/approval/choice/plan）**用户硬规矩（反复强调·多次回退）**：整卡绝不出现 Y 滚动条、底部按钮必须第一眼可见；最终定版 = 整卡 `max-height:700px;overflow:hidden` + `description{max-height:540px;overflow-y:auto}`（仅文本区内部滚动）。**不要再用字符截断+复制图标那版**（CopyableMarkdown 已删除，用户定性"越改越不像话"，回退到此版）。正文走 `MarkdownRenderer`（reason/summary/description/question/goalSummary 优先 markdown）。③SVG 画布拖拽会选中文字——`.xxx__svg{user-select:none}`。④节点内状态标签勿与标题同基线（改放底部右）。⑤工具显示名做中文映射（裸 `toolLabel` 是英文）。
- **🔴 Agent 交互设计铁律（20260914015 用户设定）**：任务核心目标**已完成**后，Agent 不得调用 `native__ask_user_choice` 弹「后续推荐」窗征求方向——那属多此一举；推荐应作为要点写进**最终回复文本**。`ask_user_choice` 仅用于"任务进行中、意图确实不明确、且必须用户拍板才能继续"的歧义分支。后端已实现双保险：`native.rs::AskUserChoiceTool::run` 在 `emit_choice_needed` 前调 `is_post_completion_recommendation(graph,session_id)`（判定=至少一步闭环且未闭环步骤至多一个且恰为最后一步/全闭环），命中则**非阻塞**回传"已完成+question+选项"作工具结果，由 LLM 写最终回复；`pipeline.rs` 全局交互准则也前置到每个子任务 system_prompt。
- 已修 bug：①记忆模式开关保存回默认——`draft.ts::draftToInput` 补 `memoryMode`+`agent-mapper.ts` INSERT 补 `memory_mode` 列+ON CONFLICT。②输入框拖高遮挡右栏——根容器下发 `--input-h`，避让高度 `calc(var(--input-h)+110px)`。

## 全局消息 / 导航 IA
- 统一 `useNotify()`（`App.useApp()` message/notification/modal），禁静态 `import {message}`；`<App message={{top:72}}>` 避让顶栏。
- 路由：`/`(Dashboard) `/model-settings` `/knowledge`(+`/:id`) `/agent-studio`(+`/new` `/:id/edit` `/:id/chat`) `/squads-workspace` `/skill-hub`(+`/:id`) `/mcp-hub`(+`/:id`) `/sandbox/python` `/sandbox/node` `/settings`(含**记忆宫殿**)。

## 日志框架
`tracing`+`tracing-subscriber`(env-filter)+`tracing-appender`(DAILY)，落盘 `$RESOURCES/logs` 优先；全仓 `println!/eprintln!`→`tracing::*` 已清零。增强：工具完成 `tool_round[call_id]: name ok=耗时 step`；LLM 轮次 `usage=(in,out)`；参数 `clip(...,800)`；`recovery.rs::resolve` 加挂起 step/title；`run_subtask` 加 `耗时={ms}ms`。

## Rust 工具链（实测 ✅ 2026-09-13 修正）
- **本机工具链可直连，沙箱能访问**：**之前「沙箱访问不了、编不了 Rust」是错误假设**——已用本机 cargo 跑通 `cargo check`(EXIT=0) 与单测。改完 Rust 后**直接本地编译验证，别甩锅让用户跑**。
- **🔴 路径用环境变量，禁硬编码（2026-09-14 用户红线）**：绝不在命令写死 Rust 绝对路径。用 `$CARGO_HOME/bin/cargo.exe` 或裸 `cargo`（用户已配 `CARGO_HOME`/`RUSTUP_HOME` 且 cargo 在 PATH）。调用：`"$CARGO_HOME/bin/cargo.exe" check --manifest-path src-tauri/Cargo.toml`。重编前停 `npm run tauri` 防 `target/` 文件锁 LNK1104。
- **⚠️ shell 坑（同会话已踩）**：本 bash 环境**缺 coreutils**——`tail`/`cat`/`head`/`ls`/`grep`/`dirname` 均失效，npm 生命周期脚本报 `/usr/bin/env: bash`。取 cargo 输出：重定向到日志文件再 `Read`（例 `cargo check ... > .log 2>&1`），勿管道 `| tail`；清理临时文件用 PowerShell `Remove-Item`。

## Phase 3 三视图 / 附件 / Squad（✅ 已落地）
- 轨迹(TracePanel)：`emit_intent_classified`+`emit_thinking_chunk`(layer 三色)；`finalizeStuckSteps()` 收敛残留 running。
- 执行图(RunDagCanvas，`@xyflow/react` v12 重写)：复合 DAG —— 步骤节点左列脊柱 + 工具子节点向右递进；每边颜色=其 target 节点状态色（running/pending 虚线+animated，success/failed/skipped 实线，失败入边红）；自定义节点 `PlanNode`/`ToolNode`；详情框在 `<ReactFlow>` 之外（滚轮不缩放图）；保留 `read_artifact`+`branch_from_step`+`handleApplyBranch`(plan_override→run_pipeline 续跑)。SIMPLE_CHAT 降级单点任务卡。**方案 C（Graph-first）已落地**：右栏默认展开执行图、过程 Tab 思考留中栏、recovery 非常驻（挂起时升起）。
- 记忆宫殿(MemoryPalace)：`memory.rs`(list/heatmap/anchor/update/delete/recall/top-K)+`native__anchor_memory`(ReadSafe)。
- 附件三态：image≤20MB / text≤200KB 内联，其余 `stageFile`→`workspace/.attachments/`，>500MB 拒绝。
- Squad：orchestrator/pipeline/chat 三模式；成员记忆+团队黑板；`global_mcp_ids`/`global_mcp_tools` 工具级开关；ReactFlow DAG(`dependsOn`)；chrono cron + TCP HTTP server 已真接线。遗留：cron/api 真调度未做。
