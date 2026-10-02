# 前端开发规范（React 19 + TS + Vite + Tauri2）

> 事实源：本文件与仓库现状冲突时以仓库为准并回改本文件。

## 技术栈与约束

| 维度 | 选型 | 约束 |
|---|---|---|
| 框架 | React 19 + TypeScript（strict）+ Vite | `npm run typecheck` 0 error 才算完成 |
| UI | antd v5 | **必须**经 `src/components/ui` 封装使用，禁裸 antd |
| 样式 | `.scss` 与 tsx 分离 | 颜色/尺寸只用 `var(--color-*)` 等设计令牌，禁内联魔法数 |
| 图标 | lucide-react | 禁 `@ant-design/icons` 与已弃用的 Tailwind |
| 状态 | Redux Toolkit / 页面级 useState | 仅跨页面状态才加全局 slice |
| 路由 | HashRouter | 新页面注册到 `src/core/router` |
| 后端访问 | Tauri invoke / 插件 | 统一走 `src/core/ipc` 与 `@/core/file/*` 封装 |

## 代码放哪里

- 页面：`src/pages/<module>/index.tsx` + `index.scss`；复杂页拆 `components/` 子目录
- 通用组件：`src/components/`（页面私有组件放页面目录内，禁塞进公共目录）
- 数据访问：`src/core/mapper/*.ts`（tauri-plugin-sql 的 SQL 全部在 mapper 层），**组件禁止直写 SQL / 裸 invoke 裸 IPC**
- 类型：`src/types/core.d.ts` / `database.d.ts`
- 富渲染：Markdown 一律经 `src/components/markdown/MarkdownRenderer`（新富块进 `rich-blocks.tsx` 的语言分发，勿自起炉灶）

## 禁止（红线）

1. 裸用 antd 底层组件、混入无关图标库。
2. 在 `components/` 写页面业务、入口文件堆业务。
3. 组件直连 DB / 散落 SQL。
4. 内联样式魔法数颜色。
5. typecheck 未过就交付；`vite build` 分包结构随意改动（懒加载块不得静态引入主包）。

## 自检清单

```text
- [ ] 经 @/components/ui 用组件
- [ ] scss 只用设计令牌、与 tsx 分离
- [ ] 数据访问走 mapper
- [ ] 路由/菜单按需注册
- [ ] npm run typecheck 0 error；涉渲染改动过 npm run build
```
