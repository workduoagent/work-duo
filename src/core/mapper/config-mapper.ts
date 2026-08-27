/**
 * 全局键值配置（app_config 表）的 SQL 数据访问层（mapper）。
 *
 * 约定：
 *  - 所有 SQL 增删改查集中在本目录（src/core/mapper），页面/组件不直接写 SQL；
 *  - SQL 行实体即 app_config（key TEXT PRIMARY KEY, value TEXT），见 src/assets/sql/init.sql；
 *  - 驱动：@tauri-apps/plugin-sql（Tauri 2 官方 SQLite 插件）；
 *  - 连接统一经 src/core/db/SqlService.getDb() 获取（全局单例，已在 InitContext 启动时建表）；
 *  - 非 Tauri 环境（浏览器 dev）回退 localStorage（单对象集中存储，key=work-duo:app-config），保证可调试；
 *  - 本文件只负责「字符串读写」，结构化的序列化/反序列化由领域层 settings-file.ts 处理。
 *
 * 需要的 Tauri 能力（capabilities，由维护者配置）：
 *  - $API$/sql/load、execute、select（db = workduo.db）。
 */
import { isTauri } from '@/core/config'
import { getDb } from '@/core/db/SqlService'

/* ------------------------------------------------------------------ *
 * SQLite 路径：app_config（key-value）
 * ------------------------------------------------------------------ */

/** 读取整张 app_config 为 { key: value } 字典。 */
export async function getAllRawConfig(): Promise<Record<string, string>> {
  if (!isTauri) return lsAll()
  const db = await getDb()
  const rows = await db.select<{ key: string; value: string }[]>(
    'SELECT key, value FROM app_config',
  )
  return rows.reduce<Record<string, string>>((acc, r) => {
    acc[r.key] = r.value
    return acc
  }, {})
}

/** 读取单个配置的原始字符串（不存在返回 null）。 */
export async function getRawConfig(key: string): Promise<string | null> {
  if (!isTauri) return lsAll()[key] ?? null
  const db = await getDb()
  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM app_config WHERE key = ?',
    [key],
  )
  return rows[0]?.value ?? null
}

/** 写入单个配置（UPSERT；value 已是待落库的字符串）。 */
export async function setRawConfig(key: string, value: string): Promise<void> {
  if (!isTauri) {
    const all = lsAll()
    all[key] = value
    lsSave(all)
    return
  }
  const db = await getDb()
  await db.execute(
    `INSERT INTO app_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  )
}

/* ------------------------------------------------------------------ *
 * 非 Tauri（浏览器 dev）回退：localStorage（单对象集中）
 * ------------------------------------------------------------------ */

const LS_KEY = 'work-duo:app-config'

function lsAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function lsSave(all: Record<string, string>): void {
  localStorage.setItem(LS_KEY, JSON.stringify(all))
}
