import {memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject} from 'react'
import {useNavigate, useParams} from 'react-router-dom'
import {ArrowLeft, Brain, Plus, Send, Trash2} from 'lucide-react'
import {listen} from '@tauri-apps/api/event'
import {invoke} from '@tauri-apps/api/core'
import {notifyOSWhenHidden} from '@/utils/osNotify'
import {Button, Empty, Input, Popconfirm, Select, Spin} from '@/components/ui'
import {useNotify} from '@/components/ui/notify'
import {PixelAgent, type AgentMotionState} from '@/components/ui/pixel-agent'
import {MarkdownRenderer} from '@/components/markdown/MarkdownRenderer'
import {getSquad, listSquadSessions, listSquadRounds, deleteSquadSession, listSquadMemories, anchorSquadMemory, deleteSquadMemory} from '@/core/mapper/squad-mapper'
import {listAgents} from '@/core/mapper/agent-mapper'
import type {AgentInfo, SquadInfo, SquadSession, SquadMemory, SquadMemoryCategory} from '@/types/core'
import {memberLabel, agentAppearanceOf, type BoardRound, type SquadBoardView} from './index'
// 舞台背景：开放式像素会议室（无会议桌，开阔地板，4:3，全屏填充）
import ROOM_BG from '@/assets/images/squad-meeting-room-open.png'

