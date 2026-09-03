# work-duo 长期约定（单一事实源 · 校准 2026-09-03）

> 与每日日志冲突以本文件为准；细节时间线见 `.workbuddy/memory/2026-08-*.md` 与 `2026-09-*.md`，前端规范见仓库根《前端开发规范.md》。
> 本文件只存「决策用约定 + 坑 + 模块边界」；逐日实现细节留在每日日志，勿重复搬入。

## 1. 技术栈与构建铁律
React19+TS+Vite+**Tauri2**；UI=**antd v5**(ConfigProvider+darkAlgorithm)，经 `@/components/ui` 封装层调用，禁裸 antd（Checkbox/Popconfirm/Radio/InputRef/Modal 等须从封装层 re-export）；Appica UI/Tailwind v4 已确认弃用。样式=**Sass**(只用 `var(--color-*)` 令牌，不写 hex/px)；图标=lucide-react；Monaco 走本地 AMD 包（非 CDN）；路由=HashRouter。
改完代码**只跑 `npm run typecheck`**，**禁 `vite build`/`npm run build`**(生成 dist* 污染 tauri.conf.json)；调试用 `npm run tauri`；勿改 `vite.config.ts`(`@`→`./src` 保留)。

## 2. 依赖管理（铁律）
**AI 只写 `package.json`，绝不自己跑安装**（禁 `npm install`/`pnpm i`/`yarn`），安装由用户 `pnpm i`。新增依赖先核版本（沙箱 `npm view` 被拦，用 `curl https://registry.npmmirror.com/<pkg>/latest`），再按正确 major 写进 `package.json`。重型库用动态 `import()` + `src/types/shims.d.ts` 兜底。
**装包标准流程**（沙箱曾踩）：本机 pnpm shim 损坏时，在干净临时目录用 `npm_config_cache=<临时> npm install` 装好，再 `cp -rn` 合并进项目 `node_modules`，`package.json` 加该依赖。

## 3. 沙箱 EPERM
注入安全删除钩子 fail-closed→EPERM。**装/删包**前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；pnpm shim 损坏→`NODE_OPTIONS= npm install`(managed node v22)。**`src/` 下删除/改名通常 EPERM**（`rm`/`git rm`/`mv`/`fs.unlink` 全拦，前缀无效）→「文件迁移」只能新建合规位置+改全部 import+typecheck，旧文件由用户手动删；**但实测 2026-09-02 移除 ApprovalModal 时 `rm` 成功（钩子未生效），故删除前先试 `rm`，失败再走手动删**。

## 4. 数据持久化
SQL→SQLite `workduo.db`+`src/core/mapper/`(**禁组件直写 SQL**)；DDL 单一事实源 `init.sql`(幂等)+`updater.sql`(ALTER 迁移，`duplicate column` 安全跳过)。`InitContext.initDB()` 顺序铁律：建表先于 `app_config` 查询（首启先 `initTables` 再读 `first_load` 再 `updateTables`）。KV→plugin-store；`isTauri` 是布尔常量非函数。
**Rust 侧读 SQLite**：`app.state::<tauri_plugin_sql::DbInstances>()`→读锁取 `DbPool`→`match DbPool::Sqlite(p){p.clone()}`→`sqlx`(0.8 sqlite+runtime-tokio) 直查；key=`"sqlite:workduo.db"`，前端须先 `load()` 挂库。**Rust 改动须 `npm run tauri` 重编译**；本沙箱无法编译 Rust，本地 `cargo check` 用 `RUSTUP_HOME=D:/Rust/rustup CARGO_HOME=D:/Rust/cargo`。
**表清单（init.sql，13 张）**：`app_config`(KV 种子) / `models` / `skill_info` / `mcp_info` / `mcp_tool_definition` / `scenario_category`(MCP/SKILL/KB 域字典，LLM 不纳入) / `agent_info` / `agent_mcp_ref` / `agent_skill_ref` / `knowledge_base` / `knowledge_asset` / `agent_conversation_session` / `agent_conversation_round`(FK ON DELETE CASCADE)。
**表新增列铁律**：`init.sql` 加列时**必须**同步在 `updater.sql` 追加 `ALTER TABLE ... ADD COLUMN`，否则存量库落后者报 `no such column`。

