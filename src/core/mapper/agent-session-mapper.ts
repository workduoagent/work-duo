/**
 * 智能体会话与轮次的 SQL 数据访问层（mapper）。
 *
 * 约定：
 *  - 所有 SQL 增删改查集中在本目录；
 *  - SQL 行实体定义在 src/types/database.d.ts；
 *  - 驱动：@tauri-apps/plugin-sql；
 *  - 非 Tauri 环境（浏览器 dev）回退 localStorage。
 *
 * 本 mapper 服务于单个智能体调试/对话页（from_site='DEBUG_CHAT'），
 * 负责会话（session）与轮次（round）的持久化。
 */
import { isTauri } from '@/core/config'
import { safeIso } from './safeTime'
import { getDb } from '@/core/db/SqlService'
import type {
  AgentConversationRound,
  AgentConversationSession,
  AgentConversationStatus,
  AppendRoundInput,
} from '@/types/core'
import type {
  AgentConversationRoundRow,
  AgentConversationSessionRow,
} from '@/types/database'

/* ------------------------------------------------------------------ *
 * 行 <-> 领域模型 转换
 * ---------------------------------------------------------------- */

function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function rowToSession(r: AgentConversationSessionRow): AgentConversationSession {
  return {
    id: r.id,
    sessionName: r.session_name ?? undefined,
    agentCode: r.agent_code,
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
    status: r.status as AgentConversationStatus,
    errorMessage: r.error_message ?? undefined,
    isCollection: r.is_collection === 1,
    isTop: r.is_top === 1,
    isArchive: r.is_archive === 1,
    fromSite: r.from_site as 'DEBUG_CHAT' | 'AGENT_GROUP',
    projectId: r.project_id ?? undefined,
    summary: r.summary ?? undefined,
    totalPromptTokens: r.total_prompt_tokens ?? undefined,
    totalCompletionTokens: r.total_completion_tokens ?? undefined,
    toolsTokens: r.tools_tokens ?? undefined,
    summaryRoundCount: r.summary_round_count ?? undefined,
    totalTurns: r.total_turns ?? undefined,
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }
}

function rowToRound(r: AgentConversationRoundRow): AgentConversationRound {
  return {
    id: r.id,
    sessionId: r.session_id,
    llmCode: r.llm_code ?? undefined,
    roundIndex: r.round_index,
    userQuestion: r.user_question ?? undefined,
    thinkingContent: r.thinking_content ?? undefined,
    assistantAnswer: r.assistant_answer ?? undefined,
    toolCallsSummary: safeParse<Record<string, unknown>[]>(r.tool_calls_summary, []),
    planStepsSummary: safeParse<Record<string, unknown>[]>(r.plan_steps, []),
    inputTokens: r.input_tokens ?? undefined,
    outputTokens: r.output_tokens ?? undefined,
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
    // 交错时间线（v26）：旁白/工具/正文按真实时序；旧 round NULL = undefined 回退旧渲染。
    // K3-2：kb-sources 段带 hits（本次引用来源），JSON 往返原样保留，形状由消费端收窄。
    segments: safeParse<Array<{ kind: string; text?: string; callId?: string; hits?: unknown[] }>>(r.segments_json, []),
    rawMessagesJson: r.raw_messages_json ?? undefined,
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage
 * ---------------------------------------------------------------- */

const LS_SESSION = 'work-duo:agent-sessions'
const LS_ROUND = 'work-duo:agent-rounds'

function lsRead<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T[]) : []
  } catch {
    return []
  }
}

function lsWrite<T>(key: string, list: T[]): void {
  localStorage.setItem(key, JSON.stringify(list))
}

/* ------------------------------------------------------------------ *
 * 会话 CRUD
 * ---------------------------------------------------------------- */

/** 创建新会话。sessionName 可空，通常首轮发送后回填为第一个问题。
 *  - opts.projectId：绑定到某工程（NULL 代表通用日常任务）；
 *  - opts.workspacePath：传入时自动按规范化路径建档/复用工程并绑定（智能工作空间绑定）。 */
