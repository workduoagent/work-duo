# 前端开发规范（React 19 + TS + Vite + Tauri2）

> 事实源：本文件与仓库现状冲突时以仓库为准并回改本文件。
>
> 本文是前端开发的**唯一规范入口**。原仓库根目录的 `前端开发规范.md` 已于 2026-10-09 并入本文件后删除。

---

## 1. 技术栈与约束

| 维度 | 选型 | 约束 |
|---|---|---|
| 框架 | React 19 + TypeScript（strict + `noUnusedLocals` + `noUnusedParameters`） | `npm run typecheck` 0 error 才算完成 |
| 桌面壳 | Tauri 2 | 路由必须 **HashRouter**（`tauri://` 协议无 SPA fallback） |
| UI | antd v5 | **必须**经 `src/components/ui` 封装使用，禁裸 antd |
| 样式 | `.scss` 与 tsx 严格分离 | 颜色/尺寸只用 `var(--color-*)` 等设计令牌，禁内联魔法数 |
| 图标 | lucide-react + 本地内联 SVG（`src/components/ui/icons`） | 禁 `@ant-design/icons`；禁已弃用的 Tailwind v4 / Appica UI |
| 状态 | Redux Toolkit / 页面级 useState | Redux 仅 `theme` slice；仅跨页面状态才加全局 slice |
| 路由 | react-router-dom v7（`createHashRouter`） | 新页面注册到 `src/core/router/index.tsx` + `paths.ts` |
| 内容渲染 | react-markdown + remark-gfm | 一律经 `src/components/markdown/MarkdownRenderer` |
| 后端访问 | Tauri invoke / 插件 | 统一走 `src/core/ipc` 与 `@/core/file/*` 封装 |
| 路径别名 | `@/*` → `src/*` | 见 `tsconfig.json` 与 `vite.config.ts` |

---

## 2. 代码放哪里

| 内容 | 位置 |
|---|---|
| 页面 | `src/pages/<module>/index.tsx` + 并列 `index.scss`；复杂页拆 `components/` 子目录 |
| 通用 UI 组件 | `src/components/ui/`（antd 之上封装，从 `index.ts` 导出） |
| 业务组件 | `src/components/<domain>/`；**页面私有组件放页面目录内，禁塞进公共目录** |
| 数据访问 | `src/core/mapper/*.ts`（SQL 全部在 mapper 层），**组件禁直写 SQL / 裸 invoke** |
| 领域类型与落盘 | `src/core/file/`（各领域一个文件，含Tauri/localStorage 双路读写） |
| KV 配置 | `src/core/store/persistence.ts` 的 `loadConfig` / `saveConfig`（自带内存回退） |
| 类型 | 编译期枚举 → `types/core.d.ts`；DB 行 → `types/database.d.ts`；运行期选项 → `core/file` |
| 富渲染 | 一律经 `MarkdownRenderer`；新富块进 `rich-blocks.tsx` 的语言分发，勿自起炉灶 |
| 纯函数工具 | `src/utils/`（`format.ts` / `logger.ts` 等），**禁 `console.log` 裸用** |
| 全局常量 | `src/core/config/`（`APP_NAME` / `isTauri` / `API_BASE`） |

---

## 3. 数据层规范

### 3.1 DDL 单一事实源

- 全部建表语句写在 `src/assets/sql/init.sql`，版本变更写在 `updater.sql`（幂等重放）
- **mapper 内禁止持有 `CREATE TABLE`**
- 迁移机制：按 `PRAGMA user_version` 与 `init.sql` 头部 `SCHEMA_VERSION` 判版本 → 成功才封版，**失败不封版、下次重试**

### 3.2 🔴 DDL 变更必查 mapper 三要素（用户红线）

任何 `ALTER TABLE ADD COLUMN` 或改列后，**`tsc` 查不出** SQL 占位符错位，必须人工核对每个 INSERT 的三要素：

1. 列清单
2. `VALUES` 的 `?` 数量
3. 参数数组长度

三者必须**相等且顺序一致**。

