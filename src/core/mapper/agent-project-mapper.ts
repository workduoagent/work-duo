/**
 * 工程档案（agent_project）数据访问层（mapper）。
 *
 * 与 agent-session-mapper 一致：DB 访问集中在本目录，驱动 @tauri-apps/plugin-sql；
 * 非 Tauri（浏览器 dev）回退 localStorage。
 *
 * 关键语义（智能工作空间绑定）：
 *  - 同一物理目录（规范化绝对路径）唯一对应一条工程记录（root_path UNIQUE）；
 *  - 不论盘符大小写 / 斜杠差异，都会命中同一条记录（规范化在 Rust canonicalize_path 完成）；
 *  - 用户首次为某目录新建会话时自动建档，之后复用。
 */
import { isTauri } from '@/core/config'
import { getDb } from '@/core/db/SqlService'
import { invoke } from '@tauri-apps/api/core'
import type { AgentProject } from '@/types/core'
import type { AgentProjectRow } from '@/types/database'
// F024：localStorage 降级读写收敛到共享实现
import { lsList, lsSave } from './localFallback'

/* ------------------------------------------------------------------ *
 * 行 <-> 领域模型 转换
 * ---------------------------------------------------------------- */
function rowToProject(r: AgentProjectRow): AgentProject {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    description: r.description ?? undefined,
    icon: r.icon ?? undefined,
    isPinned: r.is_pinned === 1,
    isArchived: r.is_archived === 1,
    customRules: r.custom_rules ?? undefined,
    lastActiveAt: r.last_active_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage
 * ---------------------------------------------------------------- */
const LS_PROJECT = 'work-duo:agent-projects'

// F024：本文件 6 个 localStorage 读写函数全部委托共享实现，
// 保留同名薄封装使 9 处调用点零改动。
function lsRead(): AgentProject[] {
  return lsList<AgentProject>(LS_PROJECT)
}
function lsWrite(list: AgentProject[]): void {
  lsSave(LS_PROJECT, list)
}

/* ------------------------------------------------------------------ *
 * 路径规范化
 * ---------------------------------------------------------------- */

/** 取路径最底层目录名（如 "D:/repo/crm" -> "crm"）。 */
export function leafDirName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned || '未命名工作区'
}

/**
 * 规范化路径为全局唯一绝对形式。
 *  - Tauri 环境：调用 Rust canonicalize_path（校验存在 + 抹平软链/大小写/斜杠）；
 *    目录不存在时 Rust 直接返回 Err，这里让错误向上传播（熔断，禁止为不存在的目录建档）。
 *  - 非 Tauri：仅做简单分隔符统一，便于 dev 回退。
 */
export async function canonicalizePath(rawPath: string): Promise<string> {
  if (isTauri) {
    return (await invoke<string>('canonicalize_path', { path: rawPath })).trim()
  }
  return rawPath.replace(/\\/g, '/').replace(/\/+$/, '')
}

/* ------------------------------------------------------------------ *
 * 工程 CRUD
 * ---------------------------------------------------------------- */

/** 列出全部工程（置顶优先 + 最后活跃倒序）。 */
export async function listProjects(): Promise<AgentProject[]> {
  if (!isTauri) return lsRead().sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.lastActiveAt - a.lastActiveAt)
  const db = await getDb()
  const rows = await db.select<AgentProjectRow[]>('SELECT * FROM agent_project ORDER BY is_pinned DESC, last_active_at DESC')
  return rows.map(rowToProject)
}

/** 按 id 查询单个工程。 */
export async function getProject(id: string): Promise<AgentProject | undefined> {
  if (!isTauri) return lsRead().find((p) => p.id === id)
  const db = await getDb()
  const rows = await db.select<AgentProjectRow[]>('SELECT * FROM agent_project WHERE id = ?', [id])
  return rows[0] ? rowToProject(rows[0]) : undefined
}

/** 按规范化 root_path 查询工程（用于复用判定）。 */
export async function getProjectByRootPath(rootPath: string): Promise<AgentProject | undefined> {
  if (!isTauri) return lsRead().find((p) => p.rootPath === rootPath)
  const db = await getDb()
  const rows = await db.select<AgentProjectRow[]>('SELECT * FROM agent_project WHERE root_path = ?', [rootPath])
  return rows[0] ? rowToProject(rows[0]) : undefined
}

export interface CreateProjectInput {
  rootPath: string
  name?: string
  description?: string
  icon?: string
  customRules?: string
}

/** 新建工程档案（root_path 唯一，重复插入会被忽略并返回已存在记录）。 */
export async function createProject(input: CreateProjectInput): Promise<AgentProject> {
  const now = Date.now()
  const id = `proj_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const name = input.name?.trim() || leafDirName(input.rootPath)

  if (!isTauri) {
    const list = lsRead()
    const existing = list.find((p) => p.rootPath === input.rootPath)
    if (existing) return existing
    const proj: AgentProject = {
      id,
      name,
      rootPath: input.rootPath,
      description: input.description,
      icon: input.icon,
      isPinned: false,
      isArchived: false,
      customRules: input.customRules,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    }
    list.push(proj)
    lsWrite(list)
    return proj
  }

  const db = await getDb()
  await db.execute(
    `INSERT OR IGNORE INTO agent_project
       (id, name, root_path, description, icon, is_pinned, is_archived, custom_rules, last_active_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    [
      id,
      name,
      input.rootPath,
      input.description ?? null,
      input.icon ?? null,
      input.customRules ?? null,
      now,
      now,
      now,
    ],
  )
  // INSERT OR IGNORE 时若已存在，id 是新生成的但未被插入；需回读真实记录
  const rows = await db.select<AgentProjectRow[]>('SELECT * FROM agent_project WHERE root_path = ?', [input.rootPath])
  return rowToProject(rows[0])
}

