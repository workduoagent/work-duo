# work-duo 长期约定（单一事实源 · 校准 2026-09-07）

> 与每日日志冲突以本文件为准；逐日实现细节留 `2026-*.md`，前端规范见仓库根《前端开发规范.md》。只存「决策约定 + 坑 + 模块边界」，勿搬实现细节。

## 1. 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；样式=Sass（只用 `var(--color-*)`）；图标=lucide-react；Monaco 本地 AMD；路由=HashRouter(`src/core/router/index.tsx`)。**只跑 `npm run typecheck`**，禁 `vite build`/`npm run build`；调试 `npm run tauri`；勿改 `vite.config.ts`。
文档阅读栈（本地优先）：Monaco/pdfjs+`@react-pdf-viewer`(PDF)/docx-preview(Word)/react-reader(EPUB)/video.js+wavesurfer(音视频)/xlsx+ag-grid(表格)/react-markdown+katex+mermaid(富文本)。
Squad 编排 UI 用 **`@xyflow/react`**（已装，用户 `pnpm i`）。

## 2. 依赖管理
AI 只写 `package.json`，绝不自己装（禁 `npm/pnpm/yarn i`），安装由用户 `pnpm i`。重型库用动态 `import()`+`src/types/shims.d.ts` 兜底。

## 3. 沙箱 EPERM
注入钩子 fail-closed→EPERM。**装/删包**前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；pnpm 损坏→`NODE_OPTIONS= npm install`(managed node v22)。`src/` 删除/改名通常 EPERM→只能新建合规位置+改 import+typecheck，旧文件用户手动删（个别先试 `rm`）。

