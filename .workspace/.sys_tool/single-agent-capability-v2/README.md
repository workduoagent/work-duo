# 单 Agent 能力测评套件 v2（Capability Suite v2）

> `.workspace/.sys_tool/single-agent-capability`（v1）的二次补充与扩展：从「引擎单点能力」走向**「真实工作场景下的单智能体整体编排」**。
> MCP 驱动、runner 端独立 ground-truth、五维评分。创建：2026-09-27（由 ZCode 依用户要求设计实现）。

## 覆盖面（55 例 / 11 系列）

| 系列 | 场景 | 用例数 | 特点 |
|---|---|---|---|
| C | 对话与交互 | 6 | 多轮指代/长文附件摘要/JSON 结构化/幻觉对抗/风格约束/file 附件 |
| K | 编码任务 | 6 | **复用 workduo-mcp L2 seeds 真实缺陷项目** + TDD + 回归绿 + 评审不改码 |
| O | 办公任务 | 5 | Excel/PNG 产物契约（魔数校验）+ 纪要转待办 + 周报 + 商务邮件 |
| T | 数据处理 | 5 | **runner 端独立重算比对**（不信任模型自报）+ 清洗/聚合/对账/浮点陷阱 |
| M | 记忆与个性化 | 4 | 跨会话偏好/更新冲突/forced 双轨/蒸馏候选 |
| B | 知识库 RAG | 5 | 事实问答/多库归属/标签辅助/溯源/更新即生效 |
| P | 插件深度 | 5 | **Agent 自助装配插件**/参数契约/超时契约/多参复用编排 |
| S | 技能编排 | 3 | 技能工作流服从/导出导入闭环/双技能择路 |
| E | **整体编排旗舰** | 6 | 经营简报全链/跨 run 项目推进/回滚恢复/附件评审流/无人值守/记忆驱动偏好 |
| X | 边界与对抗 | 5 | 提示注入/沙箱离线纪律/越权删除诱饵/超长指令/幂等 |
| N | 模块契约快验 | 5 | 全部无 LLM 秒级，可挂 CI |

## 快速开始

```bash
cd E:/Codes/ABC/work-duo/.workspace/.sys_tool/single-agent-capability-v2

node run_capability_suite_v2.mjs list                  # 用例清单
node run_capability_suite_v2.mjs env                   # 探活（工具数应为 84）
node run_capability_suite_v2.mjs run --suite quick     # 无 LLM 快验 ~1 分钟
node run_capability_suite_v2.mjs run --suite smoke     # 冒烟 ~15 分钟
node run_capability_suite_v2.mjs run --suite e2e       # 旗舰编排 ~30–60 分钟
node run_capability_suite_v2.mjs run --suite full      # 全量 55 例
node run_capability_suite_v2.mjs run --ids E9-1,T4-1   # 指定用例
node run_capability_suite_v2.mjs score                 # 评分卡（读 OUT）
node run_capability_suite_v2.mjs sheet                 # 重新生成 scoring-sheet.csv
```

结果写 `.workspace/.eval-results/capability2-<ts>/`；工作空间按用例隔离于 `eval-workspace/capability2/<caseId>/`。

## 前置与可调环境变量

- WorkDuo 运行中（`127.0.0.1:18755/mcp`，84 工具）；≥1 个 `tool_calls=1` 模型。
- `CAP2_MODEL_ID` 指定模型（默认自动挑 multimodal；**实测建议 DeepSeek-V4.1-Flash**）。
- `CAP2_WAIT_MS` 终态等待上限（默认 480s，**慢 ≠ 死**）；`CAP2_TOKEN_BUDGET_SIMPLE` 纯问答预算（默认 8k）。
- `OUT` / `CAP2_WS_ROOT` 覆盖结果与工作空间根目录。

## 与 v1 的关系

| | v1 | v2 |
|---|---|---|
| 焦点 | 引擎单点能力（intent/planner/verifier/recovery…，映射到源码） | 场景化编排（对话/编码/办公/数据/插件/技能/RAG/对抗） |
| 数据核对 | 磁盘穿透 + reply 关键词 | + **runner 独立重算** + **二进制魔数**（不信任自报） |
| 出题源 | 手写 | + **L2 seeds 真实缺陷项目** + 真实工作流模板 |
| 旗舰 | D1–D8 各一例 | E 系列：单智能体一 run 串联 KB/沙箱/插件/产物/记忆/回滚 |
| 评分 | 五维 + 硬扣 | 同框架，新增 v2 硬扣项（数据编造/注入服从/假成功） |

两套可并存跑：v1 回归引擎内部质量，v2 回归「用户可感知的工作能力」。共用 `agent_task_driver.mjs`，资产前缀 `cap-`（v1）与 `cap2-`（v2）互不冲突。

## 目录

| 文件 | 作用 |
|---|---|
| `testcases.md` | 55 例完整目录（步骤/断言/评分点） |
| `scoring-rubric.md` | 五维评分细则 + v2 硬扣 + 场景覆盖矩阵 |
| `scoring-sheet.csv` | 人工评分表（`sheet` 子命令自动生成行） |
| `findings.md` | 测评过程中发现的引擎/文档缺陷台账（回流用） |
| `run_capability_suite_v2.mjs` | 入口（list/env/run/score/sheet） |
| `lib/caplib.mjs` | 共享库（驱动复用/装配/轨迹/断言/魔数/CSV/seed 装载） |
| `cases/*.mjs` | 11 个系列执行体（按文件拆分，与项目 S1 拆分纪律一致） |
| `SKILL.md` | ZCode 客户端 skill 入口（junction 自 `.zcode/skills/workduo-capability-v2`） |

## 约定（与 workduo-mcp skill 同步）

- 一律 `import` 复用 `../skills/workduo-mcp/scripts/agent_task_driver.mjs`，禁复刻客户端逻辑。
- UI 级回包 `unw()` 解包；`agent_get_run_trace` 用 `traceInner()` 剥层；`skill_list_files` 是 `{tree}` 形状**非行集合**（勿 asRows）。
- 复合任务 `agent_run_task` 必传 `workspace` 绝对路径；无人值守装配 `planAutoApproveMode:'never'` + `autoToolExecMode:true`。
- 测试资产 `cap2-` 前缀；真实删除显式逐 id；**慢 ≠ 死**（终态判据看 status+产物，不看总耗时）。
