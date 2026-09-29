/**
 * 小分队（Squad）协作的 SQL 数据访问层（mapper）。
 *
 * 约定与 agent-mapper 一致：
 *  - 所有 SQL 集中在本目录，页面/组件不直接写 SQL；
 *  - 行实体定义在 src/types/database.d.ts（AgentSquadRow / AgentSquadMemberRow / ...）；
 *  - 驱动：@tauri-apps/plugin-sql，经 src/core/db/SqlService.getDb() 获取全局单例；
 *  - 非 Tauri 环境（浏览器 dev）回退 localStorage，保证可调试。
 *
 * 注意：运行小分队走 Tauri 命令 `run_squad_task`（见 src-tauri/src/agent/commands.rs），
 * 本 mapper 仅负责小分队的「元数据 CRUD + 运行历史查询」。
 */
import { isTauri } from '@/core/config'
import { safeIso } from './safeTime'
import { invoke } from '@tauri-apps/api/core'
import type {
  SquadApiConfig,
  SquadInfo,
  SquadMember,
  SquadMemberInput,
  SquadMemory,
  SquadRound,
  SquadSession,
  SquadUpsertInput,
} from '@/types/core'
import type {
  AgentSquadChatConfigRow,
  AgentSquadMemberRow,
  AgentSquadRow,
  AgentSquadRoundRow,
  AgentSquadSessionRow,
} from '@/types/database'
import { getDb } from '@/core/db/SqlService'

/* ------------------------------------------------------------------ *
 * 行 <-> 领域模型 转换
 * ------------------------------------------------------------------ */

function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function toJson(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return JSON.stringify(v)
}

function now(): number {
  return Date.now()
}

async function loadMembers(db: Awaited<ReturnType<typeof getDb>>, squadId: string): Promise<SquadMember[]> {
  const rows = await db.select<AgentSquadMemberRow[]>(
    'SELECT * FROM agent_squad_member WHERE squad_id = ? ORDER BY CASE WHEN pipeline_order IS NULL THEN 0 ELSE 1 END, pipeline_order ASC, created_at ASC',
    [squadId],
  )
  return rows.map((r) => ({
    id: r.id,
    squadId: r.squad_id,
    agentId: r.agent_id,
    role: r.role ?? '',
    personaOverride: r.persona_override ?? undefined,
    pipelineOrder: r.pipeline_order ?? null,
    dependsOn: r.depends_on ? safeParse<string[]>(r.depends_on, []) : [],
    // S2：角色工具面（NULL/坏 JSON → undefined = inherit 不裁剪）。
    toolProfile: safeParse<SquadMember['toolProfile']>(r.tool_profile_json ?? null, undefined),
    isLeader: r.is_leader === 1,
    createdAt: safeIso(r.created_at),
  }))
}

async function loadChatConfig(
  db: Awaited<ReturnType<typeof getDb>>,
  squadId: string,
): Promise<SquadInfo['chatConfig']> {
  const rows = await db.select<AgentSquadChatConfigRow[]>(
    'SELECT * FROM agent_squad_chat_config WHERE squad_id = ?',
    [squadId],
  )
  if (rows[0]) {
    return {
      maxRounds: rows[0].max_rounds,
      summarizerAgentId: rows[0].summarizer_agent_id ?? null,
      // S3 批次2（§7.1）：结论转执行（DDL v38，默认关）。
      executeActions: rows[0].execute_actions === 1,
    }
  }
  return { maxRounds: 8, summarizerAgentId: null, executeActions: false }
}