## 5. 已移除 / 架构定调（用户决策）
- **知识库向量化(kb-vector) 已于 2026-09-01 整项移除**回滚到 HEAD，未经明确要求不得重建。教训：拒重型原生依赖（lancedb/fastembed/ort，拉长编译+需 protoc）。
- **客户端不做本地重推理**——embedding/重排序/LLM 一律走云端 API，默认否决本地跑模型（除非用户明确要求）。
- **LLM 模型分类不进 scenario_category 字典**：`models.category` 是 text/multimodal/stt/tts/embedding/rerank 固定枚举，直接驱动动态表单，须与代码严格对应（2026-08-29 已从字典还原）。

## 6. 全局消息与通知
统一 `useNotify()`（=`App.useApp()` message），禁静态 `import {message}`；`<App message={{top:72}}>` 避让 56px 顶栏。`notify.ts` 另提供 `result({ok,error?}, ...)` 模式（成功静默、失败弹 error）——core/file 层返回 `{ok,error?}` 结构（如 `KbOpResult`）与之兼容，不依赖 ui 层。**仅异常场景弹提示**（批量/常规成功操作静默）。

## 7. 导航 IA（2026-09-01 校准）
TopBar 两级钻取胶囊菜单。`百宝箱`(treasure) 二级 = **LLM / MCP / Skill**（Python 已移出百宝箱）。
一级路由（`src/core/router`）：`/`(dashboard) · `/model-settings` · `/knowledge`+`/:id` · `/agent-studio`(+`/new` `/:id/edit` `/:id/chat`) · `/squads-workspace` · `/skill-hub`+`/:id` · `/mcp-hub`+`/:id` · `/sandbox/python` · `/settings`。
**Python 归入「设置」页左侧栏「沙箱环境」分组**（路由 `/sandbox/python`，`routeToTopKey` 映射 `'settings'`）；智能体=agent-studio。dashboard / squads-workspace 当前为**占位骨架**（见 §8）。

## 8. 功能模块清单（实现状态）
| 模块 | 页面 / Rust 命令 | 主表 | 状态 | 关键点 |
|---|---|---|---|---|
| 模型 LLM | model-settings | `models` | ✅ | 固定 6 分类驱动动态表单；`tool_calls` 开关；连通性测试走 **plugin-http POST 探测**（CORS 绕开）；厂商 SVG 走 `import.meta.glob` |
| 技能 Skill | skill-hub | `skill_info` | ✅ | 落盘 `<identifier>/SKILL.md`+scripts/references/assets/templates；`instruction`≠`SKILL.md` 两独立字段；Logo=`logo.<ext>` 根目录（无 DB 列）；详情页内置 Monaco 编辑器；ZIP 导入 |
| MCP | mcp-hub | `mcp_info`+`mcp_tool_definition` | ✅ | Rust `mcp.rs` `sync_mcp_tools`/`call_mcp_tool`（Streamable HTTP POST+session-id+SSE 体解析，STDIO 拒绝）；`streamableHttp`=`HTTP`；导入 mcpServers.json（token 类转 Bearer+同名头）；`timeout_sec` 动态 |
| 知识库 | knowledge | `knowledge_base`+`knowledge_asset` | ✅ | **无向量化**；identifier 驱动磁盘目录；`file_count`/`file_size` 反范式聚合(init v6)；MultiFileViewer 按扩展名分发（pdf @react-pdf-viewer v3+pdfjs **v3.11**;docx-preview;xlsx+ag-grid;pptx 走 jszip;md(katex+mermaid);img;audio wavesurfer;video;epub）；PDF 中文本地化+主题跟随 |
| 智能体 | agent-studio | `agent_info`+refs+sessions+rounds | ✅ | 见 §9 |
| Python 沙箱 | sandbox/python | （mamba 环境目录） | ✅ | Rust `mamba_manager`（micromamba sidecar，8 命令，`DEFAULT_ENV=default`/`DEFAULT_PYTHON=3.11`，`$RESOURCES/mamba_root`）；中文路径→ASCII 临时副本+`cwd`；NodeJs 未建 |
| 设置 | settings | `app_config` | ✅ | 左栏：系统设置/记忆存储/安全中心/关于我们/沙箱环境；键 `auto_launch`/`network_proxy`/`workspace_path`/`client_notify`/`memory_enabled`/`session_auto_new`/`imported_memories`/`knowledge_base_path`/`skill_path` |
| Dashboard | `/` | — | ⚠️ 骨架 | 欢迎页+4 统计卡（知识库/智能体/协作小组/模型配置，当前硬编码 0，未接数据） |
| 小分队 | `/squads-workspace` | — | ⚠️ 骨架 | 「多智能体协作车间」，UI 占位，无 DB 表、未实现 |

