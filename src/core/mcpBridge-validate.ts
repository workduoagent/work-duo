/**
 * F006：MCP UI 意图载荷运行时校验。
 *
 * 背景：dispatch 原先靠 `payload as X` 编译期断言——外部 MCP 客户端可注入任意形状 JSON
 * （典型：agent:round_update 的 patch.segments 非数组流入 segments_json，被 message-ui
 * 当 ChatSegment[] 渲染 → 渲染异常；upsertAgent 同理写入任意形状）。
 *
 * 规则：
 *  - 通用底线：payload 必须为 null/undefined 或普通对象（防标量/数组注入）；
 *  - 按意图声明字段类型：'s'=string，'n'=number，'b'=boolean，'o'=普通对象，'a'=数组，
 *    's[]'/'n[]'/'o[]'=元素数组；尾缀 '?'=可选（undefined/null 均放行，供 patch 置空语义）；
 *    规则值也可以是嵌套 FieldSpec（对普通对象递归校验）；
 *  - 未声明的字段不拦（保持前向兼容）；声明了的字段类型不符即拒绝（throw → 信封 ok:false）。
 *  新增意图时请在此登记载荷形状。
 */

interface FieldSpec {
  [k: string]: string | FieldSpec
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkValue(v: unknown, rule: string | FieldSpec, path: string): string | null {
  if (typeof rule === 'object') {
    // 嵌套对象规格
    if (v === undefined || v === null) return null // 无嵌套规格必填语义，默认宽松
    if (!isPlainObject(v)) return `${path} 类型应为对象`
    return checkShape(v, rule, path)
  }
  const optional = rule.endsWith('?')
  const kind = optional ? rule.slice(0, -1) : rule
  if (v === undefined || v === null) {
    return optional ? null : `${path} 缺失`
  }
  const ok =
    (kind === 's' && typeof v === 'string') ||
    (kind === 'n' && typeof v === 'number' && Number.isFinite(v)) ||
    (kind === 'b' && typeof v === 'boolean') ||
    (kind === 'o' && isPlainObject(v)) ||
    (kind === 'a' && Array.isArray(v)) ||
    (kind === 's[]' && Array.isArray(v) && v.every((x) => typeof x === 'string')) ||
    (kind === 'n[]' && Array.isArray(v) && v.every((x) => typeof x === 'number')) ||
    (kind === 'o[]' && Array.isArray(v) && v.every((x) => isPlainObject(x)))
  return ok ? null : `${path} 类型应为 ${kind}`
}

function checkShape(payload: unknown, spec: FieldSpec, prefix: string): string | null {
  if (!isPlainObject(payload)) return `${prefix}: payload 必须是对象`
  for (const [k, rule] of Object.entries(spec)) {
    const err = checkValue((payload as Record<string, unknown>)[k], rule, `${prefix}.${k}`)
    if (err) return err
  }
  return null
}

const AGENT_UPSERT: FieldSpec = {
  id: 's?',
  name: 's',
  identifier: 's',
  logo: 's?',
  appearance: 'o?',
  scenario: 's?',
  description: 's?',
  systemPrompt: 's?',
  welcomeMessage: 's?',
  llmId: 's?',
  llmConfig: 'o?',
  ttsId: 's?',
  ttsConfig: 'o?',
  sttId: 's?',
  sttConfig: 'o?',
  isActive: 'b?',
  autoToolExecMode: 'b?',
  allowSandbox: 'b?',
  memoryMode: 's?',
  planAutoApproveMode: 's?',
  mcpTools: 'o[]?',
  skillIds: 's[]?',
  pluginIds: 's[]?',
  kbIds: 's[]?',
}

const ROUND_PATCH: FieldSpec = {
  thinkingContent: 's?',
  assistantAnswer: 's?',
  toolCallsSummary: 's?',
  planStepsSummary: 's?',
  segments: 'a?',
  inputTokens: 'n?',
  outputTokens: 'n?',
  endTime: 'n?',
}

const SESSION_PATCH: FieldSpec = {
  sessionName: 's?',
  status: 's?',
  endTime: 'n?',
  summary: 's?',
  errorMessage: 's?',
  totalPromptTokens: 'n?',
  totalCompletionTokens: 'n?',
  toolsTokens: 'n?',
  projectId: 's?',
}

/** 意图 → 载荷字段规格（含嵌套对象/patch 白名单）。未登记的意图只做通用对象底线检查。 */
const INTENT_SPECS: Record<string, FieldSpec> = {
  'agent:ui_create': AGENT_UPSERT,
  'agent:ui_update': AGENT_UPSERT,
  'agent:ui_delete': { id: 's' },
  'agent:ui_get': { id: 's' },
  'agent:session_create': { agentIdentifier: 's', sessionName: 's?', projectId: 's?' },
  'agent:round_create': { sessionId: 's', roundIndex: 'n', userQuestion: 's?', llmCode: 's?', startTime: 'n?' },
  'agent:project_ensure': { rootPath: 's' },
  'agent:round_update': { roundId: 's', patch: ROUND_PATCH },
  'agent:session_update': { id: 's', patch: SESSION_PATCH },
  'agent:session_list': { agentIdentifier: 's' },
  'agent:session_get': { id: 's' },
  'agent:round_list': { sessionId: 's' },
  'agent:server_bind': { agentId: 's', serverIds: 's[]?' },
  'plugin:set_enabled': { id: 's', enabled: 'b' },
  'plugin:test': { pluginId: 's', params: 'o?' },
  'kb:add_tag': { kbId: 's', assetId: 's', tag: 's' },
  'kb:remove_tag': { kbId: 's', assetId: 's', tag: 's' },
  'kb:rename_tag': { kbId: 's', assetId: 's', from: 's', to: 's' },
  'kb:get_tags': { kbId: 's', assetId: 's' },
  'memory:anchor': { key: 's', content: 's', category: 's?', agentId: 's?', sessionId: 's?' },
  'memory:update': { id: 's', key: 's?', content: 's?', category: 's?' },
  'memory:delete': { id: 's' },
  'memory:recall': { id: 's' },
  'memory:confirm_candidate': { id: 's' },
  'memory:reject_candidate': { id: 's' },
  'skill:set_status': { id: 's', status: 'n' },
  'skill:read_file': { identifier: 's', relPath: 's', skillPath: 's?' },
  'skill:write_file': { identifier: 's', relPath: 's', content: 's', skillPath: 's?' },
  'skill:list_files': { identifier: 's', skillPath: 's?' },
  'skill:export': { identifier: 's', skillPath: 's?' },
}

export function validateIntentPayload(intent: string, payload: unknown): string | null {
  if (payload !== null && payload !== undefined && !isPlainObject(payload)) {
    return `${intent}: payload 必须是对象`
  }
  const spec = INTENT_SPECS[intent]
  if (!spec || payload == null) return null
  return checkShape(payload, spec, intent)
}
