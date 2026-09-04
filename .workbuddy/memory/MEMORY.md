# work-duo 长期约定（单一事实源 · 校准 2026-09-04）

> 与每日日志冲突以本文件为准；逐日实现细节留 `.workbuddy/memory/2026-*.md`，前端规范见仓库根《前端开发规范.md》。只存「决策约定 + 坑 + 模块边界」，勿搬实现细节。

## 1. 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；样式=Sass（只用 `var(--color-*)`）；图标=lucide-react；Monaco 本地 AMD；路由=HashRouter（见 `src/core/router/index.tsx`）。**只跑 `npm run typecheck`**，禁 `vite build`/`npm run build`；调试 `npm run tauri`；勿改 `vite.config.ts`。
智能体对话/文档阅读栈（本地优先、非云端）：Monaco(`@monaco-editor/react`+本地 AMD 0.56)、pdfjs-dist+`@react-pdf-viewer`(PDF)、docx-preview(Word)、react-reader(EPUB)、video.js+wavesurfer.js(音视频)、xlsx+ag-grid(表格)、react-markdown+remark-gfm/math+rehype-katex/highlight+mermaid(富文本/公式/图渲染)。

## 2. 依赖管理
AI 只写 `package.json`，绝不自己装（禁 `npm/pnpm/yarn i`），安装由用户 `pnpm i`。重型库用动态 `import()`+`src/types/shims.d.ts` 兜底。

## 3. 沙箱 EPERM
注入钩子 fail-closed→EPERM。**装/删包**前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；pnpm 损坏→`NODE_OPTIONS= npm install`(managed node v22)。`src/` 删除/改名通常 EPERM→只能新建合规位置+改 import+typecheck，旧文件用户手动删（个别删除可成功，先试 `rm`）。

## 4. 数据持久化
SQL→SQLite `workduo.db`；TS 访问层在 `src/core/mapper/*.ts`（禁组件直写 SQL）。DDL 单一事实源 `src/assets/sql/init.sql`(仅 `CREATE TABLE IF NOT EXISTS`)+`src/assets/sql/updater.sql`(ALTER 迁移 v1–v13，`duplicate column` 安全跳过)；**凡引用可能尚不存在列的索引/约束必须进 updater.sql**（否则现有库 CREATE 被跳过→整段 init 崩→列缺失）。`isTauri` 是布尔常量。
Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>()`→读锁→`DbPool::Sqlite`→`sqlx`(0.8 sqlite+runtime-tokio)；key=`sqlite:workduo.db`，前端须先 `load()``。**Rust 改动本沙箱可 `cargo check`**——工具链实际位于 `/d/Rust/`（**非** `/d/envs/Rust/`）：`RUSTUP_HOME=/d/Rust/rustup CARGO_HOME=/d/Rust/cargo RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc /d/Rust/cargo/bin/cargo check`（stable-x86_64-pc-windows-msvc；运行态仍需用户 `npm run tauri` 重编译）。首次启用新 feat 需重编大量依赖（~25min），其后增量仅数秒；`--offline` 易索引误报失败，联网重跑即可。
**14 张表**（非全 agent 相关）：系统 `app_config` / `models`(含 iflytek 三件套 app_id/api_secret) / `skill_info`(+skill_markdown/status) / `mcp_info`(+mcp_tool_definition) / `scenario_category`(MCP/SKILL/KB/AGENT 字典，LLM 不纳入) / `agent_info`(+`agent_mcp_ref`+`agent_skill_ref`，最小关联单元=工具) / `knowledge_base`(+`knowledge_asset`) / `agent_project`(root_path UNIQUE/is_pinned/is_archived/custom_rules) / `agent_conversation_session`(project_id+total_turns+summary_round_count+total_prompt/completion/tools_tokens，FK 级联) / `agent_conversation_round`(raw_messages_json，FK 级联)。新增列：`init.sql`+`updater.sql` 同步。
wd_mem 双轨：任意带 workspace 运行（含自由对话）根目录 `.wd_mem/`（scripts/data/outputs/sessions/{id}.summary.md/MEMORY.md/artifacts/），由 `wd_mem.rs` 读写。
- 长期记忆文件名 **MEMORY.md**（规范命名，2026-09-04 由 project_memory.md 重命名；`read_project_memory` 仍回退读旧 project_memory.md 兼容已部署工程）；`ensure_wd_mem` 自动建 artifacts/ 并生成 `.gitignore`（忽略 sessions/data/outputs，保留 MEMORY.md/artifacts/scripts）。
- 上下文装配（`commands.rs::load_config` 统一在 Slot0 系统提示注入）：MEMORY.md 全量 + `build_tree_index` 树状索引（扫 artifacts/sessions/scripts/data，深度≤2、≤50 文件、仅首行标题不读正文）+ 自主发现指令；「固化闭环」指令要求智能体完成实质任务后调 `native__archive_artifact` 归档 artifacts/。**context.rs 不再重复注入 project_memory**（去重，避免爆上下文），仅保留会话滚动摘要 Slot。
- 原生工具新增 `native__archive_artifact`（写 .wd_mem/artifacts/{name}.md，TOCTOU 安全写 + RequireApproval；无 workspace 时拒绝，对应全局沙箱旁路）。

