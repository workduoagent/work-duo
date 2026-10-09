# WorkDuo L2 生态测评评分卡

> 生成时间：2026-09-23T04:52:45.171Z · 样本：用例 34 / 故障 8 / 并发组 13

## 三维总览

| 维度 | 指标 | 值 |
|---|---|---|
| 高可用 | 终态率 | 97.1% (33/34) |
| 高可用 | 成功率 done | 64.7% |
| 高可用 | 产物达成均值 | 50% |
| 高性能 | 时延 P50/P90/P99 | 473143 / 602983 / 603068 ms |
| 自愈 | 故障注入通过 | 100% |
| 自愈 | 并发组终态率 | 88.2% |

## 按难度/场景

| 分桶 | n | done% | 产物% | P50ms |
|---|---|---|---|---|
| A/H | 7 | 57.1% | 69% | 587778 |
| A/M | 14 | 85.7% | 61% | 289519 |
| B/H | 7 | 28.6% | 14% | 602983 |
| B/M | 6 | 66.7% | 46% | 545393 |

## 按模型

| 模型 | n | done% | P50ms |
|---|---|---|---|
| AG:DeepSeek-V4.1-Flash | 33 | 66.7% | 473143 |
| 96af449e-dfc0-48ec-b077-aa9f02b43d64 | 1 | 0% | 24 |

## 用例明细

| ID | 标题 | status | ms | 产物 | 备注 |
|---|---|---|---|---|---|
| A-H1 | 限流分页+断点续爬 | error | 602555 | 33% |  |
| A-H2 | 大批量ETL多格式产物 | done | 587778 | 100% |  |
| A-H3 | 全链路Skill+KB+插件 | error | 602968 | 0% |  |
| A-H4 | 单Agent排队多任务（锁语义） | done | 132791 | 100% |  |
| A-H5 | 三源聚合降级换源 | done | 328637 | 100% |  |
| A-H6#1 | 插件故障recovery闭环 | error | 602652 | 50% |  |
| A-H7 | KB多跳问答报告 | done | 301742 | 100% |  |
| A-M1#1 | 单源爬取+清洗+产物 | done | 141844 | 100% |  |
| A-M1#2 | 单源爬取+清洗+产物 | done | 175058 | 100% |  |
| A-M1#3 | 单源爬取+清洗+产物 | harness_error | 24 | 0% | agent_ui_create 失败: {"error":"error retu |
| A-M1#4 | 单源爬取+清洗+产物 | done | 174990 | 100% |  |
| A-M1 | 单源爬取+清洗+产物 | done | 289519 | 100% |  |
| A-M2 | 多源聚合+Excel+图 | done | 473143 | 0% |  |
| A-M3#1 | 批量URL并发爬取+记忆中间态 | done | 199111 | 100% |  |
| A-M3 | 批量URL并发爬取+记忆中间态 | done | 391927 | 100% |  |
| A-M4 | 插件编写闭环 | done | 343616 | 0% |  |
| A-M5#1 | KB导入+RAG综述 | done | 415815 | 100% |  |
| A-M6 | 跨轮记忆持久化 | done | 72383 | 50% |  |
| A-M6b | 跨轮记忆召回扩展 | done | 231866 | 100% |  |
| A-M7 | KB标签治理 | done | 499964 | 0% |  |
| A-M8#1 | Skill封装与复用 | error | 602333 | 0% |  |
| B-H1#1 | 全栈+JWT+测试+Docker | error | 602849 | 0% |  |
| B-H2#1 | MCP聚合器元测评 | error | 602989 | 0% |  |
| B-H4#1 | 沙箱微服务+测试 | error | 602983 | 0% |  |
| B-H5#1 | 坏种子仓库修复（自愈） | done | 358513 | 0% |  |
| B-H5 | 坏种子仓库修复（自愈） | done | 485357 | 50% |  |
| B-H6 | 数据管道+基准 | error | 603068 | 50% |  |
| B-H7#1 | 多服务+集成测试 | error | 603041 | 0% |  |
| B-M1#2 | REST API+最小前端 | done | 467289 | 100% |  |
| B-M2#2 | React+Express CRUD | done | 503089 | 50% |  |
| B-M3#2 | 脚手架+后端拼接 | error | 602365 | 50% |  |
| B-M4 | monorepo 共享类型 | done | 355582 | 75% |  |
| B-M5#1 | 迁移+seed+API测试 | error | 602641 | 0% |  |
| B-M6#2 | SSE 实时看板 | done | 545393 | 0% |  |

## 故障注入

| Fault | ok | 观测数 |
|---|---|---|
| F-1 | true | 5 |
| F-10 | true | 4 |
| F-11 | true | 2 |
| F-12 | true | 1 |
| F-3 | true | 1 |
| F-4 | true | 3 |
| F-7 | true | 2 |
| F-8 | true | 1 |

## 并发组

- n=2 done=1/2 terminal=2/2 wall=602601ms survival=50%
- n=2 done=1/2 terminal=2/2 wall=602723ms survival=50%
- n=2 done=0/2 terminal=2/2 wall=603055ms survival=0%
- n=2 done=1/2 terminal=2/2 wall=602907ms survival=50%
- n=2 done=1/2 terminal=2/2 wall=603051ms survival=50%
- n=2 done=0/2 terminal=2/2 wall=603130ms survival=0%
- n=2 done=2/2 terminal=2/2 wall=391987ms survival=100%
- n=3 done=0/3 terminal=0/3 wall=361815ms survival=0%
- n=3 done=2/3 terminal=3/3 wall=602798ms survival=67%
- n=3 done=3/3 terminal=3/3 wall=503170ms survival=100%
- n=3 done=1/3 terminal=3/3 wall=602430ms survival=33%
- n=3 done=2/3 terminal=3/3 wall=602709ms survival=67%
- n=5 done=4/5 terminal=4/5 wall=289587ms survival=80%