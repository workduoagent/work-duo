# WorkDuo 本地插件脚本范式（标准目录）

本目录存放「本地插件（百宝箱 → 插件）」的**标准脚本范式模板**，供外部编程工具在调用
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
