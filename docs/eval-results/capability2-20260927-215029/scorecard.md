# 单 Agent 能力测评 v2 · 客观评分卡

> 2026-09-27T13:53:42.935Z · 样本 3 · OUT=E:\Codes\ABC\work-duo\docs\eval-results\capability2-20260927-215029

| 指标 | 值 |
|---|---|
| 用例数 | 3 |
| autoPass | 66.7% |
| status=done | 66.7% |

## 分维度 autoPass

| 维度 | n | pass% | 用例 |
|---|---|---|---|
| C对话 | 2 | 50% | C1-2 C1-6 |
| E编排 | 1 | 100% | E9-4 |

## 明细

| ID | 维度 | 标题 | status | pass | ms | 失败断言 |
|---|---|---|---|---|---|---|
| C1-2 | C对话 | 长文本附件摘要（token 纪律） | done | true | 36131 |  |
| C1-6 | C对话 | file 附件落盘与跨轮重解析 | failed | false | 57446 | file_landed_attachments |
| E9-4 | E编排 | 附件需求评审流（附件+分析+xlsx） | done | true | 99497 |  |

> 客观 autoPass 不能替代五维分。按 scoring-rubric.md 人工填 scoring-sheet.csv（C30/P25/V15/E15/S15 + 硬扣）。