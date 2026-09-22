# WorkDuo MCP 驱动脚本 + 本地插件脚本范式（标准目录）

## 一、MCP 标准驱动脚本（外部编程工具复用，2026-09-22 沉淀）

直连内建 MCP Server（`127.0.0.1:18755/mcp`，Streamable HTTP JSON-RPC）的标准驱动，**只做参数编排与断言**；能力缺口一律回流 SKILL+MCP 层（新增工具/改文档），严禁绕过 MCP 自写替代。

| 脚本 | 作用 | 用法 |
|---|---|---|
| `agent_task_driver.mjs` | **标准驱动库**（ESM，供其它脚本 import）：MCP 客户端（init/callTool/rawPost）/ 终态轮询 `pollRun`（三类挂起自动应答：计划审批·敏感工具审批·恢复门禁）/ 轨迹解包 `traceInner` / KB 事件提取 / 增量日志 `logFetcher` / `startRun` 组装 | `import { initMcp, callTool, startRun, … } from './agent_task_driver.mjs'` |
| `agent_e2e_audit.mjs` | **全模块四阶段评分审计**（100 分制）：P1 发现 → P2 基建装配（KB 10 文件全链路 + 插件试跑）→ P3 RAG 快路径（SIMPLE_CHAT 携带 kb_search / tags 捷径 / 误杀诊断）→ P4 复合任务 Codex 基准（workspace 绑定 / PlanDAG / verified / 产物磁盘穿透）+ 数据留痕一致性 | `node agent_e2e_audit.mjs`（客户端须运行中；报告写 cwd `e2e_audit_report.json`，`E2E_REPORT_PATH` 可改） |
| `agent_intent_probe.mjs` | **意图探针**：KB 事实问答核验「SIMPLE_CHAT 快路径 + 检索命中」（#1 回归件；`PROBE_KB_ID` 指定已索引 KB，exit 0 = PASS） | `node agent_intent_probe.mjs` |
| `trace_isolation_probe.mjs` | **#8 per-run 隔离探针**：WorkDuo 单 Agent 同时只能跑一个 run（运行锁），故真并发必须来自**两个不同 Agent**；默认 `PROBE_CREATE_AGENTS=1` 自建两临时 Agent → 并发 run → 分别取 `agent_get_run_trace{run_id}` → 断言两桶互不串台（A 桶不含 B 标记、B 桶不含 A 标记）→ 跑完自动删除。机制层已由 events.rs 单测覆盖，此处做端到端并发回归 | `node trace_isolation_probe.mjs`（默认自建；`PROBE_MODEL_ID=<id>` 指定模型；或 `PROBE_CREATE_AGENTS=0 PROBE_AGENT_ID_A=<idA> PROBE_AGENT_ID_B=<idB>` 复用现成两 Agent） |
| `composite_hang_probe.mjs` | **复合任务挂死诊断**（区分「慢」与「死」）：跑一个必走 COMPOSITE 的真复合任务（建 3 文件），**每 10s 采样** status+trace，用事件 `ts_ms` 打时间线并算**最长静默段**（静默起点=卡死点），自动应答三类挂起；超时也输出完整证据（事件线/采样/日志/磁盘产物穿透）。exit 0=完成且有产物 / 1=终态但零产物 / 2=超时未达终态 / 3=环境错 | `PROBE_MODEL_ID=<id> node composite_hang_probe.mjs`（`PROBE_WAIT_MS` 默认 480000；**网关慢时必须放宽**，见下方基线） |
| `failure_cleanup_probe.mjs` | **失败收尾回归**（筑基支柱①终态铁律）：故障注入——启动复合任务 → 中途 `agent_cancel_task` 中断 → 断言 ①到达明确终态（不停在 running）②**收尾耗时 ≤30s** ③**锁已释放**（立即再 `agent_run_task` 不得被「已有任务正在运行」拒绝）。exit 0=PASS / 1=FAIL / 3=环境错 | `node failure_cleanup_probe.mjs`（`PROBE_CANCEL_AFTER_MS` 默认 5000；`PROBE_CLEANUP_MAX_MS` 默认 30000） |

驱动约定：
- `agent_get_run_trace` 返回外层 `{"trace":{…}}`，一律用库内 `traceInner()` 解包（少剥一层是历史踩坑）。
- 无人值守装配 Agent 用 `planAutoApproveMode:'never'` + `autoToolExecMode:true`（否则每轮复合任务卡计划门禁）；`pollRun` 已自动应答三类挂起，恢复门禁默认 `skip`。
- 复合任务 `agent_run_task` 必须传 `workspace`（绝对路径），否则写文件被 PathGuard 拒绝（历史踩坑）。
- **🔴 复合任务耗时基线（2026-09-22 实测，防误判「挂死」）**：同一复合任务（建 3 文件）— DeepSeek-V4.1-Flash **40s / 最长静默 6.7s**；Qwen3.6 **240s / 最长静默 105s**（规划阶段等 75s）。**正常复合任务可达 4 分钟**，故：
  - 终态等待上限（`PROBE_WAIT_MS`）**不得 < 300s**，否则把「慢」误判成「死」；
  - 任何「总墙钟 30s 终态」类阈值都会误杀正常 run——**慢 ≠ 死**，判据应是「无产出静默时长」而非总耗时。
  - 当年 3 run「永久挂死」高度疑似模型侧（gpt-5.6-luna 调用不返回，该模型**已下线**），非引擎 COMPOSITE 缺陷：现役两模型复合任务均 done 且产出文件。
