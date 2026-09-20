/**
 * WorkDuo 自测闭环 —— 前端「逻辑 UI 意图桥」。
 *
 * 设计原则：零侵入。本模块**不修改任何既有产品逻辑**，只「调用」真实 UI handler。
 * Rust 侧内建 MCP Server（src-tauri/src/mcp_server.rs）收到 UI 意图工具调用时，
 * 经 Tauri 事件 `mcp:intent` 派发到本桥；本桥调用与界面按钮**同一个**真实 handler，
 * 完成后经 `invoke('mcp_resolve_result', ...)` 把结果回传 Rust，Rust 再回应 MCP 调用方。
 *
 * 这样自测走的就是真实 Tauri2 全流程：前端校验 → mapper SQL → tauri-plugin-sql → SQLite，
 * 与真人点击行为、副作用完全一致。
 *
 * 激活方式：无条件监听 `mcp:intent`（main.tsx 启动时调用一次 connectMcpBridge()）。
 * 仅在 WorkDuo 真的作为 MCP Server 被驱动时才会收到事件，因此常驻监听零副作用。
 *
 * 注：引擎类工具（agent_run_task / get_status / wait_task / get_run_logs）由 Rust 侧
 * 内建 MCP Server 直接处理，不经过本桥；本桥只承接 UI 意图类工具。
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

import {
  upsertAgent,
  deleteAgent,
  getAgent,
  listAgents,
} from '@/core/mapper/agent-mapper'
import {
  createSession,
  appendRound,
  updateRound,
  updateSession,
  listSessions,
  getSession,
  listRounds,
} from '@/core/mapper/agent-session-mapper'
import type { AgentUpsertInput, AgentInfo } from '@/types/core'

let started = false
let unlisten: UnlistenFn | null = null

/** 在应用启动时调用一次，注册 mcp:intent 监听。幂等。 */
export async function connectMcpBridge(): Promise<void> {
  if (started) return
  started = true

  unlisten = await listen<McpIntent>('mcp:intent', async (event) => {
    const { id, intent, payload } = event.payload
    try {
      const data = await dispatch(intent, payload)
      await invoke('mcp_resolve_result', { id, ok: true, data })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 失败时仍回传，让评测闭环能拿到错误信号，而非超时。
      await invoke('mcp_resolve_result', { id, ok: false, data: { error: message } })
    }
  })

  // eslint-disable-next-line no-console
  console.log('[mcpBridge] 已注册 mcp:intent 监听（WorkDuo 内建 MCP Server 就绪后可被驱动）')
}

/** 解除监听（一般无需调用）。 */
export function disconnectMcpBridge(): void {
  if (unlisten) {
    unlisten()
    unlisten = null
  }
  started = false
}

interface McpIntent {
  id: string
  intent: string
  payload: unknown
}

/** 脱敏 + 瘦身：单条 Agent 只回传必要字段，避免回传体积撑爆 MCP 工具上下文。 */
function slim(a: AgentInfo) {
  return {
    id: a.id,
    name: a.name,
    identifier: a.identifier,
    scenario: a.scenario,
    isActive: a.isActive,
  }
}

/**
 * 将意图分发到真实 handler。意图必须与 UI 控件最终触发的入口一致，
 * 严禁另写一份「测试专用」逻辑。
 */
async function dispatch(intent: string, payload: unknown): Promise<unknown> {
  switch (intent) {
    case 'agent:ui_create':
    case 'agent:ui_update': {
      // upsertAgent 返回全量 AgentInfo[]（含完整字段），直接透传给 MCP 工具会撑爆上下文；
      // 这里只回传本次受影响的那一条（按 id / identifier 定位），与 list 输出同构、体积可控。
      const list = await upsertAgent(payload as AgentUpsertInput)
      const p = payload as { id?: string; identifier?: string }
      const rec =
        list.find((a) => (p.id ? a.id === p.id : a.identifier === p.identifier)) ??
        list[list.length - 1]
      return rec ? slim(rec) : list
    }
    case 'agent:ui_delete': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('agent:ui_delete 缺少 id')
      await deleteAgent(id)
      return { id, deleted: true }
    }
    case 'agent:ui_get': {
      const id = (payload as { id?: string })?.id
      if (!id) throw new Error('agent:ui_get 缺少 id')
      return getAgent(id)
    }
    case 'agent:ui_list': {
      const data = await listAgents()
      // 脱敏 + 瘦身：列表仅返回必要字段，避免回传过大
      return (data as AgentInfo[]).map((a) => ({
        id: a.id,
        name: a.name,
        identifier: a.identifier,
        scenario: a.scenario,
        isActive: a.isActive,
      }))
    }
    // —— 会话 / 轮次：与 Agent 对话页「发送」同款真实 handler ——
    // 走 createSession / appendRound / updateRound / updateSession 真实入口，
    // 与界面点击行为、副作用完全一致，落库后 UI 可直接抽查历史。
    case 'agent:session_create': {
      const p = payload as { agentIdentifier?: string; sessionName?: string; projectId?: string | null }
      if (!p.agentIdentifier) throw new Error('agent:session_create 缺少 agentIdentifier')
      return createSession(p.agentIdentifier, p.sessionName, { projectId: p.projectId ?? null })
    }
    case 'agent:round_create': {
      const p = payload as Parameters<typeof appendRound>[0]
      if (!p?.sessionId) throw new Error('agent:round_create 缺少 sessionId')
      return appendRound(p)
    }
    case 'agent:round_update': {
      const p = payload as { roundId?: string; patch?: Record<string, unknown> }
      if (!p?.roundId) throw new Error('agent:round_update 缺少 roundId')
      await updateRound(p.roundId, p.patch ?? {})
      return { ok: true }
    }
    case 'agent:session_update': {
      const p = payload as { id?: string; patch?: Record<string, unknown> }
      if (!p?.id) throw new Error('agent:session_update 缺少 id')
      await updateSession(p.id, p.patch ?? {})
      return { ok: true }
    }
    case 'agent:session_list': {
      const p = payload as { agentIdentifier?: string }
      if (!p?.agentIdentifier) throw new Error('agent:session_list 缺少 agentIdentifier')
      return listSessions(p.agentIdentifier)
    }
    case 'agent:session_get': {
      const p = payload as { id?: string }
      if (!p?.id) throw new Error('agent:session_get 缺少 id')
      return getSession(p.id)
    }
    case 'agent:round_list': {
      const p = payload as { sessionId?: string }
      if (!p?.sessionId) throw new Error('agent:round_list 缺少 sessionId')
      return listRounds(p.sessionId)
    }
    default:
      throw new Error(`未知意图: ${intent}`)
  }
}
