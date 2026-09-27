# 单 Agent 能力测评 v2 · 客观评分卡

> 2026-09-26T17:23:35.970Z · 样本 7 · OUT=E:\Codes\ABC\work-duo\docs\single-agent-capability-v2\eval-results\capability2-20260927-012330

| 指标 | 值 |
|---|---|
| 用例数 | 7 |
| autoPass | 85.7% |
| status=done | 85.7% |

## 分维度 autoPass

| 维度 | n | pass% | 用例 |
|---|---|---|---|
| N模块 | 4 | 100% | N11-1 N11-2 N11-4 N11-5 |
| P插件 | 2 | 100% | P7-3 P7-4 |
| S技能 | 1 | 0% | S8-2 |

## 明细

| ID | 维度 | 标题 | status | pass | ms | 失败断言 |
|---|---|---|---|---|---|---|
| N11-1 | N模块 | 全模块枚举一致性（零副作用） | done | true |  |  |
| N11-2 | N模块 | server_host 凭证红线（secret 拒收） | done | true |  |  |
| N11-4 | N模块 | 快照契约（空态形状） | done | true |  |  |
| N11-5 | N模块 | 孤儿清扫幂等（双扫） | done | true |  |  |
| P7-3 | P插件 | 插件参数契约：缺必填快速拒绝 | done | true |  |  |
| P7-4 | P插件 | 插件超时契约（timeoutSec 兜底） | done | true |  |  |
| S8-2 | S技能 | 技能导出→导入→一致性闭环 | failed | false |  | markdown_consistent; files_structure |

> 客观 autoPass 不能替代五维分。按 scoring-rubric.md 人工填 scoring-sheet.csv（C30/P25/V15/E15/S15 + 硬扣）。