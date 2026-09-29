# kb-eng-standards · 团队工程规范

> 用途：全员规范事实源——目录、命名、栈约定、禁止项。  
> 挂载：几乎所有研发角色；配合 `skill-eng-standards` 做执行清单。

---

# 1. 目录与命名总则

## 目录

| 原则 | 说明 |
|---|---|
| 按功能分目录 | 一个业务模块一个目录；禁止巨型平铺 |
| 入口干净 | 入口文件只做装配，不写业务 |
| 共享层独立 | `components/ui`、`core/mapper`、`utils` 只放可复用能力 |
| 测试同构 | 测试路径能映射到源码路径 |
| 文档就地 | 模块 README 放在模块目录内 |

## 命名

| 类型 | 约定 | 正例 | 反例 |
|---|---|---|---|
| 文件 | kebab-case 或 PascalCase（跟框架） | `user-service.ts` | `Utils2.ts` |
| 组件 | PascalCase | `UserCard` | `userCard` |
| 函数/方法 | 动词开头 camelCase | `getUserById` | `handle`、`doIt` |
| 布尔 | is/has/can/should | `isReady` | `readyFlag` |
| 常量 | SCREAMING_SNAKE 或集中常量对象 | `MAX_PAGE_SIZE` | 魔法数散落 |
| 事件 | domain-entity-action | `agent-task-done` | `evt1` |
| 接口字段 | 全项目统一 snake_case 或 camelCase | — | 混用禁止 |

## 依赖

- 依赖只写在项目清单（`package.json` / `requirements` / `pom` / `Cargo.toml`）。
- 禁止在插件/脚本里 `pip install` 到用户全局环境；走平台声明依赖。
- 大依赖需在 ADR 说明理由。

## 注释与文档

- 注释只写 **WHY**（约束、反直觉、workaround）。
- 公开 API / 契约变更必须同步文档。
- 不写叙述型注释（`// 获取用户`）。

---

# 2. React / WorkDuo 前端铁律

> 优先级：本文件 > 个人习惯。与仓库 `前端开发规范.md` 冲突时以仓库规范为准。

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

---

# 3. Vue3 管理端约定

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
  views/<module>/
  components/
  composables/
  stores/
  api/
  router/
  utils/
```

## 规则

1. 组件库（Element Plus / Ant Design Vue）**必须封装**再用，禁止页面散装覆盖全局。
2. 逻辑超过 ~30 行或被多处使用 → 抽 `composables`。
3. 接口路径/字段对齐契约；禁止组件内手写 URL 拼接散落。
4. 列表页统一分页、加载、错误空态。
5. `vue-tsc --noEmit` 或项目 typecheck 0 error 才算完成。

## 禁止

- Options API 与 Composition API 混写同一文件（新代码一律 setup）
- 全局样式污染（非 scoped 谨慎）
- 在组件里明文存敏感 token 而不走统一封装

---

# 4. Python / Java 后端约定

## Python

| 项 | 约定 |
|---|---|
| 结构 | 按领域分包；入口与库代码分离 |
| 错误 | 边界校验；内部信任约定；不吞异常 |
| 依赖 | 写入项目清单；插件头注释声明 `dependencies` |
| 测试 | `tests/` 对称源码；pytest 可一键跑 |
| 命名 | snake_case；模块短小 |

**禁止**：隐式全局写文件、无超时的网络/子进程、把密钥写进代码。

## Java / Spring

| 项 | 约定 |
|---|---|
| 分层 | Controller / Service / Repository；DTO 与实体分离 |
| 事务 | 服务层；避免循环依赖 |
| 异常 | 统一错误码 + 全局异常处理 |
| 接口 | 与 OpenAPI 契约一致；版本策略明确 |
| 测试 | 单测 + 关键集成测试；`mvn test` 可重复 |

**禁止**：Controller 写业务事务；实体直接当响应体；打印敏感数据。

## 共同

1. 接口变更先改契约再改代码。  
2. 日志可排障：带 requestId / 关键 id，禁止只 log「error」。  
3. 配置与代码分离。  
4. 自测报告进交付包（`plugin-pytest-runner` / `plugin-java-build`）。

---

# 5. Rust / Tauri 客户端约定

## 能力与安全

| 项 | 约定 |
|---|---|
| 能力事实源 | ToolRegistry 注册决定可用工具，prompt 不能替代 |
| 路径 | PathGuard 工作区边界；越界拒绝 |
| 高危命令 | 审批门；白名单优先 |
| 沙箱语义 | Python/Bun 沙箱=环境隔离，**无 Rust 沙箱** |

## 架构纪律

1. 命令注册集中，命名稳定。  
2. 事件只增不改；破坏性变更升版本。  
3. 消息序列不变量：每条 `tool_call.id` 必有结果。  
4. 终态铁律：不挂死、不丢锁、不残留孤儿 run。  
5. 长任务异步 + 可取消。

## 工具链

- 检查用宿主 `cargo`（`plugin-cargo-check` 或 `execute_command` 白名单）。
- 环境定位：`WD_CARGO_BIN` / `CARGO_HOME`。
- 禁止插件拼任意 shell；子命令白名单 + `shell=false`。

## 自检

```text
- [ ] cargo check / test 通过
- [ ] 命令与事件契约文档已更新
- [ ] 无新增高危无审批命令
- [ ] 取消/超时路径有效
```

---

# 6. Git 与提测 / 发布纪律

## 分支与提交

| 项 | 约定 |
|---|---|
| 分支 | `feat/*` `fix/*` `chore/*`；短期存活 |
| 提交 | 一句话 WHY；必要时正文说明影响面 |
| 禁止 | 直接改共享主干；提交密钥、巨型二进制、node_modules |

## PR / 提测

1. 描述含：背景、改动点、自测命令与结果、风险、回滚。  
2. 关联任务/验收 ID。  
3. 自测必须 typecheck/build/test 相关命令通过。  
4. 大改动拆 PR；单一关注点。

## 发布

- 变更说明与版本号同步。  
- DDL 幂等、可回滚。  
- 门禁全绿才出交付包：测试无 Blocker 失败、评审 Blocker 清零。

## 回滚

- 每个发布能说明「怎么退回上一版」。  
- 破坏性变更必须有迁移路径或双写期。
