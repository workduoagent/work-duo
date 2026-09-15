# 自定义脚本插件（User-defined Script Plugin）设计方案

> 版本：v1.0（完整设计稿）  
> 范围：从数据库模型、执行契约、安全策略、Tauri IPC、Agent 装配到前端 UI 的端到端设计。  
> 原则：对齐现有 work-duo 约定（mapper / ToolRegistry / mamba / bun / 百宝箱），补齐此前评审中的缺口。

---

## 0. 产品定位与边界

### 0.1 一句话定位

**本地可执行的函数即服务（FaaS）**：用户在界面写一个 `run(params)` 函数，平台负责沙箱执行、依赖自愈，并以 `custom__<identifier>` 注册为智能体可调用工具。

### 0.2 与 Skill / MCP 的边界

| 维度 | Skill | MCP | 本地插件（本方案） |
| --- | --- | --- | --- |
| 本质 | 工作流 / 知识 / 脚手架 | 外部工具协议 | 本机可执行函数 |
| 是否真执行代码 | 否（描述型 / prompt 注入） | 远端服务执行 | 沙箱内执行用户代码 |
| 依赖自愈 | 无 | 无 | 有（exit 42 协议） |
| 典型用法 | 「怎么做研究报告」 | 「调用浏览器 / 解析 PDF」 | 「汇率换算 / 算 Token」 |
| 审批倾向 | 弱 | 中 | 强（默认需审批） |

产品文案建议在插件中心写明：**Skill 教流程，MCP 连外部，Plugin 跑函数**。

### 0.3 非目标（v1 不做）

- 插件市场 / 远程安装 / 签名校验
- 多版本历史 UI（表结构预留字段即可）
- 插件内再嵌套调用其他插件
- 非 Python / Bun 的第三运行时
- 小分队（squad）全局插件挂载（架构预留，v2 做）

---

## 1. 总体架构

