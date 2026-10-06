// @vitest-environment node
// DDL 契约测试需要真实 SQLite 执行；默认 happy-dom 环境会把node:sqlite 当浏览器
// 内建模块尝试打包而报错，故本文件显式切到 node 环境。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM 下无 __dirname，由本文件 URL 反推目录
const HERE = dirname(fileURLToPath(import.meta.url))
import { DatabaseSync } from 'node:sqlite'

/**
 * F019/F020 回归：DDL 单一事实源契约。
 *
 * F019：`segments_json` / `last_scheduled_at` 两列原先只存在于 updater.sql，
 * 新库建表即缺列，须靠ALTER 补齐——破坏「init.sql 为 DDL 单一事实源」约定。
 * F020：`mcp_info.status` 语义为 0 未测试 / 1 正常 / 2 异常，代码侧读回用 `?? 0`，
 * 但 DDL 原为DEFAULT 1 —— 任何绕过 mapper 的 INSERT 会把新 MCP 直接标成「已连通」。
 *
 * 本测试用真实 SQLite 内存库执行 init.sql 全文，验证：
 *  1. init.sql 可无错执行（语法正确）；
 *  2. mapper 读取的列在 init 建表后即存在；
 *  3. 关键默认值符合语义。
 * 建议后续接入 CI（报告 §1.19 原始处方）。
 */

const INIT_SQL = join(HERE, 'init.sql')

/** 极简 SQL 切分：忽略行注释/块注释/字符串内分号。 */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  let inStr = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    const n = sql[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        buf += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      buf += c
      if (c === "'") inStr = false
      continue
    }
    if (c === '-' && n === '-') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i++
      continue
    }
    if (c === "'") {
      inStr = true
      buf += c
      continue
    }
    if (c === ';') {
      if (buf.trim()) out.push(buf.trim())
      buf = ''
      continue
    }
    buf += c
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

function buildDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const stmt of splitStatements(readFileSync(INIT_SQL, 'utf8'))) {
    db.exec(stmt)
  }
  return db
}

describe('DDL 单一事实源（F019 / F020）', () => {
  it('init.sql 可在空库上无错执行', () => {
    const stmts = splitStatements(readFileSync(INIT_SQL, 'utf8'))
    expect(stmts.length).toBeGreaterThan(50)
    const db = new DatabaseSync(':memory:')
    const failures: string[] = []
    for (const s of stmts) {
      try {
        db.exec(s)
      } catch (e) {
        failures.push(`${(e as Error).message} | ${s.slice(0, 80)}`)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('F019：agent_conversation_round.segments_json 建表即存在', () => {
    const rows = buildDb().prepare('PRAGMA table_info(agent_conversation_round)').all() as Array<{
      name: string
      type: string
    }>
    const hit = rows.find((r) => r.name === 'segments_json')
    expect(hit, 'segments_json 只在 updater.sql，破坏 DDL 单一事实源').toBeDefined()
    expect(hit!.type).toBe('TEXT')
  })

  it('F019：agent_squad.last_scheduled_at 建表即存在', () => {
    const rows = buildDb().prepare('PRAGMA table_info(agent_squad)').all() as Array<{
      name: string
      type: string
    }>
    const hit = rows.find((r) => r.name === 'last_scheduled_at')
    expect(hit, 'last_scheduled_at 只在 updater.sql，破坏 DDL 单一事实源').toBeDefined()
    expect(hit!.type).toBe('INTEGER')
  })

  it('F020：mcp_info.status 默认 0（未测试），省略字段插入不会误标为「正常」', () => {
    const db = buildDb()
    const cols = db.prepare('PRAGMA table_info(mcp_info)').all() as Array<{
      name: string
      dflt_value: string | null
    }>
    const st = cols.find((r) => r.name === 'status')
    expect(st).toBeDefined()
    expect(st!.dflt_value, 'DDL DEFAULT 1 会让新 MCP 显示为已连通（UI 绿灯误导）').toBe('0')

    db.exec(
      `INSERT INTO mcp_info (id, protocol_type, auth_type, created_at, updated_at)
       VALUES ('t-default', 'HTTP', 'none', 0, 0)`,
    )
    const row = db.prepare('SELECT status FROM mcp_info WHERE id = ?').get('t-default') as {
      status: number
    }
    expect(row.status).toBe(0)
  })

  it('F019：updater.sql 保留同名列（新库执行 ALTER 时走 duplicate column 幂等跳过）', () => {
    // 刻意不删updater 的 ALTER —— SqlService.updateTables 会捕获
    // "duplicate column name" 并安全跳过，删掉反而会让旧库失去迁移路径。
    const updater = readFileSync(join(HERE, 'updater.sql'), 'utf8')
    expect(updater).toMatch(/ALTER TABLE agent_conversation_round ADD COLUMN segments_json/i)
    expect(updater).toMatch(/ALTER TABLE agent_squad ADD COLUMN last_scheduled_at/i)
  })
})