## 9. 智能体引擎（src-tauri/src/agent/）
命令 `run_agent_task`/`submit_approval_decision`/`cancel_agent_task`（**入参为结构体，invoke 须包进 `input`/`decision` 键**，扁平传参报 `missing required key input`）。子模块 tools/native/runtime/approval/mcp_adapter/skill_adapter/events/types/commands/context/round_compactor；ReAct 16 轮熔断、SSE 字节缓冲（`Vec<u8>` 累积仅处理完整行）、`reasoning` 布尔→`{}` 归一化、外部 MCP/Skill 视为 ReadSafe 不审批、原生写类 RequireApproval。
**LLM 调用铁律（2026-09-03 定调）**：ReAct **每轮仅 1 次 LLM 调用**——统一走流式 `call_llm_stream`，SSE 增量同时聚合 `delta.content`/`delta.reasoning`(含 reasoning_content 别名)/`delta.tool_calls`(按 index 归并)，返 `StreamOutcome`；无 tool_calls→终态一次性 emit 全文（前端 useTypewriter 打字机，落后>200 字自适应追赶），有 tool_calls→content/reasoning 作 status 进思考面板；**流式空响应回退一次非流式 `call_llm` 兜底**（防网关不支持流式 tool_calls）。**禁「非流式判断+流式输出」双调用**（曾致 token 双倍 + 非确定性下 tool_calls 被忽略 → 回答为空 → 历史回显「思考中」）。
**思考面板 flex 陷阱**：`.agent-chat__thinking-body`(flex 列+max-height+overflow:auto) 子项带 overflow 时 `min-height:auto` 计算为 0 → 被 flex-shrink 压缩而非溢出（无滚动条、内容裁剪）；必须 `> * { flex-shrink: 0 }` + `overscroll-behavior: contain`。历史回显 `roundsToMessages` 须解析 `toolCallsSummary`→`toolSteps`（否则工具卡片丢失）。
**attachments 链路（2026-09-03 接通）**：前端 `RunAgentTaskInput.attachments`→Rust 同名 Option 字段→`AgentRuntimeConfig.attachments`→`context.rs::inject_attachments` 把最后一条 user 消息 content 改写为 OpenAI 多模态数组 `[{type:text},{type:image_url}]`（无附件保持字符串）。注意 `AgentRuntimeConfig` 无 serde derive，字段**不可加 `#[serde(default)]`**。
**后端日志约定**：统一 `println!("[agent] ...")`（压缩器 `[Compactor]`），长内容经 `runtime::clip(s,max)` 截断（前 N 字符+原始长度）；覆盖：load_config 汇总 / context 装配各 Slot 体量 / 每轮 LLM 返回摘要（正文+推理+tool_calls 清单）/ 工具参数与结果截断 / raw 回填大小 / 压缩触发判定与新旧摘要大小 / MCP 调用参数与结果。
**双表会话持久化 + 后台滚动压缩（round_compactor.rs）**：轮次表增 `raw_messages_json`(协议视图，Rust 回填无损 restore)、会话表增 `total_turns`+`summary_round_count`(=last_compact_turn)、FK 级联(v11)。`build_request_messages`(Slot0 系统/Slot1 摘要/Slot2..M 活跃轮/Slot M+1 当前；活跃窗=`round_index>summary_round_count`)；`trigger_background_compaction`(`tauri::async_runtime::spawn` 非阻塞，未压缩轮数≥5 触发向前滚动合并 2 轮)；`persist_round_raw`/`bump_session_turns`/`get_pool`。`context.rs` 只读装配；`runtime.rs` 循环后回填 raw+触发压缩。`RunAgentTaskInput`/`AgentRuntimeConfig` 增 `round_id`(前端建轮后透传)；`chat.tsx`/`useAgentSession` 透传 `roundId`。
**tools_tokens 动态重算**：`round_compactor::persist_tools_tokens(app,sid,mcp_count,skill_count)` 每轮按 `(mcp_tools+skill_tools)*300` 覆盖写；中途移除 Skill/停用 MCP 下一轮自动下调（新增则上调）。前端任务结束 `getSession` 重读刷新环形图（Tauri 回写值 / dev 回退 `(toolCount+skillCount)*300`）。token 列名保持 `total_prompt_tokens`/`total_completion_tokens`/`tools_tokens`。
**前端会话页 chat.tsx**：三段式（左会话列表/中消息流/底工具条）；`ToolStepCard`/`ApprovalNotify`(右下角通知,非对话内弹窗)/`ThoughtPanel`（思考过程按**每条消息**绑定 `thought?`/`toolSteps?`，多轮互不串台）；token 环形图 SVG+悬浮 popover；头像+Bot/「我」；真实 SSE 流式；`useTypewriter` 打字机。**Rust 改动本沙箱无法编译**，需用户 `npm run tauri` 重编译确认。

