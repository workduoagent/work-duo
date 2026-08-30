/**
 * MCP 服务接入 —— 领域类型 / 运行期选项 / 文案 helper / 草稿工厂。
 *
 * 说明：
 *  - 持久化由 `src/core/mapper/mcp-mapper.ts` 负责（SQLite：workduo.db）。
 *  - 这里只保留与 UI / 表单无关的纯领域定义，供页面、组件与 mapper 复用。
 *  - 枚举（协议 / 认证 / 状态 / 场景）的「值」在 types/core.d.ts，本文件提供
 *    对应的「运行期选项列表 + 文案」(与 ModelCategory / SkillCategory 同范式)。
 *  - 本模块只做「接入」(connect)，不提供「构建」(build) MCP 的能力；工具
 *    (mcp_tool_definition) 由连通性测试 / 同步时自动发现并写入。
 */
import type {
  McpProtocolType,
  McpAuthType,
  McpStatus,
  McpScenario,
} from '@/types/core'

/* ------------------------------------------------------------------ *
 * 1. 领域模型（运行时使用）
 * ------------------------------------------------------------------ */

/** MCP 服务接入记录。 */
export interface McpInfo {
  id: string // 本地 UUID（文本主键）
  aliasName?: string // 展示别名（卡片展示用）
  mcpName: string // 服务标识（导出 mcp.json 的 key，如 file-system）
  protocolType: McpProtocolType // STDIO / SSE / HTTP
  endpointUrl?: string // SSE / HTTP 地址；STDIO 留空
  headers?: Record<string, string> // 请求头
  authType: McpAuthType // NONE / API_KEY / OAUTH2
  authConfig?: Record<string, unknown> // 认证配置
  isActive: boolean // 启用开关
  status: McpStatus // 0 未测试 / 1 正常 / 2 异常
  capabilities?: unknown[] // 能力列表
  properties?: Record<string, unknown> // 扩展配置
  description?: string
  scenario?: string // 使用场景 key（对应 scenario_category.value）
  timeoutSec?: number // 请求超时（秒），默认 120；用于连通性测试 / 工具调用
  createdAt: string // ISO 时间字符串（与 SQLite epoch 毫秒在 mapper 层互转）
  updatedAt: string
}

