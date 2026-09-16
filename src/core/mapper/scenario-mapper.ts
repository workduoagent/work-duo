/**
 * 场景分类字典（scenario_category 表）的数据访问层（mapper）。
 *
 * 统一管理 LLM / MCP / Skill / KB 的「域-选项-显示名」枚举，替代三处前端硬编码。
 * 约定：
 *  - 所有 SQL 集中在本目录；建表在 init.sql；
 *  - 驱动 @tauri-apps/plugin-sql；非 Tauri 回退 localStorage（全量数组集中存储）；
 *  - deleteScenario 会先按 scope 置空对应业务表的引用
 *    （SKILL→skill_info.scenario、MCP→mcp_info.scenario、KB→knowledge_base.scenario、
 *     AGENT→agent_info.scenario），再删字典行；
 *  - 业务表存的是 value（不变），因此删除字典项不影响旧数据的 value，仅将其引用置空。
 */
import { isTauri } from '@/core/config'
import { getDb } from '@/core/db/SqlService'
import type { ScenarioCategory, ScenarioScope } from '@/types/core'

/** 每个 scope 对应的「业务引用表 + 列」。 */
const SCOPE_REF: Partial<
  Record<ScenarioScope, { table: string; column: string; notNull: boolean }>
> = {
  SKILL: { table: 'skill_info', column: 'scenario', notNull: false },
  MCP: { table: 'mcp_info', column: 'scenario', notNull: false },
  KB: { table: 'knowledge_base', column: 'scenario', notNull: false },
  AGENT: { table: 'agent_info', column: 'scenario', notNull: false },
  PLUGIN: { table: 'user_plugin_tool', column: 'scenario', notNull: false },
}

interface Row {
  id: string
  scope: string
  value: string
  label: string
  created_at: number
  updated_at: number
}

function toCategory(r: Row): ScenarioCategory {
  return {
    id: r.id,
    scope: r.scope as ScenarioScope,
    value: r.value,
    label: r.label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 把任意显示名规整为合法的 value（小写连字符；空则回退 'item'）。 */
function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  )
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage（全量数组集中存储）
 * ------------------------------------------------------------------ */

const LS_KEY = 'work-duo:scenario-categories'

function lsAll(): ScenarioCategory[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as ScenarioCategory[]) : []
  } catch {
    return []
  }
}

function lsSave(list: ScenarioCategory[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list))
}

/* ------------------------------------------------------------------ *
 * 对外 API（页面 / 组件只调这些）
 * ------------------------------------------------------------------ */

/** 按 scope 列出选项（按创建时间升序）。 */
export async function listByScope(
  scope: ScenarioScope,
): Promise<ScenarioCategory[]> {
  if (!isTauri) return lsAll().filter((s) => s.scope === scope)
  const db = await getDb()
  const rows = await db.select<Row[]>(
    'SELECT * FROM scenario_category WHERE scope = ? ORDER BY created_at ASC',
    [scope],
  )
  return rows.map(toCategory)
}

/** 统计某 scope+value 在业务表中的引用数（删除前用于强提示）。非 Tauri 返回 0。 */
export async function countReferences(
  scope: ScenarioScope,
  value: string,
): Promise<number> {
  const ref = SCOPE_REF[scope]
  if (!ref || !isTauri) return 0
  const db = await getDb()
  const rows = await db.select<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?`,
    [value],
  )
  return rows[0]?.n ?? 0
}

/**
 * 新建：label 必填；value 由 label 自动 slug，若与同 scope 下已有项冲突则追加数字后缀。
 * 返回新建后的完整行。
 */
export async function createScenario(
  scope: ScenarioScope,
  label: string,
  value?: string,
): Promise<ScenarioCategory> {
  const base = (value && slugify(value)) || slugify(label)
  const now = Date.now()

  const existing = await listByScope(scope)
  const taken = new Set(existing.map((e) => e.value))
  let finalValue = base
  let i = 2
  while (taken.has(finalValue)) finalValue = `${base}-${i++}`

  if (!isTauri) {
    const created: ScenarioCategory = {
      id: `local-${scope}-${finalValue}-${now}`,
      scope,
      value: finalValue,
      label: label.trim(),
      createdAt: now,
      updatedAt: now,
    }
    const list = lsAll()
    list.push(created)
    lsSave(list)
    return created
  }

  const db = await getDb()
  const id = `sc-${scope}-${finalValue}-${now}`
  await db.execute(
    `INSERT INTO scenario_category (id, scope, value, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, scope, finalValue, label.trim(), now, now],
  )
  const rows = await db.select<Row[]>(
    'SELECT * FROM scenario_category WHERE id = ?',
    [id],
  )
  return toCategory(rows[0])
}

/** 仅更新显示名 label（不改 value / scope）。 */
export async function updateScenarioLabel(
  id: string,
  label: string,
): Promise<void> {
  if (!isTauri) {
    const list = lsAll().map((s) =>
      s.id === id ? { ...s, label: label.trim(), updatedAt: Date.now() } : s,
    )
    lsSave(list)
    return
  }
  const db = await getDb()
  await db.execute(
    'UPDATE scenario_category SET label = ?, updated_at = ? WHERE id = ?',
    [label.trim(), Date.now(), id],
  )
}

/**
 * 删除：先按 scope 置空对应业务表引用（NOT NULL 列置空串，可空列置 NULL），再删字典行。
 */
export async function deleteScenario(id: string): Promise<void> {
  if (!isTauri) {
    lsSave(lsAll().filter((s) => s.id !== id))
    return
  }
  const db = await getDb()
  const rows = await db.select<Row[]>(
    'SELECT * FROM scenario_category WHERE id = ?',
    [id],
  )
  const target = rows[0]
  if (!target) return
  const ref = SCOPE_REF[target.scope as ScenarioScope]
  if (ref) {
    const clearVal = ref.notNull ? '' : null
    await db.execute(
      `UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ?`,
      [clearVal, target.value],
    )
  }
  await db.execute('DELETE FROM scenario_category WHERE id = ?', [id])
}
