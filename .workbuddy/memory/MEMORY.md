# work-duo 长期约定（单一事实源 · 校准 2026-09-04）

> 与每日日志冲突以本文件为准；逐日实现细节留 `2026-*.md`，前端规范见仓库根《前端开发规范.md》。只存「决策约定 + 坑 + 模块边界」，勿搬实现细节。

## 1. 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；样式=Sass（只用 `var(--color-*)`）；图标=lucide-react；Monaco 本地 AMD；路由=HashRouter(`src/core/router/index.tsx`)。**只跑 `npm run typecheck`**，禁 `vite build`/`npm run build`；调试 `npm run tauri`；勿改 `vite.config.ts`。
文档阅读栈（本地优先）：Monaco/pdfjs+`@react-pdf-viewer`(PDF)/docx-preview(Word)/react-reader(EPUB)/video.js+wavesurfer(音视频)/xlsx+ag-grid(表格)/react-markdown+katex+mermaid(富文本)。

## 2. 依赖管理
AI 只写 `package.json`，绝不自己装（禁 `npm/pnpm/yarn i`），安装由用户 `pnpm i`。重型库用动态 `import()`+`src/types/shims.d.ts` 兜底。

## 3. 沙箱 EPERM
注入钩子 fail-closed→EPERM。**装/删包**前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；pnpm 损坏→`NODE_OPTIONS= npm install`(managed node v22)。`src/` 删除/改名通常 EPERM→只能新建合规位置+改 import+typecheck，旧文件用户手动删（个别删除先试 `rm`）。

