// 判分测试（bun:test）：初始 4 红 1 绿=缺陷在位；修复后全绿。禁止修改本文件。
import { test, expect } from 'bun:test'
import { parseLocalDate, monthLabel } from './datefmt.js'

test('month is zero-based corrected', () => {
  const dt = parseLocalDate('2026-09-24')
  expect(dt.getFullYear()).toBe(2026)
  expect(dt.getMonth()).toBe(8) // 9 月 → 索引 8
  expect(dt.getDate()).toBe(24)
})

test('january maps to index 0', () => {
  expect(parseLocalDate('2026-01-02').getMonth()).toBe(0)
})

test('december maps to index 11', () => {
  expect(parseLocalDate('2026-12-31').getMonth()).toBe(11)
})

test('monthLabel', () => {
  expect(monthLabel('2026-09-24')).toBe('Sep')
  expect(monthLabel('2026-01-15')).toBe('Jan')
})

test('local midnight, no day shift', () => {
  const dt = parseLocalDate('2026-09-24')
  expect(dt.getDate()).toBe(24)
  expect(dt.getHours()).toBe(0)
})