function rowToSquad(
  r: AgentSquadRow,
  members: SquadMember[],
  chat: SquadInfo['chatConfig'],
): SquadInfo {
  return {
    id: r.id,
    name: r.name,
    logo: r.logo ?? undefined,
    description: r.description ?? undefined,
    mode: (r.mode as SquadInfo['mode']) || 'orchestrator',
    leaderAgentId: r.leader_agent_id ?? null,
    uniqueId: r.unique_id ?? null,
    globalMcpIds: safeParse<string[]>(r.global_mcp_ids, []),
    globalMcpTools: safeParse<Record<string, string[]>>(r.global_mcp_tools ?? null, {}),
    supportsFileInput: r.supports_file_input === 1,
    workspaceDir: r.workspace_dir ?? null,
    runStrategy: safeParse<SquadInfo['runStrategy']>(r.run_strategy, {
      executionMode: 'manual',
      retryCount: 3,
    }),
    members,
    chatConfig: {
      maxRounds: chat.maxRounds,
      summarizerAgentId: chat.summarizerAgentId ?? null,
      executeActions: chat.executeActions ?? false,
    },
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage
 * ------------------------------------------------------------------ */

const LS_SQUAD = 'work-duo:squads'

function lsRead(): SquadInfo[] {
  try {
    const raw = localStorage.getItem(LS_SQUAD)
    return raw ? (JSON.parse(raw) as SquadInfo[]) : []
  } catch {
    return []
  }
}

function lsWrite(list: SquadInfo[]): void {
  localStorage.setItem(LS_SQUAD, JSON.stringify(list))
}

/* ------------------------------------------------------------------ *
 * 对外 CRUD（页面/组件只调这些）
 * ------------------------------------------------------------------ */

/** 列表（按更新时间倒序）。 */
export async function listSquads(): Promise<SquadInfo[]> {
  if (!isTauri) return lsRead()
  const db = await getDb()
  const rows = await db.select<AgentSquadRow[]>(
    'SELECT * FROM agent_squad ORDER BY updated_at DESC',
    [],
  )
  const out: SquadInfo[] = []
  for (const r of rows) {
    const members = await loadMembers(db, r.id)
    const chat = await loadChatConfig(db, r.id)
    out.push(rowToSquad(r, members, chat))
  }
  return out
}

/** 按 id 查询单个。 */
export async function getSquad(id: string): Promise<SquadInfo | undefined> {
  if (!isTauri) return lsRead().find((s) => s.id === id)
  const db = await getDb()
  const rows = await db.select<AgentSquadRow[]>('SELECT * FROM agent_squad WHERE id = ?', [id])
  if (!rows[0]) return undefined
  const members = await loadMembers(db, id)
  const chat = await loadChatConfig(db, id)
  return rowToSquad(rows[0], members, chat)
}

/** 新建 / 更新小分队（主表 + 成员表 + 群聊配置表，关联表先删后插）。返回最新列表。 */
export async function upsertSquad(input: SquadUpsertInput): Promise<SquadInfo[]> {
  const id = input.id || crypto.randomUUID()
  const t = now()
  const leaderAgentId =
    input.leaderAgentId ??
    input.members.find((m) => m.isLeader)?.agentId ??
    input.members[0]?.agentId ??
    null

  if (!isTauri) {
    const list = lsRead()
    const next: SquadInfo = {
      id,
      name: input.name,
      logo: input.logo ?? null,
      description: input.description ?? null,
      mode: input.mode,
      uniqueId: input.uniqueId ?? null,
      leaderAgentId,
      globalMcpIds: input.globalMcpIds ?? [],
      globalMcpTools: input.globalMcpTools ?? {},
      supportsFileInput: input.supportsFileInput ?? false,
      workspaceDir: input.workspaceDir ?? null,
      runStrategy: input.runStrategy,
      members: input.members.map((m) => ({
        ...m,
        id: crypto.randomUUID(),
        squadId: id,
        personaOverride: m.personaOverride ?? undefined,
        pipelineOrder: m.pipelineOrder ?? null,
        dependsOn: m.dependsOn ?? [],
        createdAt: new Date(t).toISOString(),
      })),
      chatConfig: input.chatConfig,
      createdAt: list.find((s) => s.id === id)?.createdAt ?? new Date(t).toISOString(),
      updatedAt: new Date(t).toISOString(),
    }
    const idx = list.findIndex((s) => s.id === id)
    if (idx >= 0) list[idx] = next
    else list.push(next)
    lsWrite(list)
    return list
  }

  const db = await getDb()
  await db.execute(
    `INSERT INTO agent_squad
       (id, name, logo, description, mode, leader_agent_id, unique_id, global_mcp_ids, global_mcp_tools, run_strategy, supports_file_input, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name            = excluded.name,
       logo            = excluded.logo,
       description     = excluded.description,
       mode            = excluded.mode,
       leader_agent_id = excluded.leader_agent_id,
       unique_id       = excluded.unique_id,
       global_mcp_ids  = excluded.global_mcp_ids,
       global_mcp_tools = excluded.global_mcp_tools,
       run_strategy    = excluded.run_strategy,
       supports_file_input = excluded.supports_file_input,
       workspace_dir  = excluded.workspace_dir,
       updated_at      = excluded.updated_at`,
    [
      id,
      input.name,
      input.logo ?? null,
      input.description ?? null,
      input.mode,
      leaderAgentId,
      input.uniqueId?.trim() ?? null,
      toJson(input.globalMcpIds ?? []),
      toJson(input.globalMcpTools ?? {}),
      toJson(input.runStrategy),
      input.supportsFileInput ? 1 : 0,
      input.workspaceDir ?? null,
      t,
      t,
    ],
  )

  // 成员表：先删后插
  await db.execute('DELETE FROM agent_squad_member WHERE squad_id = ?', [id])
  for (const m of input.members) {
    await db.execute(
      `INSERT INTO agent_squad_member
         (id, squad_id, agent_id, role, persona_override, pipeline_order, depends_on, tool_profile_json, is_leader, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        id,
        m.agentId,
        m.role,
        m.personaOverride ?? null,
        m.pipelineOrder && m.pipelineOrder > 0 ? m.pipelineOrder : null,
        toJson(m.dependsOn ?? []),
        m.toolProfile ? toJson(m.toolProfile) : null,
        m.isLeader ? 1 : 0,
        t,
      ],
    )
  }

  // 群聊配置：upsert
  await db.execute(
    `INSERT INTO agent_squad_chat_config (squad_id, max_rounds, summarizer_agent_id, execute_actions)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(squad_id) DO UPDATE SET
       max_rounds          = excluded.max_rounds,
       summarizer_agent_id = excluded.summarizer_agent_id,
       execute_actions     = excluded.execute_actions`,
    [
      id,
      input.chatConfig.maxRounds,
      input.chatConfig.summarizerAgentId ?? null,
      input.chatConfig.executeActions ? 1 : 0,
    ],
  )

  return listSquads()
}

/** 各编队最新会话状态（卡片实时徽标）：squad_id → status；无会话的编队不出现在结果里。 */
export async function latestSquadStatuses(): Promise<Record<string, string>> {
  if (!isTauri) return {}
  const db = await getDb()
  const rows = await db.select<Array<{ squad_id: string; status: string }>>(
    `SELECT s.squad_id, s.status FROM agent_squad_session s
     JOIN (SELECT squad_id, MAX(created_at) AS mc FROM agent_squad_session GROUP BY squad_id) m
       ON m.squad_id = s.squad_id AND s.created_at = m.mc`,
    [],
  )
  const out: Record<string, string> = {}
  for (const r of rows) out[r.squad_id] = r.status
  return out
}

/** 删除小分队（级联清理成员 / 群聊配置 / 运行会话 / 轮次）。返回最新列表。 */
export async function deleteSquad(id: string): Promise<SquadInfo[]> {
  if (!isTauri) {
    lsWrite(lsRead().filter((s) => s.id !== id))
    return lsRead()
  }
  const db = await getDb()
  await db.execute('DELETE FROM agent_squad_member WHERE squad_id = ?', [id])
  await db.execute('DELETE FROM agent_squad_chat_config WHERE squad_id = ?', [id])
  await db.execute(
    'DELETE FROM agent_squad_round WHERE session_id IN (SELECT id FROM agent_squad_session WHERE squad_id = ?)',
    [id],
  )
  await db.execute('DELETE FROM agent_squad_session WHERE squad_id = ?', [id])
  await db.execute('DELETE FROM agent_squad WHERE id = ?', [id])
  return listSquads()
}

/** 列出某小分队的运行会话（按创建时间倒序）。 */
export async function listSquadSessions(squadId: string): Promise<SquadSession[]> {
  if (!isTauri) return []
  const db = await getDb()
  const rows = await db.select<AgentSquadSessionRow[]>(
    'SELECT * FROM agent_squad_session WHERE squad_id = ? ORDER BY created_at DESC',
    [squadId],
  )
  return rows.map((r) => ({
    id: r.id,
    squadId: r.squad_id,
    title: r.title ?? undefined,
    mode: (r.mode as SquadSession['mode']) || 'orchestrator',
    status: r.status,
    snapshot: r.snapshot ?? undefined,
    // S1/S2：黑板状态板 / Mission Contract / Delivery Pack 快照（此前 SELECT * 取了但映射丢弃）。
    boardJson: r.board_json ?? undefined,
    contractJson: r.contract_json ?? undefined,
    packJson: r.pack_json ?? undefined,
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }))
}

/** 列出某会话的全部轮次（按创建时间升序，即黑板顺序）。 */
export async function listSquadRounds(sessionId: string): Promise<SquadRound[]> {
  if (!isTauri) return []
  const db = await getDb()
  const rows = await db.select<AgentSquadRoundRow[]>(
    'SELECT * FROM agent_squad_round WHERE session_id = ? ORDER BY created_at ASC',
    [sessionId],
  )
  return rows.map((r) => ({
    id: r.id,
    squadId: r.squad_id,
    sessionId: r.session_id,
    speakerAgentId: r.speaker_agent_id ?? null,
    role: r.role ?? '',
    kind: (r.kind as SquadRound['kind']) ?? 'subtask',
    content: r.content,
    createdAt: safeIso(r.created_at),
  }))
}

/** 读取小分队 API 触发服务配置（enabled / port / token）。非 Tauri 回退默认值。 */
export async function getSquadApiConfig(): Promise<SquadApiConfig> {
  if (!isTauri) return { enabled: false, port: 3939, token: '' }
  return invoke<SquadApiConfig>('get_squad_api_config')
}

/** 更新小分队 API 触发服务配置（enabled / port / token 任选传入）。返回最新配置。 */
export async function setSquadApiConfig(input: Partial<SquadApiConfig>): Promise<SquadApiConfig> {
  if (!isTauri) {
    const cur = await getSquadApiConfig()
    return { ...cur, ...input }
  }
  return invoke<SquadApiConfig>('set_squad_api_config', {
    enabled: input.enabled ?? null,
    port: input.port ?? null,
    token: input.token ?? null,
  })
}

export type { SquadMemberInput }

/* ------------------------------------------------------------------ *
 * 小分队记忆（团队黑板）CRUD
 *  - Tauri：走后端命令 anchor_squad_memory / list_squad_memories / delete_squad_memory；
 *  - 非 Tauri：localStorage 回退，保证 UI 可调试。
 * ------------------------------------------------------------------ */

const LS_SQUAD_MEM = 'work-duo:squad-memories'

function lsMemRead(): SquadMemory[] {
  try {
    const raw = localStorage.getItem(LS_SQUAD_MEM)
    return raw ? (JSON.parse(raw) as SquadMemory[]) : []
  } catch {
    return []
  }
}

function lsMemWrite(list: SquadMemory[]): void {
  localStorage.setItem(LS_SQUAD_MEM, JSON.stringify(list))
}

export interface AnchorSquadMemoryInput {
  squadId: string
  agentId?: string | null
  sessionId?: string | null
  key: string
  content: string
  category?: string
}

/** 锚定一条小分队记忆（团队黑板写入），返回最新列表。 */
export async function anchorSquadMemory(input: AnchorSquadMemoryInput): Promise<SquadMemory[]> {
  if (!isTauri) {
    const list = lsMemRead()
    const now = Date.now()
    const idx = list.findIndex(
      (m) => m.squadId === input.squadId && (m.agentId ?? null) === (input.agentId ?? null) && m.key === input.key,
    )
    if (idx >= 0) {
      list[idx] = { ...list[idx], content: input.content, category: (input.category as SquadMemory['category']) ?? 'general', refCount: list[idx].refCount + 1, updatedAt: now }
    } else {
      list.push({
        id: crypto.randomUUID(),
        squadId: input.squadId,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        key: input.key,
        content: input.content,
        category: (input.category as SquadMemory['category']) ?? 'general',
        refCount: 0,
        anchored: true,
        lastRecalledAt: null,
        createdAt: now,
        updatedAt: now,
      })
    }
    lsMemWrite(list)
    return list.filter((m) => m.squadId === input.squadId)
  }
  await invoke('anchor_squad_memory', {
    squadId: input.squadId,
    agentId: input.agentId ?? null,
    sessionId: input.sessionId ?? null,
    key: input.key,
    content: input.content,
    category: input.category ?? 'general',
  })
  return listSquadMemories(input.squadId)
}

/** 列出某小分队的全部记忆（团队共享 + 成员个人）。 */
export async function listSquadMemories(squadId: string): Promise<SquadMemory[]> {
  if (!isTauri) return lsMemRead().filter((m) => m.squadId === squadId)
  const rows = await invoke<unknown[]>('list_squad_memories', { squadId })
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    squadId: String(r.squadId),
    agentId: (r.agentId as string | null) ?? null,
    sessionId: (r.sessionId as string | null) ?? null,
    key: String(r.key),
    content: String(r.content),
    category: (r.category as SquadMemory['category']) ?? 'general',
    refCount: Number(r.refCount ?? 0),
    anchored: Number(r.anchored ?? 0) === 1,
    lastRecalledAt: (r.lastRecalledAt as number | null) ?? null,
    createdAt: Number(r.createdAt ?? 0),
    updatedAt: Number(r.updatedAt ?? 0),
  }))
}

/** 删除一条小分队记忆，返回最新列表。 */
export async function deleteSquadMemory(id: string, squadId: string): Promise<SquadMemory[]> {
  if (!isTauri) {
    lsMemWrite(lsMemRead().filter((m) => m.id !== id))
    return lsMemRead().filter((m) => m.squadId === squadId)
  }
  await invoke('delete_squad_memory', { id })
  return listSquadMemories(squadId)
}
