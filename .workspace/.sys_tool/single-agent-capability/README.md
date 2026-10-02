# 单 Agent 能力测评套件（Capability Suite）

> 面向 `src-tauri/src/agent` 单 Agent 处理链路的**可执行用例集**。
> 覆盖 8 大能力维度 + Skill 模块 + 插件模块；MCP 驱动、自动断言、五维评分。
> 生成日期：2026-09-24

## 前置条件

1. **WorkDuo 桌面端运行中**，内建 MCP 可达：`http://127.0.0.1:18755/mcp`
2. 已有至少 1 个 `tool_calls=1` 的 text/multimodal 模型（默认取 DeepSeek-V4.1-Flash 等快模型）
3. Node.js（用系统 `node` 或 `bun` 跑 `.mjs`，纯标准库，零依赖）

## 目录

| 文件 | 作用 |
|---|---|
| `testcases.md` | **完整用例目录**（D1–D8 核心 + SK 技能 + PL 插件），含步骤/断言/证据 |
| `scoring-rubric.md` | **五维打分细则**（0–5 分锚点 + 硬扣分 + 分档） |
| `scoring-sheet.csv` | 人工/半自动填分表（每用例一行） |
| `run_capability_suite.mjs` | **MCP 驱动执行器**（list / env / run / score） |
| `../skills/workduo-mcp/scripts/agent_task_driver.mjs` | 标准驱动库（客户端 / 轮询 / HITL 自动应答 / 轨迹解包） |

## 快速开始

```bash
cd E:/Codes/ABC/work-duo/.workspace/.sys_tool/single-agent-capability

# 0. 看用例清单
node run_capability_suite.mjs list

# 1. 环境探活（工具数 / 模型 / 技能 / 插件）
node run_capability_suite.mjs env

# 2. 冒烟（约 5–10 分钟，跳过 LLM 重型复合任务）
node run_capability_suite.mjs run --suite smoke

# 3. 全量核心链路（D1–D8，约 30–60 分钟）
node run_capability_suite.mjs run --suite core

# 4. Skill 模块（SK1–SK6，多数无 LLM）
node run_capability_suite.mjs run --suite skill

# 5. 插件模块（PL1–PL8，多数无 LLM）
node run_capability_suite.mjs run --suite plugin

# 6. 全量
node run_capability_suite.mjs run --suite full

# 7. 指定用例
node run_capability_suite.mjs run --ids D1-1,D2-1,SK-2,PL-3

# 8. 汇总评分卡（读 OUT 目录 JSON → scorecard.md）
node run_capability_suite.mjs score
```

结果默认写 `.workspace/.eval-results/capability-YYYYMMDD-HHMMSS/`（可用 `OUT=路径` 覆盖）。

## 套件 → 打分维度映射

| 套件 | 用例前缀 | 主打分维度 | 权重 |
|---|---|---|---|
| core / smoke | `D1-*` | 意图分流正确性 | 过程 25% 中的一部分 |
| core | `D2-*` | 规划质量 | 过程正确性 |
| core | `D3-*` | 微 ReAct 执行闭环 | 完成度 30% |
| core | `D4-*` | 工具与安全边界 | 安全可控 15% |
| core | `D5-*` | 校验与证据 | 客观验证率 15% |
| core | `D6-*` | 失败恢复与门禁 | 安全可控 + 过程 |
| core | `D7-*` | 上下文与记忆 | 效率 15% |
| core | `D8-*` | 生命周期与隔离 | 安全可控 15% |
| skill | `SK-*` | Skill 模块 UI 级真实链路 | 完成度 + 留痕 |
| plugin | `PL-*` | 插件 FaaS 全链路 | 完成度 + 安全 |

五维权重与 0–5 分锚点见 `scoring-rubric.md`。自动断言产出的 `autoScore`（0/1）只作客观证据，**最终五维分由评分人按 rubric 在 `scoring-sheet.csv` 打**。

## 约定（与 workduo-mcp skill 同步）

- `agent_get_run_trace` 返回外层 `{"trace":…}`，一律 `traceInner()` 剥一层。
- UI 级工具（`skill_*` / `plugin_*` / `kb_*` / `memory_*` / `agent_ui_*`）回包 `{ok,data}`，驱动 `unw()` 解包。
- 复合任务 `agent_run_task` **必须传 `workspace` 绝对路径**，否则 PathGuard 拒写。
- 无人值守装配 Agent：`planAutoApproveMode:'never'` + `autoToolExecMode:true`。
- 测试 Agent/技能/插件一律 `cap_demo_` / `cap-test-` 前缀；**真实不可逆删除需显式 id**，套件只清理自己创建的 `cap-demo-` 资产。
- 复合任务墙钟基线：简单写文件 40s–4min；等待上限默认 `WD_CAP_WAIT_MS=480000`，慢模型环境调大。**慢 ≠ 死**。

## 与既有 L2 harness 的关系

| | 本套件 | `l2_eval_harness.mjs` |
|---|---|---|
| 焦点 | 单 Agent **处理能力**（意图/规划/ReAct/校验/恢复/上下文）+ Skill/插件模块 | 生态场景（A/B×M/H）+ 并发 + 故障注入三维评分 |
| 用例粒度 | 一维一例，断言链路特征 | 场景任务，断言产物 |
| 评分 | 五维 0–5 + 硬扣 | 高可用/高性能/自愈百分比 |
| 建议 | 发版前能力回归 / 模块验收 | 生态压测 / 长稳 |
