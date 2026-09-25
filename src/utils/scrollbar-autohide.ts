/**
 * 全局滚动条自动隐藏。
 *
 * 仅给「正在滚动」的元素临时加 `.wd-scrolling`：
 * - CSS 据此显示滚动条（配合 `:hover` 实现「悬浮/滚动时出现，失焦隐藏」）。
 * - 停止滚动约 0.8s 后移除，不活跃的滚动条回归隐藏。
 *
 * 必须在应用启动时调用一次（见 main.tsx）。
 */
// 台账 S5：挂 globalThis 跨 HMR 存活（热更后丢状态仅影响滚动条瞬态，低危但同款治理）。
interface ScrollbarState {
  timer: ReturnType<typeof setTimeout> | undefined
  activeEl: HTMLElement | null
}
const st = ((globalThis as { __wdScrollbar?: ScrollbarState }).__wdScrollbar ??= {
  timer: undefined,
  activeEl: null,
})

export function initScrollbarAutoHide(): void {
  const onScroll = (e: Event) => {
    const el = e.target as HTMLElement | null
    if (!el || !el.classList) return

    // 切换到另一个滚动容器时，先清掉旧容器的状态
    if (st.activeEl && st.activeEl !== el) {
      st.activeEl.classList.remove('wd-scrolling')
    }
    st.activeEl = el
    el.classList.add('wd-scrolling')

    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => {
      el.classList.remove('wd-scrolling')
      if (st.activeEl === el) st.activeEl = null
    }, 800)
  }

  // capture 阶段监听，确保任意内层滚动容器都能被捕获
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
}
