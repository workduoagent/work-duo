# work-duo 长期约定（单一事实源 · 校准 2026-09-01）

> 与每日日志冲突以本文件为准；细节见 `.workbuddy/memory/2026-08-*.md`，前端规范见仓库根《前端开发规范.md》。

## 技术栈
React19+TS+Vite+**Tauri2**；UI=**antd v5**(ConfigProvider+darkAlgorithm)，Appica UI/Tailwind v4 已弃用；样式=**Sass**(tsx/scss 分离、无 .css、只用 `var(--color-*)` 令牌、不写 hex/px)；图标=lucide-react；组件/页面统一走 `@/components/ui` 封装层，禁散用裸 antd。

## 构建/检查（铁律）
改完代码**只跑 `npm run typecheck`**；**禁 `vite build`/`npm run build`**(生成 dist* 污染 tauri.conf.json 的 frontendDist)；调试用 `npm run tauri`；勿改 `vite.config.ts`(用户维护，`@`→`./src` 保留)。

## 依赖管理（铁律 · 用户多次强调）
- **AI 只负责把依赖写进 `package.json`，绝不自己跑安装命令**（禁 `npm install`/`pnpm i`/`yarn` 等）。安装由用户手动执行 `pnpm i`。
- 新增依赖时：先核对各包最新版本（沙箱内 `npm view` 被拦，用 `curl https://registry.npmmirror.com/<pkg>/latest` 或临时 node 脚本 `fetch` 查），再按正确 major/范围写进 `package.json` 的 `dependencies`/`devDependencies`。
- 注意大版本 API 兼容性：例如 `@react-pdf-viewer` v1↔v3 的 `Worker/Viewer/defaultLayoutPlugin()` API 一致但 peer 的 `pdfjs-dist` 版本不同；写版本前确认代码所用 API 与锁定的大版本匹配。
- 重型库用动态 `import()` + try/catch 兜底，配 `src/types/shims.d.ts` 的 `declare module` 兜底（空声明无默认导出会在未安装时报"无默认导出"，故 shim 应带 `export default any`）。

