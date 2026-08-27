/**
 * 路由页面「设置」：一级菜单，点击直接跳转。
 * - 左侧栏：四个分区（系统设置 / 记忆存储 / 安全中心 / 关于我们）；
 * - 右侧主内容：当前分区对应的面板；
 * - 所有配置经 src/core/file/settings-file.ts 落库到 app_config 表。
 */
import { useCallback, useEffect, useState } from 'react'
import { SlidersHorizontal, Brain, ShieldCheck, Info } from 'lucide-react'
import { Spin } from 'antd'
import {
  loadSettings,
  saveSettings,
  type AppSettings,
} from '@/core/file/settings-file'
import { SystemSettingsPanel } from './components/SystemSettingsPanel'
import { MemoryPanel } from './components/MemoryPanel'
import { SecurityPanel } from './components/SecurityPanel'
import { AboutPanel } from './components/AboutPanel'
import './index.scss'

type SectionId = 'system' | 'memory' | 'security' | 'about'

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode }[] = [
  { id: 'system', label: '系统设置', icon: <SlidersHorizontal size={18} /> },
  { id: 'memory', label: '记忆存储', icon: <Brain size={18} /> },
  { id: 'security', label: '安全中心', icon: <ShieldCheck size={18} /> },
  { id: 'about', label: '关于我们', icon: <Info size={18} /> },
]

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [active, setActive] = useState<SectionId>('system')

  useEffect(() => {
    void loadSettings().then(setSettings)
  }, [])

  const commit = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      if (!prev) return prev
      const next = { ...prev, ...patch }
      void saveSettings(next)
      return next
    })
  }, [])

  if (!settings) {
    return (
      <div className="settings settings--loading">
        <Spin />
      </div>
    )
  }

  return (
    <div className="settings">
      <aside className="settings__sidebar">
        <div className="settings__sidebar-title">设置</div>
        <nav className="settings__nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings__nav-item${active === s.id ? ' is-active' : ''}`}
              onClick={() => setActive(s.id)}
              aria-current={active === s.id ? 'page' : undefined}
            >
              <span className="settings__nav-icon">{s.icon}</span>
              <span className="settings__nav-label">{s.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="settings__content">
        {active === 'system' && (
          <SystemSettingsPanel settings={settings} onChange={commit} />
        )}
        {active === 'memory' && <MemoryPanel settings={settings} onChange={commit} />}
        {active === 'security' && (
          <SecurityPanel settings={settings} onChange={commit} />
        )}
        {active === 'about' && <AboutPanel />}
      </main>
    </div>
  )
}
