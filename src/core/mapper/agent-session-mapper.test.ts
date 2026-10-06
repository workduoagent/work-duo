import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * F021 回归：updateSession 的「显式置空」语义。
 *
 * 原实现对每列用 `COALESCE(?, col)`，导致传 null 时恒取旧值 —— 任何字段都无法
 * 置空，被迫用 clearSessionProject 打补丁绕过（见 agent-session-mapper.ts 该函数）。
 *
 * 新约定：字段不在 patch /值为 undefined → 不改该列；值为 null → 置 NULL。
 */

const executed: Array<{ sql: string; params: unknown[] }> = []

vi.mock('@/core/config', () => ({ isTauri: true }))
vi.mock('@/core/db/SqlService', () => ({
  getDb: vi.fn(async () => ({
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      executed.push({ sql, params })
      return { rowsAffected: 1 }
    }),
  })),
}))
vi.mock('./sqlUtils', () => ({
  safeParse: <T,>(s: string | null, fallback: T): T => {
    if (!s) return fallback
    try {
      return JSON.parse(s) as T
    } catch {
      return fallback
    }
  },
}))

import { updateSession, clearSessionProject } from './agent-session-mapper'

describe('updateSession —— 显式置空语义（F021）', () => {
  beforeEach(() => {
    executed.length = 0
  })

  it('只更新 patch 中出现的列（未出现的列不进 SET）', async () => {
    await updateSession('s1', { sessionName: '新名字' })
    expect(executed).toHaveLength(1)
    const { sql, params } = executed[0]
    expect(sql).toContain('session_name = ?')
    expect(sql).not.toContain('summary')
    expect(sql).not.toContain('project_id')
    expect(sql).not.toContain('COALESCE') // 原 bug 的标志
    // params 顺序：SET 字段… → updated_at → id
    expect(params.slice(0, 1)).toEqual(['新名字'])
    expect(params).toHaveLength(3)
    expect(params[2]).toBe('s1')
  })

  it('null 可显式置空（projectId 解绑）', async () => {
    await updateSession('s1', { projectId: null })
    const { sql, params } = executed[0]
    expect(sql).toContain('project_id = ?')
    expect(params[0]).toBeNull()
  })

  it('clearSessionProject 是 projectId:null 的语义化封装', async () => {
    await clearSessionProject('s1')
    const { sql, params } = executed[0]
    expect(sql).toContain('project_id = ?')
    expect(params[0]).toBeNull()
  })

  it('多字段混合：undefined 跳过、null 置空、其余写值', async () => {
    await updateSession('s1', {
      summary: '新摘要',
      errorMessage: null, // 显式清空错误信息
      endTime: undefined, // 不改
    })
    const { sql, params } = executed[0]
    expect(sql).toContain('summary = ?')
    expect(sql).toContain('error_message = ?')
    expect(sql).not.toContain('end_time')
    expect(params.slice(0, 2)).toEqual(['新摘要', null])
  })

  it('空 patch 不产生写操作（避免无意义UPDATE 与 updated_at 抖动）', async () => {
    await updateSession('s1', {})
    expect(executed).toHaveLength(0)
  })

  it('全部字段为 undefined 时同样不写库', async () => {
    await updateSession('s1', { summary: undefined, status: undefined })
    expect(executed).toHaveLength(0)
  })

  it('SET 子句的列名取自白名单常量，不含用户可控拼接', async () => {
    await updateSession('s1', { status: 'DONE' })
    const { sql } = executed[0]
    // 列名必须是固定 snake_case 白名单项
    expect(sql).toMatch(/UPDATE agent_conversation_session SET status = \?, updated_at = \? WHERE id = \?/)
  })
})
