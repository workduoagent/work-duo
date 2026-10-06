import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * F036 回归：CSS 令牌完整性。
 *
 * 背景：全项目 94 个 var() 引用中曾有 30 个语义色只存在于调用点的 fallback 里
 * （如 var(--color-primary, #1677ff)）。因都带 fallback，编译不报错、视觉不炸，
 * 缺陷被完全掩盖——但换主题时这批文字永不变化，且 fallback 是 antd 旧默认蓝，
 * 与 Ocean 调色板不一致，导致 chat 页与其它页面出现两套主色。
 *
 * 本测试锁住「引用了但从未定义」这个不变量，防止将来再引入同类缺陷。
 * 例外白名单：
 *   - --pill-w / --pill-x：TopBar 运行时通过 style.setProperty 注入的滑块位移
 *   - 以 -- 开头的运行时注入型变量（脚本可按前缀扩展白名单）
 */

const SRC = join(__dirname, '..')

/** 递归收集源码文件（跳过依赖与产物目录）。 */
function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'target') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collectFiles(p, acc)
    else if (/\.(scss|tsx|ts)$/.test(name)) acc.push(p)
  }
  return acc
}

const files = collectFiles(SRC)

/** 收集所有 CSS 自定义属性引用。 */
function collectUsed(): Map<string, number> {
  const used = new Map<string, number>()
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
      used.set(m[1], (used.get(m[1]) ?? 0) + 1)
    }
  }
  return used
}

/** 收集所有已定义令牌（允许缩进/嵌套作用域，如 `.sw { --swbg: ... }`）。 */
function collectDefined(): Set<string> {
  const defined = new Set<string>()
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1])
  }
  return defined
}

/** 运行时由 JS 注入的变量：scss 不定义是正确设计。 */
const RUNTIME_INJECTED = new Set(['--pill-w', '--pill-x'])

describe('CSS 令牌完整性（F036）', () => {
  it('源码文件扫描器本身有效（避免空扫描假绿）', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.endsWith('variables.scss'))).toBe(true)
  })

  it('不存在「引用了但从未定义」的 CSS 变量', () => {
    const used = collectUsed()
    const defined = collectDefined()
    const missing = [...used.keys()]
      .filter((k) => !defined.has(k))
      .filter((k) => !RUNTIME_INJECTED.has(k))
      // 排除正则截断误报：`var(--color-` 这类残缺名不是合法令牌
      .filter((k) => !/^--[a-z]*-$/.test(k))
      .sort()
    expect(missing, `以下令牌被引用但未定义：${missing.join(', ')}`).toEqual([])
  })

  it('关键语义令牌在明暗两段均有定义（换主题不失效）', () => {
    const vars = readFileSync(join(SRC, 'styles', 'variables.scss'), 'utf8')
    // 抽取 :root/.light 段与 .dark 段
    const lightStart = vars.indexOf(':root,')
    const darkStart = vars.indexOf('.dark {')
    expect(lightStart).toBeGreaterThan(-1)
    expect(darkStart).toBeGreaterThan(lightStart)
    const lightSeg = vars.slice(lightStart, darkStart)
    const darkSeg = vars.slice(darkStart, vars.indexOf('\n}', darkStart))

    const critical = [
      '--color-primary',
      '--color-muted',
      '--color-text-tertiary',
      '--color-surface',
      '--color-bg',
      '--color-error',
      '--color-info',
      '--color-trace-exec',
      '--color-trace-chat',
      '--accent',
    ]
    for (const name of critical) {
      expect(lightSeg, `浅色段缺 ${name}`).toContain(name + ':')
      expect(darkSeg, `暗色段缺 ${name}`).toContain(name + ':')
    }
  })

  it('尺寸令牌在 :root 段定义（圆角刻度与布局常量）', () => {
    const vars = readFileSync(join(SRC, 'styles', 'variables.scss'), 'utf8')
    const sizeStart = vars.indexOf('/* 尺寸 / 圆角')
    const sizeSeg = vars.slice(sizeStart, vars.indexOf('\n}', sizeStart))
    for (const name of ['--radius-sm', '--radius-md', '--radius-lg', '--input-h', '--right-w']) {
      expect(sizeSeg, `尺寸段缺 ${name}`).toContain(name + ':')
    }
  })
})
