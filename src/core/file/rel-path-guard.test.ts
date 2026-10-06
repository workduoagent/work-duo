/**
 * F005 回归锚：assertSafeRelPath 路径越界守卫（kbFs / skillFs 共用）。
 * 守卫必须拒绝：.. 穿越 / 绝对路径 / 盘符写法 / 空段 / 空串；合法相对路径放行。
 */
import { describe, expect, it } from 'vitest'
import { assertSafeRelPath } from './rel-path-guard'

describe('assertSafeRelPath', () => {
  it('放行合法相对路径', () => {
    expect(() => assertSafeRelPath('docs/a.txt', 'kb')).not.toThrow()
    expect(() => assertSafeRelPath('scripts/x.py', 'kb')).not.toThrow()
    expect(() => assertSafeRelPath('a/b/c', 'kb')).not.toThrow()
  })

  it('拒绝 .. 穿越（含反斜杠归一与内嵌形态）', () => {
    expect(() => assertSafeRelPath('../secret', 'kb')).toThrow()
    expect(() => assertSafeRelPath('..\\secret', 'kb')).toThrow()
    expect(() => assertSafeRelPath('docs/../../.ssh/authorized_keys', 'kb')).toThrow()
    expect(() => assertSafeRelPath('docs/../..', 'kb')).toThrow()
  })

  it('拒绝绝对路径（POSIX 根 / 盘符）', () => {
    expect(() => assertSafeRelPath('/etc/passwd', 'kb')).toThrow()
    expect(() => assertSafeRelPath('C:/Windows/system32', 'kb')).toThrow()
    expect(() => assertSafeRelPath('C:\\Users\\x', 'kb')).toThrow()
    expect(() => assertSafeRelPath('D:/data', 'kb')).toThrow()
  })

  it('拒绝空串与空段', () => {
    expect(() => assertSafeRelPath('', 'kb')).toThrow()
    expect(() => assertSafeRelPath('docs//a.txt', 'kb')).toThrow()
    expect(() => assertSafeRelPath('docs/', 'kb')).toThrow()
  })

  it('拒绝盘符内嵌段（Windows 相对盘符写法）', () => {
    expect(() => assertSafeRelPath('docs/C:/evil', 'kb')).toThrow()
  })

  it('报错信息携带 label 便于定位入口', () => {
    expect(() => assertSafeRelPath('../x', 'kb:add_file')).toThrow(/kb:add_file/)
  })
})