## 5. 已移除 / 架构定调
知识库向量化已移除；客户端不跑本地重推理（embedding/重排/LLM 走云端）。LLM 分类 `models.category` 固定枚举，不进 scenario_category 字典。iflytek 三件套+签名 WS（models 增 app_id/api_secret）。工作空间绑定 DB 逻辑全在 TS mapper，路径规范化用 Rust `canonicalize_path`。

## 6. 全局消息
统一 `useNotify()`（=`App.useApp()` message），禁静态 `import {message}`；`<App message={{top:72}}>` 避让 56px 顶栏。`notify.ts` 的 `result({ok,error?})` 成功静默、失败弹 error；仅异常场景弹提示。

## 7. 导航 IA
TopBar 两级胶囊（百宝箱=LLM/MCP/Skill，纯 HTML 实现不依赖 UI 库）。路由(`src/core/router/index.tsx`，HashRouter)：`/`(Dashboard 占位) `/model-settings` `/knowledge`(+`/:id`) `/agent-studio`(+`/new` `/:id/edit` `/:id/chat`) `/squads-workspace`(占位) `/skill-hub`(+`/:id`) `/mcp-hub`(+`/:id`) `/sandbox/python` `/settings`。dashboard/squads 仍为占位骨架。

## 8. 智能体引擎（src-tauri/src/agent/）
命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（**入参为结构体，invoke 须包 `input`/`decision` 键**）。**架构（2026-09-04 重构为三层流水线，替代旧全局大 ReAct）**：`run_task` = 意图分流（`intent.rs` 规则短路+LLM 轻量分类，失败降级 COMPOSITE）→ SIMPLE_CHAT 走 `run_simple_chat`（单次流式、0 工具、带会话历史）/ COMPOSITE_TASK → DAG 规划（`planner.rs` 只注能力大纲不含 Schema、JSON 失败降级单任务、≤5 步、**规划调用强制 `temperature=0` 确定性、同类任务保持拆分粒度一致**）→ 流水线执行（`pipeline.rs` 子任务独立 messages、产物管道纯文本摘要、`MAX_SUBTASK_ITERATIONS=8`、连续 2 错误拦截、失败重试 3 次中止）。工具执行轮公共函数 `runtime::run_tool_calls_round`。模块文件（扁平 `src-tauri/src/agent/*.rs`）：`mod.rs`/`commands.rs`/`types.rs`/`tools.rs`/`native.rs`/`runtime.rs`/`approval.rs`/`mcp_adapter.rs`/`skill_adapter.rs`/`events.rs`/`context.rs`/`round_compactor.rs`/`wd_mem.rs`/`intent.rs`/`planner.rs`/`pipeline.rs`（`wd_mem.rs` 含 `wd_mem_read/write_project_memory`，无独立 fs_helper 子模块）。
**LLM 铁律**：ReAct 每轮仅 1 次流式 `call_llm_stream`，SSE 聚合 delta.content/reasoning(reasoning_content)/tool_calls(按 index 归并)→`StreamOutcome`(含 `usage:(prompt,completion)`，取自 OpenAI `usage`，跨轮累计：写回会话表 `persist_session_tokens` + 经 `agent-task-done` payload 带出前端替代估算)；无 tool_calls→终态一次性 emit；有→进思考面板；**流式空响应回退一次非流式 `call_llm` 兜底**。禁「非流式判断+流式输出」双调用。微 ReAct 5 轮熔断（子任务级）、SSE 字节缓冲、reasoning 布尔→`{}` 归一化、外部 MCP/Skill 视为 ReadSafe、原生写类 RequireApproval。
**会话树/压缩**：`agent_project`+多级会话树（GLOBAL/PROJECT）；双表持久化+后台滚动压缩（`raw_messages_json` 协议视图、`summary_round_count` 级联）；`build_request_messages` Slot 顺序 0 系统+custom_rules/1 项目记忆/2 摘要/3..M 活跃轮/M+1 当前；`persist_tools_tokens`(覆盖写,按当前 MCP/Skill 数) 与 `persist_session_tokens`(累加真实 usage)。三层架构后 `raw_messages_json` 存**精简版**（user + 规划摘要 assistant + 最终交付 assistant），入库前 `sanitize_message_sequence`；恢复兼容（仍是合法 messages）。
**前端 chat.tsx**：三段式；DropdownMenu 用 `createPortal` 到 body（`position:fixed`+`getBoundingClientRect` 逃逸祖先 transform/overflow 裁剪，修复 Pop 偏移）；所有 Pop 菜单项 `icon+文字`；删除操作收进「更多」菜单；项目目录组只显示目录名（hover title 显示路径）；未命名会话首轮完成后用首问命名。思考面板 flex 须 `> *{flex-shrink:0}`+`overscroll-behavior:contain`；历史回显按消息绑定 thought/toolSteps。
**临时移除 Skill/MCP**（内存态，不写库）：`RunAgentTaskInput` 增 disabledSkillIds/disabledMcpIds/disabledMcpToolIds，load_config 映射前过滤，`persist_tools_tokens` 自动下调。
**约束上限**：`MAX_MCP_SERVERS=3/MAX_MCP_TOOLS=10/MAX_SKILLS=3`（draft.ts 单一事实源）。
**日志**：统一 `println!("[agent] ...")`，`sanitize_for_log` 脱敏+`clip(...,5000)`；MCP endpoint 隐藏 query。

