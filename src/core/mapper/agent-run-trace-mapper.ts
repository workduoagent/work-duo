/**
 * run 轨迹归档的数据访问层（mapper，台账 D4）。
 *
 * 表：agent_run_trace（DDL v32）——run 终态时 Rust 侧全量事件流归档；
 * 本 mapper 供前端「历史轨迹回放」读取（写入方在 Rust，前端只读）。
 */
import { isTauri } from '@/core/config'
import { getDb } from '@/core/db/SqlService'

/** 历史运行索引行（列表视图，不含全量事件以控传输量）。 */
export interface RunTraceIndexItem {
  runId: string
  agentId?: string
  sessionId?: string
  startedAt?: number
  finishedAt: number
  replyHead: string
  promptTokens: number
  completionTokens: number
  eventCount: number
}

/** 完整轨迹（与 Rust events::get_trace 同构）。 */
export interface RunTraceFull {
  runId: string
  events: Array<Record<string, unknown>>
  thinking: string
  reply: string
  counts: {
    events: number
    thinkingChars: number
    replyChars: number
    promptTokens: number
    completionTokens: number
  }
}

interface TraceRow {
  run_id: string
  agent_id: string | null
  session_id: string | null
  started_at: number | null
  finished_at: number
  thinking: string | null
  reply: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  events_json: string
}

/** 历史运行索引：按会话或智能体过滤，started_at 倒序，默认最近 20 条。 */
export async function listRunTraces(filter: { sessionId?: string; agentId?: string; limit?: number }): Promise<RunTraceIndexItem[]> {
  if (!isTauri) return []
  const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100)
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter.sessionId) {
    conditions.push('session_id = ?')
    params.push(filter.sessionId)
  }
  if (filter.agentId) {
    conditions.push('agent_id = ?')
    params.push(filter.agentId)
  }
  if (conditions.length === 0) return []
  const db = await getDb()
  const rows = (await db.select<TraceRow[]>(
    `SELECT run_id, agent_id, session_id, started_at, finished_at, reply, prompt_tokens, completion_tokens, events_json, thinking
     FROM agent_run_trace WHERE ${conditions.join(' AND ')}
     ORDER BY started_at DESC LIMIT ${limit}`,
    params,
  )) as TraceRow[]
  return rows.map((r) => ({
    runId: r.run_id,
    agentId: r.agent_id ?? undefined,
    sessionId: r.session_id ?? undefined,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at,
    replyHead: (r.reply ?? '').split('\n')[0]?.slice(0, 120) ?? '',
    promptTokens: r.prompt_tokens ?? 0,
    completionTokens: r.completion_tokens ?? 0,
    eventCount: (r.events_json.match(/"type"/g) ?? []).length,
  }))
}

/** 完整轨迹读取（回放）；查无返回 null。 */
export async function getRunTrace(runId: string): Promise<RunTraceFull | null> {
  if (!isTauri) return null
  const db = await getDb()
  const rows = (await db.select<TraceRow[]>(
    'SELECT run_id, agent_id, session_id, started_at, finished_at, thinking, reply, prompt_tokens, completion_tokens, events_json FROM agent_run_trace WHERE run_id = ?',
    [runId],
  )) as TraceRow[]
  const r = rows[0]
  if (!r) return null
  let events: Array<Record<string, unknown>> = []
  try {
    events = JSON.parse(r.events_json) as Array<Record<string, unknown>>
  } catch {
    events = []
  }
  const thinking = r.thinking ?? ''
  return {
    runId: r.run_id,
    events,
    thinking,
    reply: r.reply ?? '',
    counts: {
      events: events.length,
      thinkingChars: thinking.length,
      replyChars: (r.reply ?? '').length,
      promptTokens: r.prompt_tokens ?? 0,
      completionTokens: r.completion_tokens ?? 0,
    },
  }
}