## 4. 数据持久化
SQLite `workduo.db`；TS 访问层 `src/core/mapper/*.ts`（禁组件直写 SQL）。**DDL 单一事实源**：`src/assets/sql/init.sql`(仅 CREATE TABLE IF NOT EXISTS) + `src/assets/sql/updater.sql`(ALTER 迁移 v1–v13，`duplicate column` 安全跳过)。**凡引用可能尚不存在列的索引/约束必须进 updater.sql**，否则现有库 CREATE 被跳过→整段 init 崩→列缺失。`isTauri` 是布尔常量。
Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>()`→读锁→`DbPool::Sqlite`→`sqlx`(0.8 sqlite+runtime-tokio)；key=`sqlite:workduo.db`，前端须先 `load()`。
**14 张表**：`app_config`/`models`(含 iflytek app_id/api_secret)/`skill_info`(+skill_markdown)/`mcp_info`(+mcp_tool_definition)/`scenario_category`(字典,LLM不纳入)/`agent_info`(+agent_mcp_ref+agent_skill_ref)/`knowledge_base`(+knowledge_asset)/`agent_project`/`agent_conversation_session`/`agent_conversation_round`。新增列：init+updater 同步。
wd_mem 双轨：任意带 workspace 运行根目录 `.wd_mem/`(scripts/data/outputs/sessions/{id}.summary.md/MEMORY.md/artifacts/)；长期记忆文件名 **MEMORY.md**（旧 project_memory.md 回退兼容）；`native__archive_artifact` 归档 artifacts/(RequireApproval，无 workspace 拒绝)；`load_config` Slot0 注入 MEMORY.md+`build_tree_index` 索引+固化闭环指令。

## 5. 已移除 / 架构定调
知识库向量化已移除；客户端不跑本地重推理（embedding/重排/LLM 走云端）。LLM 分类 `models.category` 固定枚举，不进 scenario_category。iflytek 三件套+签名 WS。工作空间绑定 DB 逻辑全在 TS mapper，路径规范化用 Rust `canonicalize_path`。

## 6. 全局消息
统一 `useNotify()`（=`App.useApp()` message），禁静态 `import {message}`；`<App message={{top:72}}>` 避让 56px 顶栏。`notify.ts` 的 `result({ok,error?})` 成功静默、失败弹 error。

## 7. 导航 IA
TopBar 两级胶囊（百宝箱=LLM/MCP/Skill，纯 HTML）。路由(HashRouter)：`/`(Dashboard 占位) `/model-settings` `/knowledge`(+`/:id`) `/agent-studio`(+`/new` `/:id/edit` `/:id/chat`) `/squads-workspace`(占位) `/skill-hub`(+`/:id`) `/mcp-hub`(+`/:id`) `/sandbox/python` `/settings`。dashboard/squads 仍占位骨架。

## 8. 智能体引擎（src-tauri/src/agent/，扁平 *.rs）
命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（**入参为结构体，invoke 须包 `input`/`decision` 键**）。**三层流水线架构**（替代旧全局大 ReAct）：意图分流(`intent.rs` 规则短路+LLM 轻量分类，失败降级 COMPOSITE) → SIMPLE_CHAT(`run_simple_chat` 单次流式0工具) / COMPOSITE → DAG 规划(`planner.rs` 只注能力大纲不含 Schema、JSON 失败降级单任务、`temperature=0` 确定性、≤5 步) → 流水线执行(`pipeline.rs` 子任务独立 messages、`MAX_SUBTASK_ITERATIONS=8`、连续 2 错误拦截、失败重试 3 次中止)。工具轮公共 `runtime::run_tool_calls_round`。取消信号链：`cancel_flag:Arc<AtomicBool>` 贯穿 run_task/simple_chat/pipeline，`call_llm_stream` 检测即断流。
**LLM 铁律**：每轮仅 1 次流式 `call_llm_stream`，SSE 聚合 delta.content/reasoning/tool_calls(按 index 归并)→`StreamOutcome`(含 `usage`，跨轮累计写回会话表+经 `agent-task-done` payload 带出前端)；无 tool_calls→终态 emit；有→思考面板；**流式空响应回退一次非流式 `call_llm` 兜底**。禁「非流式判断+流式输出」双调用。
**会话/消息**：`raw_messages_json` 存精简版（user+规划摘要 assistant+最终交付 assistant），入库前 `sanitize_message_sequence`；恢复兼容。约束上限 `MAX_MCP_SERVERS=3/MAX_MCP_TOOLS=10/MAX_SKILLS=3`(draft.ts)。日志统一 `println!("[agent] ...")`，`sanitize_for_log` 脱敏+clip。

## 9. 执行链路不变量（架构红线 · 2026-09-04 实测）
- **能力层优先（最重要）**：约束必须落在**能力层**(`register_native_tools` 注册集合)，只写进 system_prompt 必然被模型绕过（实测模型用 shell 找系统 python 并 `winget install Python` 装进宿主）。`allow_sandbox` 为唯一真值源，同时驱动注册集合与提示分支（沙箱段/cmd 段/sh 段）。
- **消息序列配对不变量**：每个 assistant 的全部 `tool_call.id` 须有对应结果；每条 tool 消息须可追溯发起者。裁剪只能落配对安全边界；**发送前与落库前各调一次 `sanitize_message_sequence`** 自检自愈（补占位/删孤儿）。违反⇒网关 HTTP 400 `tool result's tool id(...) not found`(2013)，脏数据落库「一次崩次次崩」。
- **熔断靠"无进展"而非砍总轮数**：`MAX_SUBTASK_ITERATIONS=8` 仅计工具轮，**无 tool_calls 的终态汇报轮不计入**，避免"产物已生成但没机会汇报"误判未闭环。
- **沙箱工具摩擦=反向诱导绕道**：`native__run_python_sandbox` 支持 `code` 直传（内部落盘 `.wd_mem/scripts/`，仍过 PathGuard）；提示须同时给可达路径与禁令，只讲禁令无效。
- **提示能力须真实**：缺失能力应在运行时自愈（如沙箱 `ModuleNotFoundError`→白名单 `micromamba install` 重试），不靠模型自我纠错。
- **副作用**：沙箱开启⇒`execute_command` 不注册⇒git/npm/curl 等宿主命令不可用。架构总览见 `docs/Agent引擎架构与执行逻辑.md`。

## 10. 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`（禁 max-width+margin:0 auto）；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks：`useMemo`/`useState` 须在 early-return 前无条件执行；派生 state 须在 useMemo 前。Popover/Dropdown 逃逸用 `position:fixed`+`getBoundingClientRect`。Tauri capabilities scope 须 `https://*`。编辑含中文/反引号行后 re-grep 复核落盘。

## 11. Rust 工具链路径（重要）
cargo 二进制实际在 `/d/envs/Rust/.cargo/bin/cargo`；rustup 家目录在 `/d/Rust/rustup`（两者不在同一父目录）。编译：`RUSTUP_HOME=/d/Rust/rustup CARGO_HOME=/d/envs/Rust/.cargo RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/envs/Rust/.cargo/bin/cargo check`。首次启用新 feature 重编依赖约 25min，其后增量数秒；`--offline` 易索引误报，联网重跑。

