# 目录与命名总则

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
| 接口字段 | 全项目统一 snake_case 或 camelCase | 混用禁止 | |

## 依赖

- 依赖只写在项目清单（`package.json` / `requirements` / `pom` / `Cargo.toml`）。
- 禁止在插件/脚本里 `pip install` 到用户全局环境；走平台声明依赖。
- 大依赖需在 ADR 说明理由。

## 注释与文档

- 注释只写 **WHY**（约束、反直觉、workaround）。
- 公开 API / 契约变更必须同步文档。
- 不写叙述型注释（`// 获取用户`）。
