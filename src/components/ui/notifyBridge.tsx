import { useEffect } from 'react'
import { useNotify } from './notify'

type NotifyApi = ReturnType<typeof useNotify>

/**
 * 通知桥：把 antd `App.useApp()` 的通知实例暴露给**模块级代码**使用。
 *
 * 为什么需要：全局事件桥 / 终态落库等逻辑跑在 React 组件之外（不随页面挂载），
 * 但要给用户弹提醒（如「切到别的页面时任务跑完了」）。实例必须由常驻组件注册，
 * 因此 <NotifyBridge/> 挂在不随路由卸载的 AppLayout 上。
 */
let api: NotifyApi | null = null

export function setNotifyApi(next: NotifyApi | null) {
  api = next
}

/** 取通知实例；组件未挂载（极早期）时为 null，调用方应判空后跳过。 */
export function getNotifyApi(): NotifyApi | null {
  return api
}

export function NotifyBridge() {
  const n = useNotify()
  useEffect(() => {
    setNotifyApi(n)
    return () => setNotifyApi(null)
  }, [n])
  return null
}