## 12. Phase 3 路线图（差异化创新，延后）
源 `docs/WorkDuo_Agent_UI_优化与创新方案（K3）.md`「三、创新提议」。三条：§3.1 轨迹视图、§3.2 产物画布、§3.3 记忆宫殿。依赖 Phase 2 基建（#6–#10 已完成，cargo check/build 通过）。**用户显式标注延后，本次不实现。**
后端缺口（2026-09-05 核查 events.rs/types.rs/intent.rs）：Phase 2 已 emit `tool_started`/`tool_finished`(ToolStep 带 args/result/duration_ms)/`plan_generated`(PlanDAG: goal+tasks+depends_on)/`step_started`/`step_finished`/`token_update`/`artifact_created`(ArtifactRef 带 step)/`agent-task-done`(tokens)/`agent-task-error`/`agent-recovery-needed`。
- **§3.1 轨迹视图（约 75% 就绪）**：缺 ①emit_intent_classified（intent.rs 返回 IntentProfile 但未 emit）②thinking_chunk 分层事件（规划/执行/自检，现仅 text_chunk/status）③消息序列快照事件。节点级数据其余已齐，主要是前端时间轴/DAG 渲染。
- **§3.2 产物画布（约 85% 就绪）**：缺 ①branch_from_step 分支重规划命令（真后端工作）②产物内容读取 API 供预览。plan_generated+artifact_created+depends_on 已足组装画布节点/边；拖拽/连线/预览为前端。
- **§3.3 记忆宫殿（约 15% 就绪，缺口最大）**：wd_mem 仅磁盘态、round_compactor 会压缩，但无前端通道——缺 memory_recalled 事件、context_compacted 结构化事件（现仅 emit_status 字符串）、anchor_memory 锚定命令、list_memories 列举 API、引用次数统计。需 4+ 新事件/命令 + 召回埋点。
前端规范同 §10。建议后续启动 Phase 3 时**先补后端遥测缺口**（intent emit + memory 事件/API），前端再据此构建三视图。

## 13. 附件持久化三态（2026-09-05 实测）
- **路由（前端 chat.tsx addFiles）**：image≤20MB 内联 dataUrl / text≤200KB 内联文本 / 其余（含大图·二进制·大文本）走 `stageFile` 分片落盘。>500MB 拒绝。
- **落盘（file 型）**：二进制本体真实写入 `workspace/.attachments/`（Rust `persist_bytes`：文件名 sanitize+去分隔符+双重路径校验防逃逸）；前端/会话只持 `AttachmentInput.path` 绝对路径引用。是「既留存本地又只持路径」的混合态。
- **内联（image/text 型）**：内容直接进消息 body，随 `raw_messages_json` 存进 `agent_conversation_round`（SQLite），不生成独立文件。
- **会话落库**：user 消息恒含附件信息（内联内容 或 "已落盘到 path" 提示），模型历史始终有记录。
- **跨会话恢复（image 已修，file 待补）**：历史 `AgentConversationRound` 原缺 `raw_messages_json`（`listRounds` 只取 `userQuestion` 纯文本）→ 重开会话图片卡片丢。修复（2026-09-05）：`database.d.ts` Row / `core.d.ts` `AgentConversationRound` / `rowToRound` 加 `raw_messages_json`→`rawMessagesJson`；`chat.tsx` `roundsToMessages` 用 `extractHistoryAttachments` 解析**最后一条 user 消息**的 `image_url` parts 重建 `attachments` 卡片（仅 image，用 `dataUrl`）。**file 型历史卡片仍未恢复**（路径在 raw_messages 文本提示里解析脆弱；文件本体仍永久留磁盘、模型历史有记录，暂不动）。

## 14. Squad（小分队）协作层（规划 2026-09-06，未实现）
"人"(Agent)已模块化 → 下一步造"人的协作层"。**规划决策（用户拍板方向）**：
- 三种协作模式全做：**编排式**(Leader 拆解委派成员 `run_task`)/**流水线**(前步产物喂后步 `initial_context`，建议 ReactFlow UI 编排)/**群聊协商**(共享讨论黑板 + Moderator 收口)。
- 成员记忆：个人记忆(按 agent_id) + Squad 级共享黑板 `agent_squad_memory` 两者皆有。
- **与 `agent_project` 解耦**：新建 `agent_squad`/`agent_squad_member`/`agent_squad_session`/`agent_squad_round`/`agent_squad_memory`/`agent_squad_chat_config` 独立表，不碰现有项目业务。
- 工作空间：成员各自独立私有 workspace `.wd_mem/squads/{squad_id}/{agent_id}/`，默认不共享，交接走 artifact/消息层；共享区 opt-in。
- 成员任职(`agent_squad_member`)承载定制：role(角色) + persona_override(人设定制，注入 system_prompt 末尾) + pipeline_order(流水线工序) + is_leader(编排主管)。
- 运行策略(三模式通用)：execution_mode('manual'|'schedule'|'api') + retry_count(节点失败重试)。
- 全局能力：Squad 级 `global_mcp_ids` 强制并入成员工具集（复用 `@提及` 机制）。
- 待确认 infra：ReactFlow 新依赖(@xyflow/react，用户 pnpm i)、定时/API 模式本期是否做真调度、logo 存 emoji。
