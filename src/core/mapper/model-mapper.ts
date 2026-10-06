/**
 * 模型接入配置的 SQL 数据访问层（mapper）。
 *
 * 约定：
 *  - 所有 SQL 增删改查集中在本目录（src/core/mapper），页面/组件不直接写 SQL；
 *  - SQL 行实体定义在 src/types/database.d.ts（ModelConfigRow）；
 *  - 驱动：@tauri-apps/plugin-sql（Tauri 2 官方 SQLite 插件）；
 *  - 连接统一经 src/core/db/SqlService.getDb() 获取（全局单例，已在 InitContext 启动时建表）；
 *  - 建表语句（DDL）集中在 src/assets/sql/init.sql，本文件不再持有 CREATE TABLE；
 *  - 异构参数（text/multimodal/...）序列化进 config 列（JSON 字符串），读取时还原到 ModelConfig；
 *  - 非 Tauri 环境（浏览器 dev）回退 localStorage，保证可调试。
 *
 * 需要的 Tauri 能力（capabilities，由维护者配置）：
 *  - $API$/sql/load、execute、select（db = workduo.db）。
 */
import { isTauri } from '@/core/config'
import type { ModelProvider } from '@/types/core'
import type { ModelConfig } from '@/core/file/model-file'
import type { ModelConfigRow } from '@/types/database'
import { getDb } from '@/core/db/SqlService'
import { safeParse } from './localFallback'
import { safeIso } from './safeTime'

/* ------------------------------------------------------------------ *
 * 行 <-> 领域模型 转换
 * ------------------------------------------------------------------ */


function modelToRow(m: ModelConfig): ModelConfigRow {
  const now = Date.now()
  const params = (m as unknown as Record<string, unknown>)[m.category] // 选中的分类参数对象（与 category 同键）
  return {
    id: m.id,
    provider: m.provider,
    name: m.name,
    model_name: m.modelName,
    base_url: m.baseUrl || null,
    api_key: m.apiKey || null,
    app_id: m.appId || null,
    api_secret: m.apiSecret || null,
    category: m.category,
    enabled: m.enabled ? 1 : 0,
    tool_calls: m.toolCalls ? 1 : 0,
    config: params ? JSON.stringify(params) : '{}',
    description: m.description || null,
    tags: m.tags && m.tags.length ? JSON.stringify(m.tags) : null,
    created_at: now,
    updated_at: now,
  }
}

function rowToModel(r: ModelConfigRow): ModelConfig {
  const category = r.category
  const params = safeParse<Record<string, unknown> | null>(r.config, null)
  const model: ModelConfig = {
    id: r.id,
    name: r.name,
    category,
    provider: r.provider as ModelProvider,
    baseUrl: r.base_url ?? '',
    apiKey: r.api_key ?? '',
    appId: r.app_id ?? '',
    apiSecret: r.api_secret ?? '',
    modelName: r.model_name,
    enabled: r.enabled === 1,
    toolCalls: r.tool_calls === 1,
    description: r.description ?? undefined,
    tags: safeParse<string[] | null>(r.tags, null) ?? undefined,
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }
  // 还原分类专属参数到对应键（text/multimodal/...）
  if (params) (model as unknown as Record<string, unknown>)[category] = params
  return model
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage
 * ------------------------------------------------------------------ */

const LS_KEY = 'work-duo:models'

function lsList(): ModelConfig[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as ModelConfig[]) : []
  } catch {
    return []
  }
}

function lsSave(list: ModelConfig[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list))
}

/* ------------------------------------------------------------------ *
 * 对外 CRUD（页面/组件只调这些）
 * ------------------------------------------------------------------ */

/** 列表（按创建时间倒序）。 */
export async function listModels(): Promise<ModelConfig[]> {
  if (!isTauri) return lsList()
  const db = await getDb()
  const rows = await db.select<ModelConfigRow[]>(
    'SELECT * FROM models ORDER BY created_at DESC',
  )
  return rows.map(rowToModel)
}

/** 按 id 查询单个。 */
export async function getModel(id: string): Promise<ModelConfig | undefined> {
  if (!isTauri) return lsList().find((m) => m.id === id)
  const db = await getDb()
  const rows = await db.select<ModelConfigRow[]>(
    'SELECT * FROM models WHERE id = ?',
    [id],
  )
  return rows[0] ? rowToModel(rows[0]) : undefined
}

