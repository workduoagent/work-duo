import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Spin } from 'antd'
import { getDb, initTables, updateTables } from '@/core/db/SqlService'
import { isTauri } from '@/core/config'
import { normalizeSkillPaths } from '@/core/mapper/skill-mapper'

/**
 * 数据库初始化上下文。
 *
 * 职责：应用启动时统一初始化本地 SQLite（workduo.db）。
 *  - 每次启动都先幂等执行 init.sql（CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE），
 *    确保 app_config / models 等基础表一定存在，再读取首启标记、执行 updater.sql 版本迁移；
 *    （首启时若先查 first_load 再建表会报 no such table: app_config，故建表必须前置）
 *  - app_config.first_load = 'true' 表示首次运行，建表完成后置为 'false'（供应用层判断首启）；
 *  - updater.sql 当前为空，安全跳过；
 *  - 非 Tauri（浏览器 dev）：跳过 DB，数据走 localStorage 回退，直接进入应用。
 * 初始化完成前展示全屏加载层，完成后渲染 children。
 */
interface InitContextType {
  /** 数据库是否就绪（非 Tauri 环境恒为 true） */
  dbReady: boolean
  /** 当前加载提示文案 */
  loadingTip: string
  /** 初始化错误信息（null 表示无错误） */
  initError: string | null
}

const InitContext = createContext<InitContextType | undefined>(undefined)

export const InitProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [dbReady, setDbReady] = useState<boolean>(false)
  const [loadingTip, setLoadingTip] = useState<string>('正在初始化本地数据库…')
  const [initError, setInitError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    // 防止 React StrictMode 双调用重复初始化
    if (started.current) return
    started.current = true

    const initDB = async (): Promise<void> => {
      // 非 Tauri 环境（浏览器 dev）：无 SQLite，跳过并直接进入应用
      if (!isTauri) {
        setDbReady(true)
        return
      }

      try {
        // 1. 读取数据库连接
        const db = await getDb()

        // 2. 每次启动都先建表（幂等）：CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE
        //    保证 app_config / models 一定存在，杜绝「首启时先查 first_load 但表不存在」的报错。
        setLoadingTip('初始化本地数据库…')
        await initTables(db)

        // 3. 此时 app_config 已存在，读取首启标记
        const rows = await db.select<{ value: string }[]>(
          "SELECT value FROM app_config WHERE key = 'first_load'",
        )
        const isFirstLoad = rows.length === 0 || rows[0].value === 'true'

        // 4. 版本迁移脚本（当前为空，安全跳过）；首启与非首启都执行，确保补丁不遗漏
        setLoadingTip('检查数据库版本更新…')
        await updateTables(db)

        // 4.5 存储目录迁移兜底：校正 skill_info.path 为「当前 skill_path/<identifier>」。
        //     修复迁移前落地的脏数据（path 仍指向旧目录 / 占位符与真实路径混用）。
        //     仅改写不相等的行，幂等，可每次启动安全执行。
        setLoadingTip('校正技能存储路径…')
        try {
          const fixed = await normalizeSkillPaths()
          if (fixed > 0) console.info(`[InitContext] 已校正 ${fixed} 条 skill_info.path`)
        } catch (e) {
          console.error('[InitContext] skill_info.path 归一失败', e)
        }

        // 5. 首启完成后置标记，供应用层判断「是否首次运行」
        if (isFirstLoad) {
          await db.execute("UPDATE app_config SET value = 'false' WHERE key = 'first_load'")
        }

        setLoadingTip(isFirstLoad ? '首次启动完成' : '数据库就绪')
        setDbReady(true)
      } catch (e) {
        // 不阻塞 UI：记录错误，DB 操作层面的错误会在调用时暴露
        const msg = e instanceof Error ? e.message : String(e)
        setInitError(msg)
        console.error('[InitContext] 数据库初始化失败：', e)
        setDbReady(true)
      }
    }

    setLoadingTip('正在初始化本地数据库…')
    void initDB()
  }, [])

  // 初始化未完成：全屏加载层；完成后渲染 children 并透出状态
  return (
    <InitContext.Provider value={{ dbReady, loadingTip, initError }}>
      {dbReady ? (
        children
      ) : (
        <Spin spinning fullscreen tip={loadingTip} size="large" />
      )}
    </InitContext.Provider>
  )
}

/**
 * 读取数据库初始化状态。未在 InitProvider 内使用时不抛错，返回安全默认值。
 */
export const useInitData = (): InitContextType => {
  const ctx = useContext(InitContext)
  if (!ctx) {
    return { dbReady: true, loadingTip: '', initError: null }
  }
  return ctx
}
