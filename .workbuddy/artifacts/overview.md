# work-duo 迁移完成总览（Appica + Tailwind → antd v5 + Sass）

## 目标
按用户第三轮指令，对 `work-duo` 全项目做架构迁移：
1. 弃用 Appica UI（含 `@appica/ui-react` / `@appica/icons-react`）
2. 弃用 Tailwind v4 与项目内 `.css`，改用 **Sass（`.scss`）**
3. UI 切换为 **antd v5**
4. 新增开发规范：**tsx 与 scss 严格分离**（组件/页面并列 `index.scss`）

## 已完成
- **设计令牌自维护**：`src/styles/{variables,mixins,layout,root}.scss`（亮 `.light` / 暗 `.dark`，语义色 + 品牌色 + 尺寸，无第三方依赖）
- **UI 封装层** `src/components/ui/`：`Button` / `Card` / `Input` / `Modal` / `Field`(+`FieldLabel`) / `icons`（本地内联 SVG），页面统一从这里取，不直接散用裸 antd
- **主题** `src/core/contexts/ThemeProvider`：antd `ConfigProvider` + `theme.darkAlgorithm`，在 `<html>` 切 `.light`/`.dark`，Redux `themeSlice` 为源，持久化 `work-duo-theme`
- **顶栏胶囊菜单** `TopBar.tsx`：图标改 `@ant-design/icons`（MCP=`NodeIndexOutlined`），其余逻辑（滑动滑块、6 个一级菜单）保持不变
- **NodeCard / WindowControls / ThemeToggle** 等改用 antd + 并列 scss
- **页面** dashboard / agent-studio / squads-workspace / knowledge(列表+详情) / **model-settings** 全部重写，Tailwind 类下沉到 `index.scss`
- **model-settings** 为迁移前唯一未改页面，本次重写：`Card`(`frame="solid"`) + `Button` + `Input` + `Modal` + `Field`，布局移入 `index.scss`

## 关键修复（tsc 报错）
- `Card.variant`：antd 5.29 **无 `filled`**，改为 `frame="solid"` 走 `.app-card--solid` 浅底类
- `Button`：`icon-lg` 比较越界、`rest.variant/rest.size` 引用已解构字段 → 修正
- `NodeCard`：改走封装 `Card`，移除对 antd 直引 `variant="filled"`
- `TopBar`：`PlugOutlined` 不存在 → `NodeIndexOutlined`

## 验证结果
- `tsc --noEmit`：**通过**（EXIT 0）
- `vite build`：**通过**（3322 模块，CSS 15.95 kB，JS 909 kB；antd 体积警告属正常，非错误）
- 视觉浏览器验证：**未完成**——本沙箱 `vite dev` 的 antd dep 预打包卡住，且 `dist/index.html` 被残留 vite/tauri 进程锁定（Windows 占用 → `EPERM` unlink），故用 `--outDir dist-build` 绕过验证。

## 环境提示（给用户）
- 默认 `dist/` 被某运行中的进程锁定，本地 `npm run build` 若报 `EPERM ... dist/index.html`，先结束占用进程（或临时换 outDir）。
- `vite dev` 在本沙箱未能启动（dep 优化挂起），建议你在本地正常 `npm run dev` 查看效果。
- 依赖安装用 `NODE_OPTIONS= npm install`（pnpm corepack shim 已损坏）。
- Sass `@import` 有 deprecation 警告（非错误），后续可迁 `@use`。
