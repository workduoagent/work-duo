import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * F026 回归：deleteProject 必须事务化。
 *
 * 背景：原实现逐条删（删 N 个会话的轮次 → 删会话 → 删工程），中途失败会留下
 * 「轮次已删、会话残留」的半删除状态。修复后用 BEGIN/COMMIT 包裹，失败回滚。
 */
const executed: Array<{ sql: string; params: unknown[] }> = []
/** 模拟某条语句执行失败（用于验证回滚路径）。 */
let failOn: RegExp | null = null

vi.mock('@/core/config', () => ({ isTauri: true }))
vi.mock('@/core/db/SqlService', () => ({
  getDb: vi.fn(async () => ({
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      executed.push({ sql, params })
      if (failOn && failOn.test(sql)) throw new Error('模拟执行失败')
      return { rowsAffected: 1 }
    }),
    select: vi.fn(async () => [
      { id: 'sess-1' },
      { id: 'sess-2' },
    ]),
  })),
}))

import { deleteProject } from './agent-project-mapper'

describe('deleteProject 事务性（F026）', () => {
  beforeEach(() => {
    executed.length = 0
    failOn = null
  })

  it('正常路径：BEGIN → 逐条删 → COMMIT', async () => {
    await deleteProject('p1')
    const sqls = executed.map((e) => e.sql)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls[sqls.length - 1]).toBe('COMMIT')
    expect(sqls.some((s) => s.includes('DELETE FROM agent_conversation_round'))).toBe(true)
    expect(sqls.some((s) => s.includes('DELETE FROM agent_conversation_session'))).toBe(true)
    expect(sqls.some((s) => s.includes('DELETE FROM agent_project'))).toBe(true)
    expect(sqls).not.toContain('ROLLBACK')
  })

  it('中途失败：ROLLBACK 且错误向上抛（不留半删除状态）', async () => {
    failOn = /DELETE FROM agent_conversation_session/
    await expect(deleteProject('p1')).rejects.toThrow('模拟执行失败')
    const sqls = executed.map((e) => e.sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
  })

  it('删工程语句本身失败也要回滚', async () => {
    failOn = /DELETE FROM agent_project/
    await expect(deleteProject('p1')).rejects.toThrow()
    const sqls = executed.map((e) => e.sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls).not.toContain('COMMIT')
  })
})