export async function createSession(
  agentCode: string,
  sessionName?: string,
  opts?: { projectId?: string | null; workspacePath?: string },
): Promise<AgentConversationSession> {
  let projectId: string | null | undefined = opts?.projectId ?? null

  // 传入工作空间路径：智能绑定——规范化后查重，复用已有工程或自动建档
  if (!projectId && opts?.workspacePath) {
    const { ensureProjectByPath } = await import('./agent-project-mapper')
    const proj = await ensureProjectByPath(opts.workspacePath)
    projectId = proj.id
  }

  const now = Date.now()
  const id = crypto.randomUUID()
  const session: AgentConversationSession = {
    id,
    agentCode,
    sessionName,
    startTime: now,
    status: 'RUNNING',
    isCollection: false,
    isTop: false,
    isArchive: false,
    fromSite: 'DEBUG_CHAT',
    projectId: projectId ?? undefined,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    toolsTokens: 0,
    summaryRoundCount: 0,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }

  if (!isTauri) {
    const list = lsRead<AgentConversationSession>(LS_SESSION)
    list.push(session)
    lsWrite(LS_SESSION, list)
    return session
  }

  const db = await getDb()
  await db.execute(
    `INSERT INTO agent_conversation_session
       (id, session_name, agent_code, start_time, end_time, status, error_message,
        is_collection, is_top, is_archive, from_site, project_id, summary, total_prompt_tokens,
        total_completion_tokens, tools_tokens, summary_round_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sessionName ?? null,
      agentCode,
      now,
      null,
      'RUNNING',
      null,
      0,
      0,
      0,
      'DEBUG_CHAT',
      projectId ?? null,
      null,
      0,
      0,
      0,
      0,
      now,
      now,
    ],
  )
  return session
}

/** 列出某智能体的所有会话（按置顶倒序 + 更新时间倒序）。 */
export async function listSessions(agentCode: string): Promise<AgentConversationSession[]> {
  if (!isTauri) {
    return lsRead<AgentConversationSession>(LS_SESSION)
      .filter((s) => s.agentCode === agentCode)
      .sort((a, b) => Number(b.isTop) - Number(a.isTop) || b.createdAt.localeCompare(a.createdAt))
  }
  const db = await getDb()
  const rows = await db.select<AgentConversationSessionRow[]>(
    `SELECT * FROM agent_conversation_session
     WHERE agent_code = ?
     ORDER BY is_top DESC, created_at DESC`,
    [agentCode],
  )
  return rows.map(rowToSession)
}

/** 按 id 查询单个会话。 */
export async function getSession(id: string): Promise<AgentConversationSession | undefined> {
  if (!isTauri) return lsRead<AgentConversationSession>(LS_SESSION).find((s) => s.id === id)
  const db = await getDb()
  const rows = await db.select<AgentConversationSessionRow[]>(
    'SELECT * FROM agent_conversation_session WHERE id = ?',
    [id],
  )
  return rows[0] ? rowToSession(rows[0]) : undefined
}

/** 更新会话基础信息（名称/状态/结束时间/摘要/错误）。 */
export async function updateSession(
  id: string,
  patch: Partial<
    Pick<
      AgentConversationSession,
      | 'sessionName'
      | 'status'
      | 'endTime'
      | 'summary'
      | 'errorMessage'
      | 'totalPromptTokens'
      | 'totalCompletionTokens'
      | 'toolsTokens'
    >
  > & {
    /** 允许传 null 以解绑工程（置为自由会话）。 */
    projectId?: string | null
  },
): Promise<void> {
  const now = Date.now()
  if (!isTauri) {
    const list = lsRead<AgentConversationSession>(LS_SESSION).map((s) =>
      s.id === id
        ? {
            ...s,
            sessionName: patch.sessionName ?? s.sessionName,
            status: patch.status ?? s.status,
            endTime: patch.endTime ?? s.endTime,
            summary: patch.summary ?? s.summary,
            errorMessage: patch.errorMessage ?? s.errorMessage,
            totalPromptTokens: patch.totalPromptTokens ?? s.totalPromptTokens,
            totalCompletionTokens: patch.totalCompletionTokens ?? s.totalCompletionTokens,
            toolsTokens: patch.toolsTokens ?? s.toolsTokens,
            projectId: patch.projectId ?? s.projectId,
            updatedAt: new Date(now).toISOString(),
          }
        : s,
    )
    lsWrite(LS_SESSION, list)
    return
  }
  const db = await getDb()
  await db.execute(
    `UPDATE agent_conversation_session SET
        session_name = COALESCE(?, session_name),
        status = COALESCE(?, status),
        end_time = COALESCE(?, end_time),
        summary = COALESCE(?, summary),
        error_message = COALESCE(?, error_message),
        total_prompt_tokens = COALESCE(?, total_prompt_tokens),
        total_completion_tokens = COALESCE(?, total_completion_tokens),
        tools_tokens = COALESCE(?, tools_tokens),
        project_id = COALESCE(?, project_id),
        updated_at = ?
     WHERE id = ?`,
    [
      patch.sessionName ?? null,
      patch.status ?? null,
      patch.endTime ?? null,
      patch.summary ?? null,
      patch.errorMessage ?? null,
      patch.totalPromptTokens ?? null,
      patch.totalCompletionTokens ?? null,
      patch.toolsTokens ?? null,
      patch.projectId ?? null,
      now,
      id,
    ],
  )
}

/** 累计会话的 token 消耗（每轮回复后调用）。
 *  - promptDelta：本轮发送给模型的 token（提示词侧）；
 *  - completionDelta：本轮模型返回的 token（对话侧）。
 * 增量累加，不覆盖历史值。 */
export async function addSessionTokens(
  id: string,
  promptDelta: number,
  completionDelta: number,
): Promise<void> {
  if (promptDelta <= 0 && completionDelta <= 0) return
  const now = Date.now()
  if (!isTauri) {
    const list = lsRead<AgentConversationSession>(LS_SESSION).map((s) =>
      s.id === id
        ? {
            ...s,
            totalPromptTokens: (s.totalPromptTokens ?? 0) + promptDelta,
            totalCompletionTokens: (s.totalCompletionTokens ?? 0) + completionDelta,
            updatedAt: new Date(now).toISOString(),
          }
        : s,
    )
    lsWrite(LS_SESSION, list)
    return
  }
  const db = await getDb()
  await db.execute(
    `UPDATE agent_conversation_session SET
        total_prompt_tokens = COALESCE(total_prompt_tokens, 0) + ?,
        total_completion_tokens = COALESCE(total_completion_tokens, 0) + ?,
        updated_at = ?
     WHERE id = ?`,
    [promptDelta, completionDelta, now, id],
  )
}

/** 切换收藏。 */
export async function toggleSessionCollection(
  id: string,
  collected: boolean,
): Promise<void> {
  const now = Date.now()
  if (!isTauri) {
    const list = lsRead<AgentConversationSession>(LS_SESSION).map((s) =>
      s.id === id ? { ...s, isCollection: collected, updatedAt: new Date(now).toISOString() } : s,
    )
    lsWrite(LS_SESSION, list)
    return
  }
  const db = await getDb()
  await db.execute(
    'UPDATE agent_conversation_session SET is_collection = ?, updated_at = ? WHERE id = ?',
    [collected ? 1 : 0, now, id],
  )
}

/** 切换置顶。 */
export async function toggleSessionTop(id: string, top: boolean): Promise<void> {
  const now = Date.now()
  if (!isTauri) {
    const list = lsRead<AgentConversationSession>(LS_SESSION).map((s) =>
      s.id === id ? { ...s, isTop: top, updatedAt: new Date(now).toISOString() } : s,
    )
    lsWrite(LS_SESSION, list)
    return
  }
  const db = await getDb()
  await db.execute(
    'UPDATE agent_conversation_session SET is_top = ?, updated_at = ? WHERE id = ?',
    [top ? 1 : 0, now, id],
  )
}

/** 重命名会话。 */
export async function renameSession(id: string, name: string): Promise<void> {
  await updateSession(id, { sessionName: name })
}

/**
 * 显式解绑会话所属工程（置 project_id 为 NULL，变回自由会话）。
 *  - 不能用 `updateSession({ projectId: null })`：其 SQL 对 project_id 用 `COALESCE(?, project_id)`，
 *    传入 null 时恒取旧值，解绑无效（见 #20260915004 B1）。
 *  - 本函数用**显式** `project_id = ?` 且参数传 null，保证写空。
 */
export async function clearSessionProject(id: string): Promise<void> {
  const now = Date.now()
  if (!isTauri) {
    const list = lsRead<AgentConversationSession>(LS_SESSION).map((s) =>
      s.id === id ? { ...s, projectId: undefined, updatedAt: new Date(now).toISOString() } : s,
    )
    lsWrite(LS_SESSION, list)
    return
  }
  const db = await getDb()
  await db.execute('UPDATE agent_conversation_session SET project_id = ?, updated_at = ? WHERE id = ?', [
    null,
    now,
    id,
  ])
}

/** 切换归档。 */
export async function setSessionArchived(id: string, archived: boolean): Promise<void> {  const now = Date.now()
  if (!isTauri) {
    const list = lsRead<AgentConversationSession>(LS_SESSION).map((s) =>
      s.id === id ? { ...s, isArchive: archived, updatedAt: new Date(now).toISOString() } : s,
    )
    lsWrite(LS_SESSION, list)
    return
  }
  const db = await getDb()
  await db.execute('UPDATE agent_conversation_session SET is_archive = ?, updated_at = ? WHERE id = ?', [
    archived ? 1 : 0,
    now,
    id,
  ])
}

/* ------------------------------------------------------------------ *
 * 树状分组（左侧会话抽屉驱动结构）
 * ---------------------------------------------------------------- */

/** 树中单个会话的精简视图。 */
export interface SessionTreeItem {
  id: string
  sessionName?: string
  totalTurns: number
  updatedAt: number
  isTop: boolean
  isArchived: boolean
  projectId?: string
}

/** 树的一个分组：GLOBAL（通用任务）或 PROJECT（某工程下会话）。 */
export interface SessionTreeGroup {
  groupType: 'GLOBAL' | 'PROJECT'
  groupId: string
  projectName: string
  rootPath: string | null
  isPinned?: boolean
  isArchived?: boolean
  sessions: SessionTreeItem[]
}

interface SessionJoinRow extends AgentConversationSessionRow {
  project_name?: string | null
  project_root_path?: string | null
  project_is_pinned?: number
  project_is_archived?: number
}

/** 会话 + 其所属工程信息的投影（用于树状分组）。 */
interface ProjectedSession extends AgentConversationSession {
  projectName?: string
  projectRootPath?: string
  projectIsPinned?: boolean
  projectIsArchived?: boolean
}

/**
 * 列出某智能体的会话，按「通用任务 / 各工程」分组输出树状结构：
 *  - GLOBAL 组：project_id 为 NULL 的会话，按 updated_at 倒序；
 *  - PROJECT 组：每个工程一组，组按工程 last_active_at 倒序（置顶优先），组内会话按 updated_at 倒序。
 * 通过单次 JOIN 查询驱动前端左侧抽屉渲染。
 */
export async function listSessionTree(agentCode: string): Promise<SessionTreeGroup[]> {
  if (!isTauri) {
    const all = lsRead<AgentConversationSession>(LS_SESSION).filter((s) => s.agentCode === agentCode)
    return buildTree(all)
  }
  const db = await getDb()
  const rows = await db.select<SessionJoinRow[]>(
    `SELECT s.*, p.name AS project_name, p.root_path AS project_root_path, p.is_pinned AS project_is_pinned, p.is_archived AS project_is_archived
     FROM agent_conversation_session s
     LEFT JOIN agent_project p ON p.id = s.project_id
     WHERE s.agent_code = ?
     ORDER BY COALESCE(p.is_pinned, 0) DESC, COALESCE(p.last_active_at, 0) DESC, s.updated_at DESC`,
    [agentCode],
  )
  const sessions: ProjectedSession[] = rows.map((r) => ({
    id: r.id,
    sessionName: r.session_name ?? undefined,
    agentCode: r.agent_code,
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
    status: r.status as AgentConversationStatus,
    errorMessage: r.error_message ?? undefined,
    isCollection: r.is_collection === 1,
    isTop: r.is_top === 1,
    isArchive: r.is_archive === 1,
    fromSite: r.from_site as 'DEBUG_CHAT' | 'AGENT_GROUP',
    projectId: r.project_id ?? undefined,
    summary: r.summary ?? undefined,
    totalPromptTokens: r.total_prompt_tokens ?? undefined,
    totalCompletionTokens: r.total_completion_tokens ?? undefined,
    toolsTokens: r.tools_tokens ?? undefined,
    summaryRoundCount: r.summary_round_count ?? undefined,
    totalTurns: r.total_turns ?? undefined,
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
    projectName: r.project_name ?? undefined,
    projectRootPath: r.project_root_path ?? undefined,
    projectIsPinned: r.project_is_pinned === 1,
    projectIsArchived: r.project_is_archived === 1,
  }))
  return buildTree(sessions)
}

/** 从已加载的会话列表构建树（Tauri 与非 Tauri 共用）。 */
function buildTree(sessions: ProjectedSession[]): SessionTreeGroup[] {
  const toItem = (s: ProjectedSession): SessionTreeItem => ({
    id: s.id,
    sessionName: s.sessionName,
    totalTurns: s.totalTurns ?? 0,
    updatedAt: Date.parse(s.updatedAt) || 0,
    isTop: s.isTop,
    isArchived: s.isArchive,
    projectId: s.projectId,
  })

  // GLOBAL 组
  const globalSessions = sessions
    .filter((s) => !s.projectId)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .map(toItem)

  const groups: SessionTreeGroup[] = [
    {
      groupType: 'GLOBAL',
      groupId: 'GLOBAL',
      projectName: '自由会话',
      rootPath: null,
      sessions: globalSessions,
    },
  ]

  // PROJECT 组：按 projectId 聚合
  const byProject = new Map<string, ProjectedSession[]>()
  for (const s of sessions) {
    if (!s.projectId) continue
    const arr = byProject.get(s.projectId) ?? []
    arr.push(s)
    byProject.set(s.projectId, arr)
  }
  for (const [pid, arr] of byProject) {
    arr.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    groups.push({
      groupType: 'PROJECT',
      groupId: pid,
      projectName: arr[0].projectName ?? '未命名工程',
      rootPath: arr[0].projectRootPath ?? null,
      isPinned: arr[0].projectIsPinned,
      isArchived: arr[0].projectIsArchived,
      sessions: arr.map(toItem),
    })
  }
  return groups
}

/** 删除会话（级联删除其轮次）。 */
export async function deleteSession(id: string): Promise<void> {
  if (!isTauri) {
    lsWrite(
      LS_SESSION,
      lsRead<AgentConversationSession>(LS_SESSION).filter((s) => s.id !== id),
    )
    lsWrite(
      LS_ROUND,
      lsRead<AgentConversationRound>(LS_ROUND).filter((r) => r.sessionId !== id),
    )
    return
  }
  const db = await getDb()
  await db.execute('DELETE FROM agent_conversation_round WHERE session_id = ?', [id])
  await db.execute('DELETE FROM agent_conversation_session WHERE id = ?', [id])
}

/* ------------------------------------------------------------------ *
 * 轮次 CRUD
 * ---------------------------------------------------------------- */

/** 追加一轮（用户提问发出时调用）。 */
export async function appendRound(input: AppendRoundInput): Promise<AgentConversationRound> {
  const now = Date.now()
  const id = crypto.randomUUID()
  const round: AgentConversationRound = {
    id,
    sessionId: input.sessionId,
    llmCode: input.llmCode,
    roundIndex: input.roundIndex,
    userQuestion: input.userQuestion,
    startTime: input.startTime ?? now,
    toolCallsSummary: [],
    planStepsSummary: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }

  if (!isTauri) {
    const list = lsRead<AgentConversationRound>(LS_ROUND)
    list.push(round)
    lsWrite(LS_ROUND, list)
    return round
  }

  const db = await getDb()
  await db.execute(
    `INSERT INTO agent_conversation_round
       (id, session_id, llm_code, round_index, user_question, thinking_content, assistant_answer,
        tool_calls_summary, plan_steps, input_tokens, output_tokens, start_time, end_time, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sessionId,
      input.llmCode ?? null,
      input.roundIndex,
      input.userQuestion ?? null,
      null,
      null,
      null,
      null,
      null,
      null,
      input.startTime ?? now,
      null,
      now,
      now,
    ],
  )
  return round
}

