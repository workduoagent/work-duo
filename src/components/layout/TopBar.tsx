import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Boxes,
  Coffee,
  Bot,
  Users,
  Settings,
  Sparkles,
  Plug,
  Wand2,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import { WindowControls } from './WindowControls'
import { ThemeToggle } from './ThemeToggle'
import { isTauri } from '@/core/config'
import { ROUTES } from '@/core/router/paths'

/** 二级菜单单项动画时长 / 逐项出场间隔（出场从左往右、收起从右往左依次错开） */
const CHILD_ANIM_MS = 500
const CHILD_STAGGER_MS = 80
/** 收起动画总时长（单项时长 + 最大逐项延迟 + 缓冲），到期后从 DOM 移除 */
const CHILD_EXIT_MS = CHILD_ANIM_MS + CHILD_STAGGER_MS * 3 + 150
/** 钻取切换期间逐帧测量滑块的窗口时长（布局动画期间滑块实时跟随） */
const TRACK_MS = 900

interface MenuNode {
  key: string
  label: string
  icon: LucideIcon
  /** 已建成页面的路由；缺省则点击仅高亮不跳转。 */
  path?: string
  /** 存在子项即为「父容器」，点击进入二级钻取而非跳转。 */
  children?: MenuNode[]
}

// 顶栏菜单树：一级菜单 + 二级子菜单。
// 百宝箱 / 设置 为父容器（含二级）；茶水间 / 搭子 / 小分队 为叶子菜单。
const MENUS: MenuNode[] = [
  {
    key: 'treasure',
    label: '百宝箱',
    icon: Boxes,
    children: [
      { key: 'llm', label: 'LLM', icon: Sparkles, path: ROUTES.modelSettings },
      { key: 'mcp', label: 'MCP', icon: Plug, path: ROUTES.mcpHub },
      { key: 'skill', label: 'Skill', icon: Wand2, path: ROUTES.skillHub },
      // 后续接入的服务继续在此追加子项即可
    ],
  },
  { key: 'tea', label: '茶水间', icon: Coffee },
  { key: 'buddy', label: '搭子', icon: Bot, path: ROUTES.agentStudio },
  { key: 'squads', label: '小分队', icon: Users, path: ROUTES.squadsWorkspace },
  {
    key: 'settings',
    label: '设置',
    icon: Settings,
    path: ROUTES.settings,
  },
]

// 子项 → 父项 key，用于「返回上级」时把高亮切回父容器。
const PARENT_OF: Record<string, string> = {}
MENUS.forEach((m) => (m.children ?? []).forEach((c) => (PARENT_OF[c.key] = m.key)))

function routeToTopKey(pathname: string): string | null {
  if (pathname.startsWith(ROUTES.modelSettings)) return 'treasure'
  if (pathname.startsWith(ROUTES.agentStudio)) return 'buddy'
  if (pathname.startsWith(ROUTES.squadsWorkspace)) return 'squads'
  return null
}

/** 滑块几何：x = 相对底槽 padding box 的左偏移，w = 选中项宽度。 */
interface ThumbRect {
  x: number
  w: number
}

/**
 * 自定义窗口头（decorations:false）。
 *  - 左侧：图片 Logo + 固定品牌名 + 版本号胶囊徽章
 *  - 中部：两级胶囊菜单（钻取动画：点击父容器 → 其余一级收起、被点项归位最左、
 *          左侧出现返回按钮、二级菜单从左往右依次铺开；返回时从右往左依次收起；
 *          二级过多时最右出现右移箭头）
 *  - 右侧：主题切换 + 分隔线 + 窗口控制三键
 *
 * 菜单使用纯 HTML 实现（不依赖任何 UI 库组件），避免内部样式与自定义胶囊层叠冲突。
 * 图标统一使用 lucide-react。
 */