```text
┌─────────────────────────────────────────────────────────────────┐
│  前端                                                            │
│  插件中心 pages/plugins          智能体向导 Step「本地插件」       │
│  Monaco 编辑 / 试跑 / Schema 预览   勾选绑定                      │
└───────────────┬─────────────────────────────┬───────────────────┘
                │ invokeCommand                │
┌───────────────▼─────────────────────────────▼───────────────────┐
│  Tauri IPC（plugin_commands）                                     │
│  list/get/upsert/delete/test/bind/unbind/listAgentPlugins        │
└───────────────┬─────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────┐
│  执行引擎（plugin_runner）                                        │
│  1. 拼装 Runner 壳 → .wd_mem/plugins/{call_id}/                   │
│  2. stdin 注入 JSON 参数                                          │
│  3. mamba / bun sidecar 执行                                      │
│  4. exit 42 → 安装依赖 → 重试一次                                 │
│  5. 清理临时目录（可配置保留）                                      │
└───────────────┬─────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────┐
│  Agent 运行时（plugin_adapter）                                    │
│  load_config 读 agent_plugin_ref → ToolRegistry                  │
│  工具名：custom__<identifier>                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 1.1 模块落点建议

| 模块 | 建议路径 | 职责 |
| --- | --- | --- |
| DDL | `src/assets/sql/init.sql` + `updater.sql` | 新装库与存量库双源同步 |
| 行实体 | `src/types/database.d.ts` | `UserPluginToolRow` / `AgentPluginRefRow` / `PluginRunLogRow` |
| 领域模型 | `src/core/file/plugin-file.ts` | `UserPluginTool` 等前端模型 |
| Mapper | `src/core/mapper/plugin-mapper.ts` | SQL CRUD + localStorage 回退 |
| Rust 命令 | `src-tauri/src/agent/plugin_commands.rs` | IPC 表面（**不堆进已超长的 commands.rs**） |
| 执行器 | `src-tauri/src/agent/plugin_runner.rs` | 壳拼装 / stdin / 42 自愈 / 超时 |
| 适配器 | `src-tauri/src/agent/plugin_adapter.rs` | `AgentTool` 包装 + 注册 |
| UI | `src/pages/plugins/index.tsx` | 插件中心 |
| 向导 | `src/pages/agent-studio/` 扩展 Step | 本地插件挂载 |

---

## 2. 数据模型

### 2.1 插件主表 `user_plugin_tool`

```sql
-- ============ 自定义脚本插件主表 ============
-- 行映射见 src/types/database.d.ts 的 UserPluginToolRow。
-- identifier：工具唯一 slug，落库前校验 ^[a-z0-9][a-z0-9_-]{1,47}$，
--   且不得与 native__ / mcp__ / skill__ / custom__ 保留前缀冲突（custom__ 由平台拼接，用户不可写入 identifier）。
-- parameters_schema：OpenAI function 可用的 JSON Schema 字符串
--   形如 {"type":"object","properties":{...},"required":[...]}。
-- dependencies：JSON 数组字符串，如 '["requests"]' 或 '["gpt-tokenizer@^2.1.2"]'。
-- script_content：用户核心代码（仅 run + 头注释，不含 Runner 壳）。
-- sample_params：试跑 / 示例参数 JSON 对象字符串，可空。
-- timeout_sec：单次执行超时（秒），默认 60，上限 300。
-- last_run_at / last_run_status：列表态冗余（0 未知 / 1 成功 / 2 失败），由 test 与 Agent 执行回写。
-- created_at / updated_at：epoch 毫秒。
CREATE TABLE IF NOT EXISTS user_plugin_tool
(
    id                TEXT    PRIMARY KEY,
    name              TEXT    NOT NULL,
    identifier        TEXT    NOT NULL,
    description       TEXT    NOT NULL,
    runtime           TEXT    NOT NULL, -- 'python' | 'bun'
    script_content    TEXT    NOT NULL,
    parameters_schema TEXT    NOT NULL,
    dependencies      TEXT,             -- JSON 数组字符串，可空
    sample_params     TEXT,             -- JSON 对象字符串，可空
    enabled           INTEGER NOT NULL DEFAULT 1,
    timeout_sec       INTEGER NOT NULL DEFAULT 60,
    scenario          TEXT,             -- 可空，与百宝箱其他模块对齐
    last_run_at       INTEGER,
    last_run_status   INTEGER,          -- 0 未知 / 1 成功 / 2 失败
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    CONSTRAINT uk_user_plugin_identifier UNIQUE (identifier)
);
```

**字段设计说明**

| 字段 | 必要性 | 说明 |
| --- | --- | --- |
| `name` / `description` | 必填 | 给人看 + 给模型理解意图；`description` NOT NULL，UI 强校验 |
| `identifier` | 必填 | 工具对外名，不包含 `custom__` 前缀 |
| `runtime` | 必填 | `python` \| `bun`；**保存后可改**，改运行时会清空「已预装依赖提示」，不自动卸载包 |
| `parameters_schema` | 必填 | 必须是合法 JSON Schema；提取失败时允许手改后保存 |
| `dependencies` | 可空 | 声明式依赖；空 = 仅标准库 / 零 npm 包 |
| `sample_params` | 可空 | 试跑一键填充，降低调试成本 |
| `timeout_sec` | 必填默认 60 | 避免写死，防脚本挂死 |
| `scenario` | 可空 | 百宝箱场景分类，与 MCP/Skill 一致 |
| `last_run_*` | 可空 | 列表「最近状态」角标，非真相源（真相在 `plugin_run_log`） |

### 2.2 智能体绑定表 `agent_plugin_ref`

对齐 `agent_mcp_ref` / `agent_skill_ref` 习惯：

```sql
-- ============ 智能体 × 本地插件关联表 ============
-- 行映射见 src/types/database.d.ts 的 AgentPluginRefRow。
-- 最小关联单元是「插件」；is_active 支持绑定级启停（会话内还可临时禁用，见 IPC）。
CREATE TABLE IF NOT EXISTS agent_plugin_ref
(
    id         TEXT    PRIMARY KEY,
    agent_id   TEXT    NOT NULL,
    plugin_id  TEXT    NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT uk_agent_plugin UNIQUE (agent_id, plugin_id)
);
```

**建议索引**（与现有风格一致，可选）：

```sql
CREATE INDEX IF NOT EXISTS idx_agent_plugin_agent ON agent_plugin_ref (agent_id);
```

### 2.3 执行日志表 `plugin_run_log`（推荐 v1 就上）

试跑与 Agent 调用共用，支撑排障与列表态。

```sql
-- ============ 插件执行日志（滚动保留，按 plugin_id + created_at 可清理） ============
CREATE TABLE IF NOT EXISTS plugin_run_log
(
    id           TEXT    PRIMARY KEY,
    plugin_id    TEXT    NOT NULL,
    agent_id     TEXT,                    -- 试跑为 NULL；Agent 调用写入
    session_id   TEXT,                    -- 会话内调用可空
    source       TEXT    NOT NULL,        -- 'test' | 'agent'
    params       TEXT,                    -- 入参 JSON（注意脱敏策略，见安全章）
    ok           INTEGER NOT NULL,        -- 0/1
    exit_code    INTEGER,
    duration_ms  INTEGER,
    stdout       TEXT,                    -- 截断后的输出
    stderr       TEXT,
    error_type   TEXT,                    -- 'DependencyMissing' | 'Timeout' | 'RuntimeError' | ...
    missing_package TEXT,
    created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_run_log_plugin ON plugin_run_log (plugin_id, created_at DESC);
```

> 存量库由你按既有升级习惯手动追加；新装库两处 SQL 需同步。

### 2.4 TypeScript 行映射

```typescript
/** 自定义脚本插件表（user_plugin_tool）行映射。 */
export interface UserPluginToolRow {
  id: string
  name: string
  identifier: string
  description: string
  runtime: 'python' | 'bun'
  script_content: string
  parameters_schema: string
  dependencies: string | null
  sample_params: string | null
  enabled: number // SQLite 布尔 0/1
  timeout_sec: number
  scenario: string | null
  last_run_at: number | null
  last_run_status: number | null // 0/1/2
  created_at: number
  updated_at: number
}

/** 智能体 × 本地插件关联表（agent_plugin_ref）行映射。 */
export interface AgentPluginRefRow {
  id: string
  agent_id: string
  plugin_id: string
  is_active: number
  created_at: number
  updated_at: number
}

/** 插件执行日志（plugin_run_log）行映射。 */
export interface PluginRunLogRow {
  id: string
  plugin_id: string
  agent_id: string | null
  session_id: string | null
  source: 'test' | 'agent'
  params: string | null
  ok: number
  exit_code: number | null
  duration_ms: number | null
  stdout: string | null
  stderr: string | null
  error_type: string | null
  missing_package: string | null
  created_at: number
}
```

### 2.5 领域模型（前端）

```typescript
export type PluginRuntime = 'python' | 'bun'

export interface UserPluginTool {
  id: string
  name: string
  identifier: string
  description: string
  runtime: PluginRuntime
  scriptContent: string
  /** OpenAI function parameters；已 JSON.parse 的对象 */
  parametersSchema: Record<string, unknown>
  dependencies: string[]
  sampleParams: Record<string, unknown> | null
  enabled: boolean
  timeoutSec: number
  scenario?: string
  lastRunAt?: string
  lastRunStatus?: 'success' | 'failed' | 'unknown'
  createdAt: string
  updatedAt: string
}

export interface PluginTestResult {
  ok: boolean
  callId: string
  durationMs: number
  exitCode: number | null
  /** 成功时的 run() 返回值（已 JSON.parse，失败则为 null） */
  result: unknown
  stdout: string
  stderr: string
  /** 自愈是否发生 */
  depsInstalled: string[]
  errorType?: 'DependencyMissing' | 'Timeout' | 'RuntimeError' | 'InvalidJson' | 'Internal'
  missingPackage?: string
  errorMessage?: string
  traceback?: string
}
```

---

## 3. 用户代码契约

### 3.1 通用约定

1. 用户只写 **核心逻辑 + 头部元数据**，不写 Runner / `if __name__`（Python）或 `main`（Bun）。
2. 必须导出（或定义）`run(params)`，入参为 JSON 对象，返回值应可 JSON 序列化。
3. 头部元数据字段：`name`（可选，缺省用表字段）、`description`、`dependencies`、`parameters`。
4. **元数据只在用户点击「提取元数据」时回写 UI / schema；保存代码不静默覆盖已手改字段。**

### 3.2 Python 用户代码

```python
"""
name: fetch_github_stars
description: 获取 GitHub 仓库 Star 数量
dependencies:
  - requests
parameters:
  repo:
    type: string
    description: 仓库名称，如 facebook/react
    required: true
"""
import requests

def run(params):
    repo = params.get("repo")
    resp = requests.get(f"https://api.github.com/repos/{repo}", timeout=15)
    resp.raise_for_status()
    return {"stars": resp.json().get("stargazers_count", 0)}
```

### 3.3 Bun / TypeScript 用户代码

```typescript
/**
 * @name calculate_cost
 * @description 估算文本 Token 数
 * @dependencies
 *   - gpt-tokenizer@^2.1.2
 * @parameters
 *   text:
 *     type: string
 *     description: 待统计文本
 *     required: true
 */
import { encode } from 'gpt-tokenizer'

export default async function run(params: { text: string }) {
  return { tokens: encode(params.text).length }
}
```

也允许 `export function run` / `export async function run`；解析顺序：`default` → `run` → 模块本身若是函数。

### 3.4 元数据 → JSON Schema 映射

| 头注释 | Schema |
| --- | --- |
| `parameters.*.type` | `properties.*.type` |
| `parameters.*.description` | `properties.*.description` |
| `parameters.*.required: true` | 进入顶层 `required` 数组 |
| 其余未知键 | 忽略并在提取结果中 warning |

生成结果必须符合：

```json
{
  "type": "object",
  "properties": {
    "repo": { "type": "string", "description": "仓库名称" }
  },
  "required": ["repo"]
}
```

**提取策略**

- 仅点「提取元数据」触发，返回 `{ name?, description?, dependencies, parametersSchema, warnings[] }`。
- 解析失败：不写库，UI 高亮错误原因；用户可手填 schema 后保存。
- `upsertPlugin` **不**自动提取；保存的是 UI 上当前值（schema 以用户确认后的为准）。

---

## 4. Runner 引导壳与执行协议

### 4.1 临时目录布局

```text
.wd_mem/plugins/{call_id}/
  ├─ runner.py | runner.ts     # 平台拼装
  ├─ user_script.py            # Python：单文件内联用户代码（或独立文件）
  └─ user_script.ts            # Bun：独立模块被 runner import
```

- `call_id`：`uuid`，每次试跑 / Agent 调用唯一。
- 默认：进程结束后 **延迟清理**（保留最近 N=5 次便于排障，可用 `app_config.plugin_keep_runs` 调节；`0` = 立即删）。
- Windows：路径保持 ASCII 安全（沿用 mamba `run_tmp` 经验）；中文仅出现在文件内容中。

### 4.2 Python Runner 壳

```python
import sys, json, traceback

# ===== USER CODE BEGIN =====
{USER_SCRIPT_CONTENT}
# ===== USER CODE END =====

def _load_params():
    raw = sys.stdin.read().strip()
    return json.loads(raw) if raw else {}

if __name__ == "__main__":
    try:
        params = _load_params()
        if not callable(run):
            raise TypeError("用户脚本未定义可调用的 run(params)")
        result = run(params)
        print(json.dumps(result, ensure_ascii=False, default=str))
    except ModuleNotFoundError as e:
        sys.stderr.write(json.dumps({
            "error_type": "DependencyMissing",
            "missing_package": e.name or "",
        }, ensure_ascii=False))
        sys.exit(42)
    except Exception as e:
        sys.stderr.write(json.dumps({
            "error": str(e),
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False))
        sys.exit(1)
```

### 4.3 Bun Runner 壳

```typescript
import userModule from './user_script.ts'

async function main() {
  try {
    const raw = await Bun.stdin.text()
    const params = raw.trim() ? JSON.parse(raw) : {}
    const handler =
      typeof userModule === 'function'
        ? userModule
        : (userModule?.default || userModule?.run)
    if (typeof handler !== 'function') {
      throw new TypeError('用户脚本未导出 default/run 函数')
    }
    const result = await handler(params)
    console.log(JSON.stringify(result ?? null))
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (
      err?.code === 'ERR_MODULE_NOT_FOUND' ||
      err?.code === 'MODULE_NOT_FOUND' ||
      /Cannot find (package|module)/i.test(msg)
    ) {
      console.error(JSON.stringify({
        error_type: 'DependencyMissing',
        missing_package: msg,
      }))
      process.exit(42)
    }
    console.error(JSON.stringify({
      error: msg,
      stack: err?.stack ?? '',
    }))
    process.exit(1)
  }
}

main()
```

### 4.4 执行协议（平台侧）

```text
test / agent_call
  │
  ├─ 校验插件 enabled、runtime、schema
  ├─ 生成 call_id，写 Runner + user_script
  ├─ spawn mamba/bun，stdin 写入 JSON.stringify(params)，关闭 stdin
  ├─ 等待退出 或 timeout（默认插件 timeout_sec，硬上限 300s）
  │
  ├─ exit 0
  │    └─ stdout 尝试 JSON.parse → result；失败则 errorType=InvalidJson（仍算脚本「跑完」但契约违约）
  │
  ├─ exit 42
  │    └─ 解析 stderr JSON → missing_package
  │         ├─ 按声明 dependencies 优先安装；失败再用 missing_package
  │         └─ 安装成功 → 重试一次（仅一次）
  │              ├─ 0 → 成功（depsInstalled 记录）
  │              └─ 非 0 → 失败，透传 stderr
  │
  ├─ exit 其他 / 进程无码
  │    └─ 兼容旧自愈：若 stderr 含 ModuleNotFoundError / Cannot find package，
  │       仍尝试安装重试一次（与现有 sandbox 双轨兼容）
  │
  └─ 写 plugin_run_log + 回写 last_run_*
```

**与现有 `run_script_with_selfheal` 的关系**

| | 现有 sandbox | 本方案插件路径 |
| --- | --- | --- |
| 触发 | stderr 正则 | **优先 exit 42**，正则兜底 |
| 入参 | 无 stdin（脚本内嵌） | **stdin JSON** |
| 重试 | 1 次 | 1 次（相同） |
| 返回 | `ScriptRunResult` | `PluginTestResult`（更丰富） |

实现上在 `plugin_runner` 内扩展 spawn：支持写 stdin；不要直接复用无 stdin 的 `run_python_script` 表面。

### 4.5 超时

- 使用异步等待 + kill 子进程（micromamba run / bun 会带子进程，需尽量杀进程树）。
- 超时错误类型：`Timeout`，`error_type` 写入日志，exit 视平台能力（可模拟 124）。

---

## 5. 安全与执行策略

### 5.1 默认立场

**插件 = 用户本机任意代码，默认高敏。**

| 控制项 | v1 策略 |
| --- | --- |
| 权限级 | `PermissionLevel::RequireApproval`（默认） |
| 与 `allow_sandbox` | Agent 必须 `allow_sandbox=1` 才注册插件工具；否则向导保存时警告、运行时不加载 |
| 网络 | v1 不强制拦截（与现 sandbox 一致）；可继承 `http_allowed_hosts` **仅当**用户脚本走平台 HTTP 工具时 |
| 文件系统 | 以 `call_id` 目录为工作目录；不额外授予 workspace 写权限（用户若自己 os 写盘属沙箱外风险，与现 Python 沙箱同级） |
| 超时 | 每插件 `timeout_sec`，默认 60s，硬上限 300s |
| 输出上限 | stdout/stderr 各截断至 64KB（日志与 LLM 上下文均用截断版） |
| 依赖安装 | 不限白名单（与现 mamba/bun 自愈一致），但 **首次安装需审批** 或走「保存时预装」显式按钮 |
| 参数落盘 | `plugin_run_log.params` 建议截断 8KB；后续可加「敏感键脱敏」开关 |

### 5.2 审批策略（与现有 ApprovalManager 对齐）

- 试跑（用户主动点）：**无需再审批**（等于用户已确认执行）。
- Agent 自动调用：走 `RequireApproval`；若 Agent 的 `auto_tool_exec_mode=1`，产品层需显式提示「插件也将在自动执行范围内」。
- 可选 v1.5：绑定表增加 `trust_level`（`normal` \| `trusted`），trusted 可跳过审批。v1 不做，避免权限模型过早复杂化。

### 5.3 identifier 校验

```text
正则：^[a-z][a-z0-9_-]{1,47}$
拒绝：native__ / mcp__ / skill__ / custom__ 开头或纯下划线
唯一：UNIQUE(identifier)
```

LLM 侧工具名固定：`custom__{identifier}`。

---

## 6. Tauri IPC 设计

命令集中在 `plugin_commands.rs`，前端经 `invokeCommand` 调用。

| 前端 Mapper 方法 | Rust Command | 说明 |
| --- | --- | --- |
| `listPlugins()` | `list_user_plugins` | 全量列表；`parameters_schema` / `dependencies` 已解析 |
| `getPlugin(id)` | `get_user_plugin` | 单条详情（含 `script_content`） |
| `upsertPlugin(data)` | `upsert_user_plugin` | create/update；**不自动 extract**；校验 schema JSON、identifier |
| `deletePlugin(id)` | `delete_user_plugin` | 删插件 + 级联 `agent_plugin_ref` + 可选清 run_log |
| `setEnabled(id, enabled)` | `set_user_plugin_enabled` | 列表快速启停 |
| `extractMeta(runtime, script)` | `extract_plugin_meta` | 纯解析，不落库 |
| `testPlugin(id, args?)` | `test_user_plugin` | 沙箱试跑；args 空则用 `sample_params` 或 `{}` |
| `saveSampleParams(id, params)` | `save_plugin_sample_params` | 可选，写回示例参数 |
| `listRunLogs(pluginId, limit)` | `list_plugin_run_logs` | 最近执行 |
| `bindPluginToAgent(agentId, pluginId)` | `bind_agent_plugin` | 建绑定（已存在则置 is_active=1） |
| `unbindPluginFromAgent(agentId, pluginId)` | `unbind_agent_plugin` | 删绑定或软删 |
| `setAgentPluginActive(agentId, pluginId, active)` | `set_agent_plugin_active` | 绑定级启停 |
| `listAgentPlugins(agentId)` | `list_agent_plugins` | 按 Agent 查绑定（含插件元数据） |

### 6.1 `upsert_user_plugin` 输入

```typescript
export interface UpsertUserPluginInput {
  id?: string // 空 = 新建
  name: string
  identifier: string
  description: string
  runtime: PluginRuntime
  scriptContent: string
  parametersSchema: Record<string, unknown>
  dependencies?: string[]
  sampleParams?: Record<string, unknown> | null
  enabled?: boolean
  timeoutSec?: number
  scenario?: string | null
}
```

校验顺序：identifier → schema 可序列化且 `type=object` → runtime 枚举 → timeout 范围 → 依赖名非法字符。

### 6.2 `test_user_plugin` 输出

见 §2.5 `PluginTestResult`。前端试跑面板直接绑定该结构。

### 6.3 运行时配置（`load_config` 增量）

在 `AgentRuntimeConfig` 增加：

```rust
pub struct MountedUserPlugin {
    pub plugin_id: String,
    pub identifier: String,      // 无前缀
    pub name: String,
    pub description: String,
    pub runtime: PluginRuntime,  // python | bun
    pub script_content: String,
    pub parameters_schema: serde_json::Value,
    pub timeout_sec: u64,
}

pub struct AgentRuntimeConfig {
    // ...existing
    pub plugin_tools: Vec<MountedUserPlugin>,
}
```

查询：`agent_plugin_ref` JOIN `user_plugin_tool`，条件：

```text
ref.is_active = 1 AND tool.enabled = 1 AND agent.allow_sandbox = 1
```

会话内临时禁用扩展（与 MCP/Skill 对齐）：`AgentRunRequest.disabled_plugin_ids`。

---

## 7. Agent 装配（plugin_adapter）

### 7.1 工具包装

```text
name:        custom__<identifier>
description: [Plugin] {name} — {description}
parameters:  {user parameters_schema}
permission:  RequireApproval
execute:     plugin_runner::run_with_params(plugin, args)
```

`execute` 返回：成功 → `result` 的 JSON 字符串；失败 → `ToolError::ExecutionFailed`（含 stderr/traceback 摘要，已截断）。

### 7.2 注册点

对齐 `runtime.rs` 中 MCP 注册逻辑：

```text
for plugin in &cfg.plugin_tools {
    plugin_adapter::register_plugins_into(&mut registry, plugin);
}
```

系统提示（`load_config`）在沙箱模式段追加一段：

```text
本地插件工具已挂载（前缀 custom__）。仅在任务匹配插件 description 时调用；
传参必须严格符合该工具的 JSON Schema；禁止伪造不存在的 custom__ 工具名。
```

### 7.3 与审批 / 自动执行

- `check_permission` 恒为 `RequireApproval`。
- verifier / recovery 将 `custom__*` 视为「运行类」工具时，可写入 `run_outcomes`（便于 `command_succeeded` 判定）——可选，v1 以返回值字符串为准即可。

---

## 8. 前端 UI

### 8.1 路由与菜单

```typescript
// paths.ts
pluginHub: '/plugin-hub',
export const pluginDetailPath = (id: string) => `/plugin-hub/${id}` // 可选，v1 可用左右栏不跳转
```

TopBar → **百宝箱** 子项新增：

| key | label | path |
| --- | --- | --- |
| llm | LLM | `/model-settings` |
| mcp | MCP | `/mcp-hub` |
| skill | Skill | `/skill-hub` |
| **plugin** | **插件** | **`/plugin-hub`** |

### 8.2 插件中心布局（开发者视图）

```text
┌──────────────┬────────────────────────────────────────────┐
│ 列表          │ 头部：name / identifier / runtime / enabled │
│ ┌──────────┐ │ 中部：Monaco（language 随 runtime 切换）     │
│ │ Python ● │ │        参数 Schema（只读预览 + 可编辑切换）  │
│ │ 汇率转换  │ │ 底部动作条：                                │
│ └──────────┘ │ [提取元数据] [试跑] [保存] [删除]             │
│ ┌──────────┐ │ ─────────────────────────────────────────  │
│ │ Bun   ●  │ │ 试跑面板：JSON 参数编辑 + 结果 Tabs          │
│ │ Token估算│ │   Result / Stdout / Stderr / Deps / Logs    │
│ └──────────┘ │                                            │
│ [+ 新建插件] │                                            │
└──────────────┴────────────────────────────────────────────┘
```

**编辑器**

- 复用 `MonacoJsonEditor`，`mode='code'`，`language='python' | 'typescript'`。
- v1 不引入 TS/Python Language Server；worker 现状仅 json，基础高亮可用，自动补全后置。
- 主题跟随应用明暗。

**提取元数据**

- 调用 `extract_plugin_meta`。
- 成功：更新表单 name/description（仅空或用户确认「覆盖」）、dependencies、schema 预览。
- 失败：notify 错误 + 可手动编辑 schema。

**试跑**

- 参数编辑器：优先 `sample_params`，否则按 schema 生成空壳 `{}`。
- 结果区展示 `PluginTestResult` 全字段；`depsInstalled` 非空时提示「已自动安装依赖」。
- 成功后可点「保存为示例参数」。

**保存**

- 本地校验：identifier、name、description 非空；schema 合法。
- 成功 toast + 刷新列表。

### 8.3 智能体向导

现为 4 步。**改为 5 步：**

```text
1 基本信息 → 2 选择模型 → 3 配置 MCP → 4 本地插件 → 5 编排 Skill
```

- 新组件：`StepPlugin.tsx`
- `draft.ts` 增加：

```typescript
pluginIds: string[]
export const MAX_PLUGINS = 10
```

- 校验：插件数 ≤ 10；若 Agent `allow_sandbox=false` 且勾选了插件 → 阻止保存或强提示并引导打开沙箱。
- 保存时写 `agent_plugin_ref`；读取 `draftFromAgent` 时 listAgentPlugins 填入。

列表 UI：卡片显示 runtime 徽标、enabled、最近运行状态；勾选即绑定。

---

## 9. Mapper 层约定

文件：`src/core/mapper/plugin-mapper.ts`

遵循现有 skill/mcp mapper：

- 行 ↔ 领域模型转换（`safeParse`）
- `getDb()` 统一连接
- 非 Tauri 回退 localStorage（键 `work-duo:plugins` / `work-duo:agent-plugins`），保证浏览器可调 UI
- **不在此写 CREATE TABLE**

核心导出：

```typescript
listPlugins(): Promise<UserPluginTool[]>
getPlugin(id: string): Promise<UserPluginTool | null>
upsertPlugin(input: UpsertUserPluginInput): Promise<UserPluginTool>
deletePlugin(id: string): Promise<void>
setPluginEnabled(id: string, enabled: boolean): Promise<void>
listAgentPlugins(agentId: string): Promise<UserPluginTool[]>
bindPlugin(agentId: string, pluginId: string): Promise<void>
unbindPlugin(agentId: string, pluginId: string): Promise<void>
setAgentPluginActive(agentId: string, pluginId: string, active: boolean): Promise<void>
```

试跑 / 提取元数据走 Rust，不进 SQL mapper。

---

## 10. 示例插件（冷启动）

内置 3 个「模板」（不强制落库，可从 UI「从模板新建」注入）：

| identifier | runtime | 说明 |
| --- | --- | --- |
| `convert_currency` | python | 汇率换算（演示 requests + 依赖自愈） |
| `fetch_github_stars` | python | GitHub stars（演示 API） |
| `count_tokens` | bun | Token 统计（演示 npm 依赖） |

---

## 11. 实施阶段（建议）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0 数据与契约** | 表结构、`database.d.ts`、`plugin-file` / `plugin-mapper` 骨架 | 浏览器/ Tauri 下 list/upsert 可用 |
| **P1 执行闭环** | `plugin_runner`：壳、stdin、42 自愈、超时、日志 | `test_user_plugin` 端到端；缺依赖能装并重试 |
| **P2 Agent 装配** | `plugin_adapter` + `load_config` + 向导 Step 4 | 挂载后 LLM 可调用 `custom__*` |
| **P3 编辑体验** | 插件中心 UI、提取元数据、试跑面板、模板 | 非开发者能 10 分钟写出可用插件 |
| **P4 打磨** | 日志页、清理策略、审批文案、导出 JSON | 可发布说明文档 |

**推荐竖切顺序（若单人开发）：P0 + P1 最小链路先通，再并行 P3 与 P2。**  
不要先做完整 Monaco 再回头补执行器——试跑是验证契约的唯一真实反馈。

---

## 12. 决策记录（ADR 摘要）

| # | 决策 | 理由 |
| --- | --- | --- |
| 1 | 用户只写 `run`，Runner 平台拼装 | 降低门槛，统一错误/自愈出口 |
| 2 | 优先 exit 42，stderr 正则兜底 | 新协议清晰，同时兼容现 sandbox 行为 |
| 3 | 参数走 stdin，不 argv | JSON 大、避免转义地狱 |
| 4 | 元数据显式提取，保存不覆盖 | 避免双写真相 |
| 5 | 绑定表对齐 mcp/skill_ref | is_active / id / updated_at 一致，后续扩展少改 |
| 6 | 默认 RequireApproval + 依赖 allow_sandbox | 用户脚本任意代码，默认高敏 |
| 7 | 插件命令独立模块 | 避免 commands.rs 继续膨胀 |
| 8 | v1 上 run_log 表 | 试跑排障与列表态刚需 |
| 9 | 向导改为 5 步 | 不与 MCP/Skill 步骤抢位置，信息架构清晰 |
| 10 | identifier 禁止用户写入 `custom__` | 命名空间由平台拼接，避免双重前缀 |

---

## 13. 风险与开放问题

| 风险 | 缓解 |
| --- | --- |
| 依赖安装慢导致试跑超时 | 安装阶段单独计时与日志；timeout 不含安装？——建议：**安装不计入插件 timeout_sec**，单独安装超时 120s |
| 用户脚本读环境变量 / 密钥 | 文档警告；后续可选「清洗环境变量」白名单 |
| Monaco 无类型检查 | 提供官方模板 + 试跑错误回传 |
| 与 sandbox 系统提示争抢「如何跑代码」的叙事 | 插件工具存在时，提示优先调 `custom__*`，而不是让模型手写脚本调 native sandbox |
| Windows 杀进程树 | 调用 `taskkill /T /F` 或 tauri shell 封装；P1 必须实测 |

**开放问题（可延后）**

1. 插件是否允许读写当前 Agent 工作空间？（v1：否，仅 call_id 目录）  
2. 是否需要「全局禁用全部插件」总开关？（建议 `app_config.plugin_hub_enabled`）  
3. squad 全局插件是否复用 `global_mcp_ids` 模式？（v2）

---

## 14. 附录：IPC 命令名与保留字速查

```text
工具名：     custom__<identifier>
保留前缀：   native__ mcp__ skill__ custom__
退出码：     0 成功 | 42 依赖缺失 | 1 一般错误 | 124 超时（约定）
临时目录：   .wd_mem/plugins/<call_id>/
Rust 模块：  plugin_commands / plugin_runner / plugin_adapter
前端页面：   /plugin-hub
向导步骤：   Step 4 本地插件
```

---

*本设计可直接作为开发蓝本。DDL 语句已与现有 init/updater 风格对齐；若你按既有升级习惯手动维护 SQL，以 §2 的表结构为准即可。*
