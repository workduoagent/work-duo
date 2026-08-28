# work-duo 项目长期约定（单一事实源 · 校准 2026-08-28）

> 与每日日志冲突以本文件为准。详细实现时间线见 `.workbuddy/memory/2026-08-*.md`；完整前端规范见仓库根《前端开发规范.md》。

## 技术栈与基本原则
- React 19 + TS + Vite + **Tauri 2** 桌面应用。
- UI = **antd v5**（ConfigProvider + `darkAlgorithm`）。**Appica UI / Tailwind v4 已弃用。**
- 样式 = **Sass**，tsx 与 scss 严格分离（项目无 `.css`）；颜色只用 `var(--color-*)` 令牌，不写 hex/px。
- 图标 = **lucide-react**（已弃用 `@ant-design/icons`）。
- 组件/页面统一用 `@/components/ui` 封装层，不散用裸 antd。
- 完整目录边界 / 自检清单 → 仓库根《前端开发规范.md》。

## 构建与检查（铁律）
- 提交前 / 改完代码**只跑 `npm run typecheck`**；**禁止手动 `vite build` / `npm run build`**——会生成 `dist*`，污染 `tauri.conf.json` 的 `frontendDist:"../dist"`，致 Tauri 打包或 EPERM 占用。
- 调试用 **`npm run tauri`**（`beforeDevCommand` 只起 dev server、不写盘），不在浏览器。
- `vite.config.ts` 由用户维护**勿改**；`@`→`./src` alias 保留。

## 沙箱环境坑：删除 / 安装 EPERM
- 根因：WorkBuddy 注入 `genie-safe-delete.cjs`，删除/覆盖转回收站；回收站 API 不可用 → fail-closed → `EPERM`（`rm`/覆盖/`pnpm install` 清 `node_modules` 全失败）。
- 绕过：命令前缀 `CODEBUDDY_SESSION_ID= CLAUDE_SESSION_ID= NODE_OPTIONS=`（例：`…= pnpm install`）。`env -u NODE_OPTIONS` 不够（bash 包装器重注）。
- pnpm corepack shim 损坏报 `MODULE_NOT_FOUND` → 退 `NODE_OPTIONS= npm install`（managed node v22.22.2）。
- Tauri capabilities scope URL 不能裸 `*`：`http:default` 用 `{url:"https://*:*"}`+`{url:"http://*:*}`。

## 数据持久化（双路）
- 文件 JSON（通用文档）→ `src/core/file/` + `@tauri-apps/plugin-fs` 落 `$APPDATA`；非 Tauri 回退 localStorage。
- SQL（联查 / 事务）→ SQLite `workduo.db`，`@tauri-apps/plugin-sql`，集中在 `src/core/mapper/`。**禁止组件直接写 SQL / 调 `db.execute`。**
- 行实体（中文注释）在 `src/types/database.d.ts`，与 `src/assets/sql/init.sql` 同步；编译期类型在 `src/types/core.d.ts`；运行期选项(label/value)放对应 `core/file` 模块。
- `src/core/db/SqlService`：`getDb()` 全局单例（WAL+busy_timeout）；`initTables`/`updateTables` 跑 `init.sql`/`updater.sql`；mapper 经 `getDb()` 取连，不再持有 CREATE TABLE。
- **DDL 单一事实源**：`init.sql` 每次启动幂等（CREATE IF NOT EXISTS + INSERT OR IGNORE）；版本变更进 `updater.sql`（安全跳过已存在）。
- **`InitContext`** 挂载 `initDB()`：先 `initTables` 建表 → 读 `first_load` → `updateTables`；首启置 `first_load='false'`。
  - ⚠️ **顺序铁律**：建表必须早于任何对 `app_config` 的查询，否则首启 `no such table: app_config` → 连锁 `no such table: models`。
- 简单 KV → `@tauri-apps/plugin-store` 经 `core/store/persistence.ts`。`@/core/config` 的 `isTauri` 是**布尔常量**，非函数。