/** 列出某会话的所有轮次（按 round_index 升序）。 */
export async function listRounds(sessionId: string): Promise<AgentConversationRound[]> {
  if (!isTauri) {
    return lsRead<AgentConversationRound>(LS_ROUND)
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.roundIndex - b.roundIndex)
  }
  const db = await getDb()
  const rows = await db.select<AgentConversationRoundRow[]>(
    'SELECT * FROM agent_conversation_round WHERE session_id = ? ORDER BY round_index ASC',
    [sessionId],
  )
  return rows.map(rowToRound)
}

/** 更新轮次结果（AI 回答回填）。 */
export async function updateRound(
  id: string,
  patch: Partial<
    Pick<
      AgentConversationRound,
      | 'thinkingContent'
      | 'assistantAnswer'
      | 'toolCallsSummary'
      | 'planStepsSummary'
      | 'segments'
      | 'inputTokens'
      | 'outputTokens'
      | 'endTime'
    >
  >,
): Promise<void> {
  const now = Date.now()
  if (!isTauri) {
    const list = lsRead<AgentConversationRound>(LS_ROUND).map((r) =>
      r.id === id
        ? {
            ...r,
            thinkingContent: patch.thinkingContent ?? r.thinkingContent,
            assistantAnswer: patch.assistantAnswer ?? r.assistantAnswer,
            toolCallsSummary: patch.toolCallsSummary ?? r.toolCallsSummary,
            planStepsSummary: patch.planStepsSummary ?? r.planStepsSummary,
            segments: patch.segments ?? r.segments,
            inputTokens: patch.inputTokens ?? r.inputTokens,
            outputTokens: patch.outputTokens ?? r.outputTokens,
            endTime: patch.endTime ?? r.endTime,
            updatedAt: new Date(now).toISOString(),
          }
        : r,
    )
    lsWrite(LS_ROUND, list)
    return
  }
  const db = await getDb()
  await db.execute(
    `UPDATE agent_conversation_round SET
        thinking_content = COALESCE(?, thinking_content),
        assistant_answer = COALESCE(?, assistant_answer),
        tool_calls_summary = COALESCE(?, tool_calls_summary),
        plan_steps = COALESCE(?, plan_steps),
        segments_json = COALESCE(?, segments_json),
        input_tokens = COALESCE(?, input_tokens),
        output_tokens = COALESCE(?, output_tokens),
        end_time = COALESCE(?, end_time),
        updated_at = ?
     WHERE id = ?`,
    [
      patch.thinkingContent ?? null,
      patch.assistantAnswer ?? null,
      patch.toolCallsSummary ? JSON.stringify(patch.toolCallsSummary) : null,
      patch.planStepsSummary ? JSON.stringify(patch.planStepsSummary) : null,
      patch.segments ? JSON.stringify(patch.segments) : null,
      patch.inputTokens ?? null,
      patch.outputTokens ?? null,
      patch.endTime ?? null,
      now,
      id,
    ],
  )
}
