# S-J6 十六轮对照实验（WD_SUBTASK_MAX_ITERATIONS=8→16）

**实验性质**：P-5 遗留对照实验（2026-09-24-full TEST-REPORT.md §十 P-5）。目的：验证「子任务工具轮上限放宽」对修复型任务的影响方向——余量提升 vs 侦察拖延恶化。

## 实验设计

| 项 | 对照组（基线） | 实验组（本跑） |
|---|---|---|
| 环境 | 默认 env（基线 8 轮，修复步 8+8=16） | `WD_SUBTASK_MAX_ITERATIONS=16`（修复步 16+8=24） |
| 用例 | S-J6 py-security-crlf-injection（CVE-2019-9740，双文件修复） | 同题同判分 |
| 预算/超时 | WAIT 默认 1900s | 同 |
| 模型 | DeepSeek-V4.1-Flash | 同（控变量） |

**基线参照（第四跑，12:3x，8 轮基线下 PASS）**：done 1083s，外层 pytest 4/0，产物 crlf_fix.md 1/1，3 步计划（勘查→修复→报告）。

## 判定标准

1. **resolved**：外层受管 venv pytest 全绿（resolved=true）
2. **耗时**：run duration（警戒线：显著劣化 >1800s）
3. **轮数消耗**：引擎日志「超轮熔断收尾」/子任务工具轮——实验组应≥对照组同位置轮数（预算放宽，正常不应触顶）
4. **侦察拖延**：熔断是否更频繁触发、修复步是否被更晚触达（恶化信号）
5. **产物**：crlf_fix.md（artifacts 契约）

## 结果（16:05~16:12 实跑，run-1790237165366-0）

| 维度 | 对照组（8 基线，第四跑） | 实验组（16 基线，本跑） | 判定 |
|---|---|---|---|
| **resolved** | true（pytest 4/0） | **true（pytest 4/0）** | ✅ 持平 |
| **耗时** | 1083s | **353s**（快 3 倍） | ✅ 无恶化 |
| **轮数消耗** | 首跑曾 24 轮烧尽熔断 | **总轮 12 / 工具轮 11 闭环，未触顶**（16 基线 / 24 修复上限） | ✅ 余量充足 |
| **侦察拖延** | —— | 无：3 轮内完成勘查→第 9 轮 pytest 全绿→12 轮写产物闭环 | ✅ 未恶化 |
| **产物** | crlf_fix.md 1/1 | crlf_fix.md 1/1（895B，sensitive 审批留痕） | ✅ 持平 |
| **usage** | —— | input 274,786 / output 5,260 | —— |

**结论**：`WD_SUBTASK_MAX_ITERATIONS=16` **安全有效**——修复型任务在更宽预算下 12 轮即自然闭环，无侦察拖延恶化，resolved 保持，耗时反降（本轮模型响应更快为主因，不全部归因 env）。**建议转正式默认**：基线 16 / 修复 +8（=24），后续观察样本积累后固化进 MAX_SUBTASK_ITERATIONS 默认值。

## 实验附带产出（判分基建两处修复）

1. **种子 artifacts 裸文件名歧义**：crlf/redos/urlparse 三个种子 `artifacts` 写裸文件名，agent 规范写入 targetDir/ 子目录时误判 miss（本跑 crlf_fix.md 实际存在但 artifactScore=0）→ 三 manifest 改全路径 + `checkArtifacts` 加同名尾段兜底匹配。
2. **harness OUT env 名澄清**：结果目录变量是 `L2_OUT`（非 OUT）；agent 沙箱内 spawnSync EBUSY（已知坑）→ 内部 [judge] 行恒 0/0/0，判分必须走三段式。
