# 单 Agent 能力测评 · 客观评分卡

> 2026-09-24T07:41:31.609Z · 样本 6 · OUT=E:\Codes\ABC\work-duo\docs\eval-results\capability-20260924-154018

## 总览

| 指标 | 值 |
|---|---|
| 用例数 | 6 |
| autoPass | 83.3% |
| status=done | 100% |

## 分维度 autoPass

| 维度 | n | pass% | 用例 |
|---|---|---|---|
| Skill | 6 | 83.3% | SK-1 SK-2 SK-3 SK-4 SK-5 SK-6 |

## 明细

| ID | 维度 | 标题 | status | pass | ms | 失败断言 |
|---|---|---|---|---|---|---|
| SK-1 | Skill | 技能发现 | done | true | 18 |  |
| SK-2 | Skill | 技能创建 | done | true | 99 |  |
| SK-3 | Skill | 技能文件读写 | done | false | 21 | roundtrip |
| SK-4 | Skill | 技能启停 | done | true | 30 |  |
| SK-5 | Skill | 技能导出导入 | done | true | 128 |  |
| SK-6 | Skill | 技能绑定 Agent | done | true | 72434 |  |

## 人工五维（请填 scoring-sheet.csv）

客观 autoPass **不能**替代五维分。按 scoring-rubric.md 对 C/P/V/E/S 打 0–5，套硬扣后换算百分制。

| 维度 | 权重 | 人工均分 0–5 |
|---|---|---|
| C 任务完成度 | 30% |  |
| P 过程正确性 | 25% |  |
| V 客观验证率 | 15% |  |
| E 效率 | 15% |  |
| S 安全可控 | 15% |  |
| **加权总分** | 100% |  |

总分 = 30*(C/5) + 25*(P/5) + 15*(V/5) + 15*(E/5) + 15*(S/5) ，再套硬扣。