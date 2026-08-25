import type { ComponentType } from 'react'
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

interface NavEntry {
  value: string
  label: string
  to: string
  Icon: ComponentType<IconProps>
}

const NAV: NavEntry[] = [
  { value: 'dashboard', label: '首页大盘', to: ROUTES.dashboard, Icon: DashboardIcon },
  { value: 'model-settings', label: '模型配置', to: ROUTES.modelSettings, Icon: ModelIcon },
  { value: 'knowledge', label: '知识库', to: ROUTES.knowledge, Icon: KnowledgeIcon },
  { value: 'agent-studio', label: '智能体工作坊', to: ROUTES.agentStudio, Icon: AgentIcon },
  { value: 'squads-workspace', label: '协作车间', to: ROUTES.squadsWorkspace, Icon: SquadsIcon },
]

export function Sidebar() {
  const { pathname } = useLocation()
  const active = pathname === '/' ? 'dashboard' : pathname.split('/')[1] ?? 'dashboard'

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-border-muted border-r bg-background-subtle p-3 md:flex">
      <div className="flex items-center gap-2 px-2 py-3">
        <div className="grid size-8 place-items-center rounded-lg bg-primary font-bold text-primary-foreground">
          W
        </div>
        <span className="text-lg font-semibold text-foreground-intense">Work Duo</span>
      </div>
      <Navigation
        aria-label="主导航"
        orientation="vertical"
        variant="pill"
        activeLink={active}
        className="mt-2 flex-1"
      >
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
    </aside>
  )
}
