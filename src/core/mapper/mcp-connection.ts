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
import { MCP_TIMEOUT_SEC_DEFAULT, timeoutHint } from '@/core/constants/runtime'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'
import {
  getOauthTokens,
  type McpInfo,
  type McpOauthTokens,
  type McpToolDefinition,
} from '@/core/file/mcp-file'
import type { McpStatus } from '@/types/core'

export interface McpConnectionResult {
  /** 1 正常 / 2 异常（测试总有确定结果，不会返回 0） */
  status: McpStatus
  ok: boolean
  error?: string
  latencyMs: number
  tools: McpToolDefinition[]
}

/** 工具调用结果（编辑测试参数弹窗「测试」按钮使用）。 */
export interface McpToolCallResult {
  ok: boolean
  error?: string
  /** tools/call 响应的解析结果（原始 JSON 文本解析失败时为字符串） */
  value?: unknown
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
  // OAUTH2：authConfig.oauth.accessToken → Authorization（Tauri 路径由 Rust 刷新，这里是浏览器回退）
  const oauth = getOauthTokens(mcp.authConfig)
  if (oauth?.accessToken && !h.Authorization) {
    h.Authorization = `${oauth.tokenType || 'Bearer'} ${oauth.accessToken}`
  }
  // Streamable HTTP 协议必备：Accept 必须同时含 application/json 与 text/event-stream，
  // Content-Type 必须为 application/json。放在最后覆盖用户误填的值，否则远端会返回
  // 406 Not Acceptable（"Client must accept both application/json and text/event-stream"）。
  h.Accept = 'application/json, text/event-stream'
  h['Content-Type'] = 'application/json'
  return h
}

/**
 * 发送 MCP `notifications/initialized` 通知（initialize 握手成功后、调用其它方法前）。
 * 部分严格服务端（如 MinerU）会要求此通知，缺失会报 "not initialized"。
 * 通知无 id、不期待结果，best-effort：发送失败也不阻断后续调用（由下游真实错误暴露）。
 */
async function notifyInitialized(
  url: string,
  headers: Record<string, string>,
  sessionId: string | null,
): Promise<void> {
  const h: Record<string, string> = { ...headers }
  if (sessionId) h['Mcp-Session-Id'] = sessionId
  try {
    await fetch(url, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    })
  } catch {
    /* best-effort：忽略通知发送失败 */
  }
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
 * @param mcp 取 protocolType / endpointUrl / headers / authType / authConfig / timeoutSec
 */