/** 新增或更新（按 id 幂等；更新时保留 created_at）。返回最新列表。 */
export async function upsertModel(model: ModelConfig): Promise<ModelConfig[]> {
  if (!isTauri) {
    const list = lsList()
    const idx = list.findIndex((m) => m.id === model.id)
    const next: ModelConfig = { ...model, updatedAt: new Date().toISOString() }
    if (idx >= 0) list[idx] = next
    else list.push(next)
    lsSave(list)
    return list
  }
  const db = await getDb()
  const row = modelToRow(model)
  await db.execute(
    `INSERT INTO models
       (id, provider, name, model_name, base_url, api_key, app_id, api_secret, category, enabled, tool_calls, config, description, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider    = excluded.provider,
       name        = excluded.name,
       model_name  = excluded.model_name,
       base_url    = excluded.base_url,
       api_key     = excluded.api_key,
       app_id      = excluded.app_id,
       api_secret  = excluded.api_secret,
       category    = excluded.category,
       enabled     = excluded.enabled,
       tool_calls  = excluded.tool_calls,
       config      = excluded.config,
       description = excluded.description,
       tags        = excluded.tags,
       updated_at  = excluded.updated_at`,
    [
      row.id,
      row.provider,
      row.name,
      row.model_name,
      row.base_url,
      row.api_key,
      row.app_id,
      row.api_secret,
      row.category,
      row.enabled,
      row.tool_calls,
      row.config,
      row.description,
      row.tags,
      row.created_at,
      row.updated_at,
    ],
  )
  return listModels()
}

/** 删除。返回最新列表。 */
export async function deleteModel(id: string): Promise<ModelConfig[]> {
  if (!isTauri) {
    const list = lsList().filter((m) => m.id !== id)
    lsSave(list)
    return list
  }
  const db = await getDb()
  await db.execute('DELETE FROM models WHERE id = ?', [id])
  return listModels()
}

/** 仅切换启用状态。返回最新列表。 */
export async function setModelEnabled(
  id: string,
  enabled: boolean,
): Promise<ModelConfig[]> {
  if (!isTauri) {
    const list = lsList().map((m) =>
      m.id === id
        ? { ...m, enabled, updatedAt: new Date().toISOString() }
        : m,
    )
    lsSave(list)
    return list
  }
  const db = await getDb()
  await db.execute('UPDATE models SET enabled = ?, updated_at = ? WHERE id = ?', [
    enabled ? 1 : 0,
    Date.now(),
    id,
  ])
  return listModels()
}

/** 批量导入（用于「导入配置」）。数组方式 upsert；冲突按 id 覆盖。返回最新列表。 */
export async function bulkUpsertModels(
  models: ModelConfig[],
): Promise<ModelConfig[]> {
  if (!isTauri) {
    const map = new Map(lsList().map((m) => [m.id, m]))
    for (const m of models) map.set(m.id, { ...m, updatedAt: new Date().toISOString() })
    const next = [...map.values()]
    lsSave(next)
    return next
  }
  const db = await getDb()
  for (const m of models) {
    const row = modelToRow(m)
    await db.execute(
      `INSERT INTO models
         (id, provider, name, model_name, base_url, api_key, app_id, api_secret, category, enabled, tool_calls, config, description, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider    = excluded.provider,
         name        = excluded.name,
         model_name  = excluded.model_name,
         base_url     = excluded.base_url,
         api_key      = excluded.api_key,
         app_id       = excluded.app_id,
         api_secret   = excluded.api_secret,
         category     = excluded.category,
         enabled      = excluded.enabled,
         tool_calls  = excluded.tool_calls,
         config       = excluded.config,
         description  = excluded.description,
         tags         = excluded.tags,
         updated_at   = excluded.updated_at`,
      [
        row.id,
        row.provider,
        row.name,
        row.model_name,
        row.base_url,
        row.api_key,
        row.app_id,
        row.api_secret,
        row.category,
        row.enabled,
        row.tool_calls,
        row.config,
        row.description,
        row.tags,
        row.created_at,
        row.updated_at,
      ],
    )
  }
  return listModels()
}