/** MCP 工具定义（由连通性测试 / 同步自动发现）。 */
export interface McpToolDefinition {
  id: string
  mcpId: string // 关联 mcp_info.id
  toolCode?: string // 工具唯一代码，如 get_weather_data
  displayName?: string // 展示名，如 获取天气数据
  description?: string
  inputSchema?: Record<string, unknown> // 入参 Schema
  outputSchema?: Record<string, unknown> // 出参 Schema
  endpoint?: string // HTTP 模式地址
  methodType?: string // POST / GET
  isActive: boolean // 启用开关
  timeout: number // 延时毫秒
  testParams?: Record<string, unknown> // 测试参数
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ *
 * 2. 运行期选项（枚举文案在此，而非 core.d.ts）
 * ------------------------------------------------------------------ */

/** 协议类型下拉选项。 */
export const MCP_PROTOCOL_OPTIONS = [
  { value: 'STDIO', label: 'STDIO（本地进程）' },
  { value: 'SSE', label: 'SSE' },
  { value: 'HTTP', label: 'HTTP（Streamable）' },
] as const

/** 认证类型下拉选项。 */
export const MCP_AUTH_OPTIONS = [
  { value: 'NONE', label: 'NONE（无认证）' },
  { value: 'API_KEY', label: 'API_KEY' },
  { value: 'OAUTH2', label: 'OAUTH2' },
] as const

/** 连通状态下拉选项（0 未测试 / 1 正常 / 2 异常）。 */
export const MCP_STATUS_OPTIONS = [
  { value: 0, label: '未测试' },
  { value: 1, label: '正常' },
  { value: 2, label: '异常' },
] as const

/** 使用场景下拉选项（value = McpScenario，label = 展示文案）。 */
export const MCP_SCENARIO_OPTIONS = [
  { value: 'file-system', label: '文件系统' },
  { value: 'web-search', label: '网络搜索' },
  { value: 'database', label: '数据库' },
  { value: 'dev-tools', label: '开发工具' },
  { value: 'communication', label: '通信协作' },
  { value: 'productivity', label: '生产力' },
] as const

const PROTOCOL_LABEL_MAP: Record<string, string> = Object.fromEntries(
  MCP_PROTOCOL_OPTIONS.map((o) => [o.value, o.label]),
)
const AUTH_LABEL_MAP: Record<string, string> = Object.fromEntries(
  MCP_AUTH_OPTIONS.map((o) => [o.value, o.label]),
)
const STATUS_LABEL_MAP: Record<number, string> = Object.fromEntries(
  MCP_STATUS_OPTIONS.map((o) => [o.value, o.label]),
)
const SCENARIO_LABEL_MAP: Record<string, string> = Object.fromEntries(
  MCP_SCENARIO_OPTIONS.map((o) => [o.value, o.label]),
)

export function getMcpProtocolLabel(p?: McpProtocolType | string | null): string {
  if (!p) return '-'
  return PROTOCOL_LABEL_MAP[p] ?? p
}

export function getMcpAuthLabel(a?: McpAuthType | string | null): string {
  if (!a) return '-'
  return AUTH_LABEL_MAP[a] ?? a
}

/** status 数字 -> 展示文案；非法值返回「未测试」。 */
export function getMcpStatusLabel(s?: McpStatus | number | null): string {
  if (s === undefined || s === null) return '未测试'
  return STATUS_LABEL_MAP[s] ?? '未测试'
}

export function getMcpScenarioLabel(s?: McpScenario | string | null): string {
  if (!s) return '未分类'
  return SCENARIO_LABEL_MAP[s] ?? s
}

/* ------------------------------------------------------------------ *
 * 4. 导出（标准 mcpServers.json 格式）
 * ------------------------------------------------------------------ */

/**
 * 把单条 MCP 接入记录转为标准 mcpServers.json 的「服务配置」对象。
 *
 * 标准格式约定：
 *  - STDIO（本地进程）：{ command, args?, env? }
 *    command / args / env 取自扩展配置 properties（本模块「仅接不建」，
 *    不提供独立表单字段，故放在 properties 透传）；
 *  - SSE / HTTP（远程）：{ url, headers? }
 *    url 取自 endpointUrl，headers 取自 headers。
 */
export function mcpToServerConfig(mcp: McpInfo): Record<string, unknown> {
  const cfg: Record<string, unknown> = {}
  // 写出标准 type 字段：STDIO / SSE / HTTP（我们的 HTTP 选项即 Streamable HTTP 传输）
  cfg.type =
    mcp.protocolType === 'STDIO'
      ? 'stdio'
      : mcp.protocolType === 'SSE'
        ? 'sse'
        : 'streamableHttp'
  if (mcp.protocolType === 'STDIO') {
    const props = (mcp.properties ?? {}) as Record<string, unknown>
    if (typeof props.command === 'string') cfg.command = props.command
    if (Array.isArray(props.args)) cfg.args = props.args
    if (props.env && typeof props.env === 'object') cfg.env = props.env
  } else if (mcp.endpointUrl) {
    cfg.url = mcp.endpointUrl
  }
  if (mcp.headers && Object.keys(mcp.headers).length > 0) {
    cfg.headers = mcp.headers
  }
  return cfg
}

/**
 * 构建标准 mcpServers.json 结构：{ mcpServers: { [服务标识]: 服务配置 } }。
 * 服务标识优先用 mcpName（导出 key），缺失时回退别名 / id。
 */
export function buildMcpServersJson(
  mcps: McpInfo[],
): { mcpServers: Record<string, Record<string, unknown>> } {
  const servers: Record<string, Record<string, unknown>> = {}
  for (const mcp of mcps) {
    const key = mcp.mcpName || mcp.aliasName || mcp.id
    servers[key] = mcpToServerConfig(mcp)
  }
  return { mcpServers: servers }
}

/* ------------------------------------------------------------------ *
 * 5. 导入（解析标准 mcpServers.json）
 * ------------------------------------------------------------------ */

/** 导入解析结果：归一化后的 McpInfo 草稿 + 非致命告警。 */
export interface ParsedMcpImport {
  items: McpInfo[]
  warnings: string[]
}

/** 服务标识合法正则（与 McpFormModal 校验一致）。 */
const MCP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{1,49}$/

/** 把任意字符串规整为合法 mcpName（避免与既有服务冲突/落库报错）。 */
function sanitizeMcpName(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '')
  if (!s) s = 'mcp'
  if (s.length > 49) s = s.slice(0, 49)
  if (!/^[A-Za-z]/.test(s)) s = `mcp-${s}`
  return s
}

/**
 * 解析标准 mcpServers.json（Claude Desktop / 官方 SDK 格式），归一化为 McpInfo 草稿。
 *
 * 类型映射：
 *  - stdio            → STDIO（command / args / env 进 properties）
 *  - sse              → SSE
 *  - streamableHttp / http(s) / 未知 → HTTP（Streamable，后端按 POST Streamable 处理）
 *
 * 远程服务（HTTP / SSE）无子进程，env 需转成请求头：
 *  - env 一律作为「同名请求头」转发（原始值，不加 Bearer 前缀）；这是 MCP 客户端
 *    的通用约定，mineru 等 SaaS 即以 MINERU_API_TOKEN 头名鉴权，而非 Authorization。
 *  - 形如 *_TOKEN / *API_KEY / *API_TOKEN 的变量额外补 `Authorization: Bearer <值>`
 *    作为兜底，兼容以 Bearer 头鉴权的 Provider；同时写入 authConfig 供表单展示。
 *  - 同时出现的 headers 字段直接并入请求头。
 */