export async function testMcpConnection(
  mcp: Pick<
    McpInfo,
    'protocolType' | 'endpointUrl' | 'headers' | 'authType' | 'authConfig' | 'timeoutSec'
  >,
): Promise<McpConnectionResult> {
  const start = performance.now()
  const timeoutMs = (mcp.timeoutSec ?? MCP_TIMEOUT_SEC_DEFAULT) * 1000
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
  const timer = setTimeout(() => controller.abort(), timeoutMs)

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

    // 1.5) 发送 notifications/initialized（MCP 规范要求；部分严格服务端
    // 会在 tools/list 前要求此通知，缺失会报 "not initialized"）。best-effort。
    await notifyInitialized(url, headers, sessionId)

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
        ? `连接超时（${timeoutHint(mcp.timeoutSec ?? MCP_TIMEOUT_SEC_DEFAULT)}），请检查地址与网络`
        : `连接异常：${err.message}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 连通 MCP 并发现工具（对外统一入口）。
 *  - Tauri 运行时：走 Rust 后端 `sync_mcp_tools` 命令（reqwest，不受浏览器 CORS 限制）；
 *  - 非 Tauri（浏览器 dev）：回退前端 `testMcpConnection` 的 fetch 探测。
 * 返回结构与 testMcpConnection 一致，调用方无需关心实现差异。
 */
export async function connectMcp(
  mcp: Pick<
    McpInfo,
    'protocolType' | 'endpointUrl' | 'headers' | 'authType' | 'authConfig' | 'timeoutSec'
  >,
): Promise<McpConnectionResult> {
  if (!isTauri) return testMcpConnection(mcp)

  try {
    const res = await invoke<{
      status: number
      ok: boolean
      error?: string
      latencyMs: number
      tools: Record<string, unknown>[]
    }>('sync_mcp_tools', {
      request: {
        endpointUrl: mcp.endpointUrl ?? '',
        protocolType: mcp.protocolType,
        headers: mcp.headers ?? {},
        authType: mcp.authType,
        authConfig: mcp.authConfig ?? {},
        timeoutSec: mcp.timeoutSec ?? MCP_TIMEOUT_SEC_DEFAULT,
      },
    })
    const tools: McpToolDefinition[] = (res.tools ?? []).map((t) => mapTool(t))
    return {
      status: (res.status === 1 ? 1 : 2) as McpStatus,
      ok: res.ok,
      error: res.error,
      latencyMs: res.latencyMs,
      tools,
    }
  } catch (e) {
    return {
      status: 2,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      latencyMs: 0,
      tools: [],
    }
  }
}

/**
 * 调用 MCP 工具的 tools/call（编辑测试参数弹窗「测试」按钮使用）。
 *  - Tauri 运行时：走 Rust 后端 `call_mcp_tool` 命令（reqwest，不受浏览器 CORS 限制）；
 *  - 非 Tauri（浏览器 dev）：回退前端 fetch 探测（内网服务可能受 CORS 拦截，属预期）。
 * 返回结构含 ok / error 与解析后的 value（供结果回显）。
 */
export async function callMcpTool(
  mcp: Pick<
    McpInfo,
    'protocolType' | 'endpointUrl' | 'headers' | 'authType' | 'authConfig' | 'timeoutSec'
  >,
  toolName: string,
  args: Record<string, unknown> | undefined,
): Promise<McpToolCallResult> {
  if (!isTauri) return callMcpToolFetch(mcp, toolName, args)
  try {
    const res = await invoke<{ ok: boolean; error?: string; raw: string }>(
      'call_mcp_tool',
      {
        request: {
          endpointUrl: mcp.endpointUrl ?? '',
          protocolType: mcp.protocolType,
          headers: mcp.headers ?? {},
          authType: mcp.authType,
          authConfig: mcp.authConfig ?? {},
          timeoutSec: mcp.timeoutSec ?? MCP_TIMEOUT_SEC_DEFAULT,
          toolName,
          arguments: args ?? {},
        },
      },
    )
    let value: unknown = res.raw
    try {
      value = JSON.parse(res.raw)
    } catch {
      /* 保留原始文本 */
    }
    return { ok: res.ok, error: res.error, value }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/* ------------------------------------------------------------------ *
 * OAuth2 授权登录（浏览器弹窗 + 本地回调，由 Rust mcp_oauth_* 命令支撑）
 * ------------------------------------------------------------------ */

export interface McpOauthBeginResult {
  sessionId: string
  authorizeUrl: string
  redirectUri: string
}

/**
 * 发起 OAuth2 授权：发现元数据 → 动态注册 → PKCE → 返回浏览器授权 URL。
 * 需随后打开 authorizeUrl，并调用 `waitMcpOauth` 取 token。
 */
export async function beginMcpOauth(
  endpointUrl: string,
  scopes?: string[],
  clientName?: string,
): Promise<McpOauthBeginResult> {
  return invoke<McpOauthBeginResult>('mcp_oauth_begin', {
    request: {
      endpointUrl,
      scopes: scopes ?? undefined,
      clientName: clientName ?? 'WorkDuo',
    },
  })
}

/** 等待浏览器授权回调并完成 code→token 交换。 */
export async function waitMcpOauth(
  sessionId: string,
  timeoutSec = 180,
): Promise<McpOauthTokens> {
  const res = await invoke<{ tokens: McpOauthTokens }>('mcp_oauth_wait', {
    sessionId,
    timeoutSec,
  })
  return res.tokens
}

/** 手动刷新 access_token（通常由 Rust 请求路径自动完成）。 */
export async function refreshMcpOauth(
  authConfig: Record<string, unknown>,
): Promise<McpOauthTokens> {
  const res = await invoke<{ tokens: McpOauthTokens }>('mcp_oauth_refresh', {
    authConfig,
  })
  return res.tokens
}

/**
 * 一键 OAuth 登录（begin → 打开浏览器 → wait）。
 * 仅 Tauri 环境可用；浏览器 dev 回退 window.open 并提示。
 */
export async function loginMcpOauth(
  endpointUrl: string,
  opts?: { scopes?: string[]; clientName?: string; timeoutSec?: number },
): Promise<McpOauthTokens> {
  if (!isTauri) {
    throw new Error('OAuth 授权登录需要在 WorkDuo 桌面端使用')
  }
  const begin = await beginMcpOauth(endpointUrl, opts?.scopes, opts?.clientName)
  // 优先系统浏览器（用户记忆中的「点连接弹浏览器」体验）
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(begin.authorizeUrl)
  } catch {
    window.open(begin.authorizeUrl, '_blank', 'noopener,noreferrer')
  }
  return waitMcpOauth(begin.sessionId, opts?.timeoutSec ?? 180)
}

/** 非 Tauri 的 tools/call 回退实现（与 testMcpConnection 同范式的 fetch 探测）。 */
async function callMcpToolFetch(
  mcp: Pick<
    McpInfo,
    'protocolType' | 'endpointUrl' | 'headers' | 'authType' | 'authConfig' | 'timeoutSec'
  >,
  toolName: string,
  args: Record<string, unknown> | undefined,
): Promise<McpToolCallResult> {
  const fail = (error: string): McpToolCallResult => ({
    ok: false,
    error,
  })

  if (mcp.protocolType === 'STDIO') {
    return fail('STDIO 类型需本地进程支持，无法在网页端调用工具（请改用 HTTP / SSE）')
  }
  if (!mcp.endpointUrl) {
    return fail('缺少 endpointUrl（SSE / HTTP 类型必须填写访问地址）')
  }

  const url = mcp.endpointUrl
  const headers = buildHeaders(mcp)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (mcp.timeoutSec ?? MCP_TIMEOUT_SEC_DEFAULT) * 1000)

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
    const sessionId =
      initRes.headers.get('mcp-session-id') ||
      initRes.headers.get('Mcp-Session-Id')
    if (sessionId) headers['Mcp-Session-Id'] = sessionId
    if (!initRes.ok) {
      const text = await initRes.text().catch(() => '')
      return fail(`initialize 失败：HTTP ${initRes.status} ${text.slice(0, 200)}`)
    }

    // 1.5) 发送 notifications/initialized（MCP 规范要求；best-effort）
    await notifyInitialized(url, headers, sessionId)

    // 2) tools/call
    const callRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: toolName, arguments: args ?? {} },
      }),
      signal: controller.signal,
    })
    const raw = await callRes.text().catch(() => '')
    let value: unknown = raw
    try {
      value = JSON.parse(raw)
    } catch {
      /* 保留原始文本 */
    }
    if (!callRes.ok) {
      return fail(`tools/call 失败：HTTP ${callRes.status} ${raw.slice(0, 200)}`)
    }
    return { ok: true, value }
  } catch (e) {
    const err = e as Error
    return fail(
      err.name === 'AbortError'
        ? `连接超时（${timeoutHint(mcp.timeoutSec ?? MCP_TIMEOUT_SEC_DEFAULT)}），请检查地址与网络`
        : `调用异常：${err.message}`,
    )
  } finally {
    clearTimeout(timer)
  }
}
