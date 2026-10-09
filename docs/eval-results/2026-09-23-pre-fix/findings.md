# WorkDuo L2 生态深度测评 — 问题清单与演化建议

> 日期：2026-09-23 · 样本：用例 34 / 故障注入 8 / 并发组 13 · 模型主桶：DeepSeek-V4.1-Flash
> 工作空间：`E:/Codes/ABC/work-duo/eval-workspace/` · 原始结果：本目录 `*.json` · 评分卡：`scorecard.md`
> 角色：以 WorkDuo 真实用户视角客观评价；能力缺口优先回流 workduo-mcp，不绕过。

---

## 0. 三维结论（先看这个）

| 维度 | 评分（客观） | 一句话 |
|---|---|---|
| **高可用** | **B+** | 终态率 97%，锁可释放、无永久挂死、清理干净；并发不崩 |
| **高性能** | **C** | 单任务可完成，但复杂/并发下 P50≈8min，**600s run 墙钟是第一瓶颈** |
| **自愈** | **B-** | 降级换源、坏种子修复部分成功；recovery/取消语义仍有毛刺 |

---

## 1. 高可用：整体健康，有两处毛刺

### 1.1 做得好的（可保持）
- **终态铁律成立**：34 用例 33 个到明确终态（97.1%）；`WD_RUN_MAX_SECS` 超时会强制 `emit_task_error`，**没有永久 running**。
- **多 Agent 真并发可行**：C-2 全绿；C-5（5×A-M1）4/5 done 且产物 100%；单 Agent 多文件任务（A-H4）一次 run 全齐。
- **资源清理干净**：测评后 `agent_ui_list` 仅剩用户原有 Agent，无孤儿。
- **锁释放**：F-1 取消后立即可再 `run_task`。
- **写路径稳定**：F-10 并发 `skill_upsert`、F-11 索引与写入竞态、F-12 记忆洪水均未打崩。

### 1.2 问题
| ID | 现象 | 影响 | 证据 |
|---|---|---|---|
| **HA-1** | `agent_cancel_task` 未把 run 变成 `cancelled`，F-1 slot1 仍 `done` | 用户点「取消」后任务可能继续跑完/继续烧 token | `fault-F-1.json` |
| **HA-2** | 计划门禁（`planAutoApproveMode=always`）与短任务竞态：8s 采样时已是 `done`，再 `submit_plan` 报「当前没有运行中的任务」 | HITL 门禁在快任务上不可观测、放行 API 报错吓人 | `fault-F-4.json` |
| **HA-3** | 并发 `skill_upsert` 同 identifier **3/3 全成功**（后写覆盖） | 无冲突检测，静默丢版本 | `fault-F-10.json` |
| **HA-4** | 无 workspace 时任务 `done` 但 reply 空、无产物，也不报 PathGuard | 用户不知道「为什么什么都没写」 | `fault-F-7.json` |

---

## 2. 高性能：600s 墙钟 + 多格式产物是两大痛点

### 2.1 系统性：`WD_RUN_MAX_SECS` 默认 600s 不够用（共性已证实）

撞墙用例（error 且 duration≈602s，日志见「运行总时长超时（600s），已强制终止」）：

| 用例 | 类型 | 并发 |
|---|---|---|
| A-M2 | 多源+Excel+图 | C-3 |
| A-M8 | Skill 封装 | C-3 |
| B-M3 | 脚手架全栈 | C-3 |
| B-M5 | 迁移+测试 | C-3 |
| A-H1 | 断点续爬 | C-2 |
| A-H3 | 全链路 Skill+KB+插件 | C-2 |
| A-H6 | 插件 recovery | C-2 |
| B-H1 | 全栈+JWT+Docker | C-2 |
| B-H2 | MCP 聚合器 | C-2 |
| B-H4 | 沙箱微服务 | C-2 |
| B-H6 | 管道+基准 | C-2 |
| B-H7 | 多服务 | C-2 |

**共性结论**：不是单用例 flake，而是 **复杂复合任务 / 并发下 Medium-H 任务预算 < 600s**。
串行对照：A-M2 串行 `done`（473s）但仍超紧；说明 **串行也贴边，并发必炸**。

**用户体验直说**：等 8–10 分钟最后被一刀切掉、reply 还是空的——像系统死机，其实只是预算到了。这比慢更伤。

### 2.2 性能数据（DeepSeek-V4.1-Flash）
| 场景 | 时延 |
|---|---|
| A-M1 单发 | **151s**（基线） |
| A-M1 @C-5 | 142–290s（尚可） |
| A-M3 @C-2 | 199s / 392s（降速明显） |
| A-M4/A-M5 @C-3 | 344s / 416s |
| 复杂 H @C-2 | 多数顶满 600s |