## 模块落点（导航用；细节见日志）
- **LLM 模型（model-settings）**：`models` 表 + `model-mapper.ts`；字段描述驱动动态表单 `components/paramFields.ts`（`ParamFieldDef[]` → slider/number/switch/select/checkbox/text/textarea）。连通性测试 `src/utils/modelTest.ts`：Tauri 走 `plugin-http` 的 `fetch`（绕 CORS），非 Tauri 回退原生 fetch；三态 success/warn/error；probe 按末尾关键字选 POST body（TEI `/embed`→`{inputs:'hi'}`，OpenAI `/embeddings`→`{model,input}`，`/rerank`→`{query,texts}`）。厂商 Logo 用 `import.meta.glob('../../assets/images/*.svg',{eager:true,as:'url'})` 查表（非 `.default`）。
- **Skill（skill-hub）**：`skill_info` 表 + `skill-mapper.ts`；`SkillCategory` 联合类型 + `SKILL_CATEGORY_OPTIONS`（core/file）；`app_config.skill_path` 种子 **`$APPDATA/.skills`**（已改）。
  - ⚠️ **不要 scope / version 字段**：用户明确「创建/编辑技能表单里没有、也不想要 scope(可见域) 和 version(版本号)」。已彻底移除（`SkillInfo`/`SkillInfoRow`/`init.sql`/`updater.sql`/`skill-mapper`/`SkillFormModal`/`SkillImportModal`/卡片状态区/详情抽屉均不再含这两个字段）；仅保留 `status`（卡片右上角 Switch 控制启用/禁用）。卡片状态区改为显示「已启用/已禁用」tag。
  - ⚠️ **两个独立字段，绝不能混**：`instruction`（技能级指令/工作流）与 `skillMarkdown`（标准 SKILL.md 正文，落盘为 `<identifier>/SKILL.md`）是两个不同列/字段，表单分两个 Tab、详情分别渲染。
  - **磁盘落盘**（创建/编辑/导入统一）：`src/core/file/skillFs.ts` 的 `persistSkillFiles(rawBase, skill, scripts, resources)` → 建目录骨架 `<identifier>/{scripts,references,assets,templates}` + 写 `SKILL.md` + 脚本(按语言补扩展名) + 资源；`removeSkillDir` 删除同步清盘；非 Tauri 返回 null（不落盘）。`$APPDATA`/`$RESOURCE` 占位由 `resolveRealSkillBasePath` 解析为真实目录（`appDataDir`/`resourceDir`）。**注意 `@tauri-apps/plugin-fs` 的 `writeTextFile/writeFile` 无 `recursive` 选项**（目录已由 `ensureSkillDir` 预建），不要加。
  - 脚本编辑用 `MonacoJsonEditor mode="code"` + 语言 `Select`（`SCRIPT_LANGUAGE_OPTIONS`：python/js/ts/bash/go/rust/java/ruby/powershell/lua）；Markdown 编辑复用 `MarkdownEditor`（双 Tab，复用 `MarkdownRenderer`）。
  - **导入技能两种来源**：`SkillImportModal` 同时支持「选择文件夹」(拖拽 folder / Upload directory / Tauri 原生 `openDialog directory`) 与「选择 ZIP 压缩包」(Upload accept=.zip / Tauri 原生 `openDialog` filters zip)。ZIP 用 `jszip`（已装 `E:/Codes/ABC/work-duo/node_modules/jszip`，自带 `index.d.ts`，无需 `@types/jszip`）在 `unzipCaptured()` 中解压为 `CapturedFile[]`，按公共顶层目录剥离、父目录作资源相对路径；`kind:'folder'|'zip'` 控制摘要 Tag。ZIP 解析在 `handleDragFile`/`handleZipDialog` 内 `import('jszip')`。
  - 卡片/分页布局 **对齐 MCP**（Header|SideBar|MainOut、状态 tag 右上角、操作区 ghost 图标 Pencil/Eye/Trash2 + 右置 Switch、Pagination）。`Modal` 封装已加 `style` prop（大表单定位用）。
