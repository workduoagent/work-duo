import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lsList, lsSave, safeParse } from './localFallback'

/**
 * F024 回归：localStorage 降级读写收敛到共享实现。
 *
 * 背景：此前 `safeParse` 散落 7 处、localStorage 读写散落 12 个 mapper 各写一遍，
 * 改一处漏N 处 —— 上一轮批量改写曾因跨函数体正则导致 80 error 回滚。
 * 现统一为 `localFallback.ts` 的三个纯函数，mapper 侧只保留薄封装。
 *
 * 本测试锁住：① 共享实现的行为契约（读失败/无数据回落、写失败上抛）；
 * ② mapper 目录内除共享模块外**不再有 localStorage 直调**。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = HERE

describe('localFallback 行为契约（F024）', () => {
  it('lsList：无数据返回空数组', () => {
    expect(lsList('nope-key')).toEqual([])
  })

  it('lsList：读回写入的数据', () => {
    lsSave('t1', [{ a: 1 }])
    expect(lsList<{ a: number }>('t1')).toEqual([{ a: 1 }])
  })

  it('lsList：坏 JSON 回落空数组（不抛）', () => {
    localStorage.setItem('t2', '{bad json')
    expect(lsList('t2')).toEqual([])
  })

  it('lsSave + lsList 往返保真', () => {
    const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]
    lsSave('t3', rows)
    expect(lsList('t3')).toEqual(rows)
  })

  it('lsSave 写失败向上抛（不静默）——UI 需能感知「未落盘」', () => {
    // happy-dom 下 Storage.prototype 的 spy 不生效，直接spy localStorage 实例
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded')
    })
    expect(() => lsSave('t4', [1])).toThrow('QuotaExceeded')
    spy.mockRestore()
  })

  it('safeParse：空值与坏JSON 均回落到fallback', () => {
    expect(safeParse<number[]>(null, [])).toEqual([])
    expect(safeParse<number[]>(undefined, [])).toEqual([])
    expect(safeParse<number[]>('', [])).toEqual([])
    expect(safeParse<number[]>('{bad', [])).toEqual([])
    expect(safeParse('{"a":1}', { a: 0 })).toEqual({ a: 1 })
  })
})

describe('mapper 目录已收口（F024）', () => {
  it('除共享模块外，mapper 内无 localStorage 直调', () => {
    // 排除共享模块与测试文件（后者用 localStorage 构造坏数据是合理的）
    const files = readdirSync(DIR).filter(
      (f) => f.endsWith('.ts') && f !== 'localFallback.ts' && !f.endsWith('.test.ts'),
    )
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(join(DIR, f), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        // config-mapper 例外：配置是 Record<string,string>（非数组），共享的
        // lsList/lsSave 不适用，保留直调 + safeParse
        if (f === 'config-mapper.ts') continue
        if (/localStorage\./.test(line)) offenders.push(`${f}: ${line.trim().slice(0, 60)}`)
      }
    }
    expect(offenders, `以下文件仍有 localStorage 直调：\n${offenders.join('\n')}`).toEqual([])
  })

  it('safeParse 只在共享模块定义（各mapper 均为 import）', () => {
    const files = readdirSync(DIR).filter(
      (f) => f.endsWith('.ts') && f !== 'localFallback.ts' && !f.endsWith('.test.ts'),
    )
    const definers: string[] = []
    for (const f of files) {
      const text = readFileSync(join(DIR, f), 'utf8')
      if (/^function safeParse/m.test(text) || /^export function safeParse/m.test(text)) definers.push(f)
    }
    expect(definers, `safeParse 应只在 localFallback.ts 定义：${definers.join(', ')}`).toEqual([])
  })
})