### 2.3 产物能力缺口：xlsx / png 生成不稳定
- A-M2 串行 done，但工作区只有 `news_raw.json/.xml`，**没有 market.xlsx / price_trend.png**。
- 同结构 A-H2（CSV+JSON+MD+PNG）却 **100% 产物**——说明 PNG 可以，**Excel 是短板**（无原生工具/插件模板时靠模型手写 xlsx 不可靠）。
- 产物文件名契约遵循也不稳（B-H5 曾把 `FIXLOG.md` 写到 workspace 根而不是 `fix-seed/`）。

---

## 3. 自愈：方向对，闭环未完成

| 能力 | 结果 | 说明 |
|---|---|---|
| 多源降级/换源 | **PASS**（A-H5 两次均 done，产物 100%） | 失败源被记录，未全盘放弃 |
| 坏种子修码 | **部分**（B-H5 done，产物 50%） | 有修复动作，FIXLOG/路径契约不完整 |
| 插件故障 recovery | **部分**（A-H6 error，产物 50%） | 600s 内未走完修插件+重跑 |
| 故障注入不致挂 | **PASS**（8/8） | 含取消、坏参、竞态、洪水 |
| 取消语义 | **弱** | 可能跑完变 done |

诚实预期得到验证：**「部分自愈」**——retry/降级有了，全自动修码/recovery 闭环未达标。

---

## 4. 用户视角「不习惯 / 不好用」清单（客观吐槽）

1. **长任务无进度体感**：8 分钟窗口里 UI/工具侧只有 wait；结束才知成败。建议 MCP 增加 `agent_get_run_progress`（step/轮次/剩余预算）。
2. **超时文案不友好**：「运行总时长超时（600s），已强制终止」——应区分「预算耗尽」vs「真挂死」，并保留已有产物索引。
3. **xlsx/图产物全靠模型硬写**：作为用户只想「要一份 Excel」，失败两次后会换工具。建议官方插件模板：`xlsx-writer` / `chart-png`。
4. **取消按钮语义不清**：点了取消任务仍 done，下次不敢信取消。
5. **计划门禁报错**「没有运行中的任务」——应返回 `no_pending_plan` 而不是 error 吓人。
6. **无 workspace 时静默空回复**——应明确提示「未绑定工作空间，文件操作被拒绝」。
7. **并发建 Agent** 需要调用方自己防 identifier 碰撞；平台可加后缀或返回可重试的 `conflict`。

---

## 5. 演化建议（按优先级，回流 MCP/SKILL/Rust）

> 若改 `src-tauri/**`，**必须重启 WorkDuo 才生效**（本轮测评未改 Rust，仅记录）。

| 优先级 | 建议 | 层 | 预期收益 |
|---|---|---|---|
| **P0** | 提高/可配置 `WD_RUN_MAX_SECS`（COMPOSITE 默认建议 ≥1200s），或按步进预算+可续跑 | Rust env/配置 | 直接消灭本轮 12 个 600s 失败 |
| **P0** | 超时/取消后回写 `assistant_answer` 摘要 + 已产物列表（现在 reply 空） | Rust+MCP | 用户可理解失败原因 |
| **P1** | 取消语义：`cancel` → 状态 `cancelled`，禁止再写新文件，保留已写 | Rust | HA-1 |
| **P1** | 官方插件模板 `xlsx_writer` / `png_chart`（进 skill scripts/） | SKILL+插件 | 解 A-M2 类 |
| **P1** | `skill_upsert` 同 identifier 并发返回 conflict 或版本号 | UI 意图层 | HA-3 |
| **P2** | `agent_get_run_progress`（step/轮次/剩余秒） | MCP 新工具 | 用户体感 |
| **P2** | `submit_plan` 无挂起时返回结构化 `no_pending` | MCP | HA-2 |
| **P2** | 无 workspace 时 reply 注入 PathGuard 说明 | Rust | HA-4 |
| **P2** | SKILL.md/README 登记 `l2_eval_harness.mjs` 与 600s 预算坑 | SKILL | 下次自测不踩 |

---

## 6. 本轮已沉淀资产

- 驱动：`docs/skills/workduo-mcp/scripts/l2_eval_harness.mjs`（已同步 `.mimocode` + `~/.config/mimocode`）
- 结果：`docs/eval-results/2026-09-23/*.json` + `scorecard.md` + 本文件
- 工作空间样本：`eval-workspace/eval-*`（保留供抽查）
- 记忆验证：`l2-a-m6-release-facts` 跨轮召回成功

## 7. 建议下一轮（L2.1）补测
1. P0 调大 run 预算后，重跑 12 个 600s 失败用例（预期 done% 显著上升）。
2. 模型对照：MiniMax-M3 / GLM-5.3-Flash 同题（本轮主桶 DeepSeek）。
3. C-8 极限 + 跨零点 F-5。
4. B-H2 串行完整元测评（本轮 C-2 下 600s 截断，文件未齐）。
