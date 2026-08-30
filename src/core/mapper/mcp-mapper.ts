/**
 * MCP 服务接入 + 工具定义的 SQL 数据访问层（mapper）。
 *
 * 约定：
 *  - 所有 SQL 增删改查集中在本目录（src/core/mapper），页面/组件不直接写 SQL；
 *  - SQL 行实体定义在 src/types/database.d.ts（McpInfoRow / McpToolDefinitionRow）；
 *  - 驱动：@tauri-apps/plugin-sql（Tauri 2 官方 SQLite 插件）；
 *  - 连接统一经 src/core/db/SqlService.getDb() 获取（全局单例，已在 InitContext 启动时建表）；
 *  - 建表语句（DDL）集中在 src/assets/sql/init.sql，本文件不再持有 CREATE TABLE；
 *  - headers / auth_config / capabilities / properties / input_schema /
 *    output_schema / test_params：JSON 序列化进对应列，读取时还原；
 *  - is_active / status：INTEGER 0/1（status 取 0/1/2）；
 *  - 非 Tauri 环境（浏览器 dev）回退 localStorage，保证可调试。
 *
 * 本模块只做「接入」：工具（mcp_tool_definition）由连通性测试 / 同步自动发现，
 * 通过 syncMcpTools 写入，不在此提供手动「构建」工具的能力。
 */
import { isTauri } from '@/core/config'
import type {
  McpProtocolType,
  McpAuthType,
  McpStatus,
} from '@/types/core'
import type { McpInfo, McpToolDefinition } from '@/core/file/mcp-file'
import type { McpInfoRow, McpToolDefinitionRow } from '@/types/database'
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

function mcpToRow(m: McpInfo): McpInfoRow {
  const now = Date.now()
  return {
    id: m.id,
    alias_name: m.aliasName || null,
    mcp_name: m.mcpName || null,
    protocol_type: m.protocolType,
    endpoint_url: m.endpointUrl || null,
    headers: m.headers ? JSON.stringify(m.headers) : null,
    auth_type: m.authType,
    auth_config: m.authConfig ? JSON.stringify(m.authConfig) : null,
    is_active: m.isActive ? 1 : 0,
    status: m.status ?? 0,
    capabilities: m.capabilities ? JSON.stringify(m.capabilities) : null,
    properties: m.properties ? JSON.stringify(m.properties) : null,
    description: m.description || null,
    scenario: m.scenario ?? null,
    timeout_sec: m.timeoutSec ?? 120,
    created_at: now,
    updated_at: now,
  }
}

