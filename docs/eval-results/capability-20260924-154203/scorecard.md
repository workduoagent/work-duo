# 单 Agent 能力测评 · 客观评分卡

> 2026-09-24T07:42:48.998Z · 样本 8 · OUT=E:\Codes\ABC\work-duo\docs\eval-results\capability-20260924-154203

## 总览

| 指标 | 值 |
|---|---|
| 用例数 | 8 |
| autoPass | 87.5% |
| status=done | 100% |

## 分维度 autoPass

| 维度 | n | pass% | 用例 |
|---|---|---|---|
| Plugin | 8 | 87.5% | PL-1 PL-2 PL-3 PL-4 PL-5 PL-6 PL-7 PL-8 |

## 明细

| ID | 维度 | 标题 | status | pass | ms | 失败断言 |
|---|---|---|---|---|---|---|
| PL-1 | Plugin | Python 插件 | done | true | 279 |  |
| PL-2 | Plugin | Bun 插件 | done | true | 197 |  |
| PL-3 | Plugin | reject node | done | true | 4 |  |
| PL-4 | Plugin | reject 缺字段 | done | false | 8 | reject_missing_id; reject_missing_script |
| PL-5 | Plugin | extract_meta | done | true | 5 |  |
| PL-6 | Plugin | 插件绑 Agent | done | true | 45284 |  |
| PL-7 | Plugin | 插件启停 | done | true | 27 |  |
| PL-8 | Plugin | 插件日志 | done | true | 7 |  |

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