/**
 * 自定义脚本插件（User-defined Script Plugin）—— 领域类型 / 运行期选项 / 草稿工厂 / 校验。
 *
 * 说明：持久化由 `src/core/mapper/plugin-mapper.ts` 负责（SQLite：workduo.db）。
 * 这里只保留与 UI / 表单无关的纯领域定义，供页面、组件与 mapper 复用。
 *
 * 关键约定（与用户设计 docs/user-plugin-design.md 对齐）：
 *  - 插件 = 本机可执行函数（FaaS）：用户只写 run(params)，平台沙箱执行并以 custom__<identifier> 注册为智能体工具；
 *  - identifier 不含 custom__ 前缀（前缀由平台拼接），且不得命中 native__ / mcp__ / skill__ / custom__ 保留前缀；
 *  - runtime 仅 'python' | 'bun'；
 *  - parametersSchema 是已 JSON.parse 的对象（落库序列化为 parameters_schema 文本）。
 */

/* ------------------------------------------------------------------ *
 * 1. 领域模型（运行时使用）
 * ------------------------------------------------------------------ */

export type PluginRuntime = 'python' | 'bun'

export interface UserPluginTool {
  id: string // 本地 UUID（文本主键）
  name: string // 展示名
  identifier: string // 唯一标识 slug（不含 custom__ 前缀）
  description: string // 给人看 + 给模型理解意图
  runtime: PluginRuntime // 'python' | 'bun'
  scriptContent: string // 用户核心代码（仅 run + 头注释）
  /** OpenAI function parameters；已 JSON.parse 的对象。 */
  parametersSchema: Record<string, unknown>
  dependencies: string[] // 声明式依赖（如 ['requests']）
  sampleParams: Record<string, unknown> | null // 试跑示例参数，可空
  enabled: boolean // 启用开关
  timeoutSec: number // 单次执行超时（秒），默认 60
  scenario?: string | null // 场景分类 key，可空
  lastRunAt?: string // ISO 时间字符串（列表态冗余）
  lastRunStatus?: 'unknown' | 'success' | 'failed' // 0/1/2
  createdAt: string // ISO 时间字符串
  updatedAt: string
}

/** 智能体 × 插件绑定（agent_plugin_ref 的运行时视图）。 */
export interface AgentPluginRef {
  id: string
  agentId: string
  pluginId: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** 插件执行日志（plugin_run_log 的运行时视图）。 */
export interface PluginRunLog {
  id: string
  pluginId: string
  agentId: string | null
  sessionId: string | null
  source: 'test' | 'agent'
  params: string | null
  ok: boolean
  exitCode: number | null
  durationMs: number | null
  stdout: string | null
  stderr: string | null
  errorType: string | null
  missingPackage: string | null
  createdAt: string
}

/** 试跑 / Agent 调用返回（与 Rust test_user_plugin 出参对齐）。 */
export interface PluginTestResult {
  ok: boolean
  callId: string
  durationMs: number
  exitCode: number | null
  /** 成功时的 run() 返回值（已 JSON.parse，失败则为 null）。 */
  result: unknown
  stdout: string
  stderr: string
  /** 自愈是否发生（依赖缺失 → 安装并重试一次）。 */
  depsInstalled: string[]
  errorType?: 'DependencyMissing' | 'Timeout' | 'RuntimeError' | 'InvalidJson' | 'Internal'
  missingPackage?: string
  errorMessage?: string
  traceback?: string
}

/* ------------------------------------------------------------------ *
 * 2. 表单提交载荷
 * ------------------------------------------------------------------ */

/** upsertPlugin 入参（id 空 = 新建）。 */
export interface UpsertUserPluginInput {
  id?: string
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

/* ------------------------------------------------------------------ *
 * 3. 校验与运行期选项
 * ------------------------------------------------------------------ */

/** 保留前缀：用户 identifier 不得命中（custom__ 由平台拼接）。 */
export const RESERVED_PLUGIN_PREFIXES = ['native__', 'mcp__', 'skill__', 'custom__']

/** identifier 正则：小写字母/数字开头，后续允许小写字母/数字/下划线/连字符，长度 2–48。 */
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9_-]{1,47}$/

export interface PluginIdentifierCheck {
  ok: boolean
  reason?: string
}

/** 校验插件 identifier：格式 + 保留前缀冲突。 */
export function validatePluginIdentifier(identifier: string): PluginIdentifierCheck {
  const id = identifier.trim()
  if (!id) return { ok: false, reason: 'identifier 不能为空' }
  if (RESERVED_PLUGIN_PREFIXES.some((p) => id.startsWith(p))) {
    return {
      ok: false,
      reason: `identifier 不得以保留前缀开头（${RESERVED_PLUGIN_PREFIXES.join(' / ')}）`,
    }
  }
  if (!IDENTIFIER_RE.test(id)) {
    return {
      ok: false,
      reason: 'identifier 须以小写字母/数字开头，仅含小写字母/数字/_/-，长度 2–48',
    }
  }
  return { ok: true }
}

/** runtime 枚举选项。 */
export const PLUGIN_RUNTIME_OPTIONS: { value: PluginRuntime; label: string; ext: string }[] = [
  { value: 'python', label: 'Python', ext: 'py' },
  { value: 'bun', label: 'Bun (TypeScript)', ext: 'ts' },
]

/* ------------------------------------------------------------------ *
 * 4. 草稿工厂
 * ------------------------------------------------------------------ */

/** 创建一个空白插件草稿（用于「新建」）。 */
export function createEmptyPlugin(): UserPluginTool {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name: '',
    identifier: '',
    description: '',
    runtime: 'python',
    scriptContent: '',
    parametersSchema: { type: 'object', properties: {}, required: [] },
    dependencies: [],
    sampleParams: null,
    enabled: true,
    timeoutSec: 60,
    scenario: undefined,
    createdAt: now,
    updatedAt: now,
  }
}
