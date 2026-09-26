import Database from '@tauri-apps/plugin-sql'
import initSqlScript from '@/assets/sql/init.sql?raw'
import updateSqlScript from '@/assets/sql/updater.sql?raw'
import { runScriptLineByLine, splitSqlStatements } from '@/core/db/sqlUtils'

/**
 * 数据库连接与初始化服务（Tauri 2 / @tauri-apps/plugin-sql）。
 *
 * 约定：
 *  - 全局唯一连接实例，首次加载时建连并开启 WAL + busy_timeout；
 *  - DDL 集中在 src/assets/sql/init.sql（首启建表与种子）与 updater.sql（版本变更）；
 *  - schema 版本单一事实源在 init.sql 头部 `SCHEMA_VERSION: N` 注释标记（台账 S11）：
 *    updateTables 据此做 user_version 校验——版本落后才重放 updater.sql（幂等），
 *    成功后 `PRAGMA user_version = N` 封存；已封版的库跳过全量重放；
 *    失败语句不封版，下次启动自动重试（半升级自愈）；库版本高于预期（降级启动）只警告不阻断；
 *  - 业务 CRUD 集中在 src/core/mapper，统一经本文件的 getDb() 取连接，
 *    不要在 mapper 内自行 Database.load 或写 CREATE TABLE。
 *
 * 需要的 Tauri 能力（capabilities，由维护者配置）：
 *  - $API$/sql/load、execute、select（db = workduo.db）。
 */
export const DB_NAME = 'sqlite:workduo.db'

// 台账 S5：挂 globalThis 跨 HMR 存活（热更后 dbInstance 重建会额外开一条后端连接）。
const dbHolder = (globalThis as { __wdSqlDb?: { instance: Database | null } }).__wdSqlDb ??= {
  instance: null,
}

/**
 * 获取数据库连接实例。
 * 首次调用：建立连接并配置 WAL / busy_timeout；后续调用直接返回已存在的实例。
 */
export const getDb = async (): Promise<Database> => {
  if (dbHolder.instance) {
    return dbHolder.instance
  }

  // 1. 初始化连接
  dbHolder.instance = await Database.load(DB_NAME)

  // 2. 开启 WAL 模式（大幅提升并发读写性能）
  await dbHolder.instance.execute('PRAGMA journal_mode = WAL;')

  // 3. 设置忙等待时间（数据库被锁时等待 5000ms 再报错，而非立即失败）
  await dbHolder.instance.execute('PRAGMA busy_timeout = 5000;')

  return dbHolder.instance
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
 * 从 init.sql 头部注释解析目标 schema 版本（单一事实源）。
 * 标记缺失/格式非法时返回 null → 调用方退回「全量重放 updater.sql」旧逻辑兜底。
 */
const parseSchemaVersion = (): number | null => {
  const m = initSqlScript.match(/^\s*--\s*SCHEMA_VERSION:\s*(\d+)\s*$/m)
  return m ? Number(m[1]) : null
}

/** 读取当前库的 PRAGMA user_version；读取失败按 0 处理（走全量重放兜底）。 */
const readUserVersion = async (db: Database): Promise<number> => {
  try {
    const rows = await db.select<{ user_version: number }[]>('PRAGMA user_version')
    return rows?.[0]?.user_version ?? 0
  } catch {
    return 0
  }
}

/**
 * 版本更新（台账 S11）：
 *  - 库版本 ≥ 目标 → 已封版/降级启动：跳过重放或仅警告，不再每次启动全量重放 updater.sql；
 *  - 库版本 < 目标 → 幂等重放 updater.sql（按语句解析，分号字面量不再误切），
 *    全部成功后封存版本号；存在失败语句则不封版，下次启动重试（半升级自愈）；
 *  - init.sql 缺版本标记 → 退回旧逻辑全量重放（吞 duplicate column / already exists）。
 */
export const updateTables = async (db: Database): Promise<void> => {
  if (!updateSqlScript.trim()) {
    return
  }

  const target = parseSchemaVersion()
  const current = await readUserVersion(db)

  if (target != null && current > target) {
    // 半升级检测：库 schema 比当前应用预期新（用户降级 App / 多设备混用）。
    // 只警告不阻断——不锁死用户，也不降版本（SQLite 无回滚迁移惯例）。
    console.warn(
      `[SqlService] 数据库 schema 版本 v${current} 高于应用预期 v${target}（可能为降级启动），跳过迁移`,
    )
    return
  }
  if (target != null && current === target) {
    return // 已封版：schema 与 init.sql 一致，无需重放
  }

  const statements = splitSqlStatements(updateSqlScript)
  let failed = 0

  for (const sql of statements) {
    try {
      await db.execute(sql)
    } catch (error: unknown) {
      const errMsg = String(error).toLowerCase()

      // 拦截并忽略特定的「已存在」安全报错——这是幂等重放的预期路径
      if (errMsg.includes('duplicate column name')) {
        console.warn(`[SqlService] 字段已存在，安全跳过: ${sql.substring(0, 50)}…`)
      } else if (errMsg.includes('already exists') && !errMsg.includes('duplicate column')) {
        console.warn(`[SqlService] 表/索引已存在，安全跳过: ${sql.substring(0, 50)}…`)
      } else {
        // 其他错误暴露但不中断后续语句（避免一条坏 SQL 卡死整个启动）；
        // failed > 0 时不封版本号，下次启动重放重试。
        failed++
        console.error(`[SqlService] 执行 updater.sql 失败: ${sql}`, error)
      }
    }
  }

  if (target == null) {
    return // init.sql 无版本标记：保持旧行为，每次启动全量重放
  }
  if (failed === 0) {
    await db.execute(`PRAGMA user_version = ${target}`)
    console.info(`[SqlService] 数据库 schema 已迁移至 v${target}`)
  } else {
    console.error(
      `[SqlService] ${failed} 条迁移语句执行失败，版本封存推迟（下次启动将重试）`,
    )
  }
}