- **🔴 LLM 调用超时可配置（自测必知）**：`runtime.rs call_llm` 已加超时兜底（默认 **180s**）+ 等待心跳（默认每 **30s** 一条「等待响应已 Ns——仍在进行中，非挂死」日志）。可用环境变量覆盖（>0 生效，App 启动时读取，改后需重启）：
  - `WD_LLM_TIMEOUT_SECS` —— 本地部署的慢模型（如 ollama 内存吃紧）可调大；**自测故障注入调小（如 5s）即可快速验证超时分支**，无需干等 180s。
  - `WD_LLM_TICK_SECS` —— 自测调小（如 1s）便于快速观测心跳日志（经 `agent_get_run_logs` 可见）。
  - 流式两道闸（2026-09-22 实测暴露后补）：`WD_LLM_STREAM_TOTAL_SECS`（流式总墙钟，默认 600）、`WD_LLM_CHUNK_TIMEOUT_SECS`（**单 chunk 静默上限**，默认 120，**须大于本地大模型 prefill 耗时**否则误杀）。判据用「无产出静默时长」——HTTP 200 后流长时间无 chunk 即判定断流。
  - `WD_RUN_MAX_SECS` —— **run 级总墙钟兜底**（默认 600），任何 run 必须在此时间内到终态，超时强制 `emit_task_error` + 释放运行锁。慢模型环境可调大。
- **🔴 三层超时兜底全景（筑基支柱①）**：① 调用级（call_llm 180s / call_llm_stream 静默 120s+总 600s）→ ② 失败判定后收尾 ≤30s → ③ run 级总墙钟 600s。**第①层堵单点，第③层兜全局**（多步累积 / 未覆盖路径）。全部 env 可调，改后需重启 App。
- 测试资产留痕不删（红线）；驱动脚本的测试用 KB/Agent 用时间戳标识符，避免冲突。

## 二、本地插件脚本范式（标准目录）

本目录另存放「本地插件（百宝箱 → 插件）」的**标准脚本范式模板**，供外部编程工具在调用
`plugin_upsert` 编写插件时直接复制填充。插件本质是**本机 FaaS**：用户只写 `run(params)`，
平台沙箱执行，并以 `custom__<identifier>` 注册为智能体工具。

## 运行契约（务必遵守，否则试跑失败）

- 入口固定为 `run(params)`：
  - **Python**：模块级 `def run(params):`，返回一个 **JSON 可序列化对象**（Runner 负责 `json.dumps` 到 stdout）。
  - **Bun/TS**：`export async function run(params)` 或 `export default`，返回 JSON 可序列化对象（Runner 负责 `JSON.stringify`）。
- **参数来源**：调用方（testPlugin / Agent 调用）把入参 JSON 写入 **stdin 首行**；Runner 读首行 `JSON.parse` 后传给 `run(params)`。
  - 因此脚本**不要读命令行 argv**，也不要等 stdin EOF（sidecar stdin 永远 piped 且无法关闭）。
- **结果输出**：`run` 的返回值由 Runner 自动序列化到 stdout；**不要自己 print 中间日志到 stdout**（会被当成结果）。调试信息写 stderr。
- **依赖缺失自愈**：脚本若缺依赖，Python 抛 `ModuleNotFoundError` / Bun 抛 `ERR_MODULE_NOT_FOUND`，
  Runner 捕获后 exit 42 + stderr JSON 上报 `missing_package`，平台自动安装依赖并重试一次。

## runtime 取值（重要）

- 只有 **`python`** 与 **`bun`** 两种！
- 用户口中的「Node 脚本」在本系统对应 **`bun`**（TypeScript）运行时。**切勿填 `node`**——会导致 `test_user_plugin` 校验失败。
- 模板文件：`plugin.python.template.py`（runtime=`python`）、`plugin.bun.template.ts`（runtime=`bun`）。

## 头注释元数据（可选，供 `plugin_extract_meta` 解析）

- Python 用三引号 `""" ... """`，Bun 用 JSDoc `/** ... */`。
- 可声明字段（宽松解析）：`name` / `description` / `dependencies:`(YAML 列表) / `parameters:`(→ JSON Schema)。
- 头注释仅用于**元数据提取与展示**；真正落库的 `parametersSchema` 由 `plugin_upsert.parametersSchema` 字段传入（与头注释独立）。

## 编写步骤

1. 复制 `plugin.python.template.py` 或 `plugin.bun.template.ts`。
2. 改写 `run(params)` 的业务逻辑，返回 JSON 对象。
3. 调用 `plugin_extract_meta` 预览元数据（可选）。
4. 调用 `plugin_upsert`：
   - `runtime`: `python` | `bun`
   - `scriptContent`: 完整脚本文本（含头注释）
   - `parametersSchema`: JSON Schema 对象（与头注释 `parameters` 对齐）
   - `dependencies`: 依赖数组（如 `['requests']`）
   - 其它：name / identifier / description / timeoutSec(默认 60, ≤300) / scenario
5. 调用 `plugin_test` 端到端试跑（传入 params 验证返回）。
6. 如需绑定到 Agent：取插件 `id` → `agent_ui_update.payload.pluginIds` 数组（≤10）。
