/**
 * 智能体的 SQL 数据访问层（mapper）。
 *
 * 约定：
 *  - 所有 SQL 增删改查集中在本目录（src/core/mapper），页面/组件不直接写 SQL；
 *  - SQL 行实体定义在 src/types/database.d.ts（AgentInfoRow / AgentMcpRefRow / AgentSkillRefRow）；
 *  - 驱动：@tauri-apps/plugin-sql（Tauri 2 官方 SQLite 插件）；
 *  - 连接统一经 src/core/db/SqlService.getDb() 获取（全局单例，已在 InitContext 启动时建表）；
 *  - 建表语句（DDL）集中在 src/assets/sql/init.sql，本文件不再持有 CREATE TABLE；
 *  - 表结构适配用户给出的 PostgreSQL 设计（agent_info），按项目约定做类型转换：
 *      int8 → TEXT UUID、jsonb → TEXT、bool → INTEGER、timestamp → epoch 毫秒；
 *  - 关联表的最小单元：
 *      agent_mcp_ref   ← 工具（tool_id → mcp_tool_definition.id），mcp_id 仅作分组冗余；
 *      agent_skill_ref ← 技能（skill_id → skill_info.id）；
 *    两张关联表在保存时「先删后插」，保证与向导勾选结果完全一致；
 *  - 非 Tauri 环境（浏览器 dev）回退 localStorage，保证可调试。
 */
import { isTauri } from '@/core/config'
import type {
  AgentInfo,
  AgentMcpToolRef,
  AgentRefCounts,
  AgentSkillRef,
  AgentUpsertInput,
  MemoryMode,
  PlanApprovalMode,
} from '@/types/core'
import type {
  AgentInfoRow,
  AgentMcpRefRow,
  AgentSkillRefRow,
} from '@/types/database'
import { getDb } from '@/core/db/SqlService'
import { safeIso } from './safeTime'

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

function toJson(v: Record<string, unknown> | undefined): string | null {
  if (!v || Object.keys(v).length === 0) return null
  return JSON.stringify(v)
}

function rowToAgent(r: AgentInfoRow): AgentInfo {
  return {
    id: r.id,
    logo: r.logo ?? undefined,
    scenario: r.scenario ?? undefined,
    name: r.name,
    identifier: r.identifier,
    description: r.description ?? undefined,
    systemPrompt: r.system_prompt ?? undefined,
    welcomeMessage: r.welcome_message ?? undefined,
    llmId: r.llm_id ?? undefined,
    llmConfig: safeParse<Record<string, unknown> | null>(r.llm_config, null) ?? undefined,
    ttsId: r.tts_id ?? undefined,
    ttsConfig: safeParse<Record<string, unknown> | null>(r.tts_config, null) ?? undefined,
    sttId: r.stt_id ?? undefined,
    sttConfig: safeParse<Record<string, unknown> | null>(r.stt_config, null) ?? undefined,
    isActive: r.is_active === 1,
    autoToolExecMode: r.auto_tool_exec_mode === 1,
    allowSandbox: r.allow_sandbox === 1,
    memoryMode: (r.memory_mode as MemoryMode) ?? 'off',
    planAutoApproveMode: (r.plan_auto_approve_mode as PlanApprovalMode) ?? 'always',
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }
}

function rowToMcpRef(r: AgentMcpRefRow): AgentMcpToolRef {
  return {
    id: r.id,
    agentId: r.agent_id,
    mcpId: r.mcp_id,
    toolId: r.tool_id,
    isActive: r.is_active === 1,
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }
}

function rowToSkillRef(r: AgentSkillRefRow): AgentSkillRef {
  return {
    id: r.id,
    agentId: r.agent_id,
    skillId: r.skill_id,
    isActive: r.is_active === 1,
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }
}

/**
 * 生成智能体唯一标识：agent- + 8 位十六进制随机串。
 * 用于新建时 identifier 留空的情况（用户设计：「不填写就随机生成」）。
 */
