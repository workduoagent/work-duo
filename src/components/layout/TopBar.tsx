import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Navigation,
  NavigationList,
  NavigationItem,
  NavigationLink,
} from '@appica/ui-react/navigation'
import {
  DashboardIcon,
  ModelIcon,
  KnowledgeIcon,
  AgentIcon,
  SquadsIcon,
  type IconProps,
} from '@/components/ui/icons'
import { ROUTES } from '@/core/router/paths'
import { WindowControls } from './WindowControls'
import { ThemeToggle } from './ThemeToggle'
import { isTauri } from '@/core/config'

interface NavEntry {
  value: string
  label: string
  to: string
  Icon: React.ComponentType<IconProps>
}

// 原侧栏菜单迁移到顶栏中部，作为横向「灵动岛」导航
const NAV: NavEntry[] = [
  { value: 'dashboard', label: '首页大盘', to: ROUTES.dashboard, Icon: DashboardIcon },
  { value: 'model-settings', label: '模型配置', to: ROUTES.modelSettings, Icon: ModelIcon },
  { value: 'knowledge', label: '知识库', to: ROUTES.knowledge, Icon: KnowledgeIcon },
  { value: 'agent-studio', label: '智能体工作坊', to: ROUTES.agentStudio, Icon: AgentIcon },
  { value: 'squads-workspace', label: '协作车间', to: ROUTES.squadsWorkspace, Icon: SquadsIcon },
]

/**
 * 自定义窗口头（decorations:false）。
 * 视觉对齐 we-create-calculation-board 的 .custom-header / .brand-section：
 *  - 左侧：图片 Logo + 固定品牌名 + 版本号胶囊徽章
 *  - 中部：横向导航菜单（原侧栏菜单已迁移至此）
 *  - 右侧：日/月切换开关 + 分隔线 + 窗口控制三键
 * 整条 Header 可拖拽（data-tauri-drag-region），内部交互区单独禁拖。
 */
export function TopBar() {
  const { pathname } = useLocation()
  const [version, setVersion] = useState('0.0.1')

  // 当前路由 → 高亮项；根路径映射到 dashboard
  const active = pathname === '/' ? 'dashboard' : pathname.split('/')[1] ?? 'dashboard'

  // 版本号来自 @tauri-apps/api/app 的 getVersion（已装，无需新增依赖）。
  // Web 开发环境无 Tauri 运行时，动态 import + catch 兜底，避免控制台报错。
  useEffect(() => {
    if (!isTauri) return
    let alive = true
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => {
        if (alive) setVersion(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  return (
    <header className="app-topbar" data-tauri-drag-region>
      {/* 左侧：品牌区（Logo + 固定品牌名 + 版本徽章） */}
      <div className="app-topbar__brand no-drag-region">
        <img src="/tauri.svg" alt="Work Duo" className="app-brand-logo" />
        <span className="app-topbar__brand-name">Work Duo</span>
        <div className="app-version-tag" title="当前版本">
          <span className="app-version-tag__text">v{version}</span>
        </div>
      </div>

      {/* 中部：横向导航菜单（原侧栏菜单，禁止拖拽） */}
      <nav className="app-topbar__nav no-drag-region" aria-label="主导航">
        <Navigation orientation="horizontal" variant="pill" activeLink={active} size="md">
          <NavigationList>
            {NAV.map(({ value, label, to, Icon }) => (
              <NavigationItem key={value}>
                <NavigationLink value={value} render={<Link to={to} />} className="w-full">
                  <Icon data-icon="start" />
                  {label}
                </NavigationLink>
              </NavigationItem>
            ))}
          </NavigationList>
        </Navigation>
      </nav>

      {/* 右侧：主题切换 + 窗口控制（禁止拖拽） */}
      <div className="app-topbar__actions no-drag-region">
        <ThemeToggle />
        <span className="app-topbar__divider" />
        <WindowControls />
      </div>
    </header>
  )
}
