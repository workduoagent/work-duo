import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * F037 回归：旧深色主题字面量不得残留在 .dark 块内。
 *
 * 背景：chat.scss 曾有 107 个 `.dark &` 块，其中 106 块内写着旧深色主题遗留的
 * 硬编码值（#1a1a1a / #1f1f1f 背景、#2f2f2f / #333 / #444 边框、
 * #e6e6e6 / #d4d4d4 / #aaa / #999 文字），绕过令牌体系。后果：
 *  1. 换主题时这批声明不跟随（浅色主题下也可能命中）；
 *  2. #aaa 在浅底上对比度约 2.0:1，远低于 WCAG AA 4.5:1。
 *
 * 本测试只约束「通用旧深灰值」。Ocean 调色板专属色（#2a2f3a / #4fd6c4 /
 * #93b4ff / #6ea8ff 等）与 lightbox 压在图片上的白色半透明层
 * （rgba(255,255,255,0.12) 等，属刻意设计）不在此列。
 */

const ROOT = join(__dirname, '..', '..')

function collectScss(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'target') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) collectScss(p, acc)
    else if (name.endsWith('.scss')) acc.push(p)
  }
  return acc
}

/** 旧深色主题遗留的通用深灰值（不含 Ocean 专属色）。 */
const LEGACY_DARK = /#(1a1a1a|1f1f1f|2f2f2f|333|3a3a3a|444|e6e6e6|d4d4d4|aaa|999)\b/i

/** 收集 `.dark &` 块内的 legacy深色字面量。块边界按缩进判定（`.dark &` 自身缩进为块内基准）。 */
function findLegacyInDarkBlocks(scss: string): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = []
  const lines = scss.split(/\r?\n/)
  let inDark = false
  let baseIndent = 0
  const file = scss
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!inDark && /\.dark\s*&/.test(line)) {
      inDark = true
      baseIndent = line.match(/^\s*/)![0].length
      continue
    }
    if (inDark) {
      const indent = line.match(/^\s*/)![0].length
      if (line.trim() && indent <= baseIndent) {
        inDark = false
        continue
      }
      if (LEGACY_DARK.test(line)) {
        hits.push({ file, line: i + 1, text: line.trim() })
      }
    }
  }
  return hits
}

describe('旧深色主题字面量（F037）', () => {
  const scssFiles = collectScss(join(ROOT, 'src'))

  it('样式扫描器本身有效（避免空扫描假绿）', () => {
    expect(scssFiles.length).toBeGreaterThan(20)
    expect(scssFiles.some((f) => f.endsWith('chat.scss'))).toBe(true)
  })

  it('.dark 块内不再有旧深色字面量', () => {
    const allHits: Array<{ file: string; line: number; text: string }> = []
    for (const f of scssFiles) {
      allHits.push(...findLegacyInDarkBlocks(readFileSync(f, 'utf8')))
    }
    const detail = allHits.map((h) => `${h.file}:${h.line} ${h.text}`).join('\n')
    expect(allHits, `以下 .dark 块内仍有旧深色字面量：\n${detail}`).toEqual([])
  })

  it('chat.scss 不再有 var(--令牌, #hex) 形式的死 fallback', () => {
    // F036 补齐令牌后，fallback 永不生效，属误导性残留
    const text = readFileSync(join(ROOT, 'src', 'pages', 'agent-studio', 'chat.scss'), 'utf8')
    const dead = text.match(/var\(--[a-zA-Z0-9_-]+,\s*#[0-9a-fA-F]{3,8}\)/g) ?? []
    expect(dead, `仍有死 fallback：${dead.join(', ')}`).toEqual([])
  })

  it('已知低对比裸写值已改为令牌（画廊区 #999 → 次级文字）', () => {
    const text = readFileSync(join(ROOT, 'src', 'pages', 'agent-studio', 'chat.scss'), 'utf8')
    // 该块原为 color:#999（浅底对比度约 2.8:1）与 color:#333 / background:#f0f0f0
    expect(text).not.toMatch(/color:\s*#999\s*;/)
    expect(text).toContain('&__gallery-sub')
  })
})
