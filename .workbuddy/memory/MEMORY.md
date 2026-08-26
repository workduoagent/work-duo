# work-duo 项目长期约定

## 技术栈（2026-08-26 全面迁移后）
- React 19 + TypeScript + Vite + Tauri 2 桌面应用。
- **UI 库 = antd v5**（ConfigProvider + `theme.darkAlgorithm`）。**已弃用 Appica UI（`@appica/ui-react` / `@appica/icons-react`）。**
- **样式 = Sass（`.scss`）**。**已弃用 Tailwind v4 与项目内 `.css`。**
- 设计令牌自维护：`src/styles/variables.scss`（亮色挂 `:root`/`.light`，暗色挂 `.dark`）；`root.scss` 用 `@use` 聚合（`@import` 已迁 `@use`，**消除 Dart Sass deprecation 告警**）。

## 构建配置
- `vite.config.ts` 由用户本人维护，**不要修改**。`resolve.alias` `"@"->./src"` 保留。
- 迁移时已**移除 `@tailwindcss/vite` 插件**（无 Tailwind 后不再需要）。
- `tsconfig.json`：`baseUrl:"."` + `paths:{"@/*":["src/*"]}`。

## 开发规范（新增）
- **tsx 与 scss 严格分离**：每个组件/页面配一个并列的 `index.scss`（或 `Name.scss`），在 tsx 里 `import './Name.scss'`；禁止在 tsx 写 Tailwind 工具类。
- 颜色只用令牌变量（`var(--color-*)`），不写 hex/px。
- 页面/组件统一从 `@/components/ui` 取封装组件（见下），不要直接散用裸 antd。

## UI 封装层 `src/components/ui`
- `Button` / `Card` / `Input` / `Modal` / `Field`(+`FieldLabel`) / `icons`（本地内联 SVG，lucide 风格）。
- `Button`：`variant`(solid/soft/ghost/outline/link/text/dashed/filled) + `size`(sm/md/lg/icon-sm/icon-md) 映射到 antd。
- `Card`：`frame="solid"|"ghost"`（**antd 5.29 的 Card.variant 只支持 outlined/borderless，无 filled**；solid 用 `.app-card--solid` 浅底类实现）。
- `Modal`：受控 `open` / `onOpenChange` / `title` / `description` / `footer` / `width`（antd 5.25+ 用 `destroyOnHidden`，`destroyOnClose` 已弃用）。
- `controls.tsx`：透传 antd `Select` / `Slider` / `Switch` / `InputNumber`。

## 数据持久化约定（前端 fs）
- 用户约定：**所有 fs 操作统一写在 `src/core/file/` 目录**，每类数据一个文件（如 `model-file.ts`）：定义数据结构 + 读写接口，供各页面复用。
- 存储位置：`$APPDATA/` 下的 JSON 文件（当前有 `models.json`）；用 `@tauri-apps/plugin-fs` + `@tauri-apps/api/path`（capability 已授权 `$APPDATA/**` 全套 fs 权限）。
- **非 Tauri 环境（浏览器 dev）回退 localStorage**，保证 `npm run dev` 可调试。
- 公共枚举/类型：编译期类型放 `src/types/core.d.ts`（写中文注释）；**运行期选项列表（label/value）放对应 core/file 模块**。
- 注意：`@/core/config` 的 `isTauri` 是**布尔常量**，不是函数。

## LLM 页面（model-settings）结构范式
- 页面入口 `index.tsx` + 子组件 `./components/`（各自配 `.scss`）。
- 分类专属参数用**字段描述驱动动态表单**：`components/paramFields.ts` 定义 `ParamFieldDef[]`，`ModelFormModal` 据此渲染（slider/number/switch/select/checkbox/text/textarea）。新增分类只需改 paramFields + model-file 默认值。

## 状态/主题
- Redux（@reduxjs/toolkit + react-redux）Provider；`themeSlice` 存 `mode:'light'|'dark'|'system'`。
- `src/core/contexts/ThemeProvider`：包 antd `ConfigProvider`（暗色用 `darkAlgorithm`），并在 `document.documentElement` 切 `.light`/`.dark` 类；持久化 storageKey = `'work-duo-theme'`。
- `src/main.tsx` 启动时从 localStorage 注入 Redux，避免首屏闪烁。

## 依赖安装（本沙箱）
- `pnpm` 经 corepack 的 shim 路径损坏（`MODULE_NOT_FOUND`）。改用 `NODE_OPTIONS= npm install`（managed node v22.22.2）。
- `vite build` 若报 `EPERM ... dist/index.html`：是**残留 vite/tauri 进程锁定了该文件**（Windows 文件占用）。本沙箱下 `unlink` 被拦，可 `vite build --outDir dist-build` 绕过验证；根治需先释放占用进程。

## 顶栏胶囊菜单 `src/components/layout/TopBar.tsx`
- 纯 HTML 实现（弃用 Appica Navigation 以避免内部样式层叠冲突）。
- 6 个一级菜单（LLM/MCP/Skill/智能体/小分队/设置），图标用 `@ant-design/icons`（MCP=`NodeIndexOutlined`）。
- 滑动滑块：`useLayoutEffect`+`ResizeObserver`+`document.fonts.ready` 测量选中项几何 → 写 CSS 变量 `--pill-x`/`--pill-w` → transform+width 过渡。
- **已接路由**：`NAV_PATHS` 映射菜单→`ROUTES`（llm→model-settings / agent→agent-studio / squads→squads-workspace），`useLocation` 同步高亮；mcp/skill/settings 建页后补映射即可。
