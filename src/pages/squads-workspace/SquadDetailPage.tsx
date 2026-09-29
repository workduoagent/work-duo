import {memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject} from 'react'
import {useNavigate, useParams} from 'react-router-dom'
import {ArrowLeft, Brain, Plus, Send, Trash2} from 'lucide-react'
import {listen} from '@tauri-apps/api/event'
import {invoke} from '@tauri-apps/api/core'
import {Button, Empty, Input, Select, Spin} from '@/components/ui'
import {useNotify} from '@/components/ui/notify'
import {PixelAgent} from '@/components/ui/pixel-agent'
import {MarkdownRenderer} from '@/components/markdown/MarkdownRenderer'
import {getSquad, listSquadSessions, listSquadRounds, deleteSquadSession, listSquadMemories, anchorSquadMemory, deleteSquadMemory} from '@/core/mapper/squad-mapper'
import {listAgents} from '@/core/mapper/agent-mapper'
import type {AgentInfo, SquadInfo, SquadSession, SquadMemory, SquadMemoryCategory} from '@/types/core'
import {memberLabel, agentAppearanceOf, type BoardRound, type SquadBoardView} from './index'
// 舞台背景：等距像素风会议室（椅子已由像素小人站位表达，换图时同步核对 SEATS 坐标）
import ROOM_BG from '@/assets/images/squad-meeting-room.png'

const ACTIVE_STATUSES = ['running', 'paused', 'awaiting_checkpoint', 'awaiting_delivery']
const STATUS_PILL: Record<string, {label: string; cls: string}> = {
    running: {label: '运行中', cls: 'live'},
    paused: {label: '已暂停', cls: 'muted'},
    awaiting_checkpoint: {label: '⏸ 待决议', cls: 'await'},
    awaiting_delivery: {label: '📦 待确认交付', cls: 'await'},
    done: {label: '✓ 已完成', cls: 'done'},
    failed: {label: '✕ 失败', cls: 'fail'},
    cancelled: {label: '已取消', cls: 'muted'},
}
const MODE_META: Record<string, {ico: string; label: string; desc: string}> = {
    orchestrator: {ico: '', label: '编排式', desc: '主管委派'},
    pipeline: {ico: '', label: '流水线', desc: '线性接力'},
    chat: {ico: '', label: '群聊', desc: '圆桌发言'},
}
const ROUND_BADGE: Record<string, {label: string; cls: string}> = {
    system: {label: '系统', cls: 'sys'}, plan: {label: '委派规划', cls: 'plan'},
    subtask: {label: '发言', cls: 'msg'}, handoff: {label: '交接', cls: 'hand'},
    inject: {label: '插话', cls: 'inject'}, summary: {label: '汇总', cls: 'msg'},
    metrics: {label: '指标', cls: 'metrics'}, checkpoint: {label: '门禁', cls: 'gate'},
    delivery: {label: '交付', cls: 'gate'},
}
/**
 * 会议桌座位（舞台坐标百分比）：主位在桌前正中，其余沿长桌两侧围坐。
 * 顺序即优先级——成员按此顺序落座，人数不足时后面的座位空着（不画椅子）。
 */
/**
 * 会议桌座位（舞台坐标百分比）：主位在桌前正中，其余沿桌前沿一字排开。
 * 坐标与背景图 src/assets/images/squad-meeting-room.png（1920×600）对应，
 * 改图时需同步这套坐标（用图片百分比即可，舞台按 100%×100% 铺图，不裁切）。
 */
const SEATS: Array<{x: number; y: number}> = [
    // 坐标为「图片坐标系」百分比（squad-meeting-room.png 1920x600，3.2:1 与舞台同比例，
    // object-fit: fill 严格 1:1 铺满不裁切）。桌面 x≈18.5%~80.5%、y≈49%~77%。
    // 常规 1~6 号沿桌前沿一字排开（脚踩桌前沿外地面），7~10 人多时启用（后排/桌后沿）。
    {x: 47, y: 75.5},   // 桌前正中（主位）
    {x: 38.5, y: 75},   // 桌前左
    {x: 55.5, y: 75.8}, // 桌前右
    {x: 30, y: 74.5},   // 桌前左外
    {x: 63.5, y: 76},   // 桌前右外
    {x: 71.5, y: 76.2}, // 桌右前角
    {x: 26, y: 47},     // 桌后沿左（人多时启用）
    {x: 37, y: 46},     // 桌后沿中左（人多时启用）
    {x: 59, y: 46.5},   // 桌后沿中右（人多时启用）
    {x: 70, y: 47.5},   // 桌后沿右（人多时启用）
]
/** 座位角色标签（按协作模式）：与 SEATS 顺序一一对应 */
const SEAT_LABELS: Record<string, string[]> = {
    orchestrator: ['主管 · 调度', '执行 A', '执行 B', '执行 C', '执行 D', '支持', '支持', '旁听', '旁听', '旁听'],
    pipeline: ['工位 1', '工位 2', '工位 3', '工位 4', '工位 5', '记录', '记录', '旁听', '旁听', '旁听'],
    chat: ['发言', '倾听', '倾听', '思考', '思考', '旁听', '旁听', '旁听', '旁听', '旁听'],
}
/** 桌前那一排（气泡挂到小人下方，避免压住桌面）的判定阈值 */
const FRONT_ROW_Y = 70

/** 按模式与人数取落座表：第 1 位坐主位，其余沿桌两侧展开 */
function seatSpots(mode: string, n: number): Array<{x: number; y: number; role: string}> {
    const labels = SEAT_LABELS[mode] || SEAT_LABELS.orchestrator
    const count = Math.max(n, 1)
    return Array.from({length: count}, (_, i) => {
        const seat = SEATS[i % SEATS.length]
        return {x: seat.x, y: seat.y, role: labels[i % labels.length]}
    })
}

