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

/**
 * 回归：两栏挑选器（__picker--two，步骤 4~7：编排 Skill / 本地插件 /
 * 绑定知识库 / 绑定服务器）的右栏「已编排/已绑定」不应被挤到页面底部。
 *
 * 背景（真实 bug）：__picker--two 的折叠断点是 1100px，而通用的
 * __picker-aside--right 有一条 1280px 的 `grid-column: 1 / -1`
 *（为三栏 __picker 的折叠而设）。tauri.conf.json 的 minWidth=1200
 * ⇒ **1200~1280px 是完全可达的窗口区间**，该区间内：
 *   网格仍是两栏（1fr 260px），但右栏被强制跨满整行 → 掉到主栏下方，
 *   右侧明明还有 260px 空位，视觉上像是「布局坏了」。
 *
 * 修复：__picker--two 在 ≤1280px 显式 `grid-column: auto` 抵消，
 * 只在真正折叠成单栏（≤1100px）时才让右栏落到下方。
 */
describe('两栏挑选器右栏不被挤到底部（回归）', () => {
  it('__picker--two 在 ≤1280px 显式抵消右栏的 grid-column: 1 / -1', () => {
    expect(
      WIZARD,
      '两栏变体必须在 ≤1280px 写 `grid-column: auto` 抵消通用右栏规则',
    ).toMatch(
      /&__picker--two \{[\s\S]*?@media \(max-width: (\d+)px\) \{\s*>\s*\.agent-wizard__picker-aside--right \{\s*grid-column: auto;/,
    )
  })

  it('抵消断点必须与通用右栏换行断点相同（1280px），否则又会被压到底部', () => {
    const override = WIZARD.match(
      /&__picker--two \{[\s\S]*?> \.agent-wizard__picker-aside--right \{[\s\S]*?@media \(max-width: (\d+)px\)/,
    )
    const asideBreak = WIZARD.match(
      /&__picker-aside--right \{[\s\S]*?@media \(max-width: (\d+)px\) \{\s*grid-column: 1 \/ -1/,
    )
    expect(override, '应找到 __picker--two 的抵消断点').toBeTruthy()
    expect(asideBreak, '应找到通用右栏换行断点').toBeTruthy()
    expect(
      override![1],
      '抵消断点必须等于通用右栏换行断点，否则右栏仍会在两栏网格里被跨行压到底部',
    ).toBe(asideBreak![1])
  })

  it('两栏网格的折叠断点（1100px）低于抵消断点，保证抵消期间网格仍是两栏', () => {
    const collapse = WIZARD.match(
      /&__picker--two \{[\s\S]*?@media \(max-width: (\d+)px\) \{\s*grid-template-columns: minmax\(0, 1fr\);/,
    )
    const override = WIZARD.match(
      /&__picker--two \{[\s\S]*?> \.agent-wizard__picker-aside--right \{[\s\S]*?@media \(max-width: (\d+)px\)/,
    )
    expect(collapse, '应找到 __picker--two 的折叠断点').toBeTruthy()
    expect(override, '应找到 __picker--two 的抵消断点').toBeTruthy()
    expect(
      Number(collapse![1]),
      '折叠断点必须小于抵消断点；若两者相同或更大，右栏就没有「留在右侧」的窗口',
    ).toBeLessThan(Number(override![1]))
  })

  it('网格行按内容撑开（align-content: start），避免右栏与主栏之间出现莫名空档', () => {
    expect(
      WIZARD,
      '__picker 应设 align-content: start，否则 picker 填满内容区高度时行被拉伸',
    ).toMatch(/&__picker \{[\s\S]*?align-content: start;/)
  })
})
