import { Outlet, useLocation } from 'react-router-dom'
import { TopBar } from './TopBar'
import { NotifyBridge } from '@/components/ui/notifyBridge'

export function AppLayout() {
  const { pathname } = useLocation()

  return (
    <div className="app-shell">
      {/* 常驻：把 antd 通知实例暴露给模块级代码（全局事件桥在页面切走时也能弹提醒） */}
      <NotifyBridge />
      <TopBar />
      <main className="app-content">
        {/* key=pathname 触发 remount，配合 .page-transition 做路由淡入动画 */}
        <div key={pathname} className="page-transition">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
