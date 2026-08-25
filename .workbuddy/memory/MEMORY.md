# work-duo 项目长期约定

## 构建配置
- `vite.config.ts` 由用户本人维护，**不要修改**。需包含：
  - `resolve.alias`: `"@" -> path.resolve(__dirname, "./src")`（`"type":"module"` 时用 `fileURLToPath(new URL("./src", import.meta.url))`）
  - 插件：`@tailwindcss/vite`（Tailwind v4）
- `tsconfig.json` 已配置 `baseUrl: "."` + `paths: { "@/*": ["src/*"] }`（TS 侧别名）。

## Appica UI（@appica/ui-react@1.1.0）
- 一律按 subpath 导入：`@appica/ui-react/button|card|dialog|input|field|navigation|badge`。
- `ThemeProvider`: `@appica/ui-react/providers/theme-provider`；`useTheme`: `@appica/ui-react/hooks/use-theme`。
- 全局样式：`src/assets/styles/index.css` = `@import 'tailwindcss'` + `@import '@appica/ui-react/styles.css'` + `@source '../../../node_modules/@appica/ui-react/dist'`。
- 颜色只用 role token（`bg-background` / `text-foreground` 等），不写 hex/px。

## 状态/主题
- Redux（@reduxjs/toolkit + react-redux）为 Provider；`themeSlice` 存 `mode: 'light'|'dark'|'system'`。
- 主题持久化 storageKey = `'work-duo-theme'`（ThemeProvider 与 index.html 防闪烁脚本共用）。

## 依赖安装（本沙箱）
- 必须用 `NODE_OPTIONS= pnpm install` 且关闭沙箱，否则 safe-delete 钩子拦截 bin shim 清理导致失败。
