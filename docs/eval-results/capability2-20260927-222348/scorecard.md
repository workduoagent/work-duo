# 单 Agent 能力测评 v2 · 客观评分卡

> 2026-09-27T14:24:40.130Z · 样本 2 · OUT=E:\Codes\ABC\work-duo\docs\eval-results\capability2-20260927-222348

| 指标 | 值 |
|---|---|
| 用例数 | 2 |
| autoPass | 50% |
| status=done | 50% |

## 分维度 autoPass

| 维度 | n | pass% | 用例 |
|---|---|---|---|
| B知识库 | 1 | 0% | B6-5 |
| C对话 | 1 | 100% | C1-3 |

## 明细

| ID | 维度 | 标题 | status | pass | ms | 失败断言 |
|---|---|---|---|---|---|---|
| B6-5 | B知识库 | 知识更新即生效（增量索引闭环） | failed | false | 42310 | before_honest; after_knows |
| C1-3 | C对话 | 结构化 JSON 输出遵循 | done | true | 6050 |  |

> 客观 autoPass 不能替代五维分。按 scoring-rubric.md 人工填 scoring-sheet.csv（C30/P25/V15/E15/S15 + 硬扣）。