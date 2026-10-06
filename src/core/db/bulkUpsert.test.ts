import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from '@tauri-apps/plugin-sql'
import { bulkUpsert } from './sqlUtils'

/**
 * F024 回归：`bulkUpsert` 的 SQL 生成与 `preserveColumns` 语义。
 *
 * 背景：模型配置的 `upsertModel` 与 `bulkUpsertModels` 此前各写一份 16 列的
 * INSERT + ON CONFLICT（列清单要改两遍），后者还逐行 execute 无分批。改用
 * 共享的 `bulkUpsert` 后，**曾引入一处行为回归**：共享实现默认「所有非键列都
 * 更新」，会多生成 `created_at = excluded.created_at`，而原实现刻意**不**更新
 * `created_at`（`upsertModel` 注释写明「更新时保留 created_at」）。
 * 故 `bulkUpsert` 增加 `preserveColumns` 参数，调用方显式声明保留列。
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** 收集执行过的 SQL */
function makeSpyDb() {
  const sqls: string[] = []
  const params: unknown[][] = []
  const db = {
    execute: async (sql: string, p: unknown[] = []) => {
      sqls.push(sql)
      params.push(p)
      return { rowsAffected: 0, lastInsertId: 0 }
    },
    select: async () => [],
    close: async () => {},
    // plugin-sql Database 还有其他成员，这里用 as unknown 规避结构断言
  } as unknown as Database
  return { db, sqls, params }
}

describe('bulkUpsert SQL 生成（F024）', () => {
  it('生成 INSERT + ON CONFLICT DO UPDATE', async () => {
    const { db, sqls } = makeSpyDb()
    await bulkUpsert(db, 'models', ['id', 'name', 'created_at'], [{ id: 'a', name: 'x', created_at: 1 }])
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).toContain('INSERT INTO models')
    expect(sqls[0]).toContain('ON CONFLICT(id) DO UPDATE SET')
    expect(sqls[0]).toContain('name = excluded.name')
  })

  it('preserveColumns 中的列不进入 DO UPDATE（保留原值）', async () => {
    const { db, sqls } = makeSpyDb()
    await bulkUpsert(db, 'models', ['id', 'name', 'created_at'], [{ id: 'a', name: 'x', created_at: 1 }], ['id'], ['created_at'])
    const setPart = sqls[0].slice(sqls[0].indexOf('DO UPDATE SET'))
    expect(setPart).toContain('name = excluded.name')
    expect(setPart, 'created_at 应被保留，不出现在 DO UPDATE SET 里').not.toContain('created_at')
  })

  it('created_at 仍出现在 INSERT 列中（插入时写入）', async () => {
    const { db, sqls } = makeSpyDb()
    await bulkUpsert(db, 'models', ['id', 'name', 'created_at'], [{ id: 'a', name: 'x', created_at: 1 }], ['id'], ['created_at'])
    const insertPart = sqls[0].slice(0, sqls[0].indexOf('ON CONFLICT'))
    expect(insertPart, '保留列插入时仍要写值').toContain('created_at')
  })

  it('无保留列时全部非键列都更新（原默认行为）', async () => {
    const { db, sqls } = makeSpyDb()
    await bulkUpsert(db, 'models', ['id', 'name', 'created_at'], [{ id: 'a', name: 'x', created_at: 1 }])
    const setPart = sqls[0].slice(sqls[0].indexOf('DO UPDATE SET'))
    expect(setPart).toContain('created_at = excluded.created_at')
  })

  it('超过 50 行自动分批', async () => {
    const { db, sqls } = makeSpyDb()
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `id${i}`, name: `n${i}` }))
    await bulkUpsert(db, 'models', ['id', 'name'], rows)
    expect(sqls.length, '120 行应分 3 批').toBe(3)
  })

  it('空数组直接返回（不发 SQL）', async () => {
    const { db, sqls } = makeSpyDb()
    await bulkUpsert(db, 'models', ['id'], [])
    expect(sqls).toHaveLength(0)
  })

  it('undefined 值转为 null（SQLite 不接受 undefined）', async () => {
    const { db, params } = makeSpyDb()
    await bulkUpsert(db, 'models', ['id', 'name'], [{ id: 'a', name: undefined }])
    expect(params[0]).toEqual(['a', null])
  })
})

describe('model-mapper 已复用 bulkUpsert（F024）', () => {
  const src = readFileSync(join(HERE, '..', 'mapper', 'model-mapper.ts'), 'utf8')

  it('两处 upsert 均走 bulkUpsert（不再手写 INSERT）', () => {
    expect(src).toContain("bulkUpsert(db, 'models', MODEL_COLUMNS, [modelToRow(model)]")
    expect(src).toContain("bulkUpsert(db, 'models', MODEL_COLUMNS, models.map(modelToRow)")
    // 不应再有手写的 16 列 INSERT
    expect(src).not.toMatch(/INSERT INTO models\s*\n\s*\(id, provider, name, model_name/)
  })

  it('两处都声明保留 created_at（更新时保留创建时间）', () => {
    // 按行提取调用语句——正则会被 modelToRow(model) 的括号提前截断
    const lines = src.split(/\r?\n/)
    const calls = lines.filter((l) => l.includes("bulkUpsert(db, 'models'"))
    expect(calls, '应有 2 处 bulkUpsert 调用').toHaveLength(2)
    for (const c of calls) {
      expect(c, `须传 preserveColumns 含 created_at：${c.trim()}`).toContain("'created_at'")
    }
  })

  it('列清单只维护一份（MODEL_COLUMNS 常量）', () => {
    const defs = src.match(/const MODEL_COLUMNS[\s\S]*?\n\]/)
    expect(defs, '应有 MODEL_COLUMNS 常量').toBeTruthy()
    // 16 个列名各出现一次（定义处）
    const body = defs![0]
    expect(body).toContain("'api_secret'")
    expect(body).toContain("'tool_calls'")
  })
})
