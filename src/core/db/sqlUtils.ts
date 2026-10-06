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
 * 按语句切分 SQL 脚本（台账 S11）。
 *
 * 状态机解析，正确跳过以下「分号非语句边界」的场景：
 *  - 单引号字符串（'' 转义）与双引号标识符（"" 转义）内的分号；
 *  - 反引号 / [方括号] 标识符内的分号；
 *  - `--` 行注释与 `/* ... *`/` 块注释内的分号（同时保证字符串字面量里的
 *    `--` 不会被误当注释破坏——旧实现 replace(/--.*$/gm) 有此缺陷）。
 *
 * 切出的语句保留内部注释（驱动可接受前导/内部注释）；仅含注释的片段被丢弃。
 * 注意：CREATE TRIGGER ... BEGIN...END 体内的分号仍会误切——项目 DDL 惯例
 * 不在 init/updater 中使用触发器，若未来引入需改用真正的 SQL 解析器。
 */
export const splitSqlStatements = (script: string): string[] => {
  const statements: string[] = []
  let cur = ''
  let i = 0
  const n = script.length

  /** 丢弃仅含注释的片段：去掉行/块注释后无实质内容则不作为语句下发 */
  const push = (): void => {
    const meaningful = cur
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
    if (meaningful) statements.push(cur.trim())
    cur = ''
  }

  while (i < n) {
    const ch = script[i]
    const next = script[i + 1]

    // 行注释：读到行尾（换行符保留在语句内，无语义影响）
    if (ch === '-' && next === '-') {
      while (i < n && script[i] !== '\n') {
        cur += script[i]
        i++
      }
      continue
    }
    // 块注释：读到 */
    if (ch === '/' && next === '*') {
      cur += '/*'
      i += 2
      while (i < n && !(script[i] === '*' && script[i + 1] === '/')) {
        cur += script[i]
        i++
      }
      if (i < n) {
        cur += '*/'
        i += 2
      }
      continue
    }
    // 单引号字符串（'' 转义）
    if (ch === "'") {
      cur += ch
      i++
      while (i < n) {
        if (script[i] === "'") {
          if (script[i + 1] === "'") {
            cur += "''"
            i += 2
            continue
          }
          cur += "'"
          i++
          break
        }
        cur += script[i]
        i++
      }
      continue
    }
    // 双引号标识符（"" 转义）
    if (ch === '"') {
      cur += ch
      i++
      while (i < n) {
        if (script[i] === '"') {
          if (script[i + 1] === '"') {
            cur += '""'
            i += 2
            continue
          }
          cur += '"'
          i++
          break
        }
        cur += script[i]
        i++
      }
      continue
    }
    // 反引号标识符（无转义）
    if (ch === '`') {
      cur += ch
      i++
      while (i < n && script[i] !== '`') {
        cur += script[i]
        i++
      }
      if (i < n) {
        cur += '`'
        i++
      }
      continue
    }
    // [方括号] 标识符（无转义）
    if (ch === '[') {
      cur += ch
      i++
      while (i < n && script[i] !== ']') {
        cur += script[i]
        i++
      }
      if (i < n) {
        cur += ']'
        i++
      }
      continue
    }
    // 语句边界
    if (ch === ';') {
      push()
      i++
      continue
    }
    cur += ch
    i++
  }
  push()
  return statements
}

/**
 * 按语句切分并逐条执行。
 * 任一条失败即中断并向上抛出，便于定位写错的 SQL。
 */
export const runScriptLineByLine = async (
  db: Database,
  script: string,
): Promise<void> => {
  const statements = splitSqlStatements(script)

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
/**
 * 批量 Upsert（存在即更新，不存在即插入）。
 *  - 自动生成 ON CONFLICT DO UPDATE 语句；
 *  - 自动分批（每批 50 行）防止 SQLite 参数过多报错；
 *  - 自动将 undefined 转为 null（SQLite 不接受 undefined）。
 *
 * @param conflictKeys 冲突检测键（唯一约束字段），如 ['id'] 或 ['ws_id', 'id']
 * @param preserveColumns 冲突时**保留原值**的列（插入时仍写入）。典型是
 *        `created_at`——「更新时保留创建时间」是 upsert 的常见语义，而默认的
 *        「所有非键列都更新」会把它覆盖成新值。
 *
 * F024：泛型约束由 `Record<string, unknown>` 放宽为 `object` —— 前者要求索引签名，
 * 而领域行类型（`ModelConfigRow` 等由 `database.d.ts` 声明的 interface）天然没有
 * 索引签名，会导致「明明结构完整却传不进来」。约束只需保证 `T` 是对象即可，
 * 取值仍由 `columns` 决定。
 */
export const bulkUpsert = async <T extends object>(
  db: Database,
  tableName: string,
  columns: string[],
  data: T[],
  conflictKeys: string[] = ['id'],
  preserveColumns: string[] = [],
): Promise<void> => {
  if (!data || data.length === 0) return

  // SQLite 单条 SQL 参数数量有限（约 999），按列数分批到安全范围
  const CHUNK_SIZE = 50

  // 冲突时更新的列 = 全部列 - 冲突键 - 需保留原值的列
  const updateColumns = columns.filter(
    (col) => !conflictKeys.includes(col) && !preserveColumns.includes(col),
  )
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
      // 列名来自调用方的常量清单（schema 固定），此处按动态键取值需显式收窄
      const row = item as Record<string, unknown>
      columns.forEach((col) => {
        const val = row[col]
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
