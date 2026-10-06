import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LongTaskProgress, useLongTask } from './LongTaskProgress'

/**
 * F048 回归：长耗时任务进度。
 *
 * 背景：导入类操作（ZIP 解包 / JSON 解析 / 批量写入）动辄数百毫秒到数秒，
 * 此前界面**完全静止**——只有按钮转圈，用户不知���在读文件、解析还是写库。
 * 沙箱 Python 页已有成熟形态（阶段文案 + 百分比 + 平滑推进），但未抽象复用。
 *
 * 核心不变量：
 *  1. 阶段可见（start/step 的 msg 能渲染出来）；
 *  2. **进度平滑** —— 真实任务常长时间不动（ZIP 解包无法中途报进度），
 *     定时器让进度缓动逼近目标，给出「仍在进行」的感知；
 *  3. 失败态转错误样式，且**卸载时清理定时器**（否则对已卸载组件 setState）。
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
  vi.useRealTimers()
})

/** 把 hook 暴露到 DOM 便于断言 */
function Probe({ onReady }: { onReady?: (t: ReturnType<typeof useLongTask>) => void }) {
  const task = useLongTask()
  onReady?.(task)
  return (
    <div>
      <LongTaskProgress pct={task.pct} msg={task.msg} error={task.error} />
    </div>
  )
}

describe('useLongTask 状态机（F048）', () => {
  it('start → 进入运行态并显示阶段文案', () => {
    let t!: ReturnType<typeof useLongTask>
    const el = render(<Probe onReady={(x) => (t = x)} />)
    act(() => t.start('正在解包 ZIP…'))
    expect(el.textContent).toContain('正在解包 ZIP…')
    expect(t.running).toBe(true)
    expect(t.pct).toBeGreaterThan(0)
  })

  it('step → 更新进度与阶段', () => {
    let t!: ReturnType<typeof useLongTask>
    const el = render(<Probe onReady={(x) => (t = x)} />)
    act(() => t.start('读取中'))
    act(() => t.step(45, '正在写入配置…'))
    expect(t.pct).toBe(45)
    expect(el.textContent).toContain('正在写入配置…')
  })

  it('finish → 100% 且退出运行态', () => {
    let t!: ReturnType<typeof useLongTask>
    render(<Probe onReady={(x) => (t = x)} />)
    act(() => t.start())
    act(() => t.finish('导入完成'))
    expect(t.pct).toBe(100)
    expect(t.running).toBe(false)
    expect(t.error).toBe('')
  })

  it('fail → 记录错误并退出运行态', () => {
    let t!: ReturnType<typeof useLongTask>
    const el = render(<Probe onReady={(x) => (t = x)} />)
    act(() => t.start())
    act(() => t.fail('导入失败：磁盘满'))
    expect(t.error).toContain('磁盘满')
    expect(t.running).toBe(false)
    // 错误态优先展示错误文案
    expect(el.textContent).toContain('磁盘满')
  })

  it('reset → 回到初始态', () => {
    let t!: ReturnType<typeof useLongTask>
    render(<Probe onReady={(x) => (t = x)} />)
    act(() => t.start())
    act(() => t.reset())
    expect(t.pct).toBe(0)
    expect(t.msg).toBe('')
    expect(t.running).toBe(false)
  })

  it('平滑推进：定时器让进度在无新step 时也缓慢前进（给出「仍在进行」感知）', () => {
    vi.useFakeTimers()
    let t!: ReturnType<typeof useLongTask>
    render(<Probe onReady={(x) => (t = x)} />)
    act(() => t.start('处理中'))
    const p0 = t.pct
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(t.pct, '无新 step 时进度也应缓动前进').toBeGreaterThan(p0)
  })

  it('卸载时清理定时器（不对已卸载组件 setState）', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let t!: ReturnType<typeof useLongTask>
    const el = render(<Probe onReady={(x) => (t = x)} />)
    act(() => t.start())
    // 卸载后再推进定时器，不应产生 React 警告
    act(() => {
      root!.unmount()
    })
    root = null
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    const reactWarn = spy.mock.calls.some((c) => String(c[0]).includes('unmounted'))
    expect(reactWarn, '卸载后不应有 setState 警告').toBe(false)
    spy.mockRestore()
    el.remove()
    container = null
  })
})

describe('LongTaskProgress 展示（F048）', () => {
  it('无文案无错误时不渲染（不占位）', () => {
    const el = render(<LongTaskProgress pct={0} msg="" error="" />)
    expect(el.querySelector('.app-long-task')).toBeNull()
  })

  it('渲染进度条并带 progressbar 语义（读屏可读百分比）', () => {
    const el = render(<LongTaskProgress pct={42} msg="正在导入…" error="" />)
    const bar = el.querySelector('[role="progressbar"]')
    expect(bar).toBeTruthy()
    expect(bar?.getAttribute('aria-valuenow')).toBe('42')
    expect(el.textContent).toContain('正在导入…')
  })

  it('错误态加 is-error 类并显示错误文案', () => {
    const el = render(<LongTaskProgress pct={30} msg="导入中" error="解析失败" />)
    expect(el.querySelector('.app-long-task.is-error')).toBeTruthy()
    expect(el.textContent).toContain('解析失败')
    // 错误优先：不显示原阶段文案
    expect(el.textContent).not.toContain('导入中')
  })

  it('百分比超界被夹到 0-100', () => {
    const el = render(<LongTaskProgress pct={150} msg="x" error="" />)
    const bar = el.querySelector('[role="progressbar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('100')
  })
})