export function parseMcpServersJson(raw: string): ParsedMcpImport {
  const warnings: string[] = []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const root = (data ?? null) as Record<string, unknown> | null
  const servers =
    root && typeof root === 'object' && root.mcpServers && typeof root.mcpServers === 'object'
      ? (root.mcpServers as Record<string, unknown>)
      : (root as Record<string, unknown> | null)
  if (!servers || typeof servers !== 'object' || Object.keys(servers).length === 0) {
    throw new Error('未找到 mcpServers 配置（需要 { "mcpServers": { ... } } 结构）')
  }

  const items: McpInfo[] = []
  for (const [key, val] of Object.entries(servers)) {
    if (!val || typeof val !== 'object') {
      warnings.push(`「${key}」配置无效，已跳过`)
      continue
    }
    const cfg = val as Record<string, unknown>
    const typeRaw = typeof cfg.type === 'string' ? (cfg.type as string) : ''
    const type = typeRaw.toLowerCase()

    let protocolType: McpProtocolType
    if (type === 'stdio') protocolType = 'STDIO'
    else if (type === 'sse') protocolType = 'SSE'
    else {
      protocolType = 'HTTP'
      if (type && type !== 'streamablehttp' && type !== 'http' && type !== 'https') {
        warnings.push(`「${key}」未知类型 "${typeRaw}"，已按 HTTP（Streamable）处理`)
      }
    }

    const mcpName = MCP_NAME_RE.test(key) ? key : (() => {
      const safe = sanitizeMcpName(key)
      warnings.push(`「${key}」标识不合法，已规整为 "${safe}"`)
      return safe
    })()

    const now = new Date().toISOString()
    const base: McpInfo = {
      id: crypto.randomUUID(),
      aliasName: '',
      mcpName,
      protocolType,
      authType: 'NONE',
      isActive: true,
      status: 0,
      createdAt: now,
      updatedAt: now,
    }

    // STDIO：command / args / env 透传进 properties（与导出对称）
    if (protocolType === 'STDIO') {
      const props: Record<string, unknown> = {}
      if (typeof cfg.command === 'string') props.command = cfg.command
      if (Array.isArray(cfg.args)) props.args = cfg.args
      if (cfg.env && typeof cfg.env === 'object') props.env = cfg.env
      base.properties = props
      items.push(base)
      continue
    }

    // 远程（HTTP / SSE）
    if (typeof cfg.url === 'string' && cfg.url.trim()) base.endpointUrl = cfg.url.trim()
    else warnings.push(`「${key}」缺少 url，导入后请补全访问地址`)

    const headers: Record<string, string> = {}
    if (cfg.headers && typeof cfg.headers === 'object') {
      for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') headers[k] = String(v)
      }
    }

    // env → 请求头（远程服务无子进程，env 按「同名请求头」转发，这是 MCP 客户端
    // 的通用约定：mineru 等 SaaS 即以 MINERU_API_TOKEN 头名鉴权，而非 Authorization）。
    if (cfg.env && typeof cfg.env === 'object') {
      for (const [k, v] of Object.entries(cfg.env as Record<string, unknown>)) {
        const s = typeof v === 'string' || typeof v === 'number' ? String(v) : ''
        if (!s) continue
        // 一律作为同名请求头转发（原始值，不加 Bearer 前缀）
        headers[k] = s
        // 形如 *_TOKEN / *API_KEY 的变量额外补 Authorization: Bearer 兜底，
        // 兼容以 Bearer 头鉴权的 Provider；同时把认证信息写入 authConfig 供表单展示。
        if (/(token|api[_-]?key)$/i.test(k)) {
          if (!headers.Authorization) headers.Authorization = `Bearer ${s}`
          base.authType = 'API_KEY'
          base.authConfig = { key_name: k, key_value: s }
        }
      }
    }

    if (Object.keys(headers).length > 0) base.headers = headers
    items.push(base)
  }

  return { items, warnings }
}

/* ------------------------------------------------------------------ *
 * 3. 草稿工厂
 * ------------------------------------------------------------------ */

/** 创建一个空白 MCP 接入草稿（用于「接入服务」）。 */
export function createEmptyMcp(): McpInfo {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    aliasName: '',
    mcpName: '',
    protocolType: 'HTTP',
    endpointUrl: '',
    headers: undefined,
    authType: 'NONE',
    authConfig: undefined,
    isActive: true,
    status: 0,
    capabilities: undefined,
    properties: undefined,
    description: '',
    scenario: undefined,
    timeoutSec: 120,
    createdAt: now,
    updatedAt: now,
  }
}
