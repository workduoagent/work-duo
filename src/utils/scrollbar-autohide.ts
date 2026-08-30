/**
 * 全局滚动条自动隐藏。
 *
 * 仅给「正在滚动」的元素临时加 `.wd-scrolling`：
 * - CSS 据此显示滚动条（配合 `:hover` 实现「悬浮/滚动时出现，失焦隐藏」）。
 * - 停止滚动约 0.8s 后移除，不活跃的滚动条回归隐藏。
 *
 * 必须在应用启动时调用一次（见 main.tsx）。
 */
let timer: ReturnType<typeof setTimeout> | undefined
let activeEl: HTMLElement | null = null

export function initScrollbarAutoHide(): void {
  const onScroll = (e: Event) => {
    const el = e.target as HTMLElement | null
    if (!el || !el.classList) return

    // 切换到另一个滚动容器时，先清掉旧容器的状态
    if (activeEl && activeEl !== el) {
      activeEl.classList.remove('wd-scrolling')
    }
    activeEl = el
    el.classList.add('wd-scrolling')

    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      el.classList.remove('wd-scrolling')
      if (activeEl === el) activeEl = null
    }, 800)
  }

  // capture 阶段监听，确保任意内层滚动容器都能被捕获
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
}