/**
 * 智能绑定核心：传入原始路径，规范化后查重；
 * 命中已有工程则复用，否则自动建档（取叶目录名）。返回工程记录。
 */
export async function ensureProjectByPath(rawPath: string): Promise<AgentProject> {
  const rootPath = await canonicalizePath(rawPath)
  const existing = await getProjectByRootPath(rootPath)
  if (existing) return existing
  return createProject({ rootPath })
}

export interface UpdateProjectPatch {
  name?: string
  description?: string
  icon?: string
  isPinned?: boolean
  isArchived?: boolean
  customRules?: string
  lastActiveAt?: number
}

/** 更新工程档案（名称 / 说明 / 图标 / 置顶 / 归档 / 专属规则）。 */
export async function updateProject(id: string, patch: UpdateProjectPatch): Promise<void> {
  const now = Date.now()
  if (!isTauri) {
    const list = lsRead().map((p) =>
      p.id === id
        ? {
            ...p,
            name: patch.name ?? p.name,
            description: patch.description ?? p.description,
            icon: patch.icon ?? p.icon,
            isPinned: patch.isPinned ?? p.isPinned,
            isArchived: patch.isArchived ?? p.isArchived,
            customRules: patch.customRules ?? p.customRules,
            lastActiveAt: patch.lastActiveAt ?? p.lastActiveAt,
            updatedAt: now,
          }
        : p,
    )
    lsWrite(list)
    return
  }
  const db = await getDb()
  await db.execute(
    `UPDATE agent_project SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        icon = COALESCE(?, icon),
        is_pinned = COALESCE(?, is_pinned),
        is_archived = COALESCE(?, is_archived),
        custom_rules = COALESCE(?, custom_rules),
        last_active_at = COALESCE(?, last_active_at),
        updated_at = ?
     WHERE id = ?`,
    [
      patch.name ?? null,
      patch.description ?? null,
      patch.icon ?? null,
      patch.isPinned === undefined ? null : patch.isPinned ? 1 : 0,
      patch.isArchived === undefined ? null : patch.isArchived ? 1 : 0,
      patch.customRules ?? null,
      patch.lastActiveAt ?? now,
      now,
      id,
    ],
  )
}

/**
 * 删除工程（级联清除其下所有会话与轮次）。
 * 显式先删轮次再删会话再删工程，确保即便 SQLite 外键未开启也能安全清除脏数据。
 */
export async function deleteProject(id: string): Promise<void> {
  if (!isTauri) {
    const projs = lsRead().filter((p) => p.id !== id)
    lsWrite(projs)
    const sessions = lsReadSessions().filter((s) => s.projectId !== id)
    lsWriteSessions(sessions)
    const rounds = lsReadRounds().filter((r) => !sessions.some((s) => s.id === r.sessionId))
    lsWriteRounds(rounds)
    return
  }
  const db = await getDb()
  // F026：原为「逐条删」（删 N 个会话的轮次 → 删会话 → 删工程），中途失败会留下
  // 「轮次已删、会话残留」的半删除状态。改为事务包裹：任一步失败整体回滚。
  //
  // 注：DDL 里 agent_conversation_session.project_id 与
  // agent_conversation_round.session_id 都声明了 ON DELETE CASCADE，实测
  // node:sqlite（SQLite ≥3.26 默认 foreign_keys=ON）删父行会连带删子行，
  // 因此两条级联 DELETE 已足够；此处仍显式保留轮次删除并在事务内 —— 不依赖
  // 连接级的 PRAGMA 设置（若将来连接串关掉外键，显式删除仍能保证正确性），
  // 事务则负责「要么全删要么全不删」。
  await db.execute('BEGIN')
  try {
    const sessRows = await db.select<{ id: string }[]>(
      'SELECT id FROM agent_conversation_session WHERE project_id = ?',
      [id],
    )
    for (const row of sessRows) {
      await db.execute('DELETE FROM agent_conversation_round WHERE session_id = ?', [row.id])
    }
    await db.execute('DELETE FROM agent_conversation_session WHERE project_id = ?', [id])
    await db.execute('DELETE FROM agent_project WHERE id = ?', [id])
    await db.execute('COMMIT')
  } catch (err) {
    // 回滚失败不应掩盖原始错误，故单独 try 吞掉（仅记录）
    try {
      await db.execute('ROLLBACK')
    } catch (rollbackErr) {
      console.error('[agent-project-mapper] deleteProject 回滚失败：', rollbackErr)
    }
    throw err
  }
}

/* ------------------------------------------------------------------ *
 * 非 Tauri 会话/轮次回退（deleteProject 级联用，避免循环依赖，内联最小实现）
 * ---------------------------------------------------------------- */
const LS_SESSION = 'work-duo:agent-sessions'
const LS_ROUND = 'work-duo:agent-rounds'

function lsReadSessions(): Array<{ id: string; projectId?: string }> {
  return lsList<{ id: string; projectId?: string }>(LS_SESSION)
}
function lsWriteSessions(list: Array<{ id: string; projectId?: string }>): void {
  lsSave(LS_SESSION, list)
}
function lsReadRounds(): Array<{ sessionId: string }> {
  return lsList<{ sessionId: string }>(LS_ROUND)
}
function lsWriteRounds(list: Array<{ sessionId: string }>): void {
  lsSave(LS_ROUND, list)
}
