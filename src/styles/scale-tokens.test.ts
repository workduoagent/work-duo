import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * F052 回归：间距刻度令牌 + 侧栏宽度令牌 + wizard 折叠阈值。
 *
 * 背景：
 *  1. 全项目 1411 处 gap/padding/width 裸px（gap 678 / padding 493 / width 240），
 *     间距节奏无法统一调控；
 *  2. wizard 编辑器三栏 `220px minmax(0,1fr) 260px` 硬编码，折叠阈值 1100px，
 *     而 `tauri.conf.json` 的 `minWidth: 1200` + lib.rs 按显示器 work_area 收敛
 *     ⇒ **1200px 是可达的最小窗口**。原阈值意味着 1200~1280 区间（笔记本最常见
 *     宽度）第三栏仍占位、中栏被挤到约 610px，挑选器内容拥挤。
 *
 * 本测试锁住：刻度按实测分布设定、侧栏令牌已定义、wizard 两处折叠阈值一致
 *（改一处忘另一处会导致折叠后第三栏重叠）。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const VARS = readFileSync(join(ROOT, 'src', 'styles', 'variables.scss'), 'utf8')
const WIZARD = readFileSync(join(ROOT, 'src', 'pages', 'agent-studio', 'wizard.scss'), 'utf8')

describe('间距刻度令牌（F052）', () => {
  it('主刻度齐全（4px 基准倍增）', () => {
    const expected: Record<string, string> = {
      '--space-1': '4px',
      '--space-2': '8px',
      '--space-3': '12px',
      '--space-4': '16px',
      '--space-5': '20px',
      '--space-6': '24px',
      '--space-8': '32px',
    }
    for (const [name, val] of Object.entries(expected)) {
      const re = new RegExp(`${name}:\\s*${val.replace('px', 'px')}\\s*;`)
      expect(VARS, `${name} 应为 ${val}`).toMatch(re)
    }
  })

  it('半档刻度齐全（实测 2/6/10/14 合计出现 496 次，不可只给整数档）', () => {
    for (const [name, val] of [
      ['--space-05', '2px'],
      ['--space-15', '6px'],
      ['--space-25', '10px'],
      ['--space-35', '14px'],
    ] as const) {
      expect(VARS, `${name} 应为 ${val}`).toMatch(new RegExp(`${name}:\\s*${val}\\s*;`))
    }
  })

  it('侧栏 / 辅助面板宽度令牌存在', () => {
    expect(VARS).toMatch(/--sidebar-w:\s*220px\s*;/)
    expect(VARS).toMatch(/--aside-w:\s*300px\s*;/)
  })
})

describe('wizard 三栏折叠阈值（F052）', () => {
  it('折叠阈值提到 1280px（1200px 是可达的最小窗口）', () => {
    // __picker 自身的折叠断点
    expect(WIZARD).toMatch(
      /&__picker \{[\s\S]*?@media \(max-width: 1280px\) \{[\s\S]*?grid-template-columns: var\(--sidebar-w\) minmax\(0, 1fr\)/,
    )
  })

  it('侧栏宽度已用令牌而非硬编码', () => {
    expect(WIZARD, '三栏应走 var(--sidebar-w) / var(--aside-w)').toMatch(
      /grid-template-columns: var\(--sidebar-w\) minmax\(0, 1fr\) var\(--aside-w\)/,
    )
    // 不应再有裸 220px / 260px 三栏定义
    expect(WIZARD).not.toMatch(/grid-template-columns:\s*220px\s+minmax/)
  })

  /**
   * 关键一致性：__picker 的折叠断点与 __picker-aside--right 的换行断点
   * 必须一致 —— 只改一处会导致折叠后第三栏与中栏重叠。
   */
  it('两处折叠阈值一致（避免折叠后第三栏重叠）', () => {
    const pickerBreak = WIZARD.match(/&__picker \{[\s\S]*?@media \(max-width: (\d+)px\)/)
    const asideBreak = WIZARD.match(
      /&__picker-aside--right \{[\s\S]*?@media \(max-width: (\d+)px\) \{\s*grid-column: 1 \/ -1/,
    )
    expect(pickerBreak, '应找到 __picker 的折叠断点').toBeTruthy()
    expect(asideBreak, '应找到 __picker-aside--right 的换行断点').toBeTruthy()
    expect(
      asideBreak![1],
      '两处阈值必须相同，否则折叠后第三栏会与中栏重叠',
    ).toBe(pickerBreak![1])
  })

  it('保留 720px 单栏断点（窄屏兜底）', () => {
    expect(WIZARD).toMatch(/@media \(max-width: 720px\) \{\s*grid-template-columns: 1fr;/)
  })
})
