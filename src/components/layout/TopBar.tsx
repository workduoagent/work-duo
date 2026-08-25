import { useLocation } from 'react-router-dom'
import { Button } from '@appica/ui-react/button'
import { SunIcon, MoonIcon, MonitorIcon } from '@/components/ui/icons'
import { useTheme } from '@/hooks/useTheme'
import { WindowControls } from './WindowControls'
import type { ThemeMode } from '@/core/store/slices/themeSlice'

const TITLES: Record<string, string> = {
  '/': '首页大盘',
  '/model-settings': '模型配置',
  '/knowledge': '知识库',
  '/agent-studio': '智能体工作坊',
  '/squads-workspace': '协作车间',
}

const NEXT: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

function pageTitle(pathname: string): string {
  if (pathname.startsWith('/knowledge/')) return '知识库详情'
  return TITLES[pathname] ?? 'Work Duo'
}

export function TopBar() {
  const { pathname } = useLocation()
  const { theme, setTheme } = useTheme()

  const next = NEXT[theme]
  const Icon = theme === 'dark' ? SunIcon : theme === 'light' ? MoonIcon : MonitorIcon

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-border-muted border-b bg-background px-4">
      <h1 className="text-base font-semibold text-foreground-intense">{pageTitle(pathname)}</h1>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-md"
          aria-label="切换主题"
          onClick={() => setTheme(next)}
        >
          <Icon />
        </Button>
        <WindowControls />
      </div>
    </header>
  )
}
