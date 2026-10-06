import {useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType} from 'react'
import {useLocation, useNavigate} from 'react-router-dom'
import {
    Boxes,
    BookOpen,
    Bot,
    Users,
    Settings,
    Sparkles,
    Plug,
    Wand2,
    Puzzle,
    Server,
    ChevronDown,
    Home,
} from 'lucide-react'
import {WindowControls} from './WindowControls'
import {ThemeToggle} from './ThemeToggle'
import {isTauri} from '@/core/config'
import {ROUTES} from '@/core/router/paths'

interface MenuNode {
    key: string
    label: string
    icon: ComponentType<{className?: string}>
    /** 已建成页面的路由；缺省则点击仅高亮不跳转。 */
    path?: string
    /** 存在子项即为「分组」，点击展开下拉而非跳转。 */
    children?: MenuNode[]
}

// 顶栏菜单树：百宝箱为分组（含 LLM / MCP / Skill 下拉）；其余为一级叶子。
// F042：补「首页」项——此前 ROUTES.dashboard虽已注册（index route），但菜单里
// 没有入口，用户只能手输 hash 才能回首页。
const MENUS: MenuNode[] = [
    {key: 'home', label: '首页', icon: Home, path: ROUTES.dashboard},
    {
        key: 'treasure',
        label: '百宝箱',
        icon: Boxes,
        children: [
            {key: 'llm', label: 'LLM', icon: Sparkles, path: ROUTES.modelSettings},
            {key: 'mcp', label: 'MCP', icon: Plug, path: ROUTES.mcpHub},
            {key: 'skill', label: 'Skill', icon: Wand2, path: ROUTES.skillHub},
            {key: 'plugin', label: '插件', icon: Puzzle, path: ROUTES.pluginHub},
            {key: 'server', label: '服务器', icon: Server, path: ROUTES.serverHub},
        ],
    },
    {key: 'kb', label: '知识库', icon: BookOpen, path: ROUTES.knowledge},
    {key: 'agent', label: '智能体', icon: Bot, path: ROUTES.agentStudio},
    {key: 'squads', label: '小分队', icon: Users, path: ROUTES.squadsWorkspace},
    {key: 'settings', label: '设置', icon: Settings, path: ROUTES.settings},
]

// 子项 → 父项 key，用于子项页高亮时滑块回退到父容器。
const PARENT_OF: Record<string, string> = {}
MENUS.forEach((m) => (m.children ?? []).forEach((c) => (PARENT_OF[c.key] = m.key)))

/**
 * 路由 → 顶栏选中项。
 *
 * F047：原先是逐条 `if (pathname.startsWith(...))` 且**只覆盖 4 条路由**，
 * 导致 `/knowledge` / `/skill-hub` / `/mcp-hub` / `/plugin-hub` / `/server-hub` /
 * `/settings` 等 8 条已注册路由进页面后**选中胶囊消失**（`useEffect` 里
 * `if (!top) return` 直接跳过），用户看不出自己在哪一页。
 *
 * 现改为**数据驱动**：从 MENUS 反查（叶子按 path、子项按父容器回退），
 * 新增菜单项只需改MENUS 一处，不必再维护这份映射。
 *
 * 注意 `/` 是首页且是所有路径的前缀，必须**精确相等**而非 startsWith，
 * 否则任何子页面都会被判为「首页选中」。
 */
function routeToTopKey(pathname: string): string | null {
    // 首页：精确匹配（`/` 是所有路径的前缀，用 startsWith 会全盘误判）
    if (pathname === ROUTES.dashboard) return 'home'

    // 叶子菜单：path 前缀匹配（如 /knowledge/:id 仍归属「知识库」）
    for (const m of MENUS) {
        if (!m.children && m.path && pathname.startsWith(m.path)) return m.key
    }
    // 分组：任一子项的 path 命中即高亮该分组（原先这里只硬编码了百宝箱）
    for (const m of MENUS) {
        if (!m.children) continue
        for (const c of m.children) {
            if (c.path && pathname.startsWith(c.path)) return m.key
        }
    }
    // 沙箱页归属「设置」（无独立菜单项，与原行为一致）
    if (pathname.startsWith(ROUTES.sandboxPython) || pathname.startsWith(ROUTES.sandbox)) return 'settings'
    return null
}