function rowToMcp(r: McpInfoRow): McpInfo {
  return {
    id: r.id,
    aliasName: r.alias_name ?? undefined,
    mcpName: r.mcp_name ?? '',
    protocolType: (r.protocol_type as McpProtocolType) ?? 'HTTP',
    endpointUrl: r.endpoint_url ?? undefined,
    headers: safeParse<Record<string, string> | null>(r.headers, null) ?? undefined,
    authType: (r.auth_type as McpAuthType) ?? 'NONE',
    authConfig:
      safeParse<Record<string, unknown> | null>(r.auth_config, null) ?? undefined,
    isActive: r.is_active === 1,
    status: (r.status as McpStatus) ?? 0,
    capabilities: safeParse<unknown[] | null>(r.capabilities, null) ?? undefined,
    properties:
      safeParse<Record<string, unknown> | null>(r.properties, null) ?? undefined,
    description: r.description ?? undefined,
    scenario: r.scenario ?? undefined,
    timeoutSec: r.timeout_sec ?? 120,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

function toolToRow(t: McpToolDefinition): McpToolDefinitionRow {
  const now = Date.now()
  return {
    id: t.id,
    mcp_id: t.mcpId,
    tool_code: t.toolCode || null,
    display_name: t.displayName || null,
    description: t.description || null,
    input_schema: t.inputSchema ? JSON.stringify(t.inputSchema) : null,
    output_schema: t.outputSchema ? JSON.stringify(t.outputSchema) : null,
    endpoint: t.endpoint || null,
    method_type: t.methodType || null,
    is_active: t.isActive ? 1 : 0,
    timeout: t.timeout || 0,
    test_params: t.testParams ? JSON.stringify(t.testParams) : null,
    created_at: now,
    updated_at: now,
  }
}

function rowToTool(r: McpToolDefinitionRow): McpToolDefinition {
  return {
    id: r.id,
    mcpId: r.mcp_id,
    toolCode: r.tool_code ?? undefined,
    displayName: r.display_name ?? undefined,
    description: r.description ?? undefined,
    inputSchema:
      safeParse<Record<string, unknown> | null>(r.input_schema, null) ?? undefined,
    outputSchema:
      safeParse<Record<string, unknown> | null>(r.output_schema, null) ?? undefined,
    endpoint: r.endpoint ?? undefined,
    methodType: r.method_type ?? undefined,
    isActive: r.is_active === 1,
    timeout: r.timeout || 0,
    testParams:
      safeParse<Record<string, unknown> | null>(r.test_params, null) ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage
 * ------------------------------------------------------------------ */

const LS_MCP_KEY = 'work-duo:mcps'
const LS_TOOL_KEY = 'work-duo:mcp-tools'

function lsListMcp(): McpInfo[] {
  try {
    const raw = localStorage.getItem(LS_MCP_KEY)
    return raw ? (JSON.parse(raw) as McpInfo[]) : []
  } catch {
    return []
  }
}
function lsSaveMcp(list: McpInfo[]): void {
  localStorage.setItem(LS_MCP_KEY, JSON.stringify(list))
}
function lsListTools(): McpToolDefinition[] {
  try {
    const raw = localStorage.getItem(LS_TOOL_KEY)
    return raw ? (JSON.parse(raw) as McpToolDefinition[]) : []
  } catch {
    return []
  }
}
function lsSaveTools(list: McpToolDefinition[]): void {
  localStorage.setItem(LS_TOOL_KEY, JSON.stringify(list))
}

/* ------------------------------------------------------------------ *
 * 对外 CRUD（页面/组件只调这些）
 * ------------------------------------------------------------------ */

/** 列表（按创建时间倒序）。可传 scenario 过滤单一场景。 */
export async function listMcps(
  scenario?: string | null,
): Promise<McpInfo[]> {
  if (!isTauri) {
    const list = lsListMcp()
    return scenario ? list.filter((m) => m.scenario === scenario) : list
  }
  const db = await getDb()
  const rows = scenario
    ? await db.select<McpInfoRow[]>(
        'SELECT * FROM mcp_info WHERE scenario = ? ORDER BY created_at DESC',
        [scenario],
      )
    : await db.select<McpInfoRow[]>(
        'SELECT * FROM mcp_info ORDER BY created_at DESC',
      )
  return rows.map(rowToMcp)
}

/** 按 id 查询单个。 */
export async function getMcp(id: string): Promise<McpInfo | undefined> {
  if (!isTauri) return lsListMcp().find((m) => m.id === id)
  const db = await getDb()
  const rows = await db.select<McpInfoRow[]>(
    'SELECT * FROM mcp_info WHERE id = ?',
    [id],
  )
  return rows[0] ? rowToMcp(rows[0]) : undefined
}

/** 新增或更新（按 id 幂等；更新时保留 created_at）。返回最新列表。 */
export async function upsertMcp(mcp: McpInfo): Promise<McpInfo[]> {
  if (!isTauri) {
    const list = lsListMcp()
    const idx = list.findIndex((m) => m.id === mcp.id)
    const next: McpInfo = { ...mcp, updatedAt: new Date().toISOString() }
    if (idx >= 0) list[idx] = next
    else list.push(next)
    lsSaveMcp(list)
    return list
  }
  const db = await getDb()
  const row = mcpToRow(mcp)
  await db.execute(
    `INSERT INTO mcp_info
       (id, alias_name, mcp_name, protocol_type, endpoint_url, headers, auth_type,
        auth_config, is_active, status, capabilities, properties, description,
        scenario, timeout_sec, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       alias_name   = excluded.alias_name,
       mcp_name     = excluded.mcp_name,
       protocol_type = excluded.protocol_type,
       endpoint_url = excluded.endpoint_url,
       headers      = excluded.headers,
       auth_type    = excluded.auth_type,
       auth_config  = excluded.auth_config,
       is_active    = excluded.is_active,
       status       = excluded.status,
       capabilities = excluded.capabilities,
       properties   = excluded.properties,
       description  = excluded.description,
       scenario     = excluded.scenario,
       timeout_sec  = excluded.timeout_sec,
       updated_at   = excluded.updated_at`,
    [
      row.id,
      row.alias_name,
      row.mcp_name,
      row.protocol_type,
      row.endpoint_url,
      row.headers,
      row.auth_type,
      row.auth_config,
      row.is_active,
      row.status,
      row.capabilities,
      row.properties,
      row.description,
      row.scenario,
      row.timeout_sec,
      row.created_at,
      row.updated_at,
    ],
  )
  return listMcps()
}

/** 删除（同时级联删除其下工具）。返回最新列表。 */
export async function deleteMcp(id: string): Promise<McpInfo[]> {
  if (!isTauri) {
    lsSaveMcp(lsListMcp().filter((m) => m.id !== id))
    lsSaveTools(lsListTools().filter((t) => t.mcpId !== id))
    return lsListMcp()
  }
  const db = await getDb()
  await db.execute('DELETE FROM mcp_tool_definition WHERE mcp_id = ?', [id])
  await db.execute('DELETE FROM mcp_info WHERE id = ?', [id])
  return listMcps()
}

/** 更新连通状态（不改动 created_at）。返回最新列表。 */
export async function updateMcpStatus(
  id: string,
  status: McpStatus,
): Promise<McpInfo[]> {
  if (!isTauri) {
    const list = lsListMcp().map((m) =>
      m.id === id
        ? { ...m, status, updatedAt: new Date().toISOString() }
        : m,
    )
    lsSaveMcp(list)
    return list
  }
  const db = await getDb()
  await db.execute('UPDATE mcp_info SET status = ?, updated_at = ? WHERE id = ?', [
    status,
    Date.now(),
    id,
  ])
  return listMcps()
}

/** 切换启用 / 禁用。返回最新列表。 */
export async function setMcpActive(
  id: string,
  active: boolean,
): Promise<McpInfo[]> {
  if (!isTauri) {
    const list = lsListMcp().map((m) =>
      m.id === id
        ? { ...m, isActive: active, updatedAt: new Date().toISOString() }
        : m,
    )
    lsSaveMcp(list)
    return list
  }
  const db = await getDb()
  await db.execute('UPDATE mcp_info SET is_active = ?, updated_at = ? WHERE id = ?', [
    active ? 1 : 0,
    Date.now(),
    id,
  ])
  return listMcps()
}

/* ------------------------------------------------------------------ *
 * 工具（mcp_tool_definition）CRUD
 * ------------------------------------------------------------------ */

/** 按 mcp_id 列出工具。 */
export async function listMcpTools(mcpId: string): Promise<McpToolDefinition[]> {
  if (!isTauri) return lsListTools().filter((t) => t.mcpId === mcpId)
  const db = await getDb()
  const rows = await db.select<McpToolDefinitionRow[]>(
    'SELECT * FROM mcp_tool_definition WHERE mcp_id = ? ORDER BY created_at DESC',
    [mcpId],
  )
  return rows.map(rowToTool)
}

/** 单个工具新增 / 更新（按 id 幂等）。返回该 mcp 的最新工具列表。 */
export async function upsertMcpTool(
  tool: McpToolDefinition,
): Promise<McpToolDefinition[]> {
  if (!isTauri) {
    const list = lsListTools()
    const idx = list.findIndex((t) => t.id === tool.id)
    const next: McpToolDefinition = { ...tool, updatedAt: new Date().toISOString() }
    if (idx >= 0) list[idx] = next
    else list.push(next)
    lsSaveTools(list)
    return listMcpTools(tool.mcpId)
  }
  const db = await getDb()
  const row = toolToRow(tool)
  await db.execute(
    `INSERT INTO mcp_tool_definition
       (id, mcp_id, tool_code, display_name, description, input_schema,
        output_schema, endpoint, method_type, is_active, timeout, test_params,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mcp_id       = excluded.mcp_id,
       tool_code    = excluded.tool_code,
       display_name = excluded.display_name,
       description  = excluded.description,
       input_schema = excluded.input_schema,
       output_schema = excluded.output_schema,
       endpoint     = excluded.endpoint,
       method_type  = excluded.method_type,
       is_active    = excluded.is_active,
       timeout      = excluded.timeout,
       test_params  = excluded.test_params,
       updated_at   = excluded.updated_at`,
    [
      row.id,
      row.mcp_id,
      row.tool_code,
      row.display_name,
      row.description,
      row.input_schema,
      row.output_schema,
      row.endpoint,
      row.method_type,
      row.is_active,
      row.timeout,
      row.test_params,
      row.created_at,
      row.updated_at,
    ],
  )
  return listMcpTools(tool.mcpId)
}

/** 删除单个工具。 */
export async function deleteMcpTool(id: string): Promise<void> {
  if (!isTauri) {
    lsSaveTools(lsListTools().filter((t) => t.id !== id))
    return
  }
  const db = await getDb()
  await db.execute('DELETE FROM mcp_tool_definition WHERE id = ?', [id])
}

/**
 * 同步工具：先删除该 mcp 下全部旧工具，再批量写入发现到的新工具。
 * 连通性测试 / 「同步工具」按钮调用，保证工具列表与真实服务一致。
 * 关键：按 tool_code 保留用户此前对工具「启用 / 禁用」的设定，避免重新同步后被重置。
 */
export async function syncMcpTools(
  mcpId: string,
  tools: McpToolDefinition[],
): Promise<McpToolDefinition[]> {
  if (!isTauri) {
    const all = lsListTools()
    // 记录该 mcp 下原有工具的启用状态（按 tool_code 匹配）
    const prevActive = new Map<string, boolean>()
    for (const t of all) {
      if (t.mcpId === mcpId && t.toolCode) prevActive.set(t.toolCode, t.isActive)
    }
    const rest = all.filter((t) => t.mcpId !== mcpId)
    const next = tools.map((t) =>
      t.toolCode && prevActive.has(t.toolCode)
        ? { ...t, isActive: prevActive.get(t.toolCode) as boolean }
        : t,
    )
    lsSaveTools([...rest, ...next])
    return next
  }
  const db = await getDb()
  // 记录原有启用状态
  const existing = await db.select<{ tool_code: string | null; is_active: number }[]>(
    'SELECT tool_code, is_active FROM mcp_tool_definition WHERE mcp_id = ?',
    [mcpId],
  )
  const prevActive = new Map<string, boolean>()
  for (const r of existing) {
    if (r.tool_code) prevActive.set(r.tool_code, r.is_active === 1)
  }
  await db.execute('DELETE FROM mcp_tool_definition WHERE mcp_id = ?', [mcpId])
  for (const t of tools) {
    const preserved =
      t.toolCode && prevActive.has(t.toolCode)
        ? (prevActive.get(t.toolCode) as boolean)
        : t.isActive
    const row = toolToRow({ ...t, isActive: preserved })
    await db.execute(
      `INSERT INTO mcp_tool_definition
         (id, mcp_id, tool_code, display_name, description, input_schema,
          output_schema, endpoint, method_type, is_active, timeout, test_params,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.mcp_id,
        row.tool_code,
        row.display_name,
        row.description,
        row.input_schema,
        row.output_schema,
        row.endpoint,
        row.method_type,
        row.is_active,
        row.timeout,
        row.test_params,
        row.created_at,
        row.updated_at,
      ],
    )
  }
  return tools
}

/* ------------------------------------------------------------------ *
 * 工具计数 + 单个工具启用开关
 * ------------------------------------------------------------------ */

/** 单个 MCP 的工具计数（总数 + 已激活数）。 */
export interface McpToolCount {
  total: number
  active: number
}

/** 单个 MCP 的工具总数 / 已激活数。 */
export async function getMcpToolCount(mcpId: string): Promise<McpToolCount> {
  if (!isTauri) {
    const list = lsListTools().filter((t) => t.mcpId === mcpId)
    const active = list.filter((t) => t.isActive).length
    return { total: list.length, active }
  }
  const db = await getDb()
  const rows = await db.select<{ total: number; active: number }[]>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(is_active), 0) AS active
       FROM mcp_tool_definition WHERE mcp_id = ?`,
    [mcpId],
  )
  const r = rows[0]
  return { total: r?.total ?? 0, active: r?.active ?? 0 }
}

/** 批量计数：返回 mcpId -> {total, active} 映射（列表页一次性拉取）。 */
export async function getMcpToolCountMap(): Promise<Record<string, McpToolCount>> {
  if (!isTauri) {
    const map: Record<string, McpToolCount> = {}
    for (const t of lsListTools()) {
      const e = (map[t.mcpId] ??= { total: 0, active: 0 })
      e.total += 1
      if (t.isActive) e.active += 1
    }
    return map
  }
  const db = await getDb()
  const rows = await db.select<{ mcp_id: string; total: number; active: number }[]>(
    `SELECT mcp_id, COUNT(*) AS total, COALESCE(SUM(is_active), 0) AS active
       FROM mcp_tool_definition GROUP BY mcp_id`,
    [],
  )
  const map: Record<string, McpToolCount> = {}
  for (const r of rows) {
    map[r.mcp_id] = { total: r.total, active: r.active }
  }
  return map
}

/** 切换单个工具的启用 / 禁用。 */
export async function setMcpToolActive(
  id: string,
  active: boolean,
): Promise<void> {
  if (!isTauri) {
    lsSaveTools(
      lsListTools().map((t) => (t.id === id ? { ...t, isActive: active } : t)),
    )
    return
  }
  const db = await getDb()
  await db.execute(
    'UPDATE mcp_tool_definition SET is_active = ?, updated_at = ? WHERE id = ?',
    [active ? 1 : 0, Date.now(), id],
  )
}