- 漏补占位符 → 报 `N values for M columns`
- 位置串列 → 错误值写进错列（曾把 `created_at` 串填成 `off`）
- 全项目仅 `src/core/mapper/agent-mapper.ts` 一处 `agent_info` upsert（同一语句管新建+编辑），动该表列必查；其它表同理grep 全 mapper

### 3.3 其他数据层约定

- SQL 行实体定义在 `src/types/database.d.ts`，与 DDL 保持同步
- 异构参数用 JSON 字符串落单列（如 `models.config`），避免频繁改表
- 占位符用 `?`，参数走数组绑定（防注入）
- 时间统一用 epoch 毫秒整型，与 ISO 字符串在 mapper 层互转
- 环境兼容：mapper 内统一 `if (!isTauri)` 回退 `localStorage`

---

## 4. 禁止（红线）

1. 裸用 antd 底层组件、混入无关图标库。
2. 在 `components/` 写页面业务、入口文件堆业务。
3. 组件直连 DB / 散落 SQL。
4. 内联样式魔法数颜色。
5. typecheck 未过就交付；`vite build` 分包结构随意改动（懒加载块不得静态引入主包）。
6. **静态 `import { message } from 'antd'`** —— 必须走 `useNotify()`（详见 §5.2）。
7. **表单输入框不设 `autoComplete="off"`** —— 详见 §5.1。
8. **为根容器设 `max-width` + `margin: 0 auto`** —— 详见 §6。

---

## 5. 交互与文案

### 5.1 表单交互

- 所有表单输入框（经 `@/components/ui` 的 `Input`）**必须显式 `autoComplete="off"`**，禁浏览器/ 密码管理器注入自动填充与黄色高亮。新建/编辑类弹窗（知识库、技能、MCP 等）统一遵守。

### 5.2 全局消息提示

- 统一走 `src/components/ui/notify.ts` 的 `useNotify()`（内部取 `App.useApp()` 的 `message` / `notification` / `modal`，跟随主题、避让顶栏）。
- 🔴 **禁止静态 `import { message } from 'antd'`** —— 静态 `message` 脱离 `<App>` 上下文，会导致主题错位、定位偏移（被顶栏遮挡）、与统一美学不一致。
- 业务结果提醒统一用 `const { result } = useNotify()` 的 `result(res, okText, failPrefix?, silentOk?)`：
  - `silentOk=true` 成功静默（写盘 / 删除等副作用操作成功后不弹 toast）
  - `silentOk=false`（默认）弹 `success(okText)`，用于用户主动触发的反馈（如手动刷新）
  - 失败一律弹 `error` 并带完整文案

### 5.3 文案规范

- 🔴 **UI 文案禁止「中文（English）」混排标签**：要么纯中文，要么纯英文缩写（`ID` / `URL` / `KB`）。
- 禁止 `唯一标识（identifier）`、`场景分类（scenario）` 这类写法。英文缩写直接用，无需包裹中文。

---

## 6. 布局规范

### 6.1 页面根容器全宽（充分利用屏幕空间）

- 所有一级页面（`model-settings` / `mcp` / `skill-hub` / `knowledge` 等）的**根容器类**（`.ms` / `.mcphub` / `.skillhub` / `.kb`）必须 `width: 100%`。
- 🔴 **禁止为根容器设置 `max-width` + `margin: 0 auto` 居中限制** —— 桌面端大屏下会居中留白，右侧大片空间被浪费。
- 需要限宽的应是**内容/控件本身**（描述文案、卡片、弹窗、输入框），而非整个页面画布。子元素需要限宽时单独给它设，不要上提到根容器。
- 卡片网格统一 `grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))`；侧栏固定列宽（如 `220px`），主区 `1fr` 占满剩余空间。
- 新建页面默认：根容器 `width: 100%` + 内容区 `padding` + 卡片/控件按需限宽。

### 6.2 主题

- 主题真源是 Redux `themeSlice`（`light` / `dark` / `system`）；`ThemeProvider` 把解析结果反映到 `<html>` 的 `.light` / `.dark` 类并驱动 antd 算法。
- 切换统一走 `useTheme().setTheme()`；自定义组件靠 `.light` / `.dark` 令牌自动适配。
- 🔴 禁新增另一套主题方案；禁直接改 `document.documentElement` 的 class。