const ACTIVE_STATUSES = ['running', 'paused', 'awaiting_plan', 'awaiting_checkpoint', 'awaiting_delivery']
const STATUS_PILL: Record<string, {label: string; cls: string}> = {
    running: {label: '运行中', cls: 'live'},
    paused: {label: '已暂停', cls: 'muted'},
    awaiting_plan: {label: '⏸ 计划待批准', cls: 'await'},
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
 * 开放式会议室座位（舞台坐标百分比，对齐 squad-meeting-room-open.png 4:3）。
 * 舞台全高铺满，背景 object-fit:fill 拉伸到面板，百分比相对整个舞台。
 * 地面从画面 y≈52%（墙脚）开始——后排必须站在地上，不能浮在窗上。
 * 人多时按前→中→后铺开，前后错位避免叠在一起。
 *
 * depth: 'near' 前/中排（大） / 'far' 靠窗后排（小，但脚仍落地）
 */
const SEATS: Array<{x: number; y: number; depth: 'near' | 'far'}> = [
    // —— 后排：墙脚地面（y≈54%，脚在 y≈63%）——
    {x: 20, y: 54.5, depth: 'far'},
    {x: 34, y: 53.8, depth: 'far'},
    {x: 48, y: 53.2, depth: 'far'},
    {x: 62, y: 53.8, depth: 'far'},
    {x: 76, y: 54.5, depth: 'far'},
    {x: 12, y: 55.2, depth: 'far'},
    {x: 88, y: 55.2, depth: 'far'},
    // —— 中排（y≈64%）——
    {x: 26, y: 64.5, depth: 'near'},
    {x: 40, y: 64.0, depth: 'near'},
    {x: 54, y: 64.8, depth: 'near'},
    {x: 68, y: 64.2, depth: 'near'},
    {x: 14, y: 65.5, depth: 'near'},
    {x: 82, y: 65.0, depth: 'near'},
    // —— 前排（y≈78%，脚踩近处地面）——
    {x: 18, y: 78.5, depth: 'near'},
    {x: 32, y: 78.0, depth: 'near'},
    {x: 46, y: 78.8, depth: 'near'},
    {x: 60, y: 78.2, depth: 'near'},
    {x: 74, y: 78.6, depth: 'near'},
    {x: 8, y: 79.5, depth: 'near'},
    {x: 88, y: 79.0, depth: 'near'},
]
/** 座位角色标签（按协作模式）：与 SEATS 顺序一一对应 */
const SEAT_LABELS: Record<string, string[]> = {
    orchestrator: ['主管 · 调度', '执行 A', '执行 B', '执行 C', '执行 D', '执行 E', '执行 F', '支持', '支持', '支持', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听'],
    pipeline: ['工位 1', '工位 2', '工位 3', '工位 4', '工位 5', '工位 6', '工位 7', '记录', '记录', '记录', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听'],
    chat: ['发言', '倾听', '倾听', '倾听', '思考', '思考', '思考', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听', '旁听'],
}
/** 前排（气泡挂到小人下方）的判定阈值 */
const FRONT_ROW_Y = 72

/** 按模式与人数取落座表：按 SEATS 从后→前铺开（后排先落墙脚地面） */
function seatSpots(mode: string, n: number): Array<{x: number; y: number; role: string; depth: 'near' | 'far'}> {
    const labels = SEAT_LABELS[mode] || SEAT_LABELS.orchestrator
    const count = Math.max(n, 1)
    return Array.from({length: count}, (_, i) => {
        const seat = SEATS[i % SEATS.length]
        return {x: seat.x, y: seat.y, role: labels[i % labels.length], depth: seat.depth}
    })
}

/** 轮次内容 → 纯文本（舞台气泡允许较长文本，超长由气泡滚动条承接） */
function plainText(src: string, max = 240): string {
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

/** 小分队工作台（像素舞台 v3，严格按设计稿 .workspace/.future/小分队/UI设计稿/小分队工作台-UI设计稿.html） */
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

    // 工作台观看心跳：后端审批梯度判定输入（看界面→挂起等决策；不在→通知 120s×2 后低危自动批）
    useEffect(() => {
        if (!id) return
        void invoke('squad_watch_heartbeat', {squadId: id})
        const t = setInterval(() => void invoke('squad_watch_heartbeat', {squadId: id}), 5000)
        return () => {
            clearInterval(t)
            void invoke('squad_watch_off', {squadId: id})
        }
    }, [id])

    // 成员审批独立事件通道（2026-10-01 复盘 P3）：后端成员审批改发 squad-awaiting-approval，
    // agent-studio 全局桥（只订阅 agent-awaiting-approval）不再把成员审批误路由进单 Agent 会话。
    // 通知走统一系统通知通道：窗口聚焦时不弹、失焦时节流，且遵守客户端通知开关；
    // 另以 approvalId 去重，防同一挂起事件重发导致 Windows Toast 连弹；具体批准仍在工作台卡片完成。
    const seenApprovalIdsRef = useRef<Set<string>>(new Set())
    useEffect(() => {
        let un: (() => void) | undefined
        void listen<{toolName?: string; approvalId?: string; squadId?: string}>('squad-awaiting-approval', (e) => {
            // 按队过滤：后台其他编队的成员审批不串进当前工作台的卡片/通知。
            if (id && e.payload?.squadId && e.payload.squadId !== id) return
            const tool = e.payload?.toolName || '敏感操作'
            const approvalId = e.payload?.approvalId
            if (approvalId) {
                setPendingApprovals((q) => q.some((x) => x.approvalId === approvalId) ? q : [...q, {approvalId, toolName: tool}])
                if (seenApprovalIdsRef.current.has(approvalId)) return
                seenApprovalIdsRef.current.add(approvalId)
            }
            // watched=true 时后端会等界面决策；watched=false 才有 120s×2 低危兜底，通知不再误承诺自动批准。
            void notifyOSWhenHidden('小分队请求授权', `${tool} 等待审批，请在工作台处理`).catch(() => {})
        }).then((f) => { un = f })
        return () => un?.()
    }, [id])
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
    // 手动无人值守开关：开 = 该队审批/门禁不再等决策（低危自动按推荐方案，L3 高危仍挂起）
    const [unattended, setUnattended] = useState(false)
    // 成员待审批卡（工作台可见即可批；后端 120s×2 兜底自动批）
    const [pendingApprovals, setPendingApprovals] = useState<Array<{ approvalId: string; toolName: string }>>([])

    // 后端返回 false = approvalId 已超时/已由取消或自动策略消费；此时不能把卡片静默移除，
    // 否则用户会以为「批准」成功但成员仍停在别的审批上。
    const resolveMemberApproval = useCallback(async (approvalId: string, decision: 'approve' | 'skip') => {
        try {
            const ok = await invoke<boolean>('squad_member_approval_resolve', {approvalId, decision})
            if (ok) {
                setPendingApprovals((q) => q.filter((x) => x.approvalId !== approvalId))
            } else {
                message.warning('该授权请求已失效或已被其他路径处理，请刷新审批列表')
            }
        } catch (e) {
            message.error(`授权决议失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }, [message])

    // 待审批列表对账（2026-10-01 复盘 P1）：此前审批卡只能靠挂起瞬间的实时事件出现，
    // 页面刷新/切走再回来/晚打开工作台都会永久丢卡——后端还在挂起、通知还在发，界面无卡。
    // 现在挂载即拉取 + 与观看心跳同频对账；后端列表是唯一事实源，超时/取消的僵尸卡一并清掉。
    const refreshPendingApprovals = useCallback(async () => {
        if (!id) return
        try {
            const rows = await invoke<Array<[string, string]>>('squad_pending_approvals', {squadId: id})
            setPendingApprovals(rows.map(([approvalId, toolName]) => ({approvalId, toolName})))
        } catch {
            // 拉取失败保留本地卡不清空，等下一轮对账
        }
    }, [id])
    useEffect(() => {
        if (!id) return
        void refreshPendingApprovals()
        const t = setInterval(() => void refreshPendingApprovals(), 5000)
        return () => clearInterval(t)
    }, [id, refreshPendingApprovals])

    function toggleUnattended() {
        const next = !unattended
        setUnattended(next)
        if (id) void invoke('squad_set_unattended', {squadId: id, on: next})
        message.info(next ? '已开启无人值守：审批将按推荐方案自动通过（高危除外）' : '已恢复人工决策模式')
    }
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
        const t = setInterval(() => { void reloadSessions() }, 10000)
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
    // 呼吸灯：谁在发言谁亮——事件状态优先，其次取最新一轮的发言者
    const lastSpeakerId = rounds.length ? (rounds[rounds.length - 1].speakerAgentId ?? null) : null
    /**
     * 成员动作状态（舞台用）：
     * - working/cheer/error：成员事件优先（执行中保持不动）
     * - speaking：当前发言者（保持不动）
     * - waiting：会话暂停 / 待审批门禁
     * - idle：其余（含运行中非发言者 → 走动）
     */
    const memberState = useCallback((agentId: string, role: string): string => {
        const ev = memberMotion[role]
        if (ev && ev !== 'idle') return ev
        const st = selectedSession?.status
        if (st === 'paused' || (st && st.startsWith('awaiting'))) return 'waiting'
        if (isRunning && agentId === lastSpeakerId) return 'speaking'
        return 'idle'
    }, [memberMotion, isRunning, lastSpeakerId, selectedSession?.status])

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
                        <Button variant={unattended ? 'solid' : 'ghost'} size="sm" aria-label="无人值守开关" title={unattended ? '无人值守：开启中（低危审批自动按推荐方案通过，高危仍挂起）' : '无人值守：关（审批通知你处理）'} onClick={toggleUnattended}>无人值守</Button>
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
                                        {!active && (
                                            <Popconfirm
                                                title="删除该协作记录"
                                                description="将一并清除该会话的轮次与交接数据，不可恢复。"
                                                okText="删除"
                                                cancelText="取消"
                                                okButtonProps={{danger: true}}
                                                onConfirm={() => void deleteSquadSession(s.id).then(() => { if (selected === s.id) selectSessionLocal(null); void reloadSessions() })}
                                            >
                                                <Button variant="ghost" size="sm" aria-label="删除" title="删除记录">🗑</Button>
                                            </Popconfirm>
                                        )}
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
                        pendingApprovals={pendingApprovals}
                        onApprove={(id) => void resolveMemberApproval(id, 'approve')}
                        onSkip={(id) => void resolveMemberApproval(id, 'skip')}
                    />

                    {/* 对话视图：底部审批条；舞台视图改为气泡，见 StageView */}
                    {view === 'dialog' && pendingApprovals.map((pa) => (
                        <div key={pa.approvalId} className="sw-round sw-round--gate">
                            <div className="sw-round__pa sw-round__pa--user">批</div>
                            <div className="sw-round__body">
                                <div className="sw-round__head"><span className="sw-round__name">授权请求</span><span className="sw-badge sw-badge--gate">成员待审批</span></div>
                                <div className="sw-round__content">
                                    成员请求执行：{pa.toolName}
                                    <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                        <Button variant="solid" size="sm" onClick={() => void resolveMemberApproval(pa.approvalId, 'approve')}>批准</Button>
                                        <Button variant="outline" size="sm" onClick={() => void resolveMemberApproval(pa.approvalId, 'skip')}>跳过</Button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
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
                                <div className="sw-input-box sw-inject-box">
                                    <div className="sw-input-box__resizer" title="向上拖动调整输入框高度" onMouseDown={startInputResize}/>
                                    <div className="sw-inject-bar">
                                        <span className="sw-modebar__label">目标</span>
                                        {(squad.members || []).map((m) => (
                                            <div key={m.id || m.agentId} className={`sw-member-pick${injectTarget === m.agentId ? ' is-on' : ''}`} onClick={() => setInjectTarget(m.agentId)}>
                                                <div className="sw-member-pick__pa"><PixelAgent appearance={appearanceOf(m.agentId)} size={20}/></div>
                                                {memberLabel(m, agents)}
                                            </div>
                                        ))}
                                    </div>
                                    <div className="sw-inject-bar">
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
                                    <textarea rows={2} placeholder="补充说明、纠偏指令…" value={injectText} onChange={(e) => setInjectText(e.target.value)} style={{height: inputHeight}}/>
                                    <div className="sw-input-box__footer">
                                        <span className="sw-inject-hint">
                                            {(() => {
                                                const t = (squad.members || []).find((m) => m.agentId === injectTarget)
                                                return t ? `将送达：${memberLabel(t, agents)}` : '先在上方选择一位成员'
                                            })()}
                                        </span>
                                        <Button variant="solid" size="sm" disabled={injectBusy || !injectText.trim()} onClick={() => void handleInject()}>{injectBusy ? '发送中…' : '发送'}</Button>
                                    </div>
                                </div>
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

/** 舞台气泡打字机：固定宽度+高度，流式输出，超长可滚动且自动滚到底 */
function StageTypewriter({text, speed = 24}: {text: string; speed?: number}) {
    const [shown, setShown] = useState(0)
    const bodyRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!text) {
            setShown(0)
            return
        }
        setShown(0)
        const id = window.setInterval(() => {
            setShown((n) => {
                if (n >= text.length) {
                    window.clearInterval(id)
                    return n
                }
                return n + 1
            })
        }, speed)
        return () => window.clearInterval(id)
    }, [text, speed])
    // 新内容出来后自动向下滚动，保证最新字可见
    useEffect(() => {
        const el = bodyRef.current
        if (!el) return
        el.scrollTop = el.scrollHeight
    }, [shown, text])
    if (!text) return null
    return (
        <div ref={bodyRef} className="sw-walker__say__body">
            {shown >= text.length ? text : text.slice(0, shown)}
            {shown < text.length && <span className="sw-walker__say__caret">▌</span>}
        </div>
    )
}

/** 按 agentId 稳定散列 → 每人步频/相位（路径改由斥力引力模拟驱动） */
function walkStyleFor(agentId: string, index: number): Record<string, string> {
    let h = (index + 1) * 2654435761
    for (let i = 0; i < agentId.length; i += 1) h = (Math.imul(h, 31) + agentId.charCodeAt(i)) >>> 0
    return {
        'walk-delay': `${-((h % 17) * 0.07)}s`,
        'walk-bob': `${0.38 + ((h >> 5) % 5) * 0.04}s`,
    }
}

/**
 * 舞台群体游走：全场自由移动 + 相邻相斥、过远相吸（简化 boids）。
 * - 忙（发言/执行/等待）的成员速度衰减到 0，定在原地；
 * - 地板边界内活动（不穿墙、不飘上天花板）。
 */
type WalkerBody = {
    id: string
    x: number
    y: number
    vx: number
    vy: number
    flip: boolean
}

const WALK_BOUNDS = { minX: 5, maxX: 94, minY: 52, maxY: 90 }
const WALK_SEP = 5.5   // % 单位：小于此距相斥
const WALK_COH = 16    // % 单位：大于此距相吸
const WALK_SPEED = 0.22 // 每 tick 最大位移（%）
const WALK_TICK_MS = 80

function useStageWalk(
    keys: string[],
    spawn: Array<{x: number; y: number}>,
    frozen: boolean[],
): WalkerBody[] {
    const bodiesRef = useRef<WalkerBody[]>([])
    const frozenRef = useRef(frozen)
    frozenRef.current = frozen

    // 初始化 / 成员变化时重播种（从座位出发）
    useEffect(() => {
        const prev = bodiesRef.current
        const next = keys.map((id, i) => {
            const old = prev.find((p) => p.id === id)
            const s = spawn[i] || spawn[i % Math.max(spawn.length, 1)] || { x: 50, y: 70 }
            return old ?? {
                id,
                x: s.x,
                y: s.y,
                vx: (Math.random() - 0.5) * 0.15,
                vy: (Math.random() - 0.5) * 0.1,
                flip: false,
            }
        })
        bodiesRef.current = next
    }, [keys.join('|'), spawn.length])

    const [tick, setTick] = useState(0)
    useEffect(() => {
        const timer = window.setInterval(() => {
            const list = bodiesRef.current
            const frz = frozenRef.current
            for (let i = 0; i < list.length; i += 1) {
                const a = list[i]
                if (frz[i]) {
                    // 定住：速度快速衰减，位移清零
                    a.vx *= 0.55
                    a.vy *= 0.55
                    if (Math.abs(a.vx) < 0.01) a.vx = 0
                    if (Math.abs(a.vy) < 0.01) a.vy = 0
                    continue
                }
                // 游走噪声（缓慢转弯）
                a.vx += (Math.random() - 0.5) * 0.06
                a.vy += (Math.random() - 0.5) * 0.05

                // 斥力 / 引力
                for (let j = 0; j < list.length; j += 1) {
                    if (j === i) continue
                    const b = list[j]
                    const dx = a.x - b.x
                    const dy = a.y - b.y
                    const d = Math.hypot(dx, dy) || 0.01
                    if (d < WALK_SEP) {
                        const k = (WALK_SEP - d) / WALK_SEP * 0.09
                        a.vx += (dx / d) * k
                        a.vy += (dy / d) * k
                    } else if (d > WALK_COH) {
                        const k = Math.min(0.05, (d - WALK_COH) / WALK_COH * 0.04)
                        a.vx -= (dx / d) * k
                        a.vy -= (dy / d) * k
                    }
                }

                // 限速
                const sp = Math.hypot(a.vx, a.vy)
                if (sp > WALK_SPEED) {
                    a.vx = (a.vx / sp) * WALK_SPEED
                    a.vy = (a.vy / sp) * WALK_SPEED
                }

                a.x += a.vx
                a.y += a.vy * 0.65 // 纵向稍慢（地板透视）

                // 边界：碰边减速转向
                if (a.x < WALK_BOUNDS.minX) { a.x = WALK_BOUNDS.minX; a.vx = Math.abs(a.vx) * 0.6 }
                if (a.x > WALK_BOUNDS.maxX) { a.x = WALK_BOUNDS.maxX; a.vx = -Math.abs(a.vx) * 0.6 }
                if (a.y < WALK_BOUNDS.minY) { a.y = WALK_BOUNDS.minY; a.vy = Math.abs(a.vy) * 0.6 }
                if (a.y > WALK_BOUNDS.maxY) { a.y = WALK_BOUNDS.maxY; a.vy = -Math.abs(a.vy) * 0.6 }

                if (Math.abs(a.vx) > 0.02) a.flip = a.vx < 0
            }
            setTick((t) => t + 1)
        }, WALK_TICK_MS)
        return () => window.clearInterval(timer)
    }, [])

    // tick 变化时返回最新位置（ref 可变对象，需要触发重渲染）
    return useMemo(() => bodiesRef.current, [tick])
}

/** 像素舞台：开放会议室 + 走动待机 + 发言/审批气泡 + 表情动作 */
const StageView = memo(function StageView({mode, members, agents, spots, appearanceOf, memberState, lastWords, systemWord, activeSpeakerId, chatCard, canInject, onPick, pendingApprovals, onApprove, onSkip}: {
    mode: string; members: Members; agents: AgentInfo[];
    spots: Array<{x: number; y: number; role: string; depth: 'near' | 'far'}>;
    appearanceOf: AppearanceOf; memberState: (agentId: string, role: string) => string;
    lastWords: Record<string, string>; systemWord: string; activeSpeakerId: string | null;
    chatCard: string | null; canInject: boolean;
    onPick: (agentId: string) => void;
    pendingApprovals?: Array<{approvalId: string; toolName: string}>;
    onApprove?: (id: string) => void;
    onSkip?: (id: string) => void;
}) {
    // PixelAgent 动作状态：与 memberState 对齐（含 waiting/thinking/speaking 等）
    const agentMotion = (motion: string): AgentMotionState => {
        if (motion === 'speaking' || motion === 'working' || motion === 'thinking' || motion === 'waiting'
            || motion === 'cheer' || motion === 'error' || motion === 'handoff') {
            return motion as AgentMotionState
        }
        return 'idle'
    }
    const isBusyPose = (motion: string) =>
        motion === 'speaking' || motion === 'working' || motion === 'thinking' || motion === 'waiting'
        || motion === 'cheer' || motion === 'error' || motion === 'handoff'

    const memberList = members || []
    const walkKeys = memberList.map((m, i) => m.agentId || String(i))
    const spawn = memberList.map((_, i) => {
        const s = spots[i % spots.length] || { x: 50, y: 70 }
        return { x: s.x, y: s.y }
    })
    const frozenFlags = memberList.map((m) => isBusyPose(memberState(m.agentId, m.role)))
    const bodies = useStageWalk(walkKeys, spawn, frozenFlags)
    const bodyOf = (id: string, fallbackIndex: number) =>
        bodies.find((b) => b.id === id) || bodies[fallbackIndex] || { x: 50, y: 70, flip: false, vx: 0, vy: 0, id }

    return (
        <div className="sw-stage" data-mode={mode}>
            <div className="sw-scene-frame">
                <img className="sw-scene__bg" src={ROOM_BG} alt="" draggable={false}/>
                {(members || []).map((m, i) => {
                    const spot = spots[i % spots.length]
                    const motion = memberState(m.agentId, m.role)
                    const anim = isBusyPose(motion) ? `is-${motion}` : 'is-idle'
                    const word = lastWords[m.agentId] || ''
                    const talking = motion === 'speaking' || motion === 'working'
                    const showWord = !!word && (talking || m.agentId === activeSpeakerId)
                    const far = spot.depth === 'far'
                    const walk = walkStyleFor(m.agentId || String(i), i)
                    const body = bodyOf(m.agentId || String(i), i)
                    return (
                        <div
                            key={m.id || i}
                            className={`sw-walker ${anim}${far ? ' is-far' : ' is-near'}${body.y >= FRONT_ROW_Y ? ' is-front' : ''}${chatCard === m.agentId ? ' is-selected' : ''}${showWord ? ' has-word' : ''}${body.flip ? ' is-flip' : ''}`}
                            style={{
                                left: `${body.x}%`,
                                top: `${body.y}%`,
                                '--walk-delay': walk['walk-delay'],
                                '--walk-bob': walk['walk-bob'],
                            } as CSSProperties}
                            onClick={(e) => { e.stopPropagation(); if (!canInject) return; onPick(m.agentId) }}
                            title={memberLabel(m, agents)}
                        >
                            {showWord && (
                                <div className={`sw-walker__say${talking ? ' is-talking' : ''}`}>
                                    <StageTypewriter text={word} speed={talking ? 18 : 28}/>
                                </div>
                            )}
                            <div className="sw-walker__glow"/>
                            <div className="sw-walker__pa">
                                <PixelAgent
                                    appearance={appearanceOf(m.agentId)}
                                    size={far ? 44 : 64}
                                    motion={isBusyPose(motion)}
                                    state={agentMotion(motion)}
                                />
                            </div>
                            <div className="sw-walker__name">{memberLabel(m, agents)} · {spot.role}</div>
                        </div>
                    )
                })}
                {/* 系统机器人：左上角盆栽桌；系统消息 / 审批都走气泡 */}
                <div className={`sw-robot-stand is-table${(systemWord || pendingApprovals?.length) ? ' has-word' : ''}`} style={{left: '10%', top: '52%'}} title="系统">
                    {(systemWord || pendingApprovals?.length) ? (
                        <div className="sw-walker__say is-sys">
                            {systemWord && <StageTypewriter text={systemWord} speed={20}/>}
                            {pendingApprovals?.map((pa) => (
                                <div key={pa.approvalId} className="sw-say-approval">
                                    <div className="sw-say-approval__title">⚠ 授权请求</div>
                                    <div className="sw-say-approval__tool">{pa.toolName}</div>
                                    <div className="sw-say-approval__actions">
                                        <button type="button" className="sw-say-approval__btn is-ok" onClick={(e) => { e.stopPropagation(); onApprove?.(pa.approvalId) }}>批准</button>
                                        <button type="button" className="sw-say-approval__btn" onClick={(e) => { e.stopPropagation(); onSkip?.(pa.approvalId) }}>跳过</button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    <div className="sw-walker__pa"><RobotPixel size={28}/></div>
                    <div className="sw-walker__name">系统</div>
                </div>
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
                                        <Popconfirm
                                            title="删除该条记忆"
                                            description="删除后不再参与召回锚定，不可恢复。"
                                            okText="删除"
                                            cancelText="取消"
                                            okButtonProps={{danger: true}}
                                            onConfirm={() => void deleteSquadMemory(m.id, squadId).then(() => reload())}
                                        >
                                            <Button variant="ghost" size="sm" aria-label="删除记忆"><Trash2 size={12}/></Button>
                                        </Popconfirm>
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