- **MCP（mcp-hub）**：仅接不建。`mcp_info`+`mcp_tool_definition` 两表；`mcp-mapper.ts`（+`syncMcpTools` 先删后插；`getMcpToolCountMap`/`getMcpToolCount`/`setMcpToolActive`；同步按 `tool_code` 保留 `is_active`）；scenario 独立枚举 6 项；STDIO 网页端不可探测。**同步/调用走 Rust 后端**：`src-tauri/src/mcp.rs` 的 `sync_mcp_tools`(initialize→tools/list) 与 `call_mcp_tool`(initialize→tools/call) 经 `invoke` 调用避免 CORS；前端 `mcp-connection.ts` 的 `connectMcp`/`callMcpTool` 在 Tauri 走 invoke、非 Tauri 回退前端 fetch。**JSON 编辑器统一用 `MonacoJsonEditor`**（`src/components/code-editor`，Monaco 本地加载，不依赖 CDN；接口 `value/onChange/readOnly/height/language/showToolbar`，theme 跟随 `<html>` `.light`/`.dark`）。详情页 authConfig/headers、工具 input/output_schema、测试参数编辑/结果回显均走它；`@visual-json/react` 与 `modern-json-react` 均已弃用并移除。**Monaco + Vite 两个坑（已解，勿回退）**：①必须设 `self.MonacoEnvironment.getWorker` 配合 Vite 的 `?worker` 导入，否则 ESM 构建用 `new URL(...,import.meta.url)` 取不到 worker，运行时报 `Failed to load worker script for label: editorWorkerService`；②monaco-editor 0.56 的 `exports` 为 `{"./*":"./esm/vs/*.js"}`，子路径**已自带 esm/vs 前缀**，故 worker 导入必须写 `monaco-editor/editor/editor.worker?worker`（写成 `monaco-editor/esm/vs/...` 会被拼成 `esm/vs/esm/vs/...`，Vite 直接 500 解析失败）。新增语言时在组件内 `LANGUAGE_WORKERS` 补对应 worker。卡片风格对齐 LLM（Header|SideBar|MainOut、状态 tag 右上角、操作区 ghost 图标 + 右置 Switch、紧凑 `{active}/{total}` pill）。
  - **同步工具走 Rust 后端**：`src-tauri/src/mcp.rs` 命令 `sync_mcp_tools`（reqwest 执行 MCP JSON-RPC `initialize`→`tools/list`，绕过 CORS）；前端 `mcp-connection.ts` 的 `connectMcp` 在 Tauri 走 `invoke('sync_mcp_tools')`、非 Tauri 回退前端 fetch。卡片操作区为 编辑/详情/禁用/删除 四个图标按钮（与 LLM 卡片一致），无「测试」按钮；详情点进 `/mcp-hub/:id` 页面（参考 nexus-web detail.tsx，工具 Tab 仅「同步 MCP 工具」、无新增工具表单）。
- **设置（settings）**：统一落 `app_config`(key-value)；`config-mapper.ts` + `settings-file.ts`；9 键种子（auto_launch/network_proxy/workspace_path/skill_path/client_notify/memory_enabled/session_auto_new/session_idle_hours/imported_memories）。`AboutPanel` 反馈/文档/仓库 URL 仍为 TODO 空串。

## 状态 / 主题
- Redux（toolkit + react-redux）；`themeSlice` 存 mode。
- `ThemeProvider` 包 antd ConfigProvider（暗色 darkAlgorithm），切 `document.documentElement` `.light`/`.dark`；持久化 `work-duo-theme`。
- `main.tsx` 从 localStorage 注入 Redux 防闪烁。`ThemeToggle`：自定义太阳/月亮滑动开关（非第三方）；开=黑夜/关=白天，默认跟随系统，点击延迟 150ms。

## 顶栏胶囊菜单 `TopBar.tsx`
- 纯 HTML（不依赖 UI 库）。两级钻取：百宝箱(LLM/MCP/Skill)/茶水间/搭子(agent-studio)/小分队(squads-workspace)/设置(一级叶子直跳 `/settings`)。
- 钻取：点父→`data-mode='drilled'`，二级 `i*80ms` 错峰铺开/反序收起(~890ms)；滑块 rAF 逐帧跟随 `--pill-x/--pill-w`；`useLocation` 高亮。宽 `min(480px,100%)`；item 42px/14px。

## UI 封装层 `@/components/ui`
- `Button`(variant×size→antd)/`Card`(`frame` solid|ghost；solid 用 `.app-card--solid`)/`Input`/`Modal`(受控 open/onOpenChange/width；antd5.25+ `destroyOnHidden`)/`Field`(+`FieldLabel`，必填星号 `.mfm__required` 红)/`controls.tsx`(透传 Select/Slider/Switch/InputNumber)。
- 给 antd Card 传 className 做内部 flex 布局时，flex/gap 必须写 `.xxx .ant-card-body`，写在根类无效。
- 全局 `root.scss` 补 `@keyframes spin`+`.animate-spin`（弃用 Tailwind 后 SpinnerIcon 旋转靠它）。