---

## 7. 依赖与构建

- `vite.config.ts` 由维护者管理，**不要修改**；`resolve.alias` 的 `@` 映射保留。
- 新增依赖需评估；**Appica UI 与 Tailwind v4 已明确弃用**，不要重新引入。
- 包管理优先 `pnpm`。
- **重型前端库必须动态 `import()` 懒加载** + `shims.d.ts` 补类型。
- **AI 协作约定**：AI 助手只负责把新增依赖登记进 `package.json`，**绝不自行执行 `pnpm i` / `npm install`**（沙箱内安装有网络/锁文件非确定性副作用，且维护者需亲自掌控 `node_modules` 与锁文件）。

---

## 8. 检查与验证

### 8.1 日常流程

```bash
npm run typecheck    # = tsc --noEmit，唯一强制门禁，必须 EXIT 0
npm run tauri        # tauri dev：带原生壳，完整 IPC / fs 能力，看效果用这个
```

- 🔴 **严禁在调试环节跑 `vite build` / `npm run build`**：`tauri.conf.json` 的 `frontendDist: "../dist"` 只认 `dist`，手动 build 或 `--outDir` 衍生的 `dist*` 目录会污染解析、可能被打包进安装包，或造成 `EPERM ... dist/index.html` 占用类报错。
- `vite build` 仅在正式打包时由 `tauri build` 经 `beforeBuildCommand` 自动触发。
- 浏览器 `npm run dev`（端口 1420）仅作无原生能力时的兜底调试，**不是验收手段**。

### 8.2 零告警原则

用户**零容忍**任何报错或告警：

- `tsc` 不得出现 error 或 warning
- Sass 用 `@use` 替代 `@import` 消除 deprecation
- dev server 里的 `Cannot apply` / `Cannot resolve` / `unknown utility` 类告警需修正用法，**不靠 `--silent` 掩盖**
- 🔴 **不要为了消除告警去跑 `vite build`** —— 会触发 §8.1 的 `dist*` 污染问题

---

## 9. 提交前自检清单

```text
- [ ] 新页面已在 core/router/index.tsx + paths.ts 注册；需进菜单已改 TopBar 的 MENUS
- [ ] 组件/页面均有并列 .scss，tsx 中已 import；tsx 内无 Tailwind 类、无内联颜色/像素
- [ ] 颜色/尺寸全部走 var(--color-*) / var(--radius-*) 令牌
- [ ] 一级页面根容器 width: 100%，无 max-width + margin: 0 auto 居中限制
- [ ] UI 组件全部来自 @/components/ui，无裸 antd；图标来自 lucide-react 或 ui/icons
- [ ] 持久化逻辑在 core/file/ 或 store/persistence.ts，并做了 isTauri 回退
- [ ] 数据访问走 core/mapper，无组件直写 SQL
- [ ] 跨页状态进 Redux，页面局部状态用 hook/useState
- [ ] 类型分层正确：枚举 core.d.ts、DB 行 database.d.ts、运行期选项 core/file
- [ ] 消息提示全部走 useNotify()，无静态 import { message } from 'antd'
- [ ] 表单输入框均设 autoComplete="off"
- [ ] UI 文案为纯中文或英文缩写，无「中文（English）」混排
- [ ] hover 效果无位移/缩放
- [ ] 变更表结构时：DDL 已同步 + 已 grep 所有 INSERT INTO <表> 核对三要素
- [ ] 新增依赖只写进 package.json，未自行跑安装命令
- [ ] npm run typecheck EXIT 0，无错误无告警
```

---

## 附：推荐参照范式

| 维度 | 范例 |
|---|---|
| 页面 | `src/pages/model-settings/`（index.tsx + components/ + index.scss + `paramFields.ts` 字段驱动动态表单） |
| 数据层 | `src/core/file/model-file.ts`（结构 + 选项常量 + Tauri/localStorage 双路读写 + 幂等 upsert） |
| IPC | `src/core/ipc/`（命令名集中 + `invokeCommand` 统一封装） |
| UI 封装 | `src/components/ui/`（antd 之上加 frame/variant 映射与 `.app-*` 类名） |
