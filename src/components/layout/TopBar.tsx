import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  ApiOutlined,
  NodeIndexOutlined,
  ToolOutlined,
  RobotOutlined,
  TeamOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { WindowControls } from './WindowControls'
import { ThemeToggle } from './ThemeToggle'
import { isTauri } from '@/core/config'

interface NavEntry {
  value: string
  label: string
  Icon: typeof ApiOutlined
}

// 顶栏中部横向菜单：全部一级菜单，一个菜单一个页面，图标 + 文字，胶囊风格。
// 点击切换驱动底槽内的品牌蓝滑块位移，暂不接路由跳转。
const NAV: NavEntry[] = [
  { value: 'llm', label: 'LLM', Icon: ApiOutlined },
  { value: 'mcp', label: 'MCP', Icon: NodeIndexOutlined },
  { value: 'skill', label: 'Skill', Icon: ToolOutlined },
  { value: 'agent', label: '智能体', Icon: RobotOutlined },
  { value: 'squads', label: '小分队', Icon: TeamOutlined },
  { value: 'settings', label: '设置', Icon: SettingOutlined },
]

/** 滑块几何：x = 相对底槽 padding box 的左偏移，w = 选中项宽度。 */
interface ThumbRect {
  x: number
  w: number
}

/**
 * 自定义窗口头（decorations:false）。
 *  - 左侧：图片 Logo + 固定品牌名 + 版本号胶囊徽章
 *  - 中部：胶囊菜单（底槽 + 品牌蓝滑块，切换有滑动动画）
 *  - 右侧：主题切换 + 分隔线 + 窗口控制三键
 *
 * 菜单使用纯 HTML 实现（不依赖 Appica Navigation 组件），避免组件内部样式
 * 与自定义胶囊样式的层叠冲突。
 */
export function TopBar() {
  const [version, setVersion] = useState('0.0.1')
  const [active, setActive] = useState('llm')

  const trackRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<ThumbRect>({ x: 0, w: 0 })
  const [ready, setReady] = useState(false)

  const measure = useCallback(() => {
    const track = trackRef.current
    if (!track) return
    const item = track.querySelector<HTMLElement>(
      `[data-nav-value="${active}"]`,
    )
    if (!item) return

    const trackBox = track.getBoundingClientRect()
    const itemBox = item.getBoundingClientRect()
    const x =
      itemBox.left -
      trackBox.left -
      track.clientLeft +
      track.scrollLeft

    setThumb((prev) =>
      Math.abs(prev.x - x) < 0.5 && Math.abs(prev.w - itemBox.width) < 0.5
        ? prev
        : { x, w: itemBox.width },
    )
  }, [active])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(track)
    return () => ro.disconnect()
  }, [measure])

  useEffect(() => {
    let alive = true
    document.fonts?.ready
      .then(() => {
        if (alive) measure()
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [measure])

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(raf)
  }, [])

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
      {/* 左侧：品牌区 */}
      <div className="app-topbar__brand no-drag-region">
        <img src="/tauri.svg" alt="Work Duo" className="app-brand-logo" />
        <span className="app-topbar__brand-name">Work Duo</span>
        <div className="app-version-tag" title="当前版本">
          <span className="app-version-tag__text">v{version}</span>
        </div>
      </div>

      {/* 中部：胶囊菜单（纯 HTML，无第三方组件依赖） */}
      <div className="app-topbar__nav no-drag-region">
        <nav className="app-nav-pills" ref={trackRef} data-ready={ready}>
          {/* 滑块 */}
          <span
            className="app-nav-pills__thumb"
            style={
              {
                '--pill-x': `${thumb.x}px`,
                '--pill-w': `${thumb.w}px`,
              } as CSSProperties
            }
            aria-hidden="true"
          />
          {/* 菜单项 */}
          <div className="app-nav-pills__list">
            {NAV.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                data-nav-value={value}
                className={`app-nav-pills__item${
                  active === value ? ' app-nav-pills__item--active' : ''
                }`}
                onClick={() => setActive(value)}
              >
                <Icon className="app-nav-pills__icon" />
                <span className="app-nav-pills__label">{label}</span>
              </button>
            ))}
          </div>
        </nav>
      </div>

      {/* 右侧 */}
      <div className="app-topbar__actions no-drag-region">
        <ThemeToggle />
        <span className="app-topbar__divider" />
        <WindowControls />
      </div>
    </header>
  )
}