export function TopBar() {
  const navigate = useNavigate()
  const location = useLocation()
  const [version, setVersion] = useState('0.0.1')
  const [drilledKey, setDrilledKey] = useState<string | null>(null)
  /** 正在播放「收起动画」的旧二级菜单，动画结束后从 DOM 移除。 */
  const [exiting, setExiting] = useState<MenuNode[] | null>(null)
  const [selected, setSelected] = useState<string>(
    () => routeToTopKey(location.pathname) ?? '',
  )
  /** 布局动画进行中：滑块逐帧跟随，关闭 transform 过渡避免拖影。 */
  const [tracking, setTracking] = useState(false)

  // drilledKey 的同步 ref：路由副作用里读取最新值而不重新触发自身。
  const drilledKeyRef = useRef<string | null>(drilledKey)
  useEffect(() => {
    drilledKeyRef.current = drilledKey
  }, [drilledKey])

  const exitTimer = useRef<number>(0)

  /** 让指定父级的二级菜单播放「从右往左依次收起」动画，结束后从 DOM 移除。 */
  const scheduleDismiss = useCallback((fromKey: string | null) => {
    if (!fromKey) return
    const children = MENUS.find((m) => m.key === fromKey)?.children
    if (!children?.length) return
    setExiting(children)
    window.clearTimeout(exitTimer.current)
    exitTimer.current = window.setTimeout(() => setExiting(null), CHILD_EXIT_MS)
  }, [])

  useEffect(() => () => window.clearTimeout(exitTimer.current), [])

  // 路由变化时同步高亮（例如从其他入口进入 model-settings）。
  // 点击二级菜单跳转时保持钻取态，只移动高亮；切到其他模块则收起钻取。
  useEffect(() => {
    const top = routeToTopKey(location.pathname)
    if (!top) return
    const current = drilledKeyRef.current
    if (current === top) {
      const child = MENUS.find((m) => m.key === top)
        ?.children?.find((c) => c.path && location.pathname.startsWith(c.path))
      setSelected(child?.key ?? top)
      return
    }
    if (current) {
      scheduleDismiss(current)
      setDrilledKey(null)
    }
    setSelected(top)
  }, [location.pathname, scheduleDismiss])

  const handleSelect = (node: MenuNode) => {
    const isChild = PARENT_OF[node.key] !== undefined

    // 父容器
    if (node.children?.length) {
      // 钻取态下点击当前锚定的一级菜单：不响应（返回上级只走左侧返回按钮）
      if (drilledKey === node.key) return
      // 切换钻取目标：旧二级菜单先播放收起动画
      if (drilledKey) scheduleDismiss(drilledKey)
      setDrilledKey(node.key)
      setSelected(node.key)
      return
    }

    // 二级项：仅高亮与跳转，保持钻取态（不自动返回上级）
    if (isChild) {
      if (node.path) navigate(node.path)
      setSelected(node.key)
      return
    }

    // 一级叶子：跳转并收起钻取
    if (node.path) navigate(node.path)
    if (drilledKey) {
      scheduleDismiss(drilledKey)
      setDrilledKey(null)
    }
    setSelected(node.key)
  }

  const handleBack = () => {
    if (!drilledKey) return
    scheduleDismiss(drilledKey)
    setDrilledKey(null)
    setSelected((prev) => PARENT_OF[prev] ?? prev)
  }

  const drilledNode = MENUS.find((m) => m.key === drilledKey) ?? null
  /** 钻取态或收起动画播放中：返回按钮可见（收起动画期间淡出且不可点）。 */
  const showBack = drilledKey !== null || exiting !== null

  const listRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<ThumbRect>({ x: 0, w: 0 })
  const [ready, setReady] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const measure = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const item = list.querySelector<HTMLElement>(`[data-nav-value="${selected}"]`)
    if (!item) return

    const listBox = list.getBoundingClientRect()
    const itemBox = item.getBoundingClientRect()
    const x = itemBox.left - listBox.left - list.clientLeft + list.scrollLeft

    setThumb((prev) =>
      Math.abs(prev.x - x) < 0.5 && Math.abs(prev.w - itemBox.width) < 0.5
        ? prev
        : { x, w: itemBox.width },
    )
  }, [selected])

  // 钻取切换期间逐帧测量，滑块实时跟随布局动画（收起/铺开）。
  useEffect(() => {
    if (drilledKey === null && exiting === null) return
    setTracking(true)
    const start = performance.now()
    let raf = 0
    const tick = () => {
      measure()
      if (performance.now() - start < TRACK_MS) {
        raf = requestAnimationFrame(tick)
      } else {
        setTracking(false)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      setTracking(false)
    }
  }, [drilledKey, exiting, measure])

  // 二级菜单溢出时才显示右移箭头
  const updateScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    setCanScrollRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1)
  }, [])

  const scrollRight = () => {
    listRef.current?.scrollBy({ left: 180, behavior: 'smooth' })
  }

  useLayoutEffect(() => {
    measure()
    // 钻取切换后布局需一帧才稳定，补一次测量
    const raf = requestAnimationFrame(() => measure())
    return () => cancelAnimationFrame(raf)
  }, [measure, drilledKey])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const ro = new ResizeObserver(() => {
      measure()
      updateScroll()
    })
    ro.observe(list)
    list.addEventListener('scroll', updateScroll)
    return () => {
      ro.disconnect()
      list.removeEventListener('scroll', updateScroll)
    }
  }, [measure, updateScroll])

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

      {/* 中部：两级胶囊菜单（纯 HTML，无第三方组件依赖） */}
      <div className="app-topbar__nav no-drag-region">
        <nav
          className="app-nav-pills"
          data-mode={drilledKey || exiting ? 'drilled' : 'top'}
          data-ready={ready}
          data-tracking={tracking}
        >
          {/* 返回上级（钻取态显示；收起动画期间淡出且不可点，不随滚动移动） */}
          {showBack && (
            <button
              type="button"
              className="app-nav-pills__back"
              data-phase={drilledKey ? 'in' : 'out'}
              onClick={handleBack}
              aria-label="返回上级菜单"
              tabIndex={drilledKey ? 0 : -1}
            >
              <ChevronLeft className="app-nav-pills__icon" />
            </button>
          )}

          {/* 菜单轨道（钻取态可横向滚动） */}
          <div className="app-nav-pills__list" ref={listRef}>
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

            {/* 一级菜单 */}
            {MENUS.map((node) => (
              <span
                key={node.key}
                className="app-nav-pills__slot"
                data-collapsed={
                  drilledKey !== null && drilledKey !== node.key ? 'true' : 'false'
                }
              >
                <button
                  type="button"
                  data-nav-value={node.key}
                  className={`app-nav-pills__item${
                    selected === node.key ? ' app-nav-pills__item--active' : ''
                  }${node.children?.length ? ' app-nav-pills__item--parent' : ''}`}
                  onClick={() => handleSelect(node)}
                >
                  <node.icon className="app-nav-pills__icon" />
                  <span className="app-nav-pills__label">{node.label}</span>
                </button>
              </span>
            ))}

            {/* 二级菜单（钻取态渲染，从左往右依次铺开） */}
            {drilledNode?.children?.map((child, i) => (
              <button
                key={`in-${child.key}`}
                type="button"
                data-nav-value={child.key}
                data-phase="enter"
                style={{ animationDelay: `${i * CHILD_STAGGER_MS}ms` }}
                className={`app-nav-pills__item app-nav-pills__item--child${
                  selected === child.key ? ' app-nav-pills__item--active' : ''
                }`}
                onClick={() => handleSelect(child)}
              >
                <child.icon className="app-nav-pills__icon" />
                <span className="app-nav-pills__label">{child.label}</span>
              </button>
            ))}

            {/* 正在收起的旧二级菜单（从右往左依次收起，动画结束后移除） */}
            {exiting?.map((child, i) => (
              <button
                key={`out-${child.key}`}
                type="button"
                data-phase="exit"
                tabIndex={-1}
                aria-hidden="true"
                style={{
                  animationDelay: `${(exiting.length - 1 - i) * CHILD_STAGGER_MS}ms`,
                }}
                className="app-nav-pills__item app-nav-pills__item--child"
              >
                <child.icon className="app-nav-pills__icon" />
                <span className="app-nav-pills__label">{child.label}</span>
              </button>
            ))}
          </div>

          {/* 右移箭头（仅钻取态且溢出时显示） */}
          {drilledKey && canScrollRight && (
            <button
              type="button"
              className="app-nav-pills__scroll"
              onClick={scrollRight}
              aria-label="显示更多菜单"
            >
              <ChevronRight className="app-nav-pills__icon" />
            </button>
          )}
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
