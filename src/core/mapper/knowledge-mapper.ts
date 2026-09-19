/**
 * 知识库的 SQL 数据访问层（mapper）。
 *
 * 约定：
 *  - 所有 SQL 增删改查集中在本目录（src/core/mapper），页面/组件不直接写 SQL；
 *  - SQL 行实体定义在 src/types/database.d.ts（KnowledgeBaseRow / KnowledgeAssetRow）；
 *  - 驱动：@tauri-apps/plugin-sql（Tauri 2 官方 SQLite 插件）；
 *  - 连接统一经 src/core/db/SqlService.getDb() 获取（全局单例，已在 InitContext 启动时建表）；
 *  - 建表语句（DDL）集中在 src/assets/sql/init.sql，本文件不再持有 CREATE TABLE；
 *  - 表结构严格适配用户给出的 PostgreSQL 设计（knowledge_base / knowledge_asset）；
 *  - 物理目录 = knowledge_base_path + '/' + identifier（identifier 即唯一标识 slug）；
 *  - 首页卡片的 file_count / file_size 由 knowledge_asset 聚合得到（不物化列）；
 *  - 非 Tauri 环境（浏览器 dev）回退 localStorage，保证可调试（资产扫描返回空）。
 */
import { isTauri } from '@/core/config'
import { safeIso } from './safeTime'
import type { KnowledgeBase, KnowledgeAsset, KnowledgeAssetType } from '@/types/core'
import type { KnowledgeBaseRow, KnowledgeAssetRow } from '@/types/database'
import { getDb } from '@/core/db/SqlService'
import {
  ensureKbDir,
  removeKbDir,
  renameKbDir,
  walkKbAssets,
} from '@/core/file/kbFs'
import { fireKbRemoveAsset, fireKbSyncAsset } from './kb-index-hooks'

const DEFAULT_KB_PATH = '$APPDATA/.knowledge_base'

/** 读取 knowledge_base_path 原始值（可能含 $APPDATA / $RESOURCE 占位，由 kbFs 解析）。 */
export async function resolveKnowledgeBasePath(): Promise<string> {
  if (!isTauri) return 'knowledge_base' // 非 Tauri 仅记录相对路径，不真实落盘
  try {
    const db = await getDb()
    const rows = await db.select<{ value: string }[]>(
      "SELECT value FROM app_config WHERE key = 'knowledge_base_path'",
    )
    return rows[0]?.value || DEFAULT_KB_PATH
  } catch {
    return DEFAULT_KB_PATH
  }
}

/* ------------------------------------------------------------------ *
 * 行 <-> 领域模型 转换
 * ------------------------------------------------------------------ */

function rowToKb(r: KnowledgeBaseRow, base: string): KnowledgeBase {
  return {
    id: r.id,
    logo: r.logo ?? undefined,
    identifier: r.identifier,
    name: r.name,
    description: r.description ?? undefined,
    scenario: r.scenario ?? undefined,
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
    path: `${base.replace(/\/+$/, '')}/${r.identifier}`,
    fileCount: r.file_count ?? 0,
    fileSize: r.file_size ?? 0,
  }
}

function rowToAsset(r: KnowledgeAssetRow): KnowledgeAsset {
  return {
    id: r.id,
    kbId: r.kb_id,
    name: r.name,
    type: (r.type as KnowledgeAssetType) ?? 1,
    fileExt: r.file_ext ?? undefined,
    fileSize: r.file_size,
    filePath: r.file_path,
    digest: r.digest ?? null,
    indexedAt: r.indexed_at ?? null,
    metaData: r.meta_data ?? null,
    createdAt: safeIso(r.created_at),
    updatedAt: safeIso(r.updated_at),
  }
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage
 * ------------------------------------------------------------------ */

const LS_KEY = 'work-duo:knowledge-bases'

function lsList(): KnowledgeBase[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as KnowledgeBase[]) : []
  } catch {
    return []
  }
}

function lsSave(list: KnowledgeBase[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list))
}

/* ------------------------------------------------------------------ *
 * 对外 CRUD（页面/组件只调这些）
 * ------------------------------------------------------------------ */

/** 列表（按创建时间倒序）。fileCount / fileSize 直读 knowledge_base 冗余列（无 LEFT JOIN）。
 *  scenarioFilter 非空时仅返回对应场景分类的知识库。 */
export async function listKnowledgeBases(scenarioFilter?: string): Promise<KnowledgeBase[]> {
  if (!isTauri) {
    return lsList().filter((k) => !scenarioFilter || k.scenario === scenarioFilter)
  }
  const db = await getDb()
  const base = await resolveKnowledgeBasePath()
  const where = scenarioFilter ? "WHERE scenario = ?" : ''
  const params = scenarioFilter ? [scenarioFilter] : []
  const rows = await db.select<KnowledgeBaseRow[]>(
    `SELECT * FROM knowledge_base ${where} ORDER BY created_at DESC`,
    params,
  )
  return rows.map((r) => rowToKb(r, base))
}

