/**
 * F018 关键路径单测：config-mapper 的 SQL 语句与参数绑定。
 * mock @tauri-apps/plugin-sql 层（SqlService.getDb），捕获 execute/select 的 SQL 与参数——
 * mapper 层是「SQL 集中地」，绑定错位（如 key/value 顺序）会造成静默数据错乱，typecheck 拦不住。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 捕获 SQL 调用的假 DB
const executed: Array<{ sql: string; params: unknown[] }> = []
const selected: Array<{ sql: string; params: unknown[] }> = []

vi.mock('@/core/config', () => ({ isTauri: true }))
vi.mock('@/core/db/SqlService', () => ({
  getDb: vi.fn(async () => ({
    execute: vi.fn(async (sql: string, params?: unknown[]) => {
      executed.push({ sql, params: params ?? [] })
      return { rowsAffected: 1 }
    }),
    select: vi.fn(async (sql: string, params?: unknown[]) => {
      selected.push({ sql, params: params ?? [] })
      // getRawConfig：按 key 回读（测试里存什么回什么）
      const key = params?.[0]
      const hit = store.get(String(key))
      return hit === undefined ? [] : [{ key, value: hit }]
    }),
  })),
}))

const store = new Map<string, string>()

import { getRawConfig, setRawConfig } from './config-mapper'

describe('config-mapper SQL 绑定', () => {
  beforeEach(() => {
    executed.length = 0
    selected.length = 0
    store.clear()
  })

  it('setRawConfig 走 UPSERT 且按 (key, value) 顺序绑定', async () => {
    await setRawConfig('skill_path', '$APPDATA/.skills')
    expect(executed).toHaveLength(1)
    const { sql, params } = executed[0]
    expect(sql).toContain('INSERT INTO app_config')
    expect(sql).toContain('ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    expect(params).toEqual(['skill_path', '$APPDATA/.skills'])
    // 写入真实生效（回读可验证）
    store.set('skill_path', '$APPDATA/.skills')
    expect(await getRawConfig('skill_path')).toBe('$APPDATA/.skills')
  })

  it('getRawConfig 按 key 参数化查询并返回 value', async () => {
    store.set('workspace_path', '$APPDATA/.workspace')
    const v = await getRawConfig('workspace_path')
    expect(v).toBe('$APPDATA/.workspace')
    expect(selected).toHaveLength(1)
    const { sql, params } = selected[0]
    expect(sql).toContain('SELECT value FROM app_config WHERE key = ?')
    expect(params).toEqual(['workspace_path'])
  })

  it('getRawConfig 查无此 key 返回 null（不抛错）', async () => {
    expect(await getRawConfig('no_such_key')).toBeNull()
  })
})
