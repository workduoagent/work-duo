import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ListState } from './ListState'

/**
 * F046 回归：列表页三态（loading / error / empty）。
 *
 * 背景：此前各列表页自行处理三态，退化形态有三：
 *  1. 加载失败 → `message.error` 后 list保持空 → 页面显示「空列表」，
 *     **用户以为「没有数据」而非「加载失败」**，排查方向从一开始就跑偏；
 *  2. 有的页面只有 loading、有的只有 Empty（`settings` / `model-settings` 连
 *     Empty 都没有，空数据时白屏）；
 *  3. 失败后无重试入口，只能刷新页面。
 *
 * 核心不变量：**错误优先于 loading 与空态**——否则失败仍会被误读为「没有数据」。
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(ui: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(ui)
  })
  return container
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

describe('ListState 三态（F046）', () => {
  it('正常态：直接渲染 children', () => {
    const el = render(
      <ListState>
        <div data-testid="content">列表内容</div>
      </ListState>,
    )
    expect(el.querySelector('[data-testid="content"]')).toBeTruthy()
    expect(el.textContent).not.toContain('加载失败')
  })

  it('错误优先于 loading 与空态（核心不变量）', () => {
    // 同时传 loading 与 empty：仍须显示错误，而非「加载中」或「暂无数据」
    const el = render(
      <ListState loading empty error={new Error('数据库连接失败')}>
        <div data-testid="content">内容</div>
      </ListState>,
    )
    const text = el.textContent ?? ''
    expect(text).toContain('加载失败')
    expect(text).toContain('数据库连接失败')
    expect(text).not.toContain('暂无数据')
  })

  it('错误优先于空态：空数据 + 有错误时显示错误而非 Empty', () => {
    const el = render(<ListState empty error="读取超时" />)
    expect(el.textContent).toContain('加载失败')
    expect(el.textContent).toContain('读取超时')
  })

  it('loading 态不显示空态文案', () => {
    const el = render(<ListState loading empty emptyText="暂无模型配置" />)
    expect(el.textContent).not.toContain('暂无模型配置')
  })

  it('空态显示自定义描述', () => {
    const el = render(<ListState empty emptyText="暂无模型配置" />)
    expect(el.textContent).toContain('暂无模型配置')
  })

  it('提供 onRetry 时错误态出现重试按钮', () => {
    let clicked = false
    const el = render(
      <ListState
        error={new Error('失败')}
        onRetry={() => {
          clicked = true
        }}
      />,
    )
    const btn = el.querySelector('button')
    expect(btn, '错误态应提供重试按钮').toBeTruthy()
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clicked, '点击重试应触发回调').toBe(true)
  })

  it('无 onRetry 时不渲染重试按钮', () => {
    const el = render(<ListState error={new Error('失败')} />)
    expect(el.querySelector('button')).toBeNull()
  })

  it('错误接受字符串或 Error 两种形态', () => {
    const a = render(<ListState error="字符串错误" />)
    expect(a.textContent).toContain('字符串错误')
    a.remove()
    const b = render(<ListState error={new Error('Error 对象')} />)
    expect(b.textContent).toContain('Error 对象')
  })

  it('className 透传（接入方保持既有布局类）', () => {
    const el = render(
      <ListState className="settings settings--loading">
        <div>x</div>
      </ListState>,
    )
    expect(el.querySelector('.settings')).toBeTruthy()
    expect(el.querySelector('.settings--loading')).toBeTruthy()
  })
})
