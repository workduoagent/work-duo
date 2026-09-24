// 判分测试（bun:test）：初始 3 红 2 绿=缺陷在位；修复后全绿。禁止修改本文件。
import { test, expect } from 'bun:test'
import { sortIds } from './sortnums.js'

test('basic numeric order', () => {
  expect(sortIds([10, 1, 2])).toEqual([1, 2, 10])
})

test('negatives and zero', () => {
  expect(sortIds([10, -3, 2, 0])).toEqual([-3, 0, 2, 10])
})

test('floats and big numbers', () => {
  expect(sortIds([2.5, 100, 22, 3])).toEqual([2.5, 3, 22, 100])
})

test('empty stays empty', () => {
  expect(sortIds([])).toEqual([])
})

test('does not mutate input', () => {
  const a = [3, 1, 2]
  sortIds(a)
  expect(a).toEqual([3, 1, 2])
})
