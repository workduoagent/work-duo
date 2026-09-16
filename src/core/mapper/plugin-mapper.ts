/**
 * 自定义脚本插件（User-defined Script Plugin）的 SQL 数据访问层（mapper）。
 *
 * 约定：
 *  - 所有 SQL 增删改查集中在本目录（src/core/mapper），页面/组件不直接写 SQL；
 *  - SQL 行实体定义在 src/types/database.d.ts（UserPluginToolRow / AgentPluginRefRow / PluginRunLogRow）；
 *  - 驱动：@tauri-apps/plugin-sql（Tauri 2 官方 SQLite 插件）；
 *  - 连接统一经 src/core/db/SqlService.getDb() 获取（全局单例，已在 InitContext 启动时建表）；
 *  - 建表语句（DDL）集中在 src/assets/sql/init.sql，本文件不再持有 CREATE TABLE；
 *  - parameters_schema / dependencies / sample_params：JSON 序列化进对应列，读取时还原；
 *  - enabled / is_active / last_run_status / ok：INTEGER 0/1（last_run_status 取 0/1/2）；
 *  - 非 Tauri 环境（浏览器 dev）回退 localStorage，保证可调试；
 *  - 注：plugin_run_log 的写入发生在 Rust 侧（试跑 / Agent 执行自愈），本模块仅提供读取（listPluginRunLogs）。
 *
 * 与现有 skill/mcp mapper 对齐：纯 DB CRUD（list/get/upsert/delete/bind/unbind）+ 非 Tauri localStorage 回退。
 * 真正需要原生执行 / 依赖自愈的（test / extract）走 Rust 命令（plugin_commands.rs，P1），不进本 mapper。
 */
import { isTauri } from '@/core/config'
import { safeIso } from './safeTime'
import type { UserPluginTool, PluginRunLog, UpsertUserPluginInput } from '@/core/file/plugin-file'
import type { UserPluginToolRow, PluginRunLogRow } from '@/types/database'
import { getDb } from '@/core/db/SqlService'

/* ------------------------------------------------------------------ *
 * 行 <-> 领域模型 转换
 * ------------------------------------------------------------------ */

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function runStatusFromRow(v: number | null): UserPluginTool['lastRunStatus'] {
  if (v === 1) return 'success'
  if (v === 2) return 'failed'
  return 'unknown'
}

function runStatusToRow(s?: UserPluginTool['lastRunStatus']): number {
  if (s === 'success') return 1
  if (s === 'failed') return 2
  return 0
}

function pluginToRow(p: UserPluginTool): UserPluginToolRow {
  const now = Date.now()
  return {
    id: p.id,
    name: p.name,
    identifier: p.identifier,
    description: p.description,
    runtime: p.runtime,
    script_content: p.scriptContent,
    parameters_schema: JSON.stringify(
      p.parametersSchema ?? { type: 'object', properties: {}, required: [] },
    ),
    dependencies: p.dependencies && p.dependencies.length ? JSON.stringify(p.dependencies) : null,
    sample_params: p.sampleParams ? JSON.stringify(p.sampleParams) : null,
    enabled: p.enabled ? 1 : 0,
    timeout_sec: p.timeoutSec ?? 60,
    scenario: p.scenario ?? null,
    last_run_at: p.lastRunAt ? Date.parse(p.lastRunAt) : null,
    last_run_status: runStatusToRow(p.lastRunStatus),
    created_at: p.createdAt ? Date.parse(p.createdAt) : now,
    updated_at: now,
  }
}

function rowToPlugin(r: UserPluginToolRow): UserPluginTool {
  return {
    id: r.id,
    name: r.name,
    identifier: r.identifier,
    description: r.description,
    runtime: (r.runtime as UserPluginTool['runtime']) ?? 'python',
    scriptContent: r.script_content,
    parametersSchema:
      safeParse<Record<string, unknown>>(r.parameters_schema, {}) ??
      { type: 'object', properties: {}, required: [] },
    dependencies: safeParse<string[]>(r.dependencies, []),
    sampleParams: safeParse<Record<string, unknown> | null>(r.sample_params, null),
    enabled: r.enabled === 1,
    timeoutSec: r.timeout_sec ?? 60,
    scenario: r.scenario ?? undefined,
    lastRunAt: r.last_run_at ? safeIso(r.last_run_at) : undefined,
    lastRunStatus: runStatusFromRow(r.last_run_status),
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }
}