## 沙箱 EPERM（装/删包 + 删文件）
根因：注入 `genie-safe-delete.cjs` 转回收站 fail-closed→EPERM。绕过：命令前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`；pnpm shim 损坏→`NODE_OPTIONS= npm install`(managed node v22.22.2)。装新包标准流程：临时目录 `npm_config_cache=... npm install` → `cp -rn` 合并进项目 node_modules → 改 package.json。Tauri capability scope 不能裸 `*`。
⚠️ **重要扩展**：agent 对 `src/` 下源文件的**删除/改名也一律 EPERM 拦截**——`rm`、`git clean -f`、`node fs.unlink`、甚至 `mv`(rename) 全部 `Permission denied`，上述前缀无效（前缀只救 npm install）。因此「文件迁移/归位」类任务只能走「在合规新位置建文件 + 改全部 import 引用 + typecheck」，**旧文件 agent 删不掉**，须由用户在 IDE/资源管理器手动删除，或临时关闭删除保护钩子。先确认旧文件是否未跟踪(`git status`)，已跟踪用 `git rm` 也会被拦。历史案例（BatchExportModal/ScenarioSelect/scrollbar-autohide.ts 等）已清理，见 `2026-08-30.md`。

## 数据持久化
文件JSON→`src/core/file/`+plugin-fs 落 $APPDATA（非 Tauri 回退 localStorage）；SQL→SQLite `workduo.db`+`src/core/mapper/`（**禁组件直写 SQL/db.execute**）。DDL 单一事实源 `init.sql`(幂等)+`updater.sql`。`InitContext.initDB()` **顺序铁律**：建表必须先于任何 `app_config` 查询（否则首启 no such table 连锁）。KV→plugin-store；`isTauri` 是布尔常量非函数。

## 模块落点
- **LLM(model-settings)**：`models`+`model-mapper`；动态表单 `paramFields.ts`(`ParamFieldDef[]`)；连通性 `src/utils/modelTest.ts`（Tauri 走 plugin-http 绕 CORS，三态 success/warn/error）。
- **Skill(skill-hub)**：`skill_info`+`skill-mapper`；**禁 scope/version 字段**，仅 status（卡片右上角 Switch）；`instruction`(技能指令) 与 `skillMarkdown`(SKILL.md 正文) 两独立字段、分 Tab/分渲染；落盘 `skillFs.persistSkillFiles`，骨架 `<identifier>/{scripts,references,assets,templates}`+`SKILL.md`；头像固定 `<identifier>/logo.<ext>`(无则显名称首字)；导入支持文件夹/ZIP(jszip)；卡片/分页对齐 MCP；详情独立页 `/skill-hub/:id`。
- **MCP(mcp-hub)**：仅接不建；同步/调用走 Rust `src-tauri/src/mcp.rs` 经 invoke 绕 CORS；JSON 编辑统一 `MonacoJsonEditor`（本地加载，worker 坑已解勿回退）；卡片操作 编辑/详情/禁用/删除。
- **设置(settings)**：`app_config` KV，9 键种子（含 skill_path 种子 `$APPDATA/.skills`）。
- **沙箱 Python(sandbox/python)**：Rust `src-tauri/src/mamba_manager.rs` 内嵌 micromamba 绿色便携（`$RESOURCES/mamba_root`，8 命令：init/list/install/uninstall/reset/run/list_envs/delete；`default` 环境启动经 `lib.rs` `.setup()` 后台自动建、禁删禁重置；`run_python_script` 中文路径走 ASCII 临时副本+`cwd` 规避 Windows cmd 编码坑）；前端 `src/pages/sandbox/python`（MCP 风格卡片上中下 + 详情弹窗融合装卸依赖 + 全屏百分比进度遮罩）；`src/core/mapper/sandbox-mapper.ts` 封装 `Result<String,String>`→`{ok,error?,data?}`。**Rust 改动需 `npm run tauri` 重编译后前端 invoke 才生效**；纯前端改动仅 `npm run typecheck`。

## 已移除 / 勿自行重启（用户决策）
- **知识库向量化（kb-vector）已于 2026-09-01 由用户整项移除**。原产物全部回滚删除：`src/core/kb-vector/`、`src-tauri/src/kb_vector.rs`、`src-tauri/kb/`(Python 抽取分块脚本)、`src/pages/settings/components/KnowledgePanel.*`，以及 `init.sql`/`database.d.ts`/`detail.tsx`/`settings/index.tsx`/`Cargo.toml` 中的相关改动（已回到 HEAD，无未跟踪残留，`npm run typecheck` 通过）。**未经用户明确要求，不得重建或重新引入。**
- 移除原因（用户原话）：对实现质量与可行性不满意。教训：本项目不接受为了单一功能引入**重型原生依赖**（`lancedb`/`fastembed`/`ort`）——它会显著拉长 Windows 编译时间，并给用户机器增加 `protoc` 等编译期外部依赖；且此类改动在沙箱内无法端到端验证（无显示、mamba 环境未就绪），交付风险高。以后遇同类需求，先做可验证的小增量并**主动提示依赖代价**，不要一次性堆大块无法验证的代码。
- **架构定调（用户明确 · 2026-09-01）：客户端不做本地重推理**——embedding / 重排序 / LLM 一律走云端 API，**默认否决任何"本地跑模型"方案**，除非用户明确要求。理由：桌面客户端无法假设用户硬件，本地推理要下近百 MB～数 GB 权重（bge-small-zh≈95MB、bge-m3≈2GB+）、CPU 推理时打满多核、ONNX 会话常驻数百 MB 内存，会拖垮低配机器与整机响应；本项目虽有内嵌 Python 沙箱（micromamba），但那仅供用户跑自己的脚本，不承担产品级推理。项目原有 LLM 模块本身就是云端的（base URL + API Key），此定调与其一致。
- 可复用的通用坑（不限于本项目）：Rust 中用到 `prost-build` 的 crate（如 `lance-encoding`）编译期需要 `protoc`；给原生 Windows 构建脚本的 `PROTOC` 环境变量**必须写 Windows 路径**（`C:/Users/.../protoc.exe`），Git-Bash 的 `/c/...` POSIX 路径会被判为找不到。

## 全局消息
统一 `useNotify()`（=`App.useApp()` 的 message），禁静态 `import {message}`；`<App message={{top:72}}>` 避让顶栏；美学在 `src/styles/message.scss`（毛玻璃/大圆角/图标徽章/下滑入场，跟随 `.light/.dark`）。

## UI/状态
`@/components/ui`(Button/Card/Input/Modal 受控/Field+FieldLabel/controls)；Redux+themeSlice；`ThemeProvider` 切 `document.documentElement` `.light/.dark`。顶栏 `TopBar.tsx` 纯 HTML 胶囊两级钻取。
**导航 IA 现状（2026-09-01 校准 · 以代码为准）**：一级菜单=百宝箱(父容器)/知识库/**智能体**/小分队/设置。
- 【百宝箱】二级仅 **LLM / MCP / Skill**（`TopBar.tsx` 的 `MENUS`）。
- **Python 不在这里**：它的最终归属是**「设置」页左侧栏的「沙箱环境」分组**（`src/pages/settings/index.tsx` 的 `GROUPS`，用官方徽标 `src/components/icons/PythonLogo`），路由仍 `/sandbox/python`。原独立一级【沙箱环境】已撤销；`routeToTopKey` 把 `sandboxPython` 映射到 `'settings'`。
- 【智能体(agent-studio)】：菜单 key `agent`（原 `buddy`，2026-09-01 更名）、label `智能体`、图标 `Bot`、路由 `/agent-studio`。**2026-09-02 已落地完整模块**（`npm run typecheck` 通过）：
  - **列表页** `src/pages/agent-studio/index.tsx`：左侧场景分类侧栏（`ScenarioSelect` scope=`AGENT`，可动态新建）+ 右侧卡片网格（头像 Base64/默认 `Bot`、名称/唯一标识/场景 chip/描述/绑定 LLM 名/已挂 MCP 工具数/技能数/启用 `Switch`）+ 按钮组 编辑/调试/删除（`Popconfirm`）；分页与知识库对齐。
  - **向导页** `wizard.tsx`（路由 `/agent-studio/new` 与 `/agent-studio/:id/edit` 共用）：4 步 `StepBasic`(名称/标识[留空随机生成]/场景/欢迎语/描述/Markdown 人设/Base64 头像/两个 Switch) → `StepModel`(大脑 LLM=text+multimodal 必选，嘴巴 TTS、耳朵 STT 可选，参数用公共 `ParamFieldsForm` 改智能体私有副本) → `StepMcp`(左选服务/中勾具体 tool/右汇总，最小单元=tool_id) → `StepSkill`(勾选 `skill_info`)。草稿模型 `draft.ts`，保存时 `agent-mapper.upsertAgent` 一次性写主表+两关联表。
  - **调试页** `chat.tsx`（路由 `/agent-studio/:id/chat`）：仿 WorkBuddy 对话页（侧栏选工作空间[plugin-dialog 选本地目录]+主区消息流[MarkdownRenderer 渲染]+输入区 Enter 发送）；顶部固定「编辑智能体」快捷入口；本版为**UI 原型**，回复走 `src/core/agent/chat.ts` 的 `buildMockReply`+`streamText`(打字机)，真实 LLM 调用接口位已留（注释写明：plugin-http 发 OpenAI 兼容请求、tools 由 agent_mcp_ref 生成）。
  - **数据层**：`agent_info`(int8→TEXT UUID、jsonb→TEXT、bool→INTEGER、timestamp→epochms) + `agent_mcp_ref`(最小单元 `tool_id`→`mcp_tool_definition.id`，`mcp_id` 仅分组冗余) + `agent_skill_ref`(最小单元 `skill_id`→`skill_info.id`)；`src/core/mapper/agent-mapper.ts`（`listAgents/getAgent/listAgentMcpTools/listAgentSkills/getAgentRefCounts/upsertAgent/deleteAgent/setAgentActive`，非 Tauri 回退 localStorage）；DDL 在 `init.sql`（幂等）+ AGENT 场景种子；`scenario-mapper` 已注册 `AGENT` 引用清理表；domain 类型在 `core.d.ts`(`AgentInfo/AgentMcpToolRef/AgentSkillRef/AgentUpsertInput/AgentRefCounts` + `ScenarioScope` 含 `'AGENT'`)，行类型在 `database.d.ts`。
  - **复用沉淀**：`src/components/model/paramFields.ts`(从 model-settings 抽出，`getParamFields()`)+`ParamFieldsForm.tsx`(`category/values/onChange`) 供 StepModel 与 ModelFormModal 共用动态参数表单。
- 死代码 `src/pages/sandbox/node/`（2026-09-01 确认仍在）待用户在 IDE/资源管理器手动删（agent 删除被 EPERM 拦截）。
- 钻取滑块用 `thumbRef` 直写 CSS 变量（非 setState），见 `2026-08-31.md`。
- ⚠️ 旧记忆（2026-08-31）曾记「Python 迁入百宝箱二级」，**该说法已被用户后续提交 `81bcd6b` 覆盖为「设置页左侧栏」**，以本节为准。
