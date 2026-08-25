import { useEffect, useRef } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * Subscribe to an event pushed from the Rust side (MCP heartbeat, scan
 * progress, ...). The handler is held in a ref so the listener is not torn
 * down and rebuilt on every render.
 */
export function useTauriEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
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
  }, [event])
}