## 4. 数据持久化
SQLite `workduo.db`；TS 访问层 `src/core/mapper/*.ts`（禁组件直写 SQL）。**DDL 单一事实源**：`src/assets/sql/init.sql`(仅 CREATE TABLE IF NOT EXISTS) + `src/assets/sql/updater.sql`(ALTER 迁移，现至 **v16**，`duplicate column` 安全跳过)。**凡引用可能尚不存在列的索引/约束必须进 updater.sql**，否则现有库 CREATE 被跳过→整段 init 崩→列缺失。`isTauri` 是布尔常量。
Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>()`→读锁→`DbPool::Sqlite`→`sqlx`(0.8 sqlite+runtime-tokio)；key=`sqlite:workduo.db`，前端须先 `load()`。
**22 张表**：`app_config` / `models`(含 iflytek 三件套) / `skill_info`(+skill_markdown) / `mcp_info`(+mcp_tool_definition) / `scenario_category`(字典,LLM不纳入) / `agent_info`(+agent_mcp_ref+agent_skill_ref) / `knowledge_base`(+knowledge_asset) / `agent_project` / `agent_conversation_session` / `agent_conversation_round` / `artifacts` / `agent_memories`+`agent_memory_events`(记忆宫殿,2026-09-06) / `agent_squad`+`agent_squad_member`+`agent_squad_chat_config`+`agent_squad_session`+`agent_squad_round`+`agent_squad_memory`(小分队,2026-09-06)。新增列：init+updater 同步。
wd_mem 双轨：任意带 workspace 运行根目录 `.wd_mem/`(scripts/data/outputs/sessions/{id}.summary.md/MEMORY.md/artifacts/)；长期记忆文件名 **MEMORY.md**（旧 project_memory.md 回退兼容）；`native__archive_artifact` 归档 artifacts/(RequireApproval)；`load_config` Slot0 注入 MEMORY.md+`build_tree_index`+固化闭环指令。

## 5. 已移除 / 架构定调
知识库向量化已移除；客户端不跑本地重推理（embedding/重排/LLM 走云端）。LLM 分类 `models.category` 固定枚举，不进 scenario_category。iflytek 三件套+签名 WS。工作空间绑定 DB 逻辑全在 TS mapper，路径规范化用 Rust `canonicalize_path`。

## 6. 全局消息
统一 `useNotify()`（=`App.useApp()` message），禁静态 `import {message}`；`<App message={{top:72}}>` 避让 56px 顶栏。`notify.ts` 的 `result({ok,error?})` 成功静默、失败弹 error。

## 7. 导航 IA
TopBar 两级胶囊（百宝箱=LLM/MCP/Skill，纯 HTML）。路由(HashRouter)：`/`(Dashboard 占位) `/model-settings` `/knowledge`(+`/:id`) `/agent-studio`(+`/new` `/:id/edit` `/:id/chat`) `/squads-workspace`(**已落地**) `/skill-hub`(+`/:id`) `/mcp-hub`(+`/:id`) `/sandbox/python` `/sandbox/node`(2026-09-07 新增) `/settings`(左侧 Tab 含**记忆宫殿**)。
记忆宫殿已从顶栏一级菜单**收进「设置」左侧 Tab**（2026-09-06 决策；`pages/memory-palace/MemoryPalace.tsx` 默认导出）。dashboard 仍占位骨架。

## 8. 智能体引擎（src-tauri/src/agent/，扁平 *.rs）
命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（**入参为结构体，invoke 须包 `input`/`decision` 键**）。**三层流水线架构**：意图分流(`intent.rs` 规则短路+LLM 轻量分类，失败降级 COMPOSITE) → SIMPLE_CHAT(`run_simple_chat` 单次流式0工具) / COMPOSITE → DAG 规划(`planner.rs` 只注能力大纲不含 Schema、JSON 失败降级单任务、`temperature=0`、≤5 步) → 流水线执行(`pipeline.rs` 子任务独立 messages、`MAX_SUBTASK_ITERATIONS=8`、连续 2 错误拦截、失败重试 3 次中止)。工具轮公共 `runtime::run_tool_calls_round`。取消信号链：`cancel_flag:Arc<AtomicBool>` 贯穿 run_task/simple_chat/pipeline，`call_llm_stream` 检测即断流。
**LLM 铁律**：每轮仅 1 次流式 `call_llm_stream`，SSE 聚合 delta.content/reasoning/tool_calls(按 index 归并)→`StreamOutcome`(含 `usage`)；无 tool_calls→终态 emit；有→思考面板；**流式空响应回退一次非流式 `call_llm`**。禁「非流式判断+流式输出」双调用。
**四优化（2026-09-06 实测，账单 61.51→42 积分，省 31.7%）**：
- 优化1·verifier `text_contains` 多关键词容错（`value.split('|')` 任一命中即可，planner/criteria_hint 同步指导）。
- 优化2·ReAct 上下文压缩 `compress_in_flight_tool_results(messages, keep_recent_full=2)`（保留最近 2 条 tool 结果完整，更早替换为单行摘要，保留 tool_call_id 维持配对不变量）。
- 优化3·取消信号优先（send 前查 cancel 直接返回；取消检查移到「流式空响应兜底」之前）。
- 优化4·零输出快速重试（拆外层 retry + `call_llm_stream_once`；content+tool_calls 双空/网络错自动重试 1 次；取消透传不重试）。
**恢复/校验**：`recovery.rs`(agent-recovery-needed) + `verifier.rs`(success_criteria 验证) + 前端 `RecoveryPanel.tsx`。
**会话/消息**：`raw_messages_json` 存精简版，入库前 `sanitize_message_sequence`；约束上限 `MAX_MCP_SERVERS=3/MAX_MCP_TOOLS=10/MAX_SKILLS=3`(draft.ts)。日志统一 `println!("[agent] ...")`，`sanitize_for_log` 脱敏+clip。

## 9. 执行链路不变量（架构红线 · 2026-09-04 实测）
- **能力层优先**：约束必须落在**能力层**(`register_native_tools` 注册集合)，只写进 system_prompt 必然被模型绕过。`allow_sandbox` 为唯一真值源，同时驱动注册集合与提示分支。
- **消息序列配对不变量**：每个 assistant 的 `tool_call.id` 须有对应结果；裁剪只能落配对安全边界；**发送前与落库前各调一次 `sanitize_message_sequence`** 自检自愈。违反⇒网关 HTTP 400 `tool result's tool id(...) not found`(2013)，脏数据落库「一次崩次次崩」。
- **熔断靠"无进展"而非砍总轮数**：`MAX_SUBTASK_ITERATIONS=8` 仅计工具轮，**无 tool_calls 的终态汇报轮不计入**。
- **计划—执行文件名绑定**：`pipeline.rs` 的 `criteria_hint` 把 `task.success_criteria` 注入子任务执行 prompt（文件名须一致），否则 planner 声明名 vs 执行器自由命名错位→校验误判失败（2026-09-06 修复）。
- **步骤成功必须 emit `step_finished(true)`**：成功分支原漏发→`finalizeStuckSteps` 兜底误标失败（2026-09-06 修复，后端真漏发）。
- **沙箱工具摩擦=反向诱导绕道**：`native__run_python_sandbox` 支持 `code` 直传；`mamba_manager::run_script_with_selfheal` 在 `ModuleNotFoundError` 时白名单 `micromamba install` 重试。**Node/Bun 沙箱同构**：`native__run_node_sandbox` 直传 `code` 落盘 `.wd_mem/scripts/*.mjs`，`bun_manager::run_script_with_selfheal` 在 `Cannot find package`/`Could not resolve` 时白名单 `bun add` 重试；Bun 镜像走 `BUN_CONFIG_REGISTRY=npmmirror`、`BUN_INSTALL=bun_root/.bun`（绿便携）。
- **Node 单一环境**：与 Python 多 env 不同，Bun 仅需单一运行时版本——`bun_root/(package.json+node_modules)`，列表恒为 `default`；无创建/删除环境能力，reset=清空 node_modules。设置页「沙箱环境」分组下含 Python / Node 两个子菜单。详见 `docs/sandbox-architecture.md` §6。
- **副作用**：沙箱开启⇒`execute_command` 不注册⇒git/npm/curl 等宿主命令不可用。架构总览见 `docs/Agent引擎架构与执行逻辑.md`。

