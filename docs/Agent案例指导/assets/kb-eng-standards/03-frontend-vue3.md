# Vue3 管理端约定

## 技术栈

| 维度 | 选型 |
|---|---|
| 框架 | Vue 3 + TypeScript |
| 风格 | `<script setup>` 组合式 API 优先 |
| 状态 | Pinia（跨页面）；组件内用 ref/computed |
| 路由 | vue-router，按模块懒加载 |
| 样式 | SCSS；组件库统一封装后再用 |
| 请求 | 统一 request 封装 + 错误码拦截 |

## 结构

```text
src/
  views/<module>/        # 页面
  components/            # 通用组件（封装层）
  composables/           # 可复用逻辑
  stores/                # Pinia
  api/                   # 接口定义（对齐契约）
  router/
  utils/
```

## 规则

1. 组件库（Element Plus / Ant Design Vue）**必须封装**再用，禁止页面散装覆盖全局。
2. 逻辑超过 ~30 行或被多处使用 → 抽 `composables`。
3. 接口路径/字段对齐 `skill-api-contract`；禁止组件内手写 URL 拼接散落。
4. 列表页统一分页、加载、错误空态。
5. `vue-tsc --noEmit` 或项目 typecheck 0 error 才算完成。

## 禁止

- Options API 与 Composition API 混写同一文件（新代码一律 setup）
- 全局样式污染（非 scoped 谨慎）
- 在组件里 `localStorage` 存敏感 token 明文而不走统一封装
