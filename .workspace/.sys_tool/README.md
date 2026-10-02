# .sys_tool —— 系统工具

跨工具共用的系统级脚本与测评套件。

| 工具 | 说明 | 入口 |
|---|---|---|
| `workduo-mcp/` | WorkDuo 内建 MCP Server（`127.0.0.1:18755/mcp`）的标准驱动：任务驱动库 / 全模块审计 / 意图探针 / 契约探针 / L2 测评 / 小分队回归 / 发布门禁 | `npm run squad:eval` / `squad:gate` / `release:gate`，或直接 `node scripts/<脚本>.mjs` |
| `single-agent-capability/` | 单 Agent 能力测评套件 v1（8 大维度 + Skill 模块） | `node run_capability_suite.mjs` |
| `single-agent-capability-v2/` | 能力测评 v2（55 场景用例 + E 系列旗舰串联） | `node run_capability_suite.mjs` |

- 测评/门禁结果一律输出到 `../.eval-results/`（gitignore，不入库）。
- 各脚本的路径引用已随 2026-10-02 工作区重组统一更新；新增脚本请勿硬编码 `docs/` 旧路径。