export function generateAgentIdentifier(): string {
  const bytes = new Uint8Array(4)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `agent-${hex}`
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage
 * ------------------------------------------------------------------ */

const LS_AGENT = 'work-duo:agents'
const LS_MCP = 'work-duo:agent-mcp-refs'
const LS_SKILL = 'work-duo:agent-skill-refs'

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
 * 对外 CRUD（页面/组件只调这些）
 * ------------------------------------------------------------------ */

/** 列表（按创建时间倒序）。scenarioFilter 非空时按场景分类过滤。 */
export async function listAgents(scenarioFilter?: string): Promise<AgentInfo[]> {
  if (!isTauri) {
    return lsRead<AgentInfo>(LS_AGENT).filter(
      (a) => !scenarioFilter || a.scenario === scenarioFilter,
    )
  }
  const db = await getDb()
  const where = scenarioFilter ? 'WHERE scenario = ?' : ''
  const params = scenarioFilter ? [scenarioFilter] : []
  const rows = await db.select<AgentInfoRow[]>(
    `SELECT * FROM agent_info ${where} ORDER BY created_at DESC`,
    params,
  )
  return rows.map(rowToAgent)
}

/** 按 id 查询单个。 */
export async function getAgent(id: string): Promise<AgentInfo | undefined> {
  if (!isTauri) return lsRead<AgentInfo>(LS_AGENT).find((a) => a.id === id)
  const db = await getDb()
  const rows = await db.select<AgentInfoRow[]>('SELECT * FROM agent_info WHERE id = ?', [
    id,
  ])
  return rows[0] ? rowToAgent(rows[0]) : undefined
}

/** 列出某智能体已绑定的 MCP 工具（按创建时间升序）。 */
export async function listAgentMcpTools(
  agentId: string,
): Promise<AgentMcpToolRef[]> {
  if (!isTauri) {
    return lsRead<AgentMcpToolRef>(LS_MCP).filter((r) => r.agentId === agentId)
  }
  const db = await getDb()
  const rows = await db.select<AgentMcpRefRow[]>(
    'SELECT * FROM agent_mcp_ref WHERE agent_id = ? ORDER BY created_at ASC',
    [agentId],
  )
  return rows.map(rowToMcpRef)
}

/** 列出某智能体已编排的技能（按创建时间升序）。 */
export async function listAgentSkills(agentId: string): Promise<AgentSkillRef[]> {
  if (!isTauri) {
    return lsRead<AgentSkillRef>(LS_SKILL).filter((r) => r.agentId === agentId)
  }
  const db = await getDb()
  const rows = await db.select<AgentSkillRefRow[]>(
    'SELECT * FROM agent_skill_ref WHERE agent_id = ? ORDER BY created_at ASC',
    [agentId],
  )
  return rows.map(rowToSkillRef)
}

/**
 * 批量统计各智能体的工具数（MCP 工具 / 技能）。
 * 列表卡片展示用，一次查两张关联表后本地聚合，避免 N+1 查询。
 */
export async function getAgentRefCounts(): Promise<Record<string, AgentRefCounts>> {
  const acc: Record<string, AgentRefCounts> = {}
  const bump = (agentId: string, key: keyof AgentRefCounts) => {
    if (!acc[agentId]) acc[agentId] = { mcpTools: 0, skills: 0 }
    acc[agentId][key] += 1
  }

  if (!isTauri) {
    for (const r of lsRead<AgentMcpToolRef>(LS_MCP)) bump(r.agentId, 'mcpTools')
    for (const r of lsRead<AgentSkillRef>(LS_SKILL)) bump(r.agentId, 'skills')
    return acc
  }

  const db = await getDb()
  const mcpRows = await db.select<{ agent_id: string; n: number }[]>(
    'SELECT agent_id, COUNT(*) AS n FROM agent_mcp_ref GROUP BY agent_id',
  )
  for (const r of mcpRows) {
    if (!acc[r.agent_id]) acc[r.agent_id] = { mcpTools: 0, skills: 0 }
    acc[r.agent_id].mcpTools = r.n
  }
  const skillRows = await db.select<{ agent_id: string; n: number }[]>(
    'SELECT agent_id, COUNT(*) AS n FROM agent_skill_ref GROUP BY agent_id',
  )
  for (const r of skillRows) {
    if (!acc[r.agent_id]) acc[r.agent_id] = { mcpTools: 0, skills: 0 }
    acc[r.agent_id].skills = r.n
  }
  return acc
}

/**
 * 新建 / 更新智能体（主表 + 两张关联表，关联表先删后插）。返回最新列表。
 * identifier 重复由 UNIQUE 约束兜底，抛错由调用方提示。
 */
export async function upsertAgent(input: AgentUpsertInput): Promise<AgentInfo[]> {
  const now = Date.now()
  const isUpdate = Boolean(input.id)
  const id = input.id || crypto.randomUUID()

  if (!isTauri) {
    const list = lsRead<AgentInfo>(LS_AGENT)
    const next: AgentInfo = {
      id,
      logo: input.logo,
      scenario: input.scenario,
      name: input.name,
      identifier: input.identifier,
      description: input.description,
      systemPrompt: input.systemPrompt,
      welcomeMessage: input.welcomeMessage,
      llmId: input.llmId,
      llmConfig: input.llmConfig,
      ttsId: input.ttsId,
      ttsConfig: input.ttsConfig,
      sttId: input.sttId,
      sttConfig: input.sttConfig,
      isActive: input.isActive ?? true,
      autoToolExecMode: input.autoToolExecMode ?? false,
      allowSandbox: input.allowSandbox ?? false,
      memoryMode: input.memoryMode ?? 'off',
      planAutoApproveMode: input.planAutoApproveMode ?? 'always',
      createdAt: isUpdate
        ? list.find((a) => a.id === id)?.createdAt ?? new Date(now).toISOString()
        : new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
    const idx = list.findIndex((a) => a.id === id)
    if (idx >= 0) list[idx] = next
    else list.push(next)
    lsWrite(LS_AGENT, list)

    const mcpRefs = lsRead<AgentMcpToolRef>(LS_MCP).filter((r) => r.agentId !== id)
    mcpRefs.push(
      ...input.mcpTools.map((t) => ({
        id: crypto.randomUUID(),
        agentId: id,
        mcpId: t.mcpId,
        toolId: t.toolId,
        isActive: true,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      })),
    )
    lsWrite(LS_MCP, mcpRefs)

    const skillRefs = lsRead<AgentSkillRef>(LS_SKILL).filter((r) => r.agentId !== id)
    skillRefs.push(
      ...input.skillIds.map((skillId) => ({
        id: crypto.randomUUID(),
        agentId: id,
        skillId,
        isActive: true,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      })),
    )
    lsWrite(LS_SKILL, skillRefs)

    // 本地插件绑定（P2 新增；键与 plugin-mapper 的 localStorage 回退保持一致）
    const pluginRefs = lsRead<{ id: string; agentId: string; pluginId: string; isActive: boolean; createdAt: string; updatedAt: string }>('work-duo:agent-plugins').filter((r) => r.agentId !== id)
    pluginRefs.push(
      ...(input.pluginIds ?? []).map((pluginId) => ({
        id: crypto.randomUUID(),
        agentId: id,
        pluginId,
        isActive: true,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      })),
    )
    lsWrite('work-duo:agent-plugins', pluginRefs)
    return list
  }

  const db = await getDb()
  await db.execute(
    `INSERT INTO agent_info
       (id, logo, scenario, name, identifier, description, system_prompt, welcome_message,
        llm_id, llm_config, tts_id, tts_config, stt_id, stt_config,
        is_active, auto_tool_exec_mode, allow_sandbox, memory_mode, plan_auto_approve_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
        logo                = excluded.logo,
        scenario            = excluded.scenario,
        name                = excluded.name,
        identifier          = excluded.identifier,
        description         = excluded.description,
        system_prompt       = excluded.system_prompt,
        welcome_message     = excluded.welcome_message,
        llm_id              = excluded.llm_id,
        llm_config          = excluded.llm_config,
        tts_id              = excluded.tts_id,
        tts_config          = excluded.tts_config,
        stt_id              = excluded.stt_id,
        stt_config          = excluded.stt_config,
        is_active           = excluded.is_active,
        auto_tool_exec_mode = excluded.auto_tool_exec_mode,
        allow_sandbox       = excluded.allow_sandbox,
        memory_mode         = excluded.memory_mode,
        plan_auto_approve_mode = excluded.plan_auto_approve_mode,
        updated_at          = excluded.updated_at`,
    [
      id,
      input.logo ?? null,
      input.scenario ?? null,
      input.name,
      input.identifier,
      input.description ?? null,
      input.systemPrompt ?? null,
      input.welcomeMessage ?? null,
      input.llmId ?? null,
      toJson(input.llmConfig),
      input.ttsId ?? null,
      toJson(input.ttsConfig),
      input.sttId ?? null,
      toJson(input.sttConfig),
      (input.isActive ?? true) ? 1 : 0,
      (input.autoToolExecMode ?? false) ? 1 : 0,
      (input.allowSandbox ?? false) ? 1 : 0,
      input.memoryMode ?? 'off',
      input.planAutoApproveMode ?? 'always',
      now,
      now,
    ],
  )

  // 关联表：先删后插，保证与向导勾选结果完全一致
  await db.execute('DELETE FROM agent_mcp_ref WHERE agent_id = ?', [id])
  for (const t of input.mcpTools) {
    await db.execute(
      `INSERT INTO agent_mcp_ref (id, agent_id, mcp_id, tool_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [crypto.randomUUID(), id, t.mcpId, t.toolId, now, now],
    )
  }

  await db.execute('DELETE FROM agent_skill_ref WHERE agent_id = ?', [id])
  for (const skillId of input.skillIds) {
    await db.execute(
      `INSERT INTO agent_skill_ref (id, agent_id, skill_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [crypto.randomUUID(), id, skillId, now, now],
    )
  }

  // 本地插件绑定（P2 新增）：先删后插，与向导勾选结果一致
  await db.execute('DELETE FROM agent_plugin_ref WHERE agent_id = ?', [id])
  for (const pluginId of input.pluginIds ?? []) {
    await db.execute(
      `INSERT INTO agent_plugin_ref (id, agent_id, plugin_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [crypto.randomUUID(), id, pluginId, now, now],
    )
  }

  return listAgents()
}

/** 删除智能体（级联清理两张关联表）。返回最新列表。 */
export async function deleteAgent(id: string): Promise<AgentInfo[]> {
  if (!isTauri) {
    lsWrite(
      LS_AGENT,
      lsRead<AgentInfo>(LS_AGENT).filter((a) => a.id !== id),
    )
    lsWrite(
      LS_MCP,
      lsRead<AgentMcpToolRef>(LS_MCP).filter((r) => r.agentId !== id),
    )
    lsWrite(
      LS_SKILL,
      lsRead<AgentSkillRef>(LS_SKILL).filter((r) => r.agentId !== id),
    )
    // 本地插件绑定级联清理（P2 新增；键与 plugin-mapper 一致）
    lsWrite(
      'work-duo:agent-plugins',
      lsRead<{ id: string; agentId: string; pluginId: string }>('work-duo:agent-plugins').filter((r) => r.agentId !== id),
    )
    return lsRead<AgentInfo>(LS_AGENT)
  }
  const db = await getDb()
  await db.execute('DELETE FROM agent_mcp_ref WHERE agent_id = ?', [id])
  await db.execute('DELETE FROM agent_skill_ref WHERE agent_id = ?', [id])
  await db.execute('DELETE FROM agent_plugin_ref WHERE agent_id = ?', [id])
  await db.execute('DELETE FROM agent_info WHERE id = ?', [id])
  return listAgents()
}

/** 仅切换启用状态（卡片右上角 Switch）。返回最新列表。 */
export async function setAgentActive(
  id: string,
  active: boolean,
): Promise<AgentInfo[]> {
  if (!isTauri) {
    const list = lsRead<AgentInfo>(LS_AGENT).map((a) =>
      a.id === id ? { ...a, isActive: active, updatedAt: new Date().toISOString() } : a,
    )
    lsWrite(LS_AGENT, list)
    return list
  }
  const db = await getDb()
  await db.execute(
    'UPDATE agent_info SET is_active = ?, updated_at = ? WHERE id = ?',
    [active ? 1 : 0, Date.now(), id],
  )
  return listAgents()
}
