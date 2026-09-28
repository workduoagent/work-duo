# Python / Java 后端约定

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
3. 配置与代码分离；环境差异用配置而非分支散落。  
4. 自测报告进交付包（`plugin-pytest-runner` / `plugin-java-build`）。