/** 轮次内容 → 纯文本摘要（舞台气泡只回显一句话，去掉 Markdown 记号与代码块） */
function plainText(src: string, max = 46): string {
    const t = (src || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
        .replace(/[#>*_`~|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 系统机器人像素（无角色的「系统」轮用它出镜：舞台上站在边上，时间线里当头像） */
function RobotPixel({size = 28}: {size?: number}) {
    const r = (x: number, y: number, w: number, h: number, fill: string, key: string) => (
        <rect key={key} x={x} y={y} width={w} height={h} fill={fill}/>
    )
    return (
        <svg className="sw-robot" width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
            {/* 天线 */}
            {r(7, 0, 1, 1, '#ef5350', 'a1')}{r(7, 1, 1, 1, '#90a4ae', 'a2')}
            {/* 头壳 + 屏幕脸 */}
            {r(4, 2, 8, 1, '#78909c', 'h1')}{r(3, 3, 10, 5, '#78909c', 'h2')}
            {r(4, 3, 8, 4, '#eceff1', 'f1')}
            {r(5, 4, 2, 2, '#0284c7', 'e1')}{r(9, 4, 2, 2, '#0284c7', 'e2')}
            {r(6, 6, 4, 1, '#90a4ae', 'm1')}
            {/* 耳侧 */}
            {r(2, 4, 1, 3, '#546e7a', 's1')}{r(13, 4, 1, 3, '#546e7a', 's2')}
            {/* 颈 + 身体 + 状态灯 */}
            {r(7, 8, 2, 1, '#607d8b', 'n1')}
            {r(4, 9, 8, 5, '#90a4ae', 'b1')}
            {r(5, 10, 6, 3, '#cfd8dc', 'b2')}
            {r(7, 11, 2, 1, '#4fc3f7', 'l1')}
            {/* 手臂 + 底座 */}
            {r(2, 9, 2, 4, '#78909c', 'r1')}{r(12, 9, 2, 4, '#78909c', 'r2')}
            {r(5, 14, 6, 1, '#607d8b', 'd1')}{r(4, 15, 8, 1, '#455a64', 'd2')}
        </svg>
    )
}

/** 轮次内容渲染：metrics/handoff/JSON → 代码块；其余 → Markdown。 */
function renderRoundContent(kind: string, text: string) {
    const t = normalizeMd(text).trim()
    if (kind === 'metrics' || kind === 'handoff' || (t.startsWith('{') && t.endsWith('}'))) {
        try { return <pre className="sw-code">{JSON.stringify(JSON.parse(t), null, 2)}</pre> } catch { /* 非 JSON 走 markdown */ }
    }
    return <MarkdownRenderer className="sw-md" content={t}/>
}

/** 结构化轮（代码块直显，不做打字机）。 */
function isStructuredRound(kind: string, text: string) {
    const t = (text || '').trim()
    return kind === 'metrics' || kind === 'handoff' || (t.startsWith('{') && t.endsWith('}'))
}

/**
 * LLM 输出的 Markdown 规范化：列表项之间的空行（loose list）会让渲染出 <li><p> 叠加结构、
 * 气泡松散；这里去列表项间空行、收敛连续空行，``` 代码块内原样保留。
 */
function normalizeMd(src: string): string {
    if (!src) return src
    const lines = src.replace(/\r\n/g, '\n').split('\n')
    const out: string[] = []
    let inFence = false
    let pendingBlank = 0
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+/
    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence
            for (let i = 0; i < pendingBlank; i++) out.push('')
            pendingBlank = 0
            out.push(line)
            continue
        }
        if (inFence) { out.push(line); continue }
        if (line.trim() === '') { pendingBlank = Math.min(pendingBlank + 1, 1); continue }
        if (bullet.test(line) && out.length > 0 && bullet.test(out[out.length - 1])) {
            pendingBlank = 0 // 列表项之间的空行：丢弃（loose list → tight list）
        }
        for (let i = 0; i < pendingBlank; i++) out.push('')
        pendingBlank = 0
        out.push(line)
    }
    for (let i = 0; i < pendingBlank; i++) out.push('')
    return out.join('\n').trim()
}

/**
 * 打字机流式气泡：仅对「运行中由事件实时推来的新轮」（fresh）做逐字输出，
 * 历史回放轮直接整段渲染。打字阶段即按 Markdown 实时渲染已输出部分（所见即所得，
 * 不会出现「打完闪变规范排列」），增长时经 onGrow 通知父级做贴底跟随。
 */
function TypewriterBubble({kind, text, fresh, onGrow}: {
    kind: string; text: string; fresh: boolean; onGrow?: () => void
}) {
    const t = normalizeMd((text || '')).trim()
    const total = t.length
    // fresh 快照进初始 state：打字只由「新轮首次挂载」触发一次，不随父级重渲染重启
    const [armed] = useState(fresh)
    const [shown, setShown] = useState(() => (fresh ? 0 : total))
    useEffect(() => {
        if (!armed || shown >= total) return
        // 基准 ~25 字/秒（tick 40ms×1 字）；超长文本封顶 ~10s 打完
        const step = Math.max(1, Math.ceil(total / 250))
        const timer = window.setInterval(() => {
            setShown((s) => {
                const n = Math.min(total, s + step)
                if (n >= total) window.clearInterval(timer)
                return n
            })
        }, 40)
        return () => window.clearInterval(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [armed, total])
    // 每次内容增长通知父级：若用户仍贴底则跟随滚动（打字撑高不丢跟随）
    useEffect(() => {
        if (armed) onGrow?.()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shown])
    if (shown >= total) return renderRoundContent(kind, text)
    return (
        <div className="sw-typing-md">
            <MarkdownRenderer className="sw-md" content={t.slice(0, shown)}/>
        </div>
    )
}

/**
 * 运行时长计时（自持 tick）。
 * 原先由父级 setNow 每秒驱动整页重渲染（连带全部 Markdown 解析 / 像素头像重建），
 * 交互会明显顿挫；改为只有这一个节点每秒更新。
 */
function LiveTimer({sinceMs}: {sinceMs: number}) {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
    }, [])
    const el = Math.max(0, now - sinceMs)
    const hms = `${String(Math.floor(el / 3600000)).padStart(2, '0')}:${String(Math.floor((el % 3600000) / 60000)).padStart(2, '0')}:${String(Math.floor((el % 60000) / 1000)).padStart(2, '0')}`
    return <span className="sw-pill sw-pill--live"><i className="sw-dot"/>运行中 · {hms}</span>
}

/** 小分队工作台（像素舞台 v3，严格按设计稿 docs/design/小分队工作台-UI设计稿.html） */
export default function SquadDetailPage() {
    const nav = useNavigate()
    const {message} = useNotify()
    const {id} = useParams()

    const [squad, setSquad] = useState<SquadInfo | undefined>(undefined)
    const [agents, setAgents] = useState<AgentInfo[]>([])
    const [loading, setLoading] = useState(true)

    const [sessions, setSessions] = useState<SquadSession[]>([])
    const [selected, setSelected] = useState<string | null>(null)
    const [rounds, setRounds] = useState<BoardRound[]>([])
    const [board, setBoard] = useState<SquadBoardView | null>(null)
    const [summary, setSummary] = useState('')
    const [view, setView] = useState<'stage' | 'dialog'>('dialog')
    const [chip, setChip] = useState<'all' | 'active' | 'await' | 'done'>('all')

    const [prompt, setPrompt] = useState('')
    const [starting, setStarting] = useState(false)
    const sessionIdRef = useRef<string | null>(null)
    // 对话时间线贴底跟随：用户上滚即暂停跟随，手动滚回底部（距底 <48px）自动恢复
    const timelineRef = useRef<HTMLDivElement>(null)
    const stickBottomRef = useRef(true)
    const handleTimelineScroll = useCallback(() => {
        const el = timelineRef.current
        if (el) stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }, [])
    // 打字机内容增长时的跟随滚动（用户上滚暂停后不跟随）
    const stickScroll = useCallback(() => {
        const el = timelineRef.current
        if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight
    }, [])
    // 输入框高度可拖拽（对齐 Agent 对话页：向上拖动调整高度）
    const [inputHeight, setInputHeight] = useState(52)
    const startInputResize = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        const startY = e.clientY
        const startH = inputHeightRef.current
        const onMove = (ev: MouseEvent) => {
            const next = Math.max(44, Math.min(240, startH + (startY - ev.clientY)))
            setInputHeight(next)
        }
        const onUp = () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
        }
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'row-resize'
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }, [])
    const inputHeightRef = useRef(inputHeight)
    useEffect(() => { inputHeightRef.current = inputHeight }, [inputHeight])
    const [injectTarget, setInjectTarget] = useState<string>('')
    const [injectMode, setInjectMode] = useState<'soft' | 'hard' | 'pre_talk'>('soft')
    const [injectText, setInjectText] = useState('')
    const [injectBusy, setInjectBusy] = useState(false)
    const [chatCard, setChatCard] = useState<string | null>(null)

    const [asideOpen, setAsideOpen] = useState(false)
    // 顶栏「团队记忆」按钮请求右栏切页：n 递增即触发（Tab 状态已下沉到右栏内部）
    const [asideReq, setAsideReq] = useState<{tab: AsideTab; n: number}>({tab: 'members', n: 0})
    const [memberMotion, setMemberMotion] = useState<Record<string, string>>({})

    const [planPending, setPlanPending] = useState(false)
    const [checkpointPending, setCheckpointPending] = useState(false)
    // 滚动跟随生效点：轮次/汇总/门禁挂起卡变化后，若用户仍贴底则自动滚到最新
    useEffect(() => {
        const el = timelineRef.current
        if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight
    }, [rounds, summary, planPending, checkpointPending, selected])

    const selectedSession = sessions.find((s) => s.id === selected) || null
    const isRunning = selectedSession?.status === 'running'
    const boardTasks = useMemo(() => {
        const raw = (board?.tasks ?? []) as unknown
        if (Array.isArray(raw)) return raw as Array<{taskId: string; title: string; assignee: string; status: string}>
        if (raw && typeof raw === 'object') return Object.entries(raw as Record<string, {title: string; assignee: string; status: string}>).map(([taskId, t]) => ({taskId, ...t}))
        return []
    }, [board])

    const reloadSessions = useCallback(async () => {
        if (!id) return
        try { setSessions(await listSquadSessions(id)) } catch { /* 容错 */ }
    }, [id])

    useEffect(() => {
        let alive = true
        ;(async () => {
            setLoading(true)
            try {
                const [sq, ags, sess] = await Promise.all([
                    id ? getSquad(id) : Promise.resolve(undefined),
                    listAgents(),
                    id ? listSquadSessions(id) : Promise.resolve([] as SquadSession[]),
                ])
                if (!alive) return
                setSquad(sq); setAgents(ags); setSessions(sess)
                const active = sess.find((x) => ACTIVE_STATUSES.includes(x.status))
                if (active) setSelected(active.id)
            } finally { if (alive) setLoading(false) }
        })()
        return () => { alive = false }
    }, [id])

    useEffect(() => {
        const t = setInterval(() => { void reloadSessions() }, 30000)
        return () => clearInterval(t)
    }, [reloadSessions])

    const openSessionRounds = useCallback(async (sid: string | null) => {
        setRounds([]); setBoard(null); setSummary(''); setPlanPending(false); setCheckpointPending(false); setChatCard(null)
        if (!sid) return
        try {
            const rs = await listSquadRounds(sid)
            setRounds(rs.map((r) => ({role: r.role, kind: r.kind, content: r.content, speakerAgentId: r.speakerAgentId})))
            const sess = sessions.find((x) => x.id === sid)
            setSummary(sess?.snapshot ?? '')
            try { setBoard(sess?.boardJson ? (JSON.parse(sess.boardJson) as SquadBoardView) : null) } catch { setBoard(null) }
        } catch (e) {
            message.error(`读取轮次失败：${e instanceof Error ? e.message : String(e)}`)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessions, message])

    function selectSessionLocal(sid: string | null) {
        setSelected(sid)
        sessionIdRef.current = sid
        setChatCard(null)
        void openSessionRounds(sid)
    }

    useEffect(() => {
        if (!squad) return
        const offs: Array<() => void> = []
        void (async () => {
            offs.push(await listen<{squadId: string; sessionId: string}>('agent-squad-session-started', (e) => {
                if (e.payload.squadId !== squad.id) return
                sessionIdRef.current = e.payload.sessionId
                setSelected(e.payload.sessionId)
                setRounds([]); setBoard(null); setSummary(''); setView('dialog')
                void reloadSessions()
            }))
            offs.push(await listen<{squadId: string; sessionId: string; speakerAgentId: string | null; role: string; kind: string; content: string}>('agent-squad-round', (e) => {
                const pl = e.payload
                if (pl.squadId !== squad.id) return
                if (sessionIdRef.current && pl.sessionId !== sessionIdRef.current) return
                if (pl.kind === 'plan') setPlanPending(true)
                if (pl.kind === 'checkpoint') setCheckpointPending(true)
                setRounds((r) => [...r, {role: pl.role, kind: pl.kind, content: pl.content, speakerAgentId: pl.speakerAgentId, fresh: true}])
            }))
            offs.push(await listen<{squadId: string; sessionId: string; summary: string}>('agent-squad-session-done', (e) => {
                if (e.payload.squadId !== squad.id) return
                setSummary(e.payload.summary)
                setMemberMotion({})
                void reloadSessions()
            }))
            offs.push(await listen<{squadId: string; memberRole: string; phase: string; ok: boolean}>('squad-member-event', (e) => {
                if (e.payload.squadId !== squad.id) return
                const st = e.payload.phase === 'started' ? 'working' : e.payload.ok ? 'cheer' : 'error'
                setMemberMotion((m) => ({...m, [e.payload.memberRole]: st}))
                if (e.payload.phase !== 'started') setTimeout(() => setMemberMotion((m) => ({...m, [e.payload.memberRole]: 'idle'})), 3000)
            }))
        })()
        return () => offs.forEach((f) => f())
    }, [squad, reloadSessions])

    async function handleStart() {
        const p = prompt.trim()
        if (!p || !squad) return
        setStarting(true); setSelected(null); sessionIdRef.current = null
        try {
            await invoke('run_squad_task', {input: {squad_id: squad.id, prompt: p}})
            setPrompt(''); setView('dialog')
            message.success('协作已启动')
        } catch (e) {
            message.error(`启动失败：${e instanceof Error ? e.message : String(e)}`)
        } finally { setStarting(false) }
    }

    async function handleRerun(s: SquadSession) {
        if (!s.title?.trim()) { message.error('该会话没有可重跑的指令'); return }
        try {
            await invoke('run_squad_task', {input: {squad_id: squad!.id, prompt: s.title}})
            message.success('已按原指令重新发起协作')
        } catch (e) { message.error(`重跑失败：${e instanceof Error ? e.message : String(e)}`) }
    }

    const handleInject = useCallback(async () => {
        const text = injectText.trim()
        const target = selectedSession?.id ?? sessionIdRef.current
        if (!text) { message.error('请输入要补充的内容'); return }
        if (!injectTarget) { message.error('请选择插话目标（成员）'); return }
        if (!target || !squad) { message.error('协作尚未开始，无法插话'); return }
        setInjectBusy(true)
        try {
            await invoke<string>('squad_inject_send', {squadId: squad.id, sessionId: target, taskId: injectTarget, content: text, mode: injectMode})
            message.success(injectMode === 'pre_talk' ? '预嘱已入队，将在其任务启动时生效' : injectMode === 'hard' ? '强打断已送达，将在该成员下一轮优先处理' : '已打断，将在该成员下一轮生效')
            setInjectText('')
        } catch (e) { message.error(`插话失败：${e instanceof Error ? e.message : String(e)}`) } finally { setInjectBusy(false) }
    }, [injectText, injectTarget, injectMode, selectedSession, squad, message])
    // 舞台上点成员：选中并打开插话卡（默认「打断」）
    const pickMember = useCallback((agentId: string) => {
        setInjectTarget(agentId); setInjectMode('soft'); setChatCard(agentId)
    }, [])
    const closeChatCard = useCallback(() => setChatCard(null), [])

    // 门禁 / 交付决议：sessionId 统一在此补齐，子组件只传业务参数
    const gateCallAsync = useCallback(async (cmd: string, args: Record<string, unknown>, okMsg: string) => {
        try {
            await invoke(cmd, {sessionId: selected ?? sessionIdRef.current, ...args}); message.success(okMsg)
            setPlanPending(false); setCheckpointPending(false)
            void reloadSessions()
        } catch (e) { message.error(`操作失败：${e instanceof Error ? e.message : String(e)}`) }
    }, [message, reloadSessions, selected])
    // 稳定引用的 void 包装：直接传内联箭头会给 memo 子组件制造新 props，导致时间线白重渲染
    const gateCall = useCallback((cmd: string, args: Record<string, unknown>, okMsg: string) => {
        void gateCallAsync(cmd, args, okMsg)
    }, [gateCallAsync])

    // 像素头像外观缓存：agentAppearanceOf 在库内未存 appearance 时会现算生成新对象，
    // 直接内联传入会击穿 PixelAgent 的 memo（每次重渲染都重建数百个 rect）；按 agentId 缓存引用。
    const appearanceMap = useMemo(() => {
        const map: Record<string, ReturnType<typeof agentAppearanceOf>> = {}
        for (const m of squad?.members || []) map[m.agentId] = agentAppearanceOf(agents, m.agentId)
        return map
    }, [agents, squad])
    const appearanceOf = useCallback((agentId?: string) => {
        if (!agentId) return agentAppearanceOf(agents, undefined)
        return appearanceMap[agentId] ?? agentAppearanceOf(agents, agentId)
    }, [agents, appearanceMap])
    // 落座表 + 场景像素画（会议室长桌，椅子按实际落座生成）：只随模式与人数变化
    const memberCount = (squad?.members || []).length
    const spots = useMemo(() => seatSpots(squad?.mode ?? 'orchestrator', memberCount), [squad?.mode, memberCount])
    // 舞台气泡：每位成员最近一次发言（舞台只回显一句话，不渲染整段 Markdown）
    const lastWords = useMemo(() => {
        const map: Record<string, string> = {}
        for (const r of rounds) {
            if (!r.speakerAgentId || r.kind === 'metrics' || r.kind === 'handoff') continue
            const t = plainText(r.content)
            if (t) map[r.speakerAgentId] = t
        }
        return map
    }, [rounds])
    // 系统轮没有角色：取最近一条系统消息给「机器人」气泡
    const systemWord = useMemo(() => {
        for (let i = rounds.length - 1; i >= 0; i--) {
            const r = rounds[i]
            if (r.speakerAgentId) continue
            const t = plainText(r.content)
            if (t) return t
        }
        return ''
    }, [rounds])
    // 呼吸灯：谁在发言谁亮——事件状态优先，其次取最新一轮的发言者（群聊等无成员事件的回退）
    const lastSpeakerId = rounds.length ? (rounds[rounds.length - 1].speakerAgentId ?? null) : null
    const memberState = useCallback((agentId: string, role: string): string => {
        const ev = memberMotion[role]
        if (ev && ev !== 'idle') return ev
        return isRunning && agentId === lastSpeakerId ? 'working' : 'idle'
    }, [memberMotion, isRunning, lastSpeakerId])

    if (loading) return <div className="squads squads--detail"><Spin spinning wrapperClassName="squads__spin"/></div>
    if (!squad) {
        return (
            <div className="squads squads--detail">
                <div className="sw-topbar">
                    <Button variant="ghost" size="sm" onClick={() => nav('/squads-workspace')}><ArrowLeft size={14}/> 返回列表</Button>
                </div>
                <div className="squad-detail__missing">未找到该小分队（可能已被删除）。</div>
            </div>
        )
    }

    const mode = squad.mode
    const isDraft = !selectedSession
    const canInject = selectedSession ? ACTIVE_STATUSES.includes(selectedSession.status) && selectedSession.status !== 'paused' : false
    const chips: Array<{key: 'all' | 'active' | 'await' | 'done'; label: string; n: number}> = [
        {key: 'all', label: '全部', n: sessions.length},
        {key: 'active', label: '运行中', n: sessions.filter((s) => ACTIVE_STATUSES.includes(s.status)).length},
        {key: 'await', label: '待决议', n: sessions.filter((s) => s.status.startsWith('awaiting')).length},
        {key: 'done', label: '已完成', n: sessions.filter((s) => s.status === 'done').length},
    ]
    const filtered = sessions.filter((s) => chip === 'all' ? true : chip === 'active' ? ACTIVE_STATUSES.includes(s.status) : chip === 'await' ? s.status.startsWith('awaiting') : s.status === 'done')
    const liveSession = sessions.find((s) => ACTIVE_STATUSES.includes(s.status))
    // createdAt 是 ISO 字符串（safeIso），Number() 直接转会 NaN → 计时显示 NaN:NaN:NaN；
    // 统一经 Date.parse 并对非法值兜底归零。
    const liveCreatedMs = liveSession
        ? (typeof liveSession.createdAt === 'number' ? liveSession.createdAt : Date.parse(String(liveSession.createdAt)))
        : NaN
    void boardTasks
    // 点选像素小人后右下角对话框的「对谁说」
    const chatMember = chatCard ? (squad.members.find((m) => m.agentId === chatCard) || null) : null

    return (
        <div className="squads squads--detail sw">
            <header className="sw-topbar">
                <button className="sw-topbar__back" onClick={() => nav('/squads-workspace')} aria-label="返回列表"><ArrowLeft size={15}/></button>
                <div className="sw-topbar__logo">{(squad.name || '队').slice(0, 1)}</div>
                <div className="sw-topbar__id">
                    <div className="sw-topbar__name">{squad.name}</div>
                    <div className="sw-topbar__meta">
                        <span className="sw-pill sw-pill--mode">{MODE_META[mode]?.label ?? mode}</span>
                        {liveSession && liveSession.status === 'running' && Number.isFinite(liveCreatedMs) && <LiveTimer sinceMs={liveCreatedMs}/>}
                        {squad.workspaceDir && <span className="sw-pill sw-pill--muted">📁 {squad.workspaceDir}</span>}
                    </div>
                </div>
                <div className="sw-topbar__center">
                    <div className="sw-viewseg">
                        <div className={`sw-viewseg__item${view === 'dialog' ? ' is-on' : ''}`} onClick={() => setView('dialog')}>对话</div>
                        <div className={`sw-viewseg__item${view === 'stage' ? ' is-on' : ''}`} onClick={() => setView('stage')}>舞台</div>
                    </div>
                </div>
                <div className="sw-topbar__spacer"/>
                <CrewBar members={squad.members} agents={agents} appearanceOf={appearanceOf} memberState={memberState}/>
            </header>

            <div className="sw-body">
                <aside className="sw-panel sw-side">
                    <div className="sw-side__cta">
                        <Button variant="solid" size="sm" block onClick={() => selectSessionLocal(null)}><Plus size={13}/> 新建任务</Button>
                        <Button variant="ghost" size="sm" aria-label="团队记忆" title="团队记忆（热更新）" onClick={() => { setAsideOpen(true); setAsideReq((r) => ({tab: 'memory', n: r.n + 1})) }}><Brain size={14}/></Button>
                    </div>
                    <div className="sw-chips">
                        {chips.map((c) => (
                            <span key={c.key} className={`sw-chip${chip === c.key ? ' is-on' : ''}`} onClick={() => setChip(c.key)}>{c.label} {c.n}</span>
                        ))}
                    </div>
                    <div className="sw-panel__body">
                        {filtered.length === 0 && <Empty description={chip === 'all' ? '还没有协作记录' : '该状态下暂无会话'}/>}
                        {filtered.map((s) => {
                            const stPill = STATUS_PILL[s.status] || {label: s.status, cls: 'muted'}
                            let prog: {done: number; total: number} | null = null
                            try {
                                const b = s.boardJson ? JSON.parse(s.boardJson) : null
                                const raw = b?.tasks
                                const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : []
                                if (list.length) prog = {done: list.filter((t: {status: string}) => t.status === 'done').length, total: list.length}
                            } catch { /* 忽略 */ }
                            const active = ACTIVE_STATUSES.includes(s.status)
                            const cardCls = active ? (s.status === 'running' ? ' is-active' : ' is-await') : s.status === 'failed' ? ' is-fail' : ' is-done'
                            return (
                                <div
                                    key={s.id}
                                    className={`sw-scard${selected === s.id ? ' is-selected' : ''}${cardCls}`}
                                    onClick={() => selectSessionLocal(s.id)}
                                >
                                    <div className="sw-scard__top">
                                        {s.status === 'running' && <i className="sw-scard__pulse"/>}
                                        {(s.status === 'awaiting_checkpoint' || s.status === 'awaiting_delivery') && <i className="sw-scard__pulse sw-scard__pulse--warn"/>}
                                        <span className="sw-scard__title">{s.title || '（无标题任务）'}</span>
                                    </div>
                                    <div className="sw-scard__meta">
                                        <span className={`sw-pill sw-pill--${stPill.cls}`}>{stPill.label}</span>
                                        <span>{new Date(s.createdAt).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})}</span>
                                    </div>
                                    {prog && (
                                        <div className="sw-scard__prog">
                                            <span>{prog.done}/{prog.total}</span>
                                            <div className="sw-scard__bar"><i style={{width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%`}}/></div>
                                        </div>
                                    )}
                                    <div className="sw-scard__ops" onClick={(e) => e.stopPropagation()}>
                                        {s.status === 'running' && <Button variant="ghost" size="sm" aria-label="暂停" title="暂停" onClick={() => void invoke('squad_pause', {squadId: squad.id}).then(() => reloadSessions())}>⏸</Button>}
                                        {(s.status === 'paused' || s.status.startsWith('awaiting')) && <Button variant="ghost" size="sm" aria-label="继续" title="继续" onClick={() => void invoke('squad_resume', {squadId: squad.id}).then(() => reloadSessions())}>▶</Button>}
                                        {active && <Button variant="ghost" size="sm" aria-label="停止" title="停止协作" onClick={() => void invoke('cancel_squad_task', {squadId: squad.id}).then(() => reloadSessions())}>⏹</Button>}
                                        {!active && <Button variant="ghost" size="sm" aria-label="重跑" title="按原指令重跑" onClick={() => void handleRerun(s)}>↻</Button>}
                                        {!active && <Button variant="ghost" size="sm" aria-label="删除" title="删除记录" onClick={() => void deleteSquadSession(s.id).then(() => { if (selected === s.id) selectSessionLocal(null); void reloadSessions() })}>🗑</Button>}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </aside>

                <main className="sw-panel sw-main" data-view={view}>
                    <StageView
                        mode={mode}
                        members={squad.members}
                        agents={agents}
                        spots={spots}
                        appearanceOf={appearanceOf}
                        memberState={memberState}
                        lastWords={lastWords}
                        systemWord={systemWord}
                        activeSpeakerId={lastSpeakerId}
                        chatCard={chatCard}
                        canInject={canInject}
                        onPick={pickMember}
                    />

                    <TimelineView
                        rounds={rounds}
                        members={squad.members}
                        agents={agents}
                        appearanceOf={appearanceOf}
                        memberMotion={memberMotion}
                        planPending={planPending}
                        checkpointPending={checkpointPending}
                        delivery={selectedSession?.status === 'awaiting_delivery'}
                        showEmpty={!isDraft}
                        summary={summary}
                        onGate={gateCall}
                        stickScroll={stickScroll}
                        scrollRef={timelineRef}
                        onScroll={handleTimelineScroll}
                    />

                    <div className="sw-composer">
                        <div className="sw-composer__body">
                            {isDraft ? (
                                <div className="sw-input-box">
                                    <div className="sw-input-box__resizer" title="向上拖动调整输入框高度" onMouseDown={startInputResize}/>
                                    <textarea rows={2} placeholder="描述这次要协作完成的任务…" value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{height: inputHeight}}/>
                                    <div className="sw-input-box__footer"><Button variant="solid" size="sm" disabled={!prompt.trim() || starting} onClick={() => void handleStart()}>{starting ? '启动中…' : '开始运行'}</Button></div>
                                </div>
                            ) : canInject ? (
                                <>
                                    <div className="sw-composer__row">
                                        <span className="sw-modebar__label">目标</span>
                                        {(squad.members || []).map((m) => (
                                            <div key={m.id || m.agentId} className={`sw-member-pick${injectTarget === m.agentId ? ' is-on' : ''}`} onClick={() => setInjectTarget(m.agentId)}>
                                                <div className="sw-member-pick__pa"><PixelAgent appearance={appearanceOf(m.agentId)} size={20}/></div>
                                                {memberLabel(m, agents)}
                                            </div>
                                        ))}
                                    </div>
                                    <div className="sw-composer__row">
                                        <span className="sw-modebar__label">方式</span>
                                        <div className="sw-seg">
                                            {([['soft', '打断'], ['hard', '强打断'], ['pre_talk', '预嘱']] as const).map(([v, l]) => (
                                                <div key={v} className={`sw-seg__item${injectMode === v ? ' is-on' : ''}`} onClick={() => setInjectMode(v)}>{l}</div>
                                            ))}
                                        </div>
                                        <span className="sw-inject-hint">
                                            {injectMode === 'soft' ? '打断：其下一轮生效' : injectMode === 'hard' ? '强打断：优先处理' : '预嘱：任务启动时注入'}
                                        </span>
                                    </div>
                                    <div className="sw-input-box">
                                        <div className="sw-input-box__resizer" title="向上拖动调整输入框高度" onMouseDown={startInputResize}/>
                                        <textarea rows={2} placeholder="补充说明、纠偏指令…" value={injectText} onChange={(e) => setInjectText(e.target.value)} style={{height: inputHeight}}/>
                                        <div className="sw-input-box__footer"><Button variant="solid" size="sm" disabled={injectBusy || !injectText.trim()} onClick={() => void handleInject()}>{injectBusy ? '发送中…' : '发送'}</Button></div>
                                    </div>
                                </>
                            ) : (
                                <div className="sw-composer__row sw-composer__row--center"><span className="sw-inject-hint">{selectedSession?.status === 'paused' ? '协作已暂停，可在左侧卡片恢复。' : selectedSession?.status === 'awaiting_delivery' ? '交付待确认：请在上方决议条操作。' : '该会话已结束，可重跑或新建任务。'}</span></div>
                            )}
                        </div>
                    </div>
                </main>
            </div>

            {asideOpen && (
                <AsideFloat
                    squadId={squad.id}
                    members={squad.members}
                    agents={agents}
                    appearanceOf={appearanceOf}
                    memberState={memberState}
                    board={board}
                    request={asideReq}
                />
            )}
            {/* 打断对话框：屏幕右下角固定浮出，与像素小人解绑 */}
            {chatMember && (
                <InjectDock
                    member={chatMember}
                    agents={agents}
                    appearanceOf={appearanceOf}
                    injectMode={injectMode}
                    injectText={injectText}
                    onMode={setInjectMode}
                    onText={setInjectText}
                    onSend={() => void handleInject()}
                    onClose={closeChatCard}
                />
            )}
            <button className="sw-aside-toggle" title={asideOpen ? '收起右栏' : '展开右栏'} onClick={() => setAsideOpen((v) => !v)}>{asideOpen ? '❮' : '❯'}</button>
        </div>
    )
}

/* --------------------------------------------------------------------------
 * 渲染分区（均 memo 化）：
 * 大页面此前每次 setState（切右栏 Tab / 计时 tick / 输入框打字 / 成员事件）都会整页
 * 重渲染，连带重跑全部 Markdown 解析管线与像素头像重建，交互明显顿挫。拆成 memo
 * 子组件后，props 未变的分区会被整体跳过，切 Tab 只重渲染右栏那一小片。
 * -------------------------------------------------------------------------- */

type AsideTab = 'members' | 'memory' | 'decisions'
type AppearanceOf = (agentId?: string) => ReturnType<typeof agentAppearanceOf>
type Members = SquadInfo['members']

/** 顶栏成员头像条：成员与状态不变时跳过重渲染（像素头像重建代价最高） */
const CrewBar = memo(function CrewBar({members, agents, appearanceOf, memberState}: {
    members: Members; agents: AgentInfo[]; appearanceOf: AppearanceOf;
    memberState: (agentId: string, role: string) => string
}) {
    return (
        <div className="sw-crew">
            {(members || []).map((m, i) => {
                const st = memberState(m.agentId, m.role)
                return (
                    <div key={m.id || i} className={`sw-crew__slot${st === 'working' || st === 'cheer' ? ' is-active' : ''}`} title={memberLabel(m, agents)}>
                        <PixelAgent appearance={appearanceOf(m.agentId)} size={26} motion={st === 'working'} state={st as 'working'}/>
                    </div>
                )
            })}
        </div>
    )
})

/** 像素舞台：会议室长桌场景 + 围坐成员 + 发言气泡回显 + 系统机器人 */
const StageView = memo(function StageView({mode, members, agents, spots, appearanceOf, memberState, lastWords, systemWord, activeSpeakerId, chatCard, canInject, onPick}: {
    mode: string; members: Members; agents: AgentInfo[];
    spots: Array<{x: number; y: number; role: string}>;
    appearanceOf: AppearanceOf; memberState: (agentId: string, role: string) => string;
    lastWords: Record<string, string>; systemWord: string; activeSpeakerId: string | null;
    chatCard: string | null; canInject: boolean;
    onPick: (agentId: string) => void
}) {
    return (
        <div className="sw-stage" data-mode={mode}>
            <div className="sw-scene-frame">
                <img className="sw-scene__bg" src={ROOM_BG} alt="" draggable={false}/>
            </div>
            {(members || []).map((m, i) => {
                const spot = spots[i % spots.length]
                const motion = memberState(m.agentId, m.role)
                const anim = motion === 'working' ? 'is-working' : motion === 'speaking' ? 'is-speaking' : 'is-idle'
                const word = lastWords[m.agentId] || ''
                const talking = anim === 'is-working' || anim === 'is-speaking'
                // 只有「正在说话的人」出气泡（含刚刚说完的那位），避免桌面被一堆气泡糊住
                const showWord = !!word && (talking || m.agentId === activeSpeakerId)
                return (
                    <div
                        key={m.id || i}
                        className={`sw-walker ${anim}${spot.y >= FRONT_ROW_Y ? ' is-front' : ''}${chatCard === m.agentId ? ' is-selected' : ''}${showWord ? ' has-word' : ''}`}
                        style={{left: `${spot.x}%`, top: `${spot.y}%`}}
                        onClick={(e) => { e.stopPropagation(); if (!canInject) return; onPick(m.agentId) }}
                        title={memberLabel(m, agents)}
                    >
                        {showWord && <div className={`sw-walker__say${talking ? ' is-talking' : ''}`}>{word}</div>}
                        <div className="sw-walker__glow"/>
                        <div className="sw-walker__pa"><PixelAgent appearance={appearanceOf(m.agentId)} size={72} motion={anim !== 'is-idle'} state={anim === 'is-working' ? 'working' : anim === 'is-speaking' ? 'speaking' : 'idle'}/></div>
                        <div className="sw-walker__name">{memberLabel(m, agents)} · {spot.role}</div>
                    </div>
                )
            })}
            {/* 系统轮没有角色：用机器人像素站在桌上，系统消息同样回显到气泡 */}
            <div className={`sw-robot-stand${systemWord ? ' has-word' : ''}`} style={{left: '74%', top: '66%'}} title="系统">
                {systemWord && <div className="sw-walker__say is-sys">{systemWord}</div>}
                <RobotPixel size={60}/>
                <div className="sw-walker__name">系统</div>
            </div>
        </div>
    )
})

/** 打断对话框：固定在屏幕右下角（不再贴着像素小人飘，避免被舞台裁掉） */
const InjectDock = memo(function InjectDock({member, agents, appearanceOf, injectMode, injectText, onMode, onText, onSend, onClose}: {
    member: {agentId: string; role?: string} | null; agents: AgentInfo[]; appearanceOf: AppearanceOf;
    injectMode: 'soft' | 'hard' | 'pre_talk'; injectText: string;
    onMode: (v: 'soft' | 'hard' | 'pre_talk') => void; onText: (v: string) => void;
    onSend: () => void; onClose: () => void
}) {
    if (!member) return null
    return (
        <div className="sw-chatcard" onClick={(e) => e.stopPropagation()}>
            <div className="sw-chatcard__head">
                <div className="sw-chatcard__ava"><PixelAgent appearance={appearanceOf(member.agentId)} size={32}/></div>
                <div className="sw-chatcard__name">{memberLabel(member, agents)}</div>
                <button className="sw-chatcard__x" onClick={onClose}>✕</button>
            </div>
            <div className="sw-chatcard__modes">
                <span>方式</span>
                {([['soft', '打断'], ['hard', '强打断'], ['pre_talk', '预嘱']] as const).map(([v, l]) => (
                    <button key={v} className={`sw-chatcard__mode${injectMode === v ? ' is-on' : ''}`} onClick={() => onMode(v)}>{l}</button>
                ))}
                <div className="sw-chatcard__mode-hint">
                    {injectMode === 'soft' ? '打断：其下一轮生效' : injectMode === 'hard' ? '强打断：优先处理' : '预嘱：任务启动时注入'}
                </div>
            </div>
            <div className="sw-chatcard__row">
                <input
                    placeholder={`对 ${memberLabel(member, agents)} 说…`}
                    value={injectText}
                    onChange={(e) => onText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') onSend() }}
                />
                <button className="sw-chatcard__send" onClick={onSend}>发送</button>
            </div>
        </div>
    )
})

/** 对话时间线：轮次不变时不随右栏 Tab / 计时等无关状态重渲染 */
const TimelineView = memo(function TimelineView({rounds, members, agents, appearanceOf, memberMotion, planPending, checkpointPending, delivery, showEmpty, summary, onGate, stickScroll, scrollRef, onScroll}: {
    rounds: BoardRound[]; members: Members; agents: AgentInfo[]; appearanceOf: AppearanceOf;
    memberMotion: Record<string, string>; planPending: boolean; checkpointPending: boolean;
    delivery: boolean; showEmpty: boolean; summary: string;
    onGate: (cmd: string, args: Record<string, unknown>, okMsg: string) => void;
    stickScroll: () => void;
    scrollRef: RefObject<HTMLDivElement | null>; onScroll: () => void
}) {
    return (
        <div className="sw-timeline" ref={scrollRef} onScroll={onScroll}>
            {rounds.map((r, i) => {
                const badge = ROUND_BADGE[r.kind] || {label: r.kind, cls: 'sys'}
                const speaker = r.speakerAgentId ? (members.find((m) => m.agentId === r.speakerAgentId)) : null
                const name = speaker ? memberLabel(speaker, agents) : r.role
                const motion = speaker ? memberMotion[memberLabel(speaker, agents)] ?? memberMotion[speaker.role] : undefined
                const anim = motion === 'working' ? 'working' : motion === 'cheer' ? 'cheer' : motion === 'error' ? 'error' : 'idle'
                return (
                    <div key={i} className={`sw-round${badge.cls === 'sys' ? ' sw-round--sys' : ''}`}>
                        <div className={`sw-round__pa${speaker && members[0]?.agentId === speaker.agentId ? ' sw-round__pa--lead' : ''}`}>
                            {speaker
                                ? <PixelAgent appearance={appearanceOf(speaker.agentId)} size={28} motion={anim !== 'idle'} state={anim as 'idle'}/>
                                : <RobotPixel size={28}/>}
                        </div>
                        <div className="sw-round__body">
                            <div className="sw-round__head">
                                <span className="sw-round__name">{name}</span>
                                <span className={`sw-badge sw-badge--${badge.cls}`}>{badge.label}</span>
                            </div>
                            <div className="sw-round__content"><div className="sw-bubble">
                                {isStructuredRound(r.kind, r.content)
                                    ? renderRoundContent(r.kind, r.content)
                                    : <TypewriterBubble kind={r.kind} text={r.content} fresh={!!r.fresh} onGrow={stickScroll}/>}
                            </div></div>
                        </div>
                    </div>
                )
            })}
            {(planPending || checkpointPending) && (
                <div className="sw-round sw-round--gate">
                    <div className="sw-round__pa sw-round__pa--user">禁</div>
                    <div className="sw-round__body">
                        <div className="sw-round__head"><span className="sw-round__name">门禁</span><span className="sw-badge sw-badge--gate">{planPending ? '计划待批准' : '检查点待决议'}</span></div>
                        <div className="sw-round__content">
                            {planPending ? '协作计划已生成，等待批准。' : '波次已完成，等待检查点决议。'}
                            <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                {planPending ? (
                                    <>
                                        <Button variant="solid" size="sm" onClick={() => onGate('squad_plan_approve', {approved: true}, '计划已批准')}>批准计划</Button>
                                        <Button variant="outline" size="sm" onClick={() => onGate('squad_plan_approve', {approved: false}, '已拒绝')}>拒绝</Button>
                                    </>
                                ) : (
                                    <>
                                        <Button variant="solid" size="sm" onClick={() => onGate('squad_checkpoint_resolve', {decision: 'continue'}, '继续执行')}>继续执行</Button>
                                        <Button variant="outline" size="sm" onClick={() => onGate('squad_checkpoint_resolve', {decision: 'rework'}, '已要求返工')}>要求返工</Button>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {delivery && (
                <div className="sw-round sw-round--gate">
                    <div className="sw-round__pa sw-round__pa--user">包</div>
                    <div className="sw-round__body">
                        <div className="sw-round__head"><span className="sw-round__name">交付</span><span className="sw-badge sw-badge--gate">交付待确认</span></div>
                        <div className="sw-round__content">
                            协作已完成，等待交付确认。
                            <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                <Button variant="solid" size="sm" onClick={() => onGate('squad_delivery_resolve', {approved: true}, '已确认交付')}>确认交付</Button>
                                <Button variant="outline" size="sm" onClick={() => onGate('squad_delivery_resolve', {approved: false}, '已要求修订')}>要求修订</Button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {rounds.length === 0 && showEmpty && <div className="sw-round"><div className="sw-round__body"><div className="sw-round__content" style={{color: 'var(--color-foreground-muted)'}}>暂无轮次内容</div></div></div>}
            {summary && !rounds.some((r) => r.kind === 'summary') && (
                <div className="sw-round sw-round--highlight">
                    <div className="sw-round__pa sw-round__pa--user">汇</div>
                    <div className="sw-round__body">
                        <div className="sw-round__head"><span className="sw-round__name">最终汇总</span><span className="sw-badge sw-badge--msg">结论</span></div>
                        <div className="sw-round__content"><div className="sw-bubble sw-bubble--hl"><MarkdownRenderer className="sw-md" content={normalizeMd(summary)}/></div></div>
                    </div>
                </div>
            )}
        </div>
    )
})

/**
 * 右栏悬浮面板：自持 Tab 与团队记忆数据。
 * Tab / 记忆输入是面板局部状态，不再提升到大页面——否则每次点 Tab 都会重渲染整条时间线。
 */
const AsideFloat = memo(function AsideFloat({squadId, members, agents, appearanceOf, memberState, board, request}: {
    squadId: string; members: Members; agents: AgentInfo[]; appearanceOf: AppearanceOf;
    memberState: (agentId: string, role: string) => string;
    board: SquadBoardView | null; request: {tab: AsideTab; n: number}
}) {
    const {message} = useNotify()
    const [tab, setTab] = useState<AsideTab>('members')
    const [memories, setMemories] = useState<SquadMemory[]>([])
    const [memKey, setMemKey] = useState('')
    const [memContent, setMemContent] = useState('')
    const [memCat, setMemCat] = useState<SquadMemoryCategory>('general')
    const [memSaving, setMemSaving] = useState(false)

    const reload = useCallback(async () => {
        try { setMemories(await listSquadMemories(squadId)) } catch { /* 容错 */ }
    }, [squadId])
    useEffect(() => { void reload() }, [reload])
    useEffect(() => {
        let un: (() => void) | undefined
        void listen<{item: SquadMemory}>('agent-squad-memory-anchored', () => { void reload() }).then((f) => { un = f })
        return () => un?.()
    }, [reload])
    // 外部（顶栏「团队记忆」按钮）请求切页：n 递增即触发
    useEffect(() => {
        setTab(request.tab)
        if (request.tab === 'memory') void reload()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [request.n])

    async function handleSave() {
        if (!memKey.trim() || !memContent.trim()) { message.error('键名与内容必填'); return }
        setMemSaving(true)
        try {
            await anchorSquadMemory({squadId, key: memKey.trim(), content: memContent.trim(), category: memCat})
            message.success('记忆已锚定（下次协作注入生效）')
            setMemKey(''); setMemContent(''); void reload()
        } catch (e) { message.error(`锚定失败：${e instanceof Error ? e.message : String(e)}`) } finally { setMemSaving(false) }
    }

    return (
        <div className="sw-aside-float">
            <aside className="sw-panel sw-aside-panel">
                <div className="sw-rtabs">
                    {([['members', '成员状态'], ['memory', '团队记忆'], ['decisions', '决策']] as const).map(([k, l]) => (
                        <div key={k} className={`sw-rtabs__item${tab === k ? ' is-on' : ''}`} onClick={() => setTab(k)}>{l}</div>
                    ))}
                </div>
                <div className="sw-panel__body">
                    {tab === 'members' && (members || []).map((m) => {
                        const motion = memberState(m.agentId, m.role)
                        const bub = motion === 'working' ? 'work' : motion === 'cheer' ? 'work' : motion === 'error' ? 'think' : 'idle'
                        const label = motion === 'working' ? '执行中' : motion === 'cheer' ? '已完成' : motion === 'error' ? '受阻' : '待命'
                        return (
                            <div key={m.id || m.agentId} className="sw-mrow">
                                <div className="sw-mrow__pa-wrap">
                                    <div className={`sw-mrow__pa${members[0]?.agentId === m.agentId ? ' sw-mrow__pa--lead' : ''}`}>
                                        <PixelAgent appearance={appearanceOf(m.agentId)} size={34} motion={bub === 'work'} state={motion === 'working' ? 'working' : motion === 'cheer' ? 'cheer' : motion === 'error' ? 'error' : 'idle'}/>
                                    </div>
                                    <div className={`sw-mrow__bubble sw-mrow__bubble--${bub}`}/>
                                </div>
                                <div className="sw-mrow__info">
                                    <div className="sw-mrow__name">{memberLabel(m, agents)}{members[0]?.agentId === m.agentId ? ' · 主管' : ''}</div>
                                    <div className="sw-mrow__role">{m.role || '成员'}</div>
                                </div>
                                <span className={`sw-mrow__state sw-mrow__state--${bub === 'work' ? 'work' : 'idle'}`}>{label}</span>
                            </div>
                        )
                    })}
                    {tab === 'memory' && (
                        <>
                            {memories.map((m) => (
                                <div key={m.id} className="sw-mem">
                                    <div className="sw-mem__head">
                                        <span className="sw-mem__key">{m.key}</span>
                                        <span className="sw-mem__cat">{m.category}</span>
                                        <Button variant="ghost" size="sm" aria-label="删除记忆" onClick={() => void deleteSquadMemory(m.id, squadId).then(() => reload())}><Trash2 size={12}/></Button>
                                    </div>
                                    <div className="sw-mem__body">{m.content}</div>
                                </div>
                            ))}
                            {memories.length === 0 && <Empty description="暂无记忆——下方锚定第一条"/>}
                            <div className="sw-mem-add">
                                <Input autoComplete="off" placeholder="键名，如：统一返回结构" value={memKey} onChange={(e) => setMemKey(e.target.value)}/>
                                <Input.TextArea autoComplete="off" rows={2} placeholder="记忆内容…" value={memContent} onChange={(e) => setMemContent(e.target.value)}/>
                                <div className="sw-mem-add__row">
                                    <Select
                                        style={{width: 110}}
                                        size="small"
                                        value={memCat}
                                        onChange={(v) => setMemCat(v as SquadMemoryCategory)}
                                        options={[{label: '通用', value: 'general'}, {label: '决策', value: 'decision'}, {label: '代码范式', value: 'code_pattern'}]}
                                    />
                                    <Button variant="solid" size="sm" loading={memSaving} disabled={!memKey.trim() || !memContent.trim()} onClick={() => void handleSave()}><Send size={13}/> 锚定</Button>
                                </div>
                            </div>
                        </>
                    )}
                    {tab === 'decisions' && (
                        (board?.decisions?.length ?? 0) === 0
                            ? <Empty description="当前会话暂无决策卡"/>
                            : (board?.decisions || []).map((d, i) => (
                                <div key={i} className="sw-mem">
                                    <div className="sw-mem__head"><span className="sw-mem__key">{d.kind}</span></div>
                                    <div className="sw-mem__body">{d.text}</div>
                                </div>
                            ))
                    )}
                </div>
            </aside>
        </div>
    )
})


