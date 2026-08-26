import { Outlet, useLocation } from 'react-router-dom'
import { TopBar } from './TopBar'

export function AppLayout() {
  const { pathname } = useLocation()

  return (
    <div className="app-shell">
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