## 10. 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`（禁 max-width+margin:0 auto）；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks：`useMemo`/`useState` 须在 early-return 前无条件执行；派生 state 须在 useMemo 前。Popover/Dropdown 逃逸用 `position:fixed`+`getBoundingClientRect`。Tauri capabilities scope 须 `https://*`。编辑含中文/反引号行后 re-grep 复核落盘。
**chat 页右栏架构**：`chat.tsx` 右栏 `agent-chat__right` 弹性列（非 fixed，底部 150px 留白避让输入栏），`Tabs` 切换 **执行轨迹 / 画布 / 产物**（可拖拽调宽 300–680）。`useAgentSession` 统一持有 `trace`/`canvas`/`memories` 三状态机。气泡内 `ThoughtPanel`+`PlanToolTimeline` 为**持久化真相源**（落库 `m.thought/m.toolSteps/m.planSteps`，刷新可回显）；右栏 Tab 为实时内存（刷新清空），两处并存互不替代（2026-09-06 决策回退）。

## 11. Rust 工具链路径（重要 · 实测校正 2026-09-07）
cargo 二进制 `/d/Rust/cargo/bin/cargo`（**非** `/d/envs/Rust/.cargo`）；CARGO_HOME `/d/Rust/cargo`；rustup 家目录 `/d/Rust/rustup`。**Cargo.toml 在 `src-tauri/`，`cargo check` 须在该目录执行**（仓库根无 Cargo.toml）。编译：`cd src-tauri && RUSTUP_HOME=/d/Rust/rustup CARGO_HOME=/d/Rust/cargo RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/Rust/cargo/bin/cargo check`。增量数秒~十几秒；`--offline` 易索引误报，联网重跑。真机重编前须停掉运行中的 `npm run tauri` 窗口，否则 `target/` 文件锁致 LNK1104。

