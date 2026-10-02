# .workspace —— 跨设备 · 跨编码工具工作区

> 无论在哪台设备、用哪个编码工具（ZCode / WorkBuddy / IDE），打开仓库先读本文件，即可接续干活。
> 点前缀 = 隐藏目录：内容型资产不进编译面、不污染常规代码检索；git 正常追踪（除 `.eval-results/`）。

| 目录 | 用途 | 进 git |
|---|---|---|
| `.memory/` | **工程记忆**：按日期 `yyyy-MM-dd.md` 记当日项目整体进展与结论；`CURRENT.md` 记「当前进行中 / 下一步」 | ✅ |
| `.norms/` | **规范**：前端 / 后端开发规范、提交协作规范（工具只 commit、用户本人 push） | ✅ |
| `.design/` | **定稿设计**：已实施落地的引擎/架构设计文档 | ✅ |
| `.future/` | **版本方案**：各版本需求方案与特性设计稿（规划中 / 未开工） | ✅ |
| `.sys_tool/` | **系统工具**：workduo-mcp（MCP 驱动脚本与技能）、single-agent-capability(-v2) 能力测评套件 | ✅ |
| `.agents/` | **预制 Agent**：可整套导入实例的 Agent 套装（原 docs/Agent市场），按类分子目录 | ✅ |
| `.eval-results/` | **运行产物**：workduo-mcp / capability / squad 等跑案例的结果 | ❌ gitignore |

## 约定（跨工具接续的五条纪律）

1. **干活前**：读 `.memory/CURRENT.md` + 最近 1-2 天的日期记忆文件；动手前过一眼 `.norms/` 对应规范。
2. **收工前**：把今天的进展 / 结论 / 遗留写进 `.memory/<今天 yyyy-MM-dd>.md`，并刷新 `CURRENT.md`。
3. **跑案例**：测评 / 门禁 / 案例结果一律输出到 `.eval-results/<case>-<stamp>/`（脚本默认已指向这里），不入库。
4. **新资产对号入座**：新预制 Agent 包 → `.agents/<分类>/`；新系统工具/脚本 → `.sys_tool/<工具名>/`；新规范条目 → `.norms/` 对应文件；定稿的引擎/架构设计仍放 `docs/`。

## 与其他记忆的关系

- `.workbuddy/` 与各编码工具自己的会话记忆是**工具私有**的；本目录是**项目规范记忆**，跨工具通用。
- 两边冲突时，以 `.memory/` 为准。
