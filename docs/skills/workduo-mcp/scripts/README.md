# WorkDuo MCP 驱动脚本 + 本地插件脚本范式（标准目录）

## 一、MCP 标准驱动脚本（外部编程工具复用，2026-09-22 沉淀）

直连内建 MCP Server（`127.0.0.1:18755/mcp`，Streamable HTTP JSON-RPC）的标准驱动，**只做参数编排与断言**；能力缺口一律回流 SKILL+MCP 层（新增工具/改文档），严禁绕过 MCP 自写替代。

| 脚本 | 作用 | 用法 |
|---|---|---|
| `agent_task_driver.mjs` | **标准驱动库**（ESM，供其它脚本 import）：MCP 客户端（init/callTool/rawPost）/ 终态轮询 `pollRun`（三类挂起自动应答：计划审批·敏感工具审批·恢复门禁）/ 轨迹解包 `traceInner` / KB 事件提取 / 增量日志 `logFetcher` / `startRun` 组装 | `import { initMcp, callTool, startRun, … } from './agent_task_driver.mjs'` |
| `agent_e2e_audit.mjs` | **全模块四阶段评分审计**（100 分制）：P1 发现 → P2 基建装配（KB 10 文件全链路 + 插件试跑）→ P3 RAG 快路径（SIMPLE_CHAT 携带 kb_search / tags 捷径 / 误杀诊断）→ P4 复合任务 Codex 基准（workspace 绑定 / PlanDAG / verified / 产物磁盘穿透）+ 数据留痕一致性 | `node agent_e2e_audit.mjs`（客户端须运行中；报告写 cwd `e2e_audit_report.json`，`E2E_REPORT_PATH` 可改） |
| `agent_intent_probe.mjs` | **意图探针**：KB 事实问答核验「SIMPLE_CHAT 快路径 + 检索命中」（#1 回归件；`PROBE_KB_ID` 指定已索引 KB，exit 0 = PASS） | `node agent_intent_probe.mjs` |

驱动约定：
- `agent_get_run_trace` 返回外层 `{"trace":{…}}`，一律用库内 `traceInner()` 解包（少剥一层是历史踩坑）。
- 无人值守装配 Agent 用 `planAutoApproveMode:'never'` + `autoToolExecMode:true`（否则每轮复合任务卡计划门禁）；`pollRun` 已自动应答三类挂起，恢复门禁默认 `skip`。
- 复合任务 `agent_run_task` 必须传 `workspace`（绝对路径），否则写文件被 PathGuard 拒绝（历史踩坑）。
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