## 10. 前端 / 工程铁律
- **UI 令牌**：只用 `var(--color-*)`，禁 hex/px；tsx/scx 分离；根容器 `width:100%`（禁 `max-width+margin:0 auto` 居中，对齐知识库 §2.9.1）；`height:100%+padding` 必加 `box-sizing:border-box`（否则撑破父级出页面 Y 滚动条）。
- **antd Card 内部 flex**：给 Card 传 className 做内部区块布局时，flex/gap 必须写 `.xxx .ant-card-body`（写在根类无效）。
- **表单**：`autoComplete="off"`；标签禁「中文(English)」混排（纯中文或缩写如 API Key/Top-P/JSON）。
- **Hooks 铁律**：任何内部用 hook 的工厂函数（如 `@react-pdf-viewer` 的 `defaultLayoutPlugin()`）必须在组件顶层**无条件**调用，绝不能放 early-return 之后的 JSX 里（Rules of Hooks 崩溃）；含动态 import 的查看器拆「加载壳+渲染内组件」两层。
- **Blob URL（React18 StrictMode）**：需 revoke 的 Object URL 一律 effect 内创建+同 effect 内 revoke，**禁 useMemo 创建+独立 effect 仅 revoke**（dev 双挂载必失效）；图片直显优先 base64 data URL。
- **Tauri capabilities scope URL**：不能裸写 `*`，须 `https://*` 或带端口 `https://*:*`；fs path 用 `$APPDATA/**` 宏路径不受影响。
- **编辑落盘复核（2026-09-02 事故）**：① 改动含中文/反引号/省略号 `…` 的源行后**必须 re-grep 或 Read 复核落盘**；② Python 移除代码块用 `l.strip()`（非 `l.lstrip()`），移除后立即 typecheck/cargo check；③ 大段删除前先确认 `git show HEAD:` 与目标文件**同源**（工作文件常未提交、超前 HEAD）。
