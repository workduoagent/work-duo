import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * F043/F045 回归：小分队列表卡片的memo 化与行为等价性。
 *
 * 背景：`SquadsWorkspacePage` 零 `memo`，卡片 JSX 内联在页面里，导致两类高频
 * state 变化会重绘整棵2700+ 行组件树（含每张卡片内 PixelAgent 的 canvas）：
 *  1. `liveStatus` —— 30s 轮询刷新；
 *  2. `hoverCrew` —— 鼠标划过任意成员小人（全局 state，每划一次整页重渲染）。
 *
 * 本测试锁住三条不变量（纯文本断言，无需React 运行时）：
 *  1. 卡片组件是 `React.memo`；
 *  2. hover 回调用 `useCallback`（否则每次渲染新箭头函数会让 memo 失效）；
 *  3. 抽离后**行为与样式未变** —— 关键 class / aria-label 全部保留，
 *    尤其「打开空间目录」按钮（无 workspaceDir 时disabled）。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CARD = join(HERE, 'SquadCard.tsx')
const PAGE = join(HERE, 'index.tsx')

const card = readFileSync(CARD, 'utf8')
const page = readFileSync(PAGE, 'utf8')

describe('SquadCard memo 化（F045）', () => {
  it('卡片组件用 React.memo 包裹', () => {
    expect(card).toMatch(/export const SquadCard = memo\(function SquadCard/)
    expect(card).toMatch(/import \{ memo, useCallback \} from 'react'/)
  })

  it('hover 回调用 useCallback（避免每次渲染新建函数使 memo 失效）', () => {
    const cbs = card.match(/useCallback\(/g) ?? []
    expect(cbs.length, 'enter/leave 两个 hover 回调都应用 useCallback').toBeGreaterThanOrEqual(2)
    // 不应在 JSX 里内联箭头函数触发 hover（那会让 memo 失效）
    expect(card, 'hover 应走 useCallback 生成的稳定引用').not.toMatch(
      /onMouseEnter=\{\(\)\s*=>\s*onHoverCrew/,
    )
  })

  /**
   * 关键设计：live 传的是**该卡片自己的状态字符串**而非整个 liveStatus map。
   * 若传整个 map，任一卡片状态变化都会让所有卡片重渲染 —— memo 就白加了。
   */
  it('live 只传本卡片状态（而非整个 map）—— memo 生效的前提', () => {
    expect(page).toMatch(/live=\{liveStatus\[squad\.id\]\}/)
    expect(page).not.toMatch(/live=\{liveStatus\}/)
    expect(card).toMatch(/live: string \| undefined/)
  })

  it('页面已改为使用 SquadCard，内联卡片 JSX 已移除', () => {
    expect(page).toMatch(/import \{ SquadCard \} from '\.\/SquadCard'/)
    expect(page).toMatch(/<SquadCard/)
    // 内联的 <Card frame="solid" className="squads__card"> 应已不在页面里
    expect(page, '内联卡片 JSX 应已抽离').not.toMatch(/<Card frame="solid" className="squads__card"/)
  })

  it('样式类名完整保留（16 个 squads__card-* / crews_* 类）', () => {
    const classes = ['squads__card', 'squads__card-head', 'squads__card-avatar', 'squads__card-logo',
      'squads__card-titles', 'squads__card-title', 'squads__card-tags', 'squads__card-desc',
      'squads__card-crew', 'squads__crew-slot', 'squads__crew-avatar', 'squads__crew-more',
      'squads__card-actions', 'squads__card-main', 'squads__card-del', 'squads__live-dot']
    for (const c of classes) {
      expect(card, `缺少样式类 ${c}`).toContain(c)
    }
  })

  it('可访问性与行为属性完整保留（4 个 aria-label + 3 个 title）', () => {
    for (const a of ['aria-label="删除"', 'aria-label="编辑"', 'aria-label="打开协作工作台"', 'aria-label="打开空间目录"']) {
      expect(card, `缺少 ${a}`).toContain(a)
    }
    for (const t of ['title="删除小分队"', 'title="打开协作工作台（运行 / 历史 / 记忆）"']) {
      expect(card, `缺少 ${t}`).toContain(t)
    }
    // 「打开空间目录」按钮：无 workspaceDir 时禁用（抽离时最容易丢的逻辑）
    expect(card).toMatch(/disabled=\{!squad\.workspaceDir\}/)
    // 成员 hover 槽位 key 格式保持 `${squadId}-${i}`
    expect(card).toMatch(/const crewKey = `\$\{squad\.id\}-\$\{i\}`/)
  })

  it('删除按钮仍包Popconfirm（不可恢复操作须二次确认）', () => {
    expect(card).toMatch(/<Popconfirm/)
    expect(card).toMatch(/okButtonProps=\{\{ ?danger: true ?\}\}/)
  })
})
