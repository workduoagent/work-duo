# .agents —— 预制 Agent 套装

可整套导入 WorkDuo 实例的预制 Agent / 小分队资产，按类分子目录。

| 包 | 说明 | 导入方式 |
|---|---|---|
| `软件开发类/` | 研发角色编队：10 Agent + 6 技能 + 13 插件 + 5 知识库 + 4 小分队（编排式/流水线/群聊三种模式各覆盖） | WorkDuo 运行中执行 `python 软件开发类/scripts/import_workduo.py`（幂等，可重复跑） |

## 新增包的约定

1. 目录名即分类名（中文直用），包内保持：`README.md`（怎么组、怎么验收）+ `assets/`（Skill/插件/KB 语料，按 identifier 命名）+ `scripts/import_workduo.py`（导入驱动）+ `generated-*-ids.json`（上次导入实例的真实 id 映射，幂等导入的依据）。
2. 导入一律走 workduo-mcp（`127.0.0.1:18755/mcp`），与 UI 操作同链路、可抽查；小分队无 MCP 创建工具，走 SQLite 直写三表。
3. 更新包内容后重跑导入脚本即可增量生效（按 identifier 先查后建）。
