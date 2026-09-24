# WorkDuo L2 生态测评评分卡

> 生成时间：2026-09-24T02:16:17.046Z · 样本：用例 26 / 故障 0 / 并发组 3

## 三维总览

| 维度 | 指标 | 值 |
|---|---|---|
| 高可用 | 终态率 | 92.3% (24/26) |
| 高可用 | 成功率 done | 92.3% |
| 高可用 | 产物达成均值 | 100% |
| 高性能 | 时延 P50/P90/P99 | 430827 / 1007480 / 1296083 ms |
| 自愈 | 故障注入通过 | 0% |
| 自愈 | 并发组终态率 | 91.3% |

## 按难度/场景

| 分桶 | n | done% | 产物% | P50ms |
|---|---|---|---|---|
| D/H | 2 | 100% | 100% | 463969 |
| D/M | 8 | 75% | 100% | 602953 |
| E/H | 1 | 100% | 100% | 847722 |
| E/M | 3 | 100% | 100% | 145569 |
| F/H | 1 | 100% | 100% | 1296083 |
| F/M | 8 | 100% | 100% | 364438 |
| S/M | 3 | 100% | 100% | 737960 |

## 按模型

| 模型 | n | done% | P50ms |
|---|---|---|---|
| AG:DeepSeek-V4.1-Flash | 26 | 92.3% | 430827 |

## Batch C 种子修复 · 客观判分

| 层级 | n | resolved% |
|---|---|---|
| security | 1 | 100% |
| logic | 2 | 100% |
| **合计** | 3 | **100%** |

| ID | seed | tier | resolved | passed/failed/errors |
|---|---|---|---|---|
| S-J1 | py-security-tarfile-traversal | security | true | 2/0/0 |
| S-J2#1 | py-logic-fnmatch-revrange | logic | true | 4/0/0 |
| S-J3#2 | py-logic-parents-negindex | logic | true | 6/0/0 |

## 用例明细

| ID | 标题 | status | ms | 产物 | 备注 |
|---|---|---|---|---|---|
| D-H1#6 | 多能力组合工程（MCP+Skill+KB+产物） | done | 463969 | 100% |  |
| D-H2#7 | 原生工具深链路（抓取→清洗→图表） | done | 277791 | 100% |  |
| D-M1 | MCP 工具面发现与跨层调用 | done | 196406 | 100% |  |
| D-M2#1 | 已装配技能/知识的复用能力 | timeout | 602953 | 100% |  |
| D-M2 | 已装配技能/知识的复用能力 | done | 645119 | 100% |  |
| D-M3#1 | MCP 工具产出 Excel（能力面） | done | 651101 | 100% |  |
| D-M3#2 | MCP 工具产出 Excel（能力面） | timeout | 603139 | 100% |  |
| D-M4#3 | 知识库检索与引用（Agent 视角） | done | 103013 | 100% |  |
| D-M5#4 | 系统原生工具组合 | done | 229040 | 100% |  |
| D-M6#5 | 沙箱执行（Python/Node） | done | 117699 | 100% |  |
| E-H1#11 | 长任务中途压缩后仍完成产物 | done | 847722 | 100% |  |
| E-M1#8 | 同会话多轮递进 | done | 145569 | 100% |  |
| E-M2#9 | 长上下文压缩后信息保留 | done | 196877 | 100% |  |
| E-M3#10 | 跨会话记忆传递（MEMORY.md） | done | 115206 | 100% |  |
| F-H1#17 | 工程全链路 .wd_mem 严谨性（大工程） | done | 1296083 | 100% |  |
| F-M1#12 | .wd_mem 结构完整性 | done | 310283 | 100% |  |
| F-M2#13 | runtime/scripts 复用（跨轮） | done | 600070 | 100% |  |
| F-M2 | runtime/scripts 复用（跨轮） | done | 364438 | 100% |  |
| F-M3#14 | runtime/data 复用（跨轮） | done | 111930 | 100% |  |
| F-M3 | runtime/data 复用（跨轮） | done | 180998 | 100% |  |
| F-M4#15 | knowledge/artifacts 沉淀与检索 | done | 313882 | 100% |  |
| F-M5#16 | graph 实体图与 sessions 摘要 | done | 430827 | 100% |  |
| F-M6 | sessions 摘要与 outputs 归档（两区能力验证） | done | 1007480 | 100% |  |
| S-J1 | 真实CVE修复：tarfile路径穿越 | done | 460961 | 100% |  |
| S-J2#1 | 真实缺陷修复：fnmatch反转范围 | done | 1138122 | 100% |  |
| S-J3#2 | 真实缺陷修复：parents负索引 | done | 737960 | 100% |  |

## 故障注入

| Fault | ok | 观测数 |
|---|---|---|

## 并发组

- n=18 done=16/18 terminal=16/18 wall=1296371ms survival=89%
- n=2 done=2/2 terminal=2/2 wall=651241ms survival=100%
- n=3 done=3/3 terminal=3/3 wall=1138373ms survival=100%