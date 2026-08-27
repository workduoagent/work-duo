/**
 * 技能能力单元的 SQL 数据访问层（mapper）。
 *
 * 约定：
 *  - 所有 SQL 增删改查集中在本目录（src/core/mapper），页面/组件不直接写 SQL；
 *  - SQL 行实体定义在 src/types/database.d.ts（SkillInfoRow）；
 *  - 驱动：@tauri-apps/plugin-sql（Tauri 2 官方 SQLite 插件）；
 *  - 连接统一经 src/core/db/SqlService.getDb() 获取（全局单例，已在 InitContext 启动时建表）；
 *  - 建表语句（DDL）集中在 src/assets/sql/init.sql，本文件不再持有 CREATE TABLE；
 *  - tags 序列化进 tags 列（JSON 字符串），读取时还原；
 *  - scenario 存 SkillCategory key；
 *  - 非 Tauri 环境（浏览器 dev）回退 localStorage，保证可调试。
 */
import { isTauri } from '@/core/config'
import type { SkillCategory } from '@/types/core'
import type { SkillInfo } from '@/core/file/skill-file'
import type { SkillInfoRow } from '@/types/database'
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

const DEFAULT_SKILL_PATH = '$RESOURCE/.skills'

/** 计算技能本地存储目录（basePath + '/' + identifier）。 */
function buildPath(basePath: string, identifier: string): string {
  return `${basePath.replace(/\/+$/, '')}/${identifier}`
}

function skillToRow(s: SkillInfo, basePath: string): SkillInfoRow {
  const now = Date.now()
  return {
    id: s.id,
    identifier: s.identifier,
    name: s.name || null,
    description: s.description || null,
    instruction: s.instruction || null,
    tags: s.tags && s.tags.length ? JSON.stringify(s.tags) : null,
    scenario: s.scenario ?? null,
    path: s.path || buildPath(basePath, s.identifier),
    created_at: now,
    updated_at: now,
  }
}

function rowToSkill(r: SkillInfoRow): SkillInfo {
  return {
    id: r.id,
    identifier: r.identifier,
    name: r.name ?? '',
    description: r.description ?? undefined,
    instruction: r.instruction ?? undefined,
    tags: safeParse<string[] | null>(r.tags, null) ?? undefined,
    scenario: (r.scenario as SkillCategory) ?? undefined,
    path: r.path ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

/* ------------------------------------------------------------------ *
 * skill_path 解析（读 app_config，非 Tauri 回退常量）
 * ------------------------------------------------------------------ */

async function resolveSkillBasePath(): Promise<string> {
  if (!isTauri) return 'skills' // 非 Tauri 仅记录相对路径，不真实落盘
  try {
    const db = await getDb()
    const rows = await db.select<{ value: string }[]>(
      "SELECT value FROM app_config WHERE key = 'skill_path'",
    )
    return rows[0]?.value || DEFAULT_SKILL_PATH
  } catch {
    return DEFAULT_SKILL_PATH
  }
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage
 * ------------------------------------------------------------------ */

const LS_KEY = 'work-duo:skills'

function lsList(): SkillInfo[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as SkillInfo[]) : []
  } catch {
    return []
  }
}

function lsSave(list: SkillInfo[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list))
}

/* ------------------------------------------------------------------ *
 * 对外 CRUD（页面/组件只调这些）
 * ------------------------------------------------------------------ */

/** 列表（按创建时间倒序）。可传 scenario 过滤单一分类。 */
export async function listSkills(
  scenario?: SkillCategory | null,
): Promise<SkillInfo[]> {
  if (!isTauri) {
    const list = lsList()
    return scenario ? list.filter((s) => s.scenario === scenario) : list
  }
  const db = await getDb()
  const rows = scenario
    ? await db.select<SkillInfoRow[]>(
        'SELECT * FROM skill_info WHERE scenario = ? ORDER BY created_at DESC',
        [scenario],
      )
    : await db.select<SkillInfoRow[]>(
        'SELECT * FROM skill_info ORDER BY created_at DESC',
      )
  return rows.map(rowToSkill)
}

/** 按 id 查询单个。 */
export async function getSkill(id: string): Promise<SkillInfo | undefined> {
  if (!isTauri) return lsList().find((s) => s.id === id)
  const db = await getDb()
  const rows = await db.select<SkillInfoRow[]>(
    'SELECT * FROM skill_info WHERE id = ?',
    [id],
  )
  return rows[0] ? rowToSkill(rows[0]) : undefined
}

/** 新增或更新（按 id 幂等；更新时保留 created_at）。返回最新列表。 */
export async function upsertSkill(skill: SkillInfo): Promise<SkillInfo[]> {
  if (!isTauri) {
    const list = lsList()
    const idx = list.findIndex((m) => m.id === skill.id)
    const next: SkillInfo = { ...skill, updatedAt: new Date().toISOString() }
    if (idx >= 0) list[idx] = next
    else list.push(next)
    lsSave(list)
    return list
  }
  const basePath = await resolveSkillBasePath()
  const db = await getDb()
  const row = skillToRow(skill, basePath)
  await db.execute(
    `INSERT INTO skill_info
       (id, identifier, name, description, instruction, tags, scenario, path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       identifier  = excluded.identifier,
       name        = excluded.name,
       description = excluded.description,
       instruction = excluded.instruction,
       tags        = excluded.tags,
       scenario    = excluded.scenario,
       path        = excluded.path,
       updated_at  = excluded.updated_at`,
    [
      row.id,
      row.identifier,
      row.name,
      row.description,
      row.instruction,
      row.tags,
      row.scenario,
      row.path,
      row.created_at,
      row.updated_at,
    ],
  )
  return listSkills()
}

/** 删除。返回最新列表。 */
export async function deleteSkill(id: string): Promise<SkillInfo[]> {
  if (!isTauri) {
    const list = lsList().filter((m) => m.id !== id)
    lsSave(list)
    return list
  }
  const db = await getDb()
  await db.execute('DELETE FROM skill_info WHERE id = ?', [id])
  return listSkills()
}
