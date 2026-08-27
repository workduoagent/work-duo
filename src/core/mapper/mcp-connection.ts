/**
 * MCP 连通性测试 + 工具发现（纯网络层，不依赖数据库）。
 *
 * 做法：
 *  - HTTP / SSE：按 MCP（Model Context Protocol）JSON-RPC 流程执行
 *      initialize 握手 -> tools/list，解析返回的工具列表；
 *  - STDIO：需本地子进程，网页端（含浏览器 dev / Tauri webview）无法直连，
 *      直接返回「异常」并提示改用 HTTP / SSE。
 *
 * 返回 McpConnectionResult：status(1 正常 / 2 异常)、是否成功、错误信息、
 * 耗时、以及发现的工具列表（工具 mcpId 由调用方回填后写入库）。
 *
 * 注意：真实的 STDIO 进程拉起应在后端 / Tauri Rust 命令内完成，这里仅做
 * 网页端可执行的 HTTP / SSE 探测，足以验证「接入」是否可达并拉取工具清单。
 */
import type { McpInfo, McpToolDefinition } from '@/core/file/mcp-file'
import type { McpStatus } from '@/types/core'

export interface McpConnectionResult {
  /** 1 正常 / 2 异常（测试总有确定结果，不会返回 0） */
  status: McpStatus
  ok: boolean
  error?: string
  latencyMs: number
  tools: McpToolDefinition[]
}

const JSON_RPC_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

/** 构造请求头：合并用户 headers，并在 API_KEY 时把 authConfig 注入为请求头。 */
function buildHeaders(
  mcp: Pick<McpInfo, 'headers' | 'authConfig' | 'authType'>,
): Record<string, string> {
  const h: Record<string, string> = { ...JSON_RPC_HEADERS }
  if (mcp.headers) {
    for (const [k, v] of Object.entries(mcp.headers)) h[k] = String(v)
  }
  // API_KEY：authConfig 形如 { key_name, key_value } 时注入为请求头
  if (mcp.authType === 'API_KEY' && mcp.authConfig) {
    const cfg = mcp.authConfig as Record<string, unknown>
    const kn = cfg.key_name
    const kv = cfg.key_value
    if (typeof kn === 'string' && typeof kv === 'string') h[kn] = kv
  }
  return h
}

/** 把一个 MCP 原始工具对象映射为本域 McpToolDefinition（mcpId 由调用方回填）。 */
function mapTool(raw: Record<string, unknown>): McpToolDefinition {
  const now = new Date().toISOString()
  const name = (raw.name as string) ?? ''
  return {
    id: crypto.randomUUID(),
    mcpId: '',
    toolCode: name,
    displayName: (raw.title as string) || name,
    description: (raw.description as string) || undefined,
    inputSchema: (raw.inputSchema as Record<string, unknown>) || undefined,
    outputSchema: (raw.outputSchema as Record<string, unknown>) || undefined,
    endpoint: undefined,
    methodType: 'POST',
    isActive: true,
    timeout: 0,
    testParams: undefined,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 执行一次 MCP 连通性测试。
 * @param mcp 取 protocolType / endpointUrl / headers / authType / authConfig
 */
export async function testMcpConnection(
  mcp: Pick<
    McpInfo,
    'protocolType' | 'endpointUrl' | 'headers' | 'authType' | 'authConfig'
  >,
): Promise<McpConnectionResult> {
  const start = performance.now()
  const fail = (error: string): McpConnectionResult => ({
    status: 2,
    ok: false,
    error,
    latencyMs: Math.round(performance.now() - start),
    tools: [],
  })

  if (mcp.protocolType === 'STDIO') {
    return fail(
      'STDIO 类型需本地进程支持，无法在网页端执行连通性测试（请改用 HTTP / SSE）',
    )
  }
  if (!mcp.endpointUrl) {
    return fail('缺少 endpointUrl（SSE / HTTP 类型必须填写访问地址）')
  }

  const url = mcp.endpointUrl
  const headers = buildHeaders(mcp)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)

  try {
    // 1) initialize 握手
    const initRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'work-duo', version: '1.0.0' },
        },
      }),
      signal: controller.signal,
    })
    // Streamable HTTP 会在响应头返回会话 id，后续请求需带上
    const sessionId =
      initRes.headers.get('mcp-session-id') ||
      initRes.headers.get('Mcp-Session-Id')
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    if (!initRes.ok) {
      const text = await initRes.text().catch(() => '')
      return fail(`initialize 失败：HTTP ${initRes.status} ${text.slice(0, 200)}`)
    }

    // 2) tools/list
    const toolsRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
      signal: controller.signal,
    })
    if (!toolsRes.ok) {
      const text = await toolsRes.text().catch(() => '')
      return fail(`tools/list 失败：HTTP ${toolsRes.status} ${text.slice(0, 200)}`)
    }
    const data = (await toolsRes.json().catch(() => null)) as
      | { result?: { tools?: Record<string, unknown>[] } }
      | null
    const rawTools: Record<string, unknown>[] = data?.result?.tools ?? []
    const tools = rawTools.map(mapTool)
    return {
      status: 1,
      ok: true,
      latencyMs: Math.round(performance.now() - start),
      tools,
    }
  } catch (e) {
    const err = e as Error
    return fail(
      err.name === 'AbortError'
        ? '连接超时（>15s），请检查地址与网络'
        : `连接异常：${err.message}`,
    )
  } finally {
    clearTimeout(timer)
  }
}