/** 按 id 查询单个（fileCount / fileSize 直读 knowledge_base 冗余列，含派生 path）。 */
export async function getKnowledgeBase(id: string): Promise<KnowledgeBase | undefined> {
  if (!isTauri) return lsList().find((k) => k.id === id)
  const db = await getDb()
  const base = await resolveKnowledgeBasePath()
  const rows = await db.select<KnowledgeBaseRow[]>(
    'SELECT * FROM knowledge_base WHERE id = ?',
    [id],
  )
  return rows[0] ? rowToKb(rows[0], base) : undefined
}

/** 新建知识库：建目录 + 写 knowledge_base 行 + 扫描写入 knowledge_asset。返回最新列表。 */
export async function createKnowledgeBase(input: {
  identifier: string
  name: string
  description?: string
  logo?: string
  scenario?: string
}): Promise<KnowledgeBase[]> {
  const now = Date.now()
  const id = crypto.randomUUID()
  const rawBase = await resolveKnowledgeBasePath()
  const folder = `${rawBase.replace(/\/+$/, '')}/${input.identifier}`

  if (!isTauri) {
    const list = lsList()
    const next: KnowledgeBase = {
      id,
      logo: input.logo,
      identifier: input.identifier,
      name: input.name,
      description: input.description,
      scenario: input.scenario,
      path: folder,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      fileCount: 0,
      fileSize: 0,
    }
    list.push(next)
    lsSave(list)
    return list
  }

  await ensureKbDir(folder)
  const db = await getDb()
  await db.execute(
    `INSERT INTO knowledge_base (id, logo, identifier, name, description, scenario, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.logo ?? null,
      input.identifier,
      input.name,
      input.description ?? null,
      input.scenario ?? null,
      now,
      now,
    ],
  )
  await syncAssets(id, folder)
  return listKnowledgeBases()
}

/** 更新知识库元数据（名称 / 简介 / Logo / 场景 / 唯一标识）。identifier 变化会同步重命名物理目录。 */
export async function updateKnowledgeBase(kb: {
  id: string
  identifier?: string
  name: string
  description?: string
  logo?: string
  scenario?: string
}): Promise<KnowledgeBase[]> {
  const now = Date.now()
  if (!isTauri) {
    const list = lsList().map((k) =>
      k.id === kb.id
        ? {
            ...k,
            identifier: kb.identifier ?? k.identifier,
            name: kb.name,
            description: kb.description,
            logo: kb.logo,
            scenario: kb.scenario,
            updatedAt: new Date(now).toISOString(),
          }
        : k,
    )
    lsSave(list)
    return list
  }

  const db = await getDb()
  // 若 identifier 变化，需先重命名物理目录
  if (kb.identifier) {
    const cur = await db.select<KnowledgeBaseRow[]>(
      'SELECT identifier FROM knowledge_base WHERE id = ?',
      [kb.id],
    )
    const oldIdentifier = cur[0]?.identifier
    if (oldIdentifier && oldIdentifier !== kb.identifier) {
      const rawBase = await resolveKnowledgeBasePath()
      const oldFolder = `${rawBase.replace(/\/+$/, '')}/${oldIdentifier}`
      const newFolder = `${rawBase.replace(/\/+$/, '')}/${kb.identifier}`
      await renameKbDir(oldFolder, newFolder)
    }
  }

  await db.execute(
    `UPDATE knowledge_base
     SET identifier = ?, name = ?, description = ?, logo = ?, scenario = ?, updated_at = ?
     WHERE id = ?`,
    [
      kb.identifier ?? null,
      kb.name,
      kb.description ?? null,
      kb.logo ?? null,
      kb.scenario ?? null,
      now,
      kb.id,
    ],
  )
  return listKnowledgeBases()
}

/** 删除知识库：清目录 + 清资产 + 删行。返回最新列表。 */
export async function deleteKnowledgeBase(kb: KnowledgeBase): Promise<KnowledgeBase[]> {
  if (!isTauri) {
    const list = lsList().filter((k) => k.id !== kb.id)
    lsSave(list)
    return list
  }
  const db = await getDb()
  // 先级联清理向量段（需要资产 id 清单，删行后即无从查起）
  await deleteKnowledgeBaseAssets(kb.id)
  await db.execute('DELETE FROM knowledge_asset WHERE kb_id = ?', [kb.id])
  await db.execute('DELETE FROM knowledge_base WHERE id = ?', [kb.id])
  if (kb.path) await removeKbDir(kb.path)
  return listKnowledgeBases()
}
// 整库删除：级联清理该库全部资产的向量段（fire-and-forget，幂等）
async function deleteKnowledgeBaseAssets(kbId: string): Promise<void> {
  if (!isTauri) return
  const db = await getDb()
  const rows = await db.select<KnowledgeAssetRow[]>(
    'SELECT id FROM knowledge_asset WHERE kb_id = ?',
    [kbId],
  )
  for (const r of rows) fireKbRemoveAsset(kbId, r.id)
}

/** 列出某知识库的全部资产（按 file_path 排序）。 */
export async function listAssets(kbId: string): Promise<KnowledgeAsset[]> {
  if (!isTauri) return []
  const db = await getDb()
  const rows = await db.select<KnowledgeAssetRow[]>(
    'SELECT * FROM knowledge_asset WHERE kb_id = ? ORDER BY file_path ASC',
    [kbId],
  )
  return rows.map(rowToAsset)
}

/** 删除某知识库下指定目录（含其全部子目录）对应的资产记录。
 *  relPath 为相对知识库根目录的路径；匹配 file_path = relPath 或其以 'relPath/' 开头的后代条目。
 *  用于「删除文件夹」时同步清理数据库，确保 knowledge_asset 与物理磁盘一致。 */
export async function deleteAssetsUnderPath(kbId: string, relPath: string): Promise<void> {
  if (!isTauri) return
  const db = await getDb()
  // 先取将被删除的资产 id 清单（删除后无从查起），级联清理向量段
  const doomed = await db.select<KnowledgeAssetRow[]>(
    'SELECT id FROM knowledge_asset WHERE kb_id = ? AND (file_path = ? OR file_path LIKE ?)',
    [kbId, relPath, `${relPath}/%`],
  )
  await db.execute(
    'DELETE FROM knowledge_asset WHERE kb_id = ? AND (file_path = ? OR file_path LIKE ?)',
    [kbId, relPath, `${relPath}/%`],
  )
  for (const r of doomed) fireKbRemoveAsset(kbId, r.id)
}

/**
 * 重新扫描知识库目录并同步 knowledge_asset（先删后插，kb_id + file_path 唯一），
 * 并回写 knowledge_base 的 file_count / file_size 冗余列。返回聚合后的 { fileCount, fileSize }。
 */
export async function refreshAssets(kb: KnowledgeBase): Promise<{
  fileCount: number
  fileSize: number
}> {
  if (!isTauri || !kb.path) return { fileCount: 0, fileSize: 0 }
  return syncAssets(kb.id, kb.path)
}

/**
 * 重新扫描知识库目录并同步 knowledge_asset，回写 knowledge_base 的 file_count / file_size 冗余列。
 * v28（K1'）：改为**按 (kb_id, file_path) 保 id 的 upsert**——不再先删后插。asset id 是
 * LanceDB kb_chunks 向量段的关联键，重扫时 id 漂移会让已索引段变孤儿；同路径资产
 * 保留原 id 与 digest/indexed_at/meta_data（Rust 增量索引据此跳过未变更文件）。
 * 磁盘上消失的路径：删除行（其 Lance 段由 Rust kb_rebuild_index / kb_sync 的清理语义回收）。
 * 返回聚合后的 { fileCount, fileSize }。
 */
async function syncAssets(id: string, folder: string): Promise<{ fileCount: number; fileSize: number }> {
  const db = await getDb()
  const existing = await db.select<KnowledgeAssetRow[]>(
    'SELECT * FROM knowledge_asset WHERE kb_id = ?',
    [id],
  )
  const byPath = new Map(existing.map((r) => [r.file_path, r]))
  const assets = await walkKbAssets(folder)
  const now = Date.now()
  const seenPaths = new Set<string>()
  /** 需要触发索引的资产（新增 / 元数据变化——Rust 侧以 digest+path 最终判定是否真的重切） */
  const toSync: string[] = []
  for (const a of assets) {
    seenPaths.add(a.filePath)
    const prev = byPath.get(a.filePath)
    if (prev) {
      // 同路径已存在：保留 id / digest / indexed_at / meta_data，仅刷新可变元数据
      if (prev.file_size !== a.sizeBytes || prev.name !== a.name || prev.type !== a.type) {
        await db.execute(
          `UPDATE knowledge_asset SET name = ?, type = ?, file_size = ?, updated_at = ? WHERE id = ?`,
          [a.name, a.type, a.sizeBytes, now, prev.id],
        )
        toSync.push(prev.id)
      }
      continue
    }
    const newId = crypto.randomUUID()
    await db.execute(
      `INSERT INTO knowledge_asset (id, kb_id, name, type, file_ext, file_size, file_path, digest, indexed_at, meta_data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      [newId, id, a.name, a.type, a.fileExt, a.sizeBytes, a.filePath, now, now],
    )
    toSync.push(newId)
  }
  // 磁盘上消失的路径 → 删行（Lance 旧段由 Rust 侧同步/重建的清理语义回收）
  const removed = existing.filter((r) => !seenPaths.has(r.file_path))
  for (const r of removed) {
    await db.execute('DELETE FROM knowledge_asset WHERE id = ?', [r.id])
  }
  // 索引联动（fire-and-forget）：新增/变化 → 增量同步；消失 → 级联清理
  for (const assetId of toSync) fireKbSyncAsset(id, assetId)
  for (const r of removed) fireKbRemoveAsset(id, r.id)
  const fileCount = assets.length
  const fileSize = assets.reduce((s, a) => s + a.sizeBytes, 0)
  // 回写 knowledge_base 冗余聚合列（列表/详情页直读，避免每次 LEFT JOIN）
  await db.execute(
    'UPDATE knowledge_base SET file_count = ?, file_size = ?, updated_at = ? WHERE id = ?',
    [fileCount, fileSize, now, id],
  )
  return { fileCount, fileSize }
}