## 9. 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`（禁 max-width+margin:0 auto）；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks：`useMemo`/`useState` 须在任意 early-return 前无条件执行；派生 state 声明须在 useMemo 前。Popover/Dropdown 逃逸用 `position:fixed`+`getBoundingClientRect`。Tauri capabilities scope 须 `https://*`。编辑含中文/反引号/省略号的源行后必须 re-grep 复核落盘；同文件多 Edit 逐条串行+复核。

## 10. 执行链路不变量（架构级约定 · 2026-09-04 实测确立）
- **能力层优先原则（最重要）**：提示是软的、工具注册表是硬的。任何约束（如"不暴露 execute_command"）必须落在**能力层**（`register_native_tools` 的注册集合）；只写进 system_prompt 必然被模型绕过——实测模型无视手写提示、用 shell 找系统 python 并 `winget install Python` 装进宿主系统。`allow_sandbox` 为唯一真值源，同时驱动注册集合与提示分支（`commands.rs` 局部真值源 + 执行环境三分支：沙箱段 / cmd 段 / sh 段）。
- **消息序列配对不变量**：每个 assistant 的**全部** `tool_call.id` 必须有对应 tool 结果；每条 tool 消息必须能追溯到发起者。裁剪（`trim_history`）只能落在配对安全边界（切点逐条前移 + `is_safe_start`/`has_orphan_tool_result` 校验 + 越界回退保留最后一条非 tool 消息）；**发送前**（每轮 `call_llm_stream` 前）与**落库前**（`raw_messages_json`）各调一次 `sanitize_message_sequence` 自检自愈（补占位结果 / 删孤儿 tool 消息）。违反 ⇒ 网关 HTTP 400 `tool result's tool id(...) not found`（code 2013），且脏数据落库后会"一次崩溃、次次崩溃"。
- **沙箱工具摩擦 = 反向诱导绕道**：`native__run_python_sandbox` 支持 `code` 直传（内部落盘 `.wd_mem/scripts/`，落盘后仍过 PathGuard），避免"先 write_file 再传 script_path + 每次审批"的两步摩擦把模型逼去用 execute_command。提示须同时给出**可达路径**与禁令，只讲禁令无效。
- **熔断护栏靠"无进展"而非砍总轮数**：三层架构后为子任务级 `MAX_SUBTASK_ITERATIONS=8`（工具轮上限）+ 连续 2 错误拦截 + 失败重试 3 次（pipeline.rs）；SIMPLE_CHAT 无工具循环不熔断。**闭环判定关键**：`pipeline.rs` 用 `loop` + 独立 `tool_iterations` 计数——只有"调用了工具的轮"计入预算，**无工具调用的终态汇报轮不计入**，确保"产物已生成但预算花在工具上、没机会发汇报"的子任务不会误判未闭环。（旧全局 `MAX_TOOL_ITERATIONS=30`/`MAX_CONSECUTIVE_ERRORS=3` 常量已随旧大循环一并删除，勿再引用）
- **副作用须知**：沙箱开启 ⇒ `execute_command` 不注册 ⇒ git/npm/curl 等宿主命令全部不可用（可选改为"保留 shell + 拦截 python/pip/winget 命令"，待定）。设计文档：`D:\Agent流程设计.md`。
