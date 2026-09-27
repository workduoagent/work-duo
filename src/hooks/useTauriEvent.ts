import { useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * Subscribe to an event pushed from the Rust side (MCP heartbeat, scan
 * progress, ...). The handler is held in a ref so the listener is not torn
 * down and rebuilt on every render.
 *
 * 台账 S12 ③：组件内事件订阅的**统一入口**——effect 里手写
 * `listen + alive/cancelled/off` 清理习语一律收编至此；按运行期命令式订阅
 * （如 squads 对话框随 run 注册、完成即退订）不适用本 hook，保留 unlistenRef 模式。
 * `enabled=false` 时不订阅（用于随弹窗开关启停的订阅）；在途注册遇到关闭/卸载
 * 会立即取消——修复「关闭后才 resolve 并把监听挂回去」的泄漏。
 */
export function useTauriEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
  enabled = true,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!enabled) return
    let unlisten: UnlistenFn | undefined
    let cancelled = false

    listen<T>(event, (e) => handlerRef.current(e.payload))
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => {
        /* listener registration failed (e.g. not running inside Tauri) */
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [event, enabled])
}
