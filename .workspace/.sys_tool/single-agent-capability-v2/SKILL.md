---
name: workduo-capability-v2
description: WorkDuo 单 Agent 能力测评套件 v2 的执行入口（v1 的场景化扩展）。面向真实工作场景的单智能体整体编排测评：55 个可执行用例覆盖对话/编码/办公/数据处理/记忆/知识库 RAG/自定义插件/技能/MCP/边界对抗 + 旗舰 E 系列（KB+沙箱+插件+产物+记忆+回滚单 run 串联）。需要跑能力回归、场景验收、评分，或解读 scorecard/findings 时用本 skill；MCP 工具面见 workduo-mcp，引擎单点能力回归见 workduo-capability（v1）。
agent_created: true
---

# WorkDuo 单 Agent 能力测评套件 v2（执行入口）

> 本文件是入口与路由；细节以同目录文档为准：`testcases.md`（55 例目录）、`scoring-rubric.md`（评分）、
> `README.md`（总览）、`findings.md`（缺陷台账）。创建 2026-09-27。

## 何时使用

- **场景化能力回归**：发版前跑 `quick`（无 LLM ~1 分钟，可挂 CI）→ `smoke`（~15 分钟）→ 按需 `full`。
- **真实工作流验收**：E 系列（经营简报全链/跨 run 推进/回滚恢复/附件评审流/无人值守/记忆偏好）。
- **模块验收**：office/data/plugin/skill/kb 等系列各 3–6 例，可单跑。
- 与 v1（workduo-capability）分工：v1 测引擎内部单点能力（D1–D8），v2 测用户可感知的场景编排；评分框架同一套。

## 前置与执行

1. WorkDuo 运行中（`127.0.0.1:18755/mcp`，84 工具）；≥1 个 `tool_calls=1` 模型。
2. **必须在 `.workspace/.sys_tool/single-agent-capability-v2` 目录下执行**（驱动库按相对路径解析）：

```bash
cd E:/Codes/ABC/work-duo/.workspace/.sys_tool/single-agent-capability-v2
node run_capability_suite_v2.mjs list | env | run --suite <名> | run --ids <ID> | score | sheet
```

3. 环境变量：`CAP2_MODEL_ID`（建议锁 DeepSeek-V4.1-Flash）、`CAP2_WAIT_MS`（默认 480s，慢≠死）、`OUT`、`CAP2_WS_ROOT`。

## 套件速查

| 套件 | 内容 | 预估 |
|---|---|---|
| quick | 7 个无 LLM 契约用例 | ~1 分钟 |
| smoke | N11-1+C1-1+O3-3+T4-1+K2-4+E9-5 | ~15 分钟 |
| chat/code/office/data/memory/kb/plugin/skill/adversarial/modules | 各系列全集 | 10–40 分钟 |
| e2e | E9-1..6 旗舰编排 | ~30–60 分钟 |
| full | 55 例 | ~2–4 小时 |

## 关键约定（违反即踩坑）

- 驱动复用 `../skills/workduo-mcp/scripts/agent_task_driver.mjs`，禁复刻客户端逻辑；`unw()` 剥 `{ok,data}`、`traceInner()` 剥 trace 层。
- `skill_list_files` 回 `{tree}` 形状（非行集合，勿 asRows）；`skill_export` 字段为 `base64`。
- **runner 端 ground-truth**：T/E 系列数值重算比对；xlsx 验 PK 魔数、PNG 验 PNG 魔数——不信任模型自报。
- 复合任务必传 `workspace` 绝对路径；无人值守 `planAutoApproveMode:'never'` + `autoToolExecMode:true`。
- 测试资产一律 `cap2-` 前缀；真实删除显式逐 id；测试 KB/技能/插件用后即清。
- 结果写 `.workspace/.eval-results/capability2-<ts>/`；新缺陷回流 `findings.md`（已知：F1 skill_import 后 skill_get 缺 skillMarkdown；F2 纯格式问答误路由 COMPOSITE 降级）。
