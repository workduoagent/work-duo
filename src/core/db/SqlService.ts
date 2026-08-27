import Database from '@tauri-apps/plugin-sql'
import initSqlScript from '@/assets/sql/init.sql?raw'
import updateSqlScript from '@/assets/sql/updater.sql?raw'
import { runScriptLineByLine } from '@/core/db/sqlUtils'

/**
 * 数据库连接与初始化服务（Tauri 2 / @tauri-apps/plugin-sql）。
 *
 * 约定：
 *  - 全局唯一连接实例，首次加载时建连并开启 WAL + busy_timeout；
 *  - DDL 集中在 src/assets/sql/init.sql（首启建表与种子）与 updater.sql（版本变更）；
 *  - 业务 CRUD 集中在 src/core/mapper，统一经本文件的 getDb() 取连接，
 *    不要在 mapper 内自行 Database.load 或写 CREATE TABLE。
 *
 * 需要的 Tauri 能力（capabilities，由维护者配置）：
 *  - $API$/sql/load、execute、select（db = workduo.db）。
 */
export const DB_NAME = 'sqlite:workduo.db'

let dbInstance: Database | null = null

/**
 * 获取数据库连接实例。
 * 首次调用：建立连接并配置 WAL / busy_timeout；后续调用直接返回已存在的实例。
 */
export const getDb = async (): Promise<Database> => {
  if (dbInstance) {
    return dbInstance
  }

  // 1. 初始化连接
  dbInstance = await Database.load(DB_NAME)

  // 2. 开启 WAL 模式（大幅提升并发读写性能）
  await dbInstance.execute('PRAGMA journal_mode = WAL;')

  // 3. 设置忙等待时间（数据库被锁时等待 5000ms 再报错，而非立即失败）
  await dbInstance.execute('PRAGMA busy_timeout = 5000;')

  return dbInstance
}

/**
 * 首次启动：执行 init.sql 建表与种子数据。
 * 先尝试整段执行（plugin-sql 支持多语句），失败则逐条执行以便定位错误 SQL。
 */
export const initTables = async (db: Database): Promise<void> => {
  try {
    await db.execute(initSqlScript)
  } catch (error) {
    console.error('[SqlService] 整体执行 init.sql 失败，尝试逐条执行…', error)
    await runScriptLineByLine(db, initSqlScript)
  }
}

/**
 * 版本更新：执行 updater.sql（安全跳过已存在对象）。
 * 当前为初始版本，updater.sql 为空；后续版本变更在此集中追加 SQL。
 */
export const updateTables = async (db: Database): Promise<void> => {
  if (!updateSqlScript.trim()) {
    return
  }

  const statements = updateSqlScript
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const sql of statements) {
    try {
      await db.execute(sql)
    } catch (error: unknown) {
      const errMsg = String(error).toLowerCase()

      // 拦截并忽略特定的「已存在」安全报错，避免升级时重复执行报错中断
      if (errMsg.includes('duplicate column name')) {
        console.warn(`[SqlService] 字段已存在，安全跳过: ${sql.substring(0, 50)}…`)
      } else if (errMsg.includes('already exists') && !errMsg.includes('duplicate column')) {
        console.warn(`[SqlService] 表/索引已存在，安全跳过: ${sql.substring(0, 50)}…`)
      } else {
        // 其他语法错误仍需暴露
        console.error(`[SqlService] 执行 updater.sql 失败: ${sql}`, error)
      }
    }
  }
}