## 12. Phase 3 创新（✅ 已落地 2026-09-06，原「延后」计划作废）
源 `docs/WorkDuo_Agent_UI_优化与创新方案（K3）.md` §3。三视图全部实现，前端在 `src/pages/agent-studio/session/` 与 `src/pages/memory-palace/`：
- **§3.1 轨迹视图（TracePanel）**：后端补 `emit_intent_classified`+`emit_thinking_chunk`(layer: plan/exec/selfcheck 三色)；前端 `TracePanel.tsx`（意图节点/分层思考/规划步骤/工具时间轴）+ `useAgentSession.trace` 状态机。`finalizeStuckSteps()` 在 `agent-task-done/error`/20min 兜底三处收敛残留 running 步骤。`run()` 须清 `traceIntent/traceThinking`（否则旧题残留）。
- **§3.2 产物画布（ArtifactCanvas）**：后端 `read_artifact`(PathGuard+按扩展名返回) + `branch_from_step`(重编号续接+`agent-plan-branch` 事件)；前端 `ArtifactCanvas.tsx`（拖拽/缩放/点击预览/右键分支/对比横幅）取代孤立的 `CanvasPanel.tsx`（不删）。**遗留**：`handleApplyBranch` 仅 log 不实际重跑（需后端支持用新分支步骤重跑）；`PlanToolTimeline.tsx` 已无引用但按铁律不删。
- **§3.3 记忆宫殿（MemoryPalace，工作量最大）**：后端 `memory.rs`(list/heatmap/anchor/update/delete/recall/top-K 自动召回+引用计数) + `agent_memories`/`agent_memory_events` 两表(v16) + 事件 `agent-memory-recalled`/`agent-context-compacted`（替代原纯字符串 `emit_status`）+ 6 命令；前端 `MemoryPalace.tsx`+`memory-palace.scss`（卡片网格/搜索/Segmented 过滤/GitHub 式召回热力图/压缩事件/锚定 Modal/详情 Drawer），现挂在「设置」Tab。
**校验基线**：每步必 `cargo check` 零警告 + `npm run typecheck` 零错误 + `npm run tauri` 真机目测。

## 13. 附件持久化三态（2026-09-05 实测）
- **路由（前端 chat.tsx addFiles）**：image≤20MB 内联 dataUrl / text≤200KB 内联文本 / 其余（含大图·二进制·大文本）走 `stageFile` 分片落盘。>500MB 拒绝。
- **落盘（file 型）**：二进制本体真实写入 `workspace/.attachments/`（Rust `persist_bytes`）；前端只持 `AttachmentInput.path` 绝对路径引用。
- **内联（image/text 型）**：内容直接进消息 body，随 `raw_messages_json` 存进 SQLite，不生成独立文件。
- **跨会话恢复（image 已修，file 待补）**：`listRounds` 原缺 `raw_messages_json`→重开会话图片卡片丢；修复：`database.d.ts`/`core.d.ts` `AgentConversationRound`/`rowToRound` 加 `rawMessagesJson`；`chat.tsx` `roundsToMessages` 用 `extractHistoryAttachments` 解析**最后一条 user 消息**的 `image_url` parts 重建卡片（仅 image）。**file 型历史卡片仍未恢复**（文件本体仍永久留磁盘，暂不动）。

## 14. Squad（小分队）协作层（✅ 已落地 2026-09-06，原「规划未实现」作废）
"人"(Agent)模块化 → 造"人的协作层"。后端 `squad_orchestrator.rs`(945 行)/`squad_scheduler.rs`(299)/`squad_api_server.rs`(218) + 6 张表（§4）+ `squad-mapper.ts`(456 行)；前端 `src/pages/squads-workspace/index.tsx`(1673 行)+`index.scss`(846)，ReactFlow 编排。
- **三种协作模式**：编排式(Leader 拆解委派成员 `run_task`)/流水线(前步产物喂后步 `initial_context`)/群聊协商(共享讨论黑板+Moderator 收口)。
- **成员记忆**：个人记忆(按 agent_id) + Squad 级共享黑板 `agent_squad_memory`。
- **与 `agent_project` 解耦**：独立 6 表，不碰现有项目业务。
- **工作空间**：成员各自私有，默认 `.wd_mem/squads/{squad_id}/{agent_id}/`（相对 app CWD 的隐藏目录）。**2026-09-07 起支持用户自选 `agent_squad.workspace_dir`**（建表 v20）：选中的绝对路径作为团队根，成员工作区为 `{workspace_dir}/{agent_id}`（保留隔离）；留空回退默认。前端表单「工作目录」字段（SquadEditorModal，含 Tauri 目录选择按钮），`squad_orchestrator::squad_member_workspace` 统一派生，`load_squad` 读出注入 `SquadRuntimeConfig.workspace`。群聊模式（chat）纯讨论不走 run_member_subtask，不落文件产物。
- **成员任职**(`agent_squad_member`)：role + persona_override(注入 system_prompt 末尾) + pipeline_order + is_leader。
- **运行策略**：execution_mode('manual'|'schedule'|'api') + retry_count。
- **全局能力**：Squad 级 `global_mcp_ids` 强制并入成员工具集（复用 `@提及` 机制）。
- **遗留待办**：ReactFlow 新依赖已装；定时/API 模式本期是否做真调度待确认；logo 存 emoji。
