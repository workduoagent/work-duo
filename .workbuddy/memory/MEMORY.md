# work-duo 长期约定（单一事实源 · 校准 2026-09-03）

> 与每日日志冲突以本文件为准；逐日实现细节留 `.workbuddy/memory/2026-*.md`，前端规范见仓库根《前端开发规范.md》。只存「决策约定 + 坑 + 模块边界」，勿搬实现细节。

## 1. 技术栈 / 构建铁律
React19+TS+Vite+**Tauri2**；UI=antd v5（经 `@/components/ui` 封装，禁裸 antd）；样式=Sass（只用 `var(--color-*)`）；图标=lucide-react；Monaco 本地 AMD；路由=HashRouter。**只跑 `npm run typecheck`**，禁 `vite build`/`npm run build`；调试 `npm run tauri`；勿改 `vite.config.ts`。

## 2. 依赖管理
AI 只写 `package.json`，绝不自己装（禁 `npm/pnpm/yarn i`），安装由用户 `pnpm i`。重型库用动态 `import()`+`src/types/shims.d.ts` 兜底。

## 3. 沙箱 EPERM
注入钩子 fail-closed→EPERM。**装/删包**前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；pnpm 损坏→`NODE_OPTIONS= npm install`(managed node v22)。`src/` 删除/改名通常 EPERM→只能新建合规位置+改 import+typecheck，旧文件用户手动删（个别删除可成功，先试 `rm`）。

## 4. 数据持久化
SQL→SQLite `workduo.db`+`src/core/mapper/`（禁组件直写 SQL）。DDL 单一事实源 `init.sql`(仅 `CREATE TABLE IF NOT EXISTS`)+`updater.sql`(ALTER 迁移，`duplicate column` 安全跳过)；**凡引用可能尚不存在列的索引/约束必须进 updater.sql**（否则现有库 CREATE 被跳过→整段 init 崩→列缺失）。`isTauri` 是布尔常量。
Rust 读 SQLite：`app.state::<tauri_plugin_sql::DbInstances>()`→读锁→`DbPool::Sqlite`→`sqlx`(0.8 sqlite+runtime-tokio)；key=`sqlite:workduo.db`，前端须先 `load()`。**Rust 改动本沙箱可 `cargo check`**（工具链 `RUSTUP_HOME=D:/envs/Rust/.rustup CARGO_HOME=D:/envs/Rust/.cargo /d/envs/Rust/.cargo/bin/cargo`，stable-x86_64-pc-windows-msvc；运行态仍需用户 `npm run tauri` 重编译）。
表（14 张，agent 相关）：`agent_info`+refs / `agent_project`(id/name/root_path UNIQUE/is_pinned/is_archived/custom_rules) / `agent_conversation_session`(增 project_id+total_turns+summary_round_count+total_prompt_tokens+total_completion_tokens+tools_tokens) / `agent_conversation_round`(增 raw_messages_json，FK 级联)。新增列：`init.sql`+`updater.sql` 同步。
wd_mem 双轨：任意带 workspace 运行（含自由对话）根目录 `.wd_mem/`（scripts/data/outputs/sessions/{id}.summary.md/project_memory.md），由 `wd_mem.rs` 读写；`load_config` 每次注入复用约定+扫 scripts/data；`context.rs` 对绑定工程再读 project_memory+summary。

## 5. 已移除 / 架构定调
知识库向量化已移除；客户端不跑本地重推理（embedding/重排/LLM 走云端）。LLM 分类 `models.category` 固定枚举，不进 scenario_category 字典。iflytek 三件套+签名 WS（models 增 app_id/api_secret）。工作空间绑定 DB 逻辑全在 TS mapper，路径规范化用 Rust `canonicalize_path`。

## 6. 全局消息
统一 `useNotify()`（=`App.useApp()` message），禁静态 `import {message}`；`<App message={{top:72}}>` 避让 56px 顶栏。`notify.ts` 的 `result({ok,error?})` 成功静默、失败弹 error；仅异常场景弹提示。

## 7. 导航 IA
TopBar 两级胶囊（百宝箱=LLM/MCP/Skill）。路由：`/model-settings` `/knowledge` `/agent-studio`(+`/new` `/:id/edit` `/:id/chat`) `/squads-workspace` `/skill-hub` `/mcp-hub` `/sandbox/python` `/settings`。dashboard/squads 仍为占位骨架。

## 8. 智能体引擎（src-tauri/src/agent/）
命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（**入参为结构体，invoke 须包 `input`/`decision` 键**）。子模块：tools/native/runtime/approval/mcp_adapter/skill_adapter/events/types/commands/context/round_compactor/wd_mem/fs_helper。
**LLM 铁律**：ReAct 每轮仅 1 次流式 `call_llm_stream`，SSE 聚合 delta.content/reasoning(reasoning_content)/tool_calls(按 index 归并)→`StreamOutcome`(含 `usage:(prompt,completion)`，取自 OpenAI `usage`，跨轮累计：写回会话表 `persist_session_tokens` + 经 `agent-task-done` payload 带出前端替代估算)；无 tool_calls→终态一次性 emit；有→进思考面板；**流式空响应回退一次非流式 `call_llm` 兜底**。禁「非流式判断+流式输出」双调用。16 轮熔断、SSE 字节缓冲、reasoning 布尔→`{}` 归一化、外部 MCP/Skill 视为 ReadSafe、原生写类 RequireApproval。
**会话树/压缩**：`agent_project`+多级会话树（GLOBAL/PROJECT）；双表持久化+后台滚动压缩（`raw_messages_json` 协议视图、`summary_round_count` 级联）；`build_request_messages` Slot 顺序 0 系统+custom_rules/1 项目记忆/2 摘要/3..M 活跃轮/M+1 当前；`persist_tools_tokens`(覆盖写,按当前 MCP/Skill 数) 与 `persist_session_tokens`(累加真实 usage)。
**前端 chat.tsx**：三段式；DropdownMenu 用 `createPortal` 到 body（`position:fixed`+`getBoundingClientRect` 逃逸祖先 transform/overflow 裁剪，修复 Pop 偏移）；所有 Pop 菜单项 `icon+文字`；删除操作收进「更多」菜单；项目目录组只显示目录名（hover title 显示路径）；未命名会话首轮完成后用首问命名。思考面板 flex 须 `> *{flex-shrink:0}`+`overscroll-behavior:contain`；历史回显按消息绑定 thought/toolSteps。
**临时移除 Skill/MCP**（内存态，不写库）：`RunAgentTaskInput` 增 disabledSkillIds/disabledMcpIds/disabledMcpToolIds，load_config 映射前过滤，`persist_tools_tokens` 自动下调。
**约束上限**：`MAX_MCP_SERVERS=3/MAX_MCP_TOOLS=10/MAX_SKILLS=3`（draft.ts 单一事实源）。
**日志**：统一 `println!("[agent] ...")`，`sanitize_for_log` 脱敏+`clip(...,5000)`；MCP endpoint 隐藏 query。

## 9. 前端 / 工程铁律
UI 令牌只用 `var(--color-*)`（禁 hex/px）；根容器 `width:100%`（禁 max-width+margin:0 auto）；表单 `autoComplete="off"`、标签禁「中文(English)」混排。Hooks：`useMemo`/`useState` 须在任意 early-return 前无条件执行；派生 state 声明须在 useMemo 前。Popover/Dropdown 逃逸用 `position:fixed`+`getBoundingClientRect`。Tauri capabilities scope 须 `https://*`。编辑含中文/反引号/省略号的源行后必须 re-grep 复核落盘；同文件多 Edit 逐条串行+复核。