/**
 * 自定义窗口头（decorations:false）。
 *  - 左侧：图片 Logo + 固定品牌名 + 版本号胶囊徽章
 *  - 中部：稳定一级标签栏（选中滑块令牌化、明暗可读；百宝箱用下拉而非原地钻取变形）
 *  - 右侧：主题切换 + 分隔线 + 窗口控制三键
 * 菜单使用纯 HTML 实现（不依赖任何 UI 库组件），避免内部样式与自定义胶囊层叠冲突。
 */
export function TopBar() {
    const navigate = useNavigate()
    const location = useLocation()
    const [version, setVersion] = useState('0.0.1')
    const [selected, setSelected] = useState<string>(
        () => routeToTopKey(location.pathname) ?? '',
    )
    /** 当前展开的下拉分组 key（仅百宝箱）；null 表示无下拉。 */
    const [openKey, setOpenKey] = useState<string | null>(null)
    const [ready, setReady] = useState(false)

    const listRef = useRef<HTMLDivElement>(null)
    const thumbRef = useRef<HTMLSpanElement>(null)
    const groupRef = useRef<HTMLDivElement>(null)

    // 直写滑块的 CSS 变量（--pill-x / --pill-w）。仅在选中变化 / 字体加载 / 容器尺寸变化时
    // 测量一次（单次 rAF），不再钻取期逐帧跟踪——选中项稳定，CSS transition 负责平滑过渡。
    const measure = useCallback(() => {
        const list = listRef.current
        const thumbEl = thumbRef.current
        if (!list || !thumbEl) return
        let el = list.querySelector<HTMLElement>(`[data-nav-value="${selected}"]`)
        // 子项页：选中项位于下拉内，回退到父容器项定位滑块。
        if (!el) {
            const p = PARENT_OF[selected]
            if (p) el = list.querySelector<HTMLElement>(`[data-nav-value="${p}"]`)
        }
        if (!el) return
        const listBox = list.getBoundingClientRect()
        const itemBox = el.getBoundingClientRect()
        // 滑块相对 item 包围盒内缩 INSET，使选中底片四周留呼吸感；
        // 否则首个/末个菜单项选中时蓝底会直接贴到胶囊内边框（视觉拥挤）。
        const INSET = 3
        const x = itemBox.left - listBox.left - list.clientLeft + list.scrollLeft + INSET
        thumbEl.style.setProperty('--pill-x', `${x}px`)
        thumbEl.style.setProperty('--pill-w', `${Math.max(0, itemBox.width - INSET * 2)}px`)
    }, [selected])

    // 路由变化时同步高亮（例如从其他入口进入 model-settings）。
    useEffect(() => {
        const top = routeToTopKey(location.pathname)
        if (!top) return
        const child = MENUS.find((m) => m.key === top)
            ?.children?.find((c) => c.path && location.pathname.startsWith(c.path))
        setSelected(child?.key ?? top)
    }, [location.pathname])

    // 选中变化后补一次测量（字体/布局稳定）。
    useLayoutEffect(() => {
        measure()
        const raf = requestAnimationFrame(() => measure())
        return () => cancelAnimationFrame(raf)
    }, [measure])

    // 容器尺寸变化 / 字体就绪时重测滑块位置。
    useEffect(() => {
        const list = listRef.current
        if (!list) return
        const ro = new ResizeObserver(() => measure())
        ro.observe(list)
        return () => ro.disconnect()
    }, [measure])

    useEffect(() => {
        let alive = true
        document.fonts?.ready
            .then(() => {
                if (alive) measure()
            })
            .catch(() => {
            })
        return () => {
            alive = false
        }
    }, [measure])

    useEffect(() => {
        const raf = requestAnimationFrame(() => setReady(true))
        return () => cancelAnimationFrame(raf)
    }, [])

    // 点击分组外部关闭下拉。
    useEffect(() => {
        if (!openKey) return
        const onDown = (e: MouseEvent) => {
            if (groupRef.current && !groupRef.current.contains(e.target as Node)) {
                setOpenKey(null)
            }
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
    }, [openKey])

    useEffect(() => {
        if (!isTauri) return
        let alive = true
        import('@tauri-apps/api/app')
            .then(({getVersion}) => getVersion())
            .then((v) => {
                if (alive) setVersion(v)
            })
            .catch(() => {
            })
        return () => {
            alive = false
        }
    }, [])

    const handleSelect = (node: MenuNode) => {
        // 分组：切换下拉展开，不跳转。
        if (node.children?.length) {
            setOpenKey((prev) => (prev === node.key ? null : node.key))
            setSelected(node.key)
            return
        }
        // 叶子：跳转并关闭下拉。
        if (node.path) navigate(node.path)
        setSelected(node.key)
        setOpenKey(null)
    }

    const handleChild = (child: MenuNode) => {
        if (child.path) navigate(child.path)
        setSelected(child.key)
        setOpenKey(null)
    }

    return (
        <header className="app-topbar" data-tauri-drag-region>
            {/* 左侧：品牌区 */}
            <div className="app-topbar__brand no-drag-region">
                <img src="/app.png" alt="Work Duo" className="app-brand-logo"/>
                <span className="app-topbar__brand-name">Work Duo</span>
                <div className="app-version-tag" title="当前版本">
                    <span className="app-version-tag__text">v{version}</span>
                </div>
            </div>

            {/* 中部：稳定一级标签栏（纯 HTML，无第三方组件依赖） */}
            <div className="app-topbar__nav no-drag-region">
                <nav
                    className="app-nav-pills"
                    data-ready={ready}
                    data-open={openKey !== null}
                >
                    <div className="app-nav-pills__list" ref={listRef}>
                        {/* 滑块（几何由 measure() 直写 CSS 变量驱动） */}
                        <span className="app-nav-pills__thumb" ref={thumbRef} aria-hidden="true"/>

                        {MENUS.map((node) =>
                            node.children?.length ? (
                                <div
                                    key={node.key}
                                    className="app-nav-pills__group"
                                    ref={node.key === 'treasure' ? groupRef : undefined}
                                >
                                    <button
                                        type="button"
                                        data-nav-value={node.key}
                                        className={`app-nav-pills__item${
                                            selected === node.key || PARENT_OF[selected] === node.key
                                                ? ' app-nav-pills__item--active'
                                                : ''
                                        }${openKey === node.key ? ' app-nav-pills__item--open' : ''}`}
                                        onClick={() => handleSelect(node)}
                                        aria-haspopup="true"
                                        aria-expanded={openKey === node.key}
                                    >
                                        <node.icon className="app-nav-pills__icon"/>
                                        <span className="app-nav-pills__label">{node.label}</span>
                                        <ChevronDown className="app-nav-pills__caret"/>
                                    </button>

                                    {openKey === node.key && (
                                        <div className="app-nav-pills__pop" role="menu">
                                            {node.children.map((c) => (
                                                <button
                                                    key={c.key}
                                                    type="button"
                                                    role="menuitem"
                                                    className={`app-nav-pills__pop-item${
                                                        selected === c.key ? ' app-nav-pills__pop-item--active' : ''
                                                    }`}
                                                    onClick={() => handleChild(c)}
                                                >
                                                    <c.icon className="app-nav-pills__icon"/>
                                                    <span className="app-nav-pills__label">{c.label}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <button
                                    key={node.key}
                                    type="button"
                                    data-nav-value={node.key}
                                    className={`app-nav-pills__item${
                                        selected === node.key ? ' app-nav-pills__item--active' : ''
                                    }`}
                                    onClick={() => handleSelect(node)}
                                >
                                    <node.icon className="app-nav-pills__icon"/>
                                    <span className="app-nav-pills__label">{node.label}</span>
                                </button>
                            ),
                        )}
                    </div>
                </nav>
            </div>

            {/* 右侧 */}
            <div className="app-topbar__actions no-drag-region">
                <ThemeToggle/>
                <span className="app-topbar__divider"/>
                <WindowControls/>
            </div>
        </header>
    )
}
