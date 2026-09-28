# React / WorkDuo 前端铁律

> 优先级：本文件 > 个人习惯。与 `前端开发规范.md` 冲突时以仓库规范为准。

## 技术栈

| 维度 | 选型 | 约束 |
|---|---|---|
| 框架 | React 19 + TS + Vite | strict |
| UI | antd v5 | **必须**经 `@/components/ui`，禁裸用 |
| 样式 | Sass `.scss` | 与 tsx 分离；只用 `var(--color-*)` |
| 图标 | lucide-react | 禁 `@ant-design/icons` |
| 状态 | Redux Toolkit | 仅跨页面才加 slice |
| 路由 | HashRouter | 注册到 `src/core/router` |
| 原生 | Tauri plugins | 统一 `src/core/ipc` |

## 功能写在哪里

- 页面：`src/pages/<module>/index.tsx` + `index.scss`
- 复杂页：`src/pages/<module>/components/`
- 业务组件：`src/components/`（通用）/ 页面目录内（私有）
- 数据：`src/core/mapper`，**组件禁直写 SQL**
- 类型：`src/types/core.d.ts` / `database.d.ts`

## 禁止

1. 裸 antd、禁止混入已弃用 Tailwind/Appica 图标。
2. 在 `components/` 写页面业务。
3. 组件直连 DB / 裸 IPC。
4. 内联样式魔法数颜色（必须走设计令牌）。
5. typecheck 未过就交付。

## 自检

```text
- [ ] 经 @/components/ui
- [ ] scss 令牌
- [ ] mapper 访问数据
- [ ] npm run typecheck 0 error
- [ ] 路由/菜单按需注册
```
