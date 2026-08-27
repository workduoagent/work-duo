import type Database from '@tauri-apps/plugin-sql'

/**
 * SQL 脚本执行工具（统一在 src/core/db 使用）。
 *
 * 约定：
 *  - DDL（建表/改表）集中在 src/assets/sql/init.sql（首启）与 updater.sql（版本变更）；
 *  - 业务 CRUD 集中在 src/core/mapper，本文件仅提供通用执行 / 批量写入能力。
 *  - SQLite 驱动不接受 undefined，批量函数统一将 undefined 转 null。
 */

/**
 * 按分号拆分并逐条执行（忽略以 -- 开头的行注释）。
 * 任一条失败即中断并向上抛出，便于定位写错的 SQL。
 */
export const runScriptLineByLine = async (
  db: Database,
  script: string,
): Promise<void> => {
  // 1. 去除 -- 风格注释
  const cleanScript = script.replace(/--.*$/gm, '')

  // 2. 按分号拆分
  const statements = cleanScript
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const sql of statements) {
    try {
      await db.execute(sql)
    } catch (e) {
      console.error(`执行出错 SQL: ${sql}`, e)
      throw e
    }
  }
}

/**
 * 通用批量插入。
 * @param db 数据库实例
 * @param tableName 表名
 * @param columns 列名数组，如 ['id', 'name', 'age']
 * @param data 数据对象数组，键需覆盖 columns
 */
export const bulkInsert = async <T extends Record<string, unknown>>(
  db: Database,
  tableName: string,
  columns: string[],
  data: T[],
): Promise<void> => {
  if (data.length === 0) return

  const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`
  const allPlaceholders = data.map(() => rowPlaceholders).join(', ')
  const flatValues: unknown[] = []
  data.forEach((item) => {
    columns.forEach((col) => flatValues.push(item[col]))
  })

  const sql = `INSERT INTO ${tableName} (${columns.join(', ')})
               VALUES ${allPlaceholders}`
  await db.execute(sql, flatValues)
}

/**
 * 批量 Upsert（存在即更新，不存在即插入）。
 *  - 自动生成 ON CONFLICT DO UPDATE 语句；
 *  - 自动分批（每批 50 行）防止 SQLite 参数过多报错；
 *  - 自动将 undefined 转为 null（SQLite 不接受 undefined）。
 *
 * @param conflictKeys 冲突检测键（唯一约束字段），如 ['id'] 或 ['ws_id', 'id']
 */
export const bulkUpsert = async <T extends Record<string, unknown>>(
  db: Database,
  tableName: string,
  columns: string[],
  data: T[],
  conflictKeys: string[] = ['id'],
): Promise<void> => {
  if (!data || data.length === 0) return

  // SQLite 单条 SQL 参数数量有限（约 999），按列数分批到安全范围
  const CHUNK_SIZE = 50

  const updateColumns = columns.filter((col) => !conflictKeys.includes(col))
  let conflictClause: string
  if (updateColumns.length > 0) {
    const setClause = updateColumns
      .map((col) => `${col} = excluded.${col}`)
      .join(', ')
    conflictClause = `ON CONFLICT(${conflictKeys.join(', ')}) DO UPDATE SET ${setClause}`
  } else {
    conflictClause = `ON CONFLICT(${conflictKeys.join(', ')}) DO NOTHING`
  }

  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunkData = data.slice(i, i + CHUNK_SIZE)
    const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`
    const allPlaceholders = chunkData.map(() => rowPlaceholders).join(', ')

    const flatValues: unknown[] = []
    chunkData.forEach((item) => {
      columns.forEach((col) => {
        const val = item[col]
        flatValues.push(val === undefined ? null : val)
      })
    })

    const sql = `INSERT INTO ${tableName} (${columns.join(', ')})
                 VALUES ${allPlaceholders}
                 ${conflictClause}`

    try {
      await db.execute(sql, flatValues)
    } catch (err) {
      console.error(`批量 Upsert 第 ${Math.floor(i / CHUNK_SIZE) + 1} 批次执行失败:`, err)
      throw err
    }
  }
}
