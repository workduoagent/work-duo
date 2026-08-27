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
  scenario?: McpScenario // 使用场景 key
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
    createdAt: now,
    updatedAt: now,
  }
}