function rowToRunLog(r: PluginRunLogRow): PluginRunLog {
  return {
    id: r.id,
    pluginId: r.plugin_id,
    agentId: r.agent_id ?? null,
    sessionId: r.session_id ?? null,
    source: (r.source as PluginRunLog['source']) ?? 'test',
    params: r.params ?? null,
    ok: r.ok === 1,
    exitCode: r.exit_code ?? null,
    durationMs: r.duration_ms ?? null,
    stdout: r.stdout ?? null,
    stderr: r.stderr ?? null,
    errorType: r.error_type ?? null,
    missingPackage: r.missing_package ?? null,
    createdAt: safeIso(r.created_at),
  }
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage
 * ------------------------------------------------------------------ */

const LS_PLUGIN_KEY = 'work-duo:plugins'
const LS_REF_KEY = 'work-duo:agent-plugins'

function lsListPlugins(): UserPluginTool[] {
  try {
    const raw = localStorage.getItem(LS_PLUGIN_KEY)
    return raw ? (JSON.parse(raw) as UserPluginTool[]) : []
  } catch {
    return []
  }
}
function lsSavePlugins(list: UserPluginTool[]): void {
  localStorage.setItem(LS_PLUGIN_KEY, JSON.stringify(list))
}
function lsListRefs(): { id: string; agentId: string; pluginId: string; isActive: boolean; createdAt: string; updatedAt: string }[] {
  try {
    const raw = localStorage.getItem(LS_REF_KEY)
    return raw
      ? (JSON.parse(raw) as { id: string; agentId: string; pluginId: string; isActive: boolean; createdAt: string; updatedAt: string }[])
      : []
  } catch {
    return []
  }
}
function lsSaveRefs(
  list: { id: string; agentId: string; pluginId: string; isActive: boolean; createdAt: string; updatedAt: string }[],
): void {
  localStorage.setItem(LS_REF_KEY, JSON.stringify(list))
}

/* ------------------------------------------------------------------ *
 * 对外 CRUD（页面/组件只调这些）
 * ------------------------------------------------------------------ */

/** 列表（按创建时间倒序）。可传 scenario 过滤单一场景。 */
export async function listPlugins(scenario?: string | null): Promise<UserPluginTool[]> {
  if (!isTauri) {
    const list = lsListPlugins()
    return scenario ? list.filter((p) => p.scenario === scenario) : list
  }
  const db = await getDb()
  const rows = scenario
    ? await db.select<UserPluginToolRow[]>(
        'SELECT * FROM user_plugin_tool WHERE scenario = ? ORDER BY created_at DESC',
        [scenario],
      )
    : await db.select<UserPluginToolRow[]>(
        'SELECT * FROM user_plugin_tool ORDER BY created_at DESC',
      )
  return rows.map(rowToPlugin)
}

/** 按 id 查询单个（含 script_content）。 */
export async function getPlugin(id: string): Promise<UserPluginTool | undefined> {
  if (!isTauri) return lsListPlugins().find((p) => p.id === id)
  const db = await getDb()
  const rows = await db.select<UserPluginToolRow[]>(
    'SELECT * FROM user_plugin_tool WHERE id = ?',
    [id],
  )
  return rows[0] ? rowToPlugin(rows[0]) : undefined
}

/** 新增或更新（按 id 幂等；更新时保留 created_at）。返回最新列表。 */
export async function upsertPlugin(input: UpsertUserPluginInput): Promise<UserPluginTool> {
  const id = input.id || crypto.randomUUID()
  const now = new Date().toISOString()
  const existing = !isTauri ? lsListPlugins().find((p) => p.id === id) : undefined
  const tool: UserPluginTool = {
    id,
    name: input.name,
    identifier: input.identifier,
    description: input.description,
    runtime: input.runtime,
    scriptContent: input.scriptContent,
    parametersSchema: input.parametersSchema,
    dependencies: input.dependencies ?? [],
    sampleParams: input.sampleParams ?? null,
    enabled: input.enabled ?? true,
    timeoutSec: input.timeoutSec ?? 60,
    scenario: input.scenario ?? null,
    lastRunAt: existing?.lastRunAt,
    lastRunStatus: existing?.lastRunStatus,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  if (!isTauri) {
    const list = lsListPlugins()
    const idx = list.findIndex((p) => p.id === id)
    if (idx >= 0) list[idx] = tool
    else list.push(tool)
    lsSavePlugins(list)
    return tool
  }

  const db = await getDb()
  const row = pluginToRow(tool)
  await db.execute(
    `INSERT INTO user_plugin_tool
       (id, name, identifier, description, runtime, script_content, parameters_schema,
        dependencies, sample_params, enabled, timeout_sec, scenario,
        last_run_at, last_run_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name             = excluded.name,
       identifier       = excluded.identifier,
       description      = excluded.description,
       runtime          = excluded.runtime,
       script_content   = excluded.script_content,
       parameters_schema = excluded.parameters_schema,
       dependencies     = excluded.dependencies,
       sample_params    = excluded.sample_params,
       enabled          = excluded.enabled,
       timeout_sec      = excluded.timeout_sec,
       scenario         = excluded.scenario,
       last_run_status  = excluded.last_run_status,
       updated_at       = excluded.updated_at`,
    [
      row.id,
      row.name,
      row.identifier,
      row.description,
      row.runtime,
      row.script_content,
      row.parameters_schema,
      row.dependencies,
      row.sample_params,
      row.enabled,
      row.timeout_sec,
      row.scenario,
      row.last_run_at,
      row.last_run_status,
      row.created_at,
      row.updated_at,
    ],
  )
  return tool
}

/** 删除插件（级联清理 agent_plugin_ref；run_log 由 Rust 侧按需清理）。返回最新列表。 */
export async function deletePlugin(id: string): Promise<void> {
  if (!isTauri) {
    lsSavePlugins(lsListPlugins().filter((p) => p.id !== id))
    lsSaveRefs(lsListRefs().filter((r) => r.pluginId !== id))
    return
  }
  const db = await getDb()
  await db.execute('DELETE FROM agent_plugin_ref WHERE plugin_id = ?', [id])
  await db.execute('DELETE FROM user_plugin_tool WHERE id = ?', [id])
}

/** 切换启用 / 禁用。返回最新列表。 */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<UserPluginTool[]> {
  if (!isTauri) {
    const list = lsListPlugins().map((p) =>
      p.id === id ? { ...p, enabled, updatedAt: new Date().toISOString() } : p,
    )
    lsSavePlugins(list)
    return list
  }
  const db = await getDb()
  await db.execute('UPDATE user_plugin_tool SET enabled = ?, updated_at = ? WHERE id = ?', [
    enabled ? 1 : 0,
    Date.now(),
    id,
  ])
  return listPlugins()
}

/** 回写示例参数（试跑面板「保存为示例参数」）。返回最新列表。 */
export async function saveSampleParams(
  id: string,
  sampleParams: Record<string, unknown> | null,
): Promise<UserPluginTool[]> {
  if (!isTauri) {
    const list = lsListPlugins().map((p) =>
      p.id === id ? { ...p, sampleParams, updatedAt: new Date().toISOString() } : p,
    )
    lsSavePlugins(list)
    return list
  }
  const db = await getDb()
  await db.execute(
    'UPDATE user_plugin_tool SET sample_params = ?, updated_at = ? WHERE id = ?',
    [sampleParams ? JSON.stringify(sampleParams) : null, Date.now(), id],
  )
  return listPlugins()
}

/** 回写最近运行状态（test / Agent 执行后）。 */
export async function setPluginLastRun(
  id: string,
  status: 'unknown' | 'success' | 'failed',
  lastRunAt?: string,
): Promise<void> {
  if (!isTauri) return
  const db = await getDb()
  await db.execute(
    'UPDATE user_plugin_tool SET last_run_status = ?, last_run_at = ?, updated_at = ? WHERE id = ?',
    [runStatusToRow(status), lastRunAt ? Date.parse(lastRunAt) : Date.now(), Date.now(), id],
  )
}

/* ------------------------------------------------------------------ *
 * 智能体绑定（agent_plugin_ref）
 * ------------------------------------------------------------------ */

/** 列出某智能体已绑定的插件（含插件元数据，JOIN user_plugin_tool）。 */
export async function listAgentPlugins(agentId: string): Promise<UserPluginTool[]> {
  if (!isTauri) {
    const refs = lsListRefs().filter((r) => r.agentId === agentId)
    return refs
      .map((r) => lsListPlugins().find((p) => p.id === r.pluginId))
      .filter((p): p is UserPluginTool => Boolean(p))
  }
  const db = await getDb()
  const rows = await db.select<UserPluginToolRow[]>(
    `SELECT p.* FROM user_plugin_tool p
     JOIN agent_plugin_ref r ON r.plugin_id = p.id
     WHERE r.agent_id = ? ORDER BY r.created_at ASC`,
    [agentId],
  )
  return rows.map(rowToPlugin)
}

/** 绑定插件到智能体（已存在则置 is_active=1）。 */
export async function bindPlugin(agentId: string, pluginId: string): Promise<void> {
  if (!isTauri) {
    const refs = lsListRefs()
    const idx = refs.findIndex((r) => r.agentId === agentId && r.pluginId === pluginId)
    const now = new Date().toISOString()
    if (idx >= 0) refs[idx] = { ...refs[idx], isActive: true, updatedAt: now }
    else
      refs.push({
        id: crypto.randomUUID(),
        agentId,
        pluginId,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
    lsSaveRefs(refs)
    return
  }
  const db = await getDb()
  const now = Date.now()
  await db.execute(
    `INSERT INTO agent_plugin_ref (id, agent_id, plugin_id, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(agent_id, plugin_id) DO UPDATE SET is_active = 1, updated_at = excluded.updated_at`,
    [crypto.randomUUID(), agentId, pluginId, now, now],
  )
}

/** 解绑插件（删除关联）。 */
export async function unbindPlugin(agentId: string, pluginId: string): Promise<void> {
  if (!isTauri) {
    lsSaveRefs(
      lsListRefs().filter((r) => !(r.agentId === agentId && r.pluginId === pluginId)),
    )
    return
  }
  const db = await getDb()
  await db.execute('DELETE FROM agent_plugin_ref WHERE agent_id = ? AND plugin_id = ?', [
    agentId,
    pluginId,
  ])
}

/** 绑定级启停。 */
export async function setAgentPluginActive(
  agentId: string,
  pluginId: string,
  active: boolean,
): Promise<void> {
  if (!isTauri) {
    lsSaveRefs(
      lsListRefs().map((r) =>
        r.agentId === agentId && r.pluginId === pluginId
          ? { ...r, isActive: active, updatedAt: new Date().toISOString() }
          : r,
      ),
    )
    return
  }
  const db = await getDb()
  await db.execute(
    'UPDATE agent_plugin_ref SET is_active = ?, updated_at = ? WHERE agent_id = ? AND plugin_id = ?',
    [active ? 1 : 0, Date.now(), agentId, pluginId],
  )
}

/* ------------------------------------------------------------------ *
 * 执行日志（plugin_run_log，只读；写入在 Rust 侧）
 * ------------------------------------------------------------------ */

/** 列出某插件最近执行日志（按时间倒序，limit 默认 50）。 */
export async function listPluginRunLogs(
  pluginId: string,
  limit = 50,
): Promise<PluginRunLog[]> {
  if (!isTauri) return [] // 浏览器回退不落盘日志
  const db = await getDb()
  const rows = await db.select<PluginRunLogRow[]>(
    'SELECT * FROM plugin_run_log WHERE plugin_id = ? ORDER BY created_at DESC LIMIT ?',
    [pluginId, limit],
  )
  return rows.map(rowToRunLog)
}
