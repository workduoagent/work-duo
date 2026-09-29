import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {useNavigate, useParams} from 'react-router-dom'
import {ArrowLeft, Brain, Plus, Send, Trash2} from 'lucide-react'
import {listen} from '@tauri-apps/api/event'
import {invoke} from '@tauri-apps/api/core'
import {Button, Empty, Input, Select, Spin} from '@/components/ui'
import {useNotify} from '@/components/ui/notify'
import {PixelAgent} from '@/components/ui/pixel-agent'
import {MarkdownRenderer} from '@/components/markdown/MarkdownRenderer'
import {getSquad, listSquadSessions, listSquadRounds, deleteSquadSession, listSquadMemories, anchorSquadMemory, deleteSquadMemory, type AnchorSquadMemoryInput} from '@/core/mapper/squad-mapper'
import {listAgents} from '@/core/mapper/agent-mapper'
import type {AgentInfo, SquadInfo, SquadSession, SquadMemory, SquadMemoryCategory} from '@/types/core'
import {memberLabel, agentAppearanceOf, type BoardRound, type SquadBoardView} from './index'

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
    orchestrator: {ico: '⚡', label: '编排式', desc: '主管委派'},
    pipeline: {ico: '🔗', label: '流水线', desc: '线性接力'},
    chat: {ico: '💬', label: '群聊', desc: '圆桌发言'},
}
const ROUND_BADGE: Record<string, {label: string; cls: string}> = {
    system: {label: '系统', cls: 'sys'}, plan: {label: '委派规划', cls: 'plan'},
    subtask: {label: '发言', cls: 'msg'}, handoff: {label: '交接', cls: 'hand'},
    inject: {label: '插话', cls: 'inject'}, summary: {label: '汇总', cls: 'msg'},
    metrics: {label: '指标', cls: 'metrics'}, checkpoint: {label: '门禁', cls: 'gate'},
    delivery: {label: '交付', cls: 'gate'},
}
const WALKER_SPOTS: Record<string, Array<{x: number; y: number; role: string}>> = {
    orchestrator: [{x: 48, y: 28, role: '主管 · 调度'}, {x: 18, y: 55, role: '执行'}, {x: 38, y: 62, role: '执行'}, {x: 62, y: 58, role: '执行'}, {x: 82, y: 52, role: '支持'}, {x: 8, y: 40, role: '待命'}, {x: 90, y: 30, role: '待命'}, {x: 70, y: 30, role: '待命'}, {x: 28, y: 30, role: '待命'}, {x: 55, y: 45, role: '待命'}],
    pipeline: [{x: 22, y: 58, role: '工位1'}, {x: 48, y: 58, role: '工位2'}, {x: 74, y: 58, role: '工位3'}, {x: 35, y: 35, role: '调度'}, {x: 88, y: 35, role: '记录'}, {x: 8, y: 35, role: '待命'}, {x: 60, y: 35, role: '待命'}, {x: 15, y: 70, role: '待命'}, {x: 65, y: 70, role: '待命'}, {x: 90, y: 60, role: '待命'}],
    chat: [{x: 35, y: 48, role: '发言'}, {x: 65, y: 48, role: '倾听'}, {x: 30, y: 68, role: '思考'}, {x: 70, y: 68, role: '倾听'}, {x: 50, y: 72, role: '主笔'}, {x: 10, y: 55, role: '旁听'}, {x: 88, y: 55, role: '旁听'}, {x: 15, y: 30, role: '旁听'}, {x: 82, y: 30, role: '旁听'}, {x: 50, y: 40, role: '旁听'}],
}

/** 场景像素画（按协作模式）：办公室 / 流水线车间 / 会议室（设计稿 sceneSVG 移植） */
function sceneSVG(mode: string): string {
    const P = 20, W = 32, H = 18
    const px = (x: number, y: number, w: number, h: number, fill: string) => `<rect x="${x * P}" y="${y * P}" width="${w * P}" height="${h * P}" fill="${fill}"/>`
    let s = `<svg viewBox="0 0 ${W * P} ${H * P}" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges">`
    if (mode === 'pipeline') {
        s += px(0, 0, 32, 2, '#37474f') + px(0, 2, 32, 11, '#546e7a')
        for (let i = 0; i < 4; i++) { s += px(2 + i * 8, 3, 5, 3, '#b3e5fc') + px(2 + i * 8, 3, 5, 1, '#81d4fa') }
        s += px(0, 13, 32, 5, '#78909c') + px(0, 13, 32, 1, '#607d8b')
        s += px(0, 15, 32, 2, '#455a64') + px(0, 15, 32, 1, '#546e7a')
        for (let i = 0; i < 32; i += 2) { s += px(i, 15, 1, 2, '#37474f') }
        s += px(1, 4, 4, 1, '#8d6e63') + px(1, 7, 4, 1, '#8d6e63') + px(1, 4, 1, 4, '#6d4c41') + px(4, 4, 1, 4, '#6d4c41')
        s += px(2, 5, 1, 1, '#ffb74d') + px(3, 5, 1, 1, '#4fc3f7') + px(2, 8, 1, 1, '#81c784')
        s += px(26, 4, 4, 1, '#8d6e63') + px(26, 7, 4, 1, '#8d6e63') + px(26, 4, 1, 4, '#6d4c41') + px(29, 4, 1, 4, '#6d4c41')
        s += px(27, 5, 1, 1, '#ff8a65') + px(28, 5, 1, 1, '#aed581')
        for (let i = 0; i < 32; i += 4) { s += px(i, 12, 2, 1, '#ffca28') + px(i + 2, 12, 2, 1, '#212121') }
        s += px(10, 4, 1, 9, '#455a64') + px(9, 3, 3, 1, '#fff59d')
        s += px(21, 4, 1, 9, '#455a64') + px(20, 3, 3, 1, '#fff59d')
    } else if (mode === 'chat') {
        s += px(0, 0, 32, 2, '#4e342e') + px(0, 2, 32, 11, '#8d6e63')
        s += px(10, 3, 12, 6, '#eceff1') + px(10, 3, 12, 1, '#cfd8dc')
        s += px(11, 4, 6, 3, '#90caf9') + px(18, 4, 3, 1, '#a5d6a7') + px(18, 6, 3, 1, '#ffcc80')
        s += px(9, 2, 1, 8, '#5d4037') + px(22, 2, 1, 8, '#5d4037')
        s += px(2, 4, 3, 3, '#ffcc80') + px(2, 4, 3, 1, '#ffb74d')
        s += px(27, 4, 3, 3, '#80cbc4') + px(27, 4, 3, 1, '#4db6ac')
        s += px(0, 13, 32, 5, '#5d4037') + px(6, 14, 20, 3, '#6d4c41')
        s += px(12, 15, 8, 2, '#a1887f') + px(13, 17, 6, 1, '#8d6e63') + px(14, 14, 4, 1, '#bcaaa4')
        ;[[11, 15], [20, 15], [11, 17], [20, 17], [15, 18], [18, 18]].forEach(([x, y]) => { s += px(x, y, 1, 1, '#5d4037') })
        s += px(0, 11, 1, 2, '#66bb6a') + px(31, 11, 1, 2, '#66bb6a') + px(0, 13, 1, 1, '#5d4037') + px(31, 13, 1, 1, '#5d4037')
        s += px(15, 2, 2, 1, '#fff59d') + px(16, 3, 1, 1, '#ffe082')
    } else {
        s += px(0, 0, 32, 2, '#3d2b1f') + px(0, 2, 32, 1, '#5c4033')
        s += px(0, 3, 32, 10, '#c4a574')
        for (let i = 0; i < 3; i++) {
            const wx = 3 + i * 10
            s += px(wx, 4, 7, 5, '#87ceeb') + px(wx + 1, 5, 2, 3, '#b0e0f0')
            s += px(wx, 4, 7, 1, '#5c4033') + px(wx, 8, 7, 1, '#5c4033') + px(wx + 3, 4, 1, 5, '#5c4033')
        }
        s += px(0, 13, 32, 5, '#d4a574') + px(0, 13, 32, 1, '#c4956a')
        for (let i = 0; i < 16; i++) { s += px(i * 2, 15, 1, 1, '#c4956a') + px(i * 2 + 1, 17, 1, 1, '#c4956a') }
        s += px(12, 4, 8, 5, '#f5f5f5') + px(12, 4, 8, 1, '#e0e0e0')
        s += px(13, 5, 3, 2, '#90caf9') + px(17, 5, 2, 2, '#a5d6a7') + px(13, 7, 5, 1, '#bdbdbd')
        s += px(11, 3, 1, 7, '#90a4ae') + px(20, 3, 1, 7, '#90a4ae')
        ;[[2, 14], [7, 14], [22, 14], [27, 14]].forEach(([x, y]) => {
            s += px(x, y, 3, 1, '#8d6e63') + px(x, y + 1, 1, 2, '#6d4c41') + px(x + 2, y + 1, 1, 2, '#6d4c41') + px(x + 1, y - 1, 1, 1, '#455a64')
        })
        s += px(24, 5, 6, 2, '#5c7a99') + px(24, 7, 6, 1, '#4a6a8a')
        s += px(0, 11, 1, 2, '#4caf50') + px(31, 11, 1, 2, '#4caf50') + px(0, 13, 1, 1, '#795548') + px(31, 13, 1, 1, '#795548')
    }
    return s + '</svg>'
}

/** 轮次内容渲染：metrics/handoff/JSON → 代码块；其余 → Markdown。 */
function renderRoundContent(kind: string, text: string) {
    const t = (text || '').trim()
    if (kind === 'metrics' || kind === 'handoff' || (t.startsWith('{') && t.endsWith('}'))) {
        try { return <pre className="sw-code">{JSON.stringify(JSON.parse(t), null, 2)}</pre> } catch { /* 非 JSON 走 markdown */ }
    }
    return <MarkdownRenderer className="sw-md" content={t}/>
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
    const [now, setNow] = useState(Date.now())

    const [injectTarget, setInjectTarget] = useState<string>('')
    const [injectMode, setInjectMode] = useState<'soft' | 'hard' | 'pre_talk'>('soft')
    const [injectText, setInjectText] = useState('')
    const [injectBusy, setInjectBusy] = useState(false)
    const [chatCard, setChatCard] = useState<string | null>(null)

    const [asideOpen, setAsideOpen] = useState(false)
    const [asideTab, setAsideTab] = useState<'members' | 'memory' | 'decisions'>('members')
    const [memberMotion, setMemberMotion] = useState<Record<string, string>>({})
    const [memories, setMemories] = useState<SquadMemory[]>([])
    const [memKey, setMemKey] = useState('')
    const [memContent, setMemContent] = useState('')
    const [memCat, setMemCat] = useState<SquadMemoryCategory>('general')
    const [memSaving, setMemSaving] = useState(false)

    const [planPending, setPlanPending] = useState(false)
    const [checkpointPending, setCheckpointPending] = useState(false)

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
    const reloadMemories = useCallback(async () => {
        if (!id) return
        try { setMemories(await listSquadMemories(id)) } catch { /* 容错 */ }
    }, [id])

    useEffect(() => {
        let alive = true
        ;(async () => {
            setLoading(true)
            try {
                const [sq, ags, sess, mems] = await Promise.all([
                    id ? getSquad(id) : Promise.resolve(undefined),
                    listAgents(),
                    id ? listSquadSessions(id) : Promise.resolve([] as SquadSession[]),
                    id ? listSquadMemories(id) : Promise.resolve([] as SquadMemory[]),
                ])
                if (!alive) return
                setSquad(sq); setAgents(ags); setSessions(sess); setMemories(mems)
                const active = sess.find((x) => ACTIVE_STATUSES.includes(x.status))
                if (active) setSelected(active.id)
            } finally { if (alive) setLoading(false) }
        })()
        return () => { alive = false }
    }, [id])

    useEffect(() => {
        const t = setInterval(() => { void reloadSessions(); setNow(Date.now()) }, 30000)
        return () => clearInterval(t)
    }, [reloadSessions])
    useEffect(() => {
        if (!isRunning) return
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
    }, [isRunning])

    useEffect(() => {
        let un: (() => void) | undefined
        void listen<{item: SquadMemory}>('agent-squad-memory-anchored', () => { void reloadMemories() }).then((f) => { un = f })
        return () => un?.()
    }, [reloadMemories])

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
                setRounds((r) => [...r, {role: pl.role, kind: pl.kind, content: pl.content, speakerAgentId: pl.speakerAgentId}])
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

    async function handleInject() {
        const text = injectText.trim()
        const target = selectedSession?.id ?? sessionIdRef.current
        if (!text) { message.error('请输入要补充的内容'); return }
        if (!injectTarget) { message.error('请选择插话目标（成员）'); return }
        if (!target) { message.error('协作尚未开始，无法插话'); return }
        setInjectBusy(true)
        try {
            await invoke<string>('squad_inject_send', {squadId: squad!.id, sessionId: target, taskId: injectTarget, content: text, mode: injectMode})
            message.success(injectMode === 'pre_talk' ? '预嘱已入队，将在其任务启动时生效' : injectMode === 'hard' ? '强打断已送达，将在该成员下一轮优先处理' : '已打断，将在该成员下一轮生效')
            setInjectText('')
        } catch (e) { message.error(`插话失败：${e instanceof Error ? e.message : String(e)}`) } finally { setInjectBusy(false) }
    }

    async function gateCall(cmd: string, args: Record<string, unknown>, okMsg: string) {
        try {
            await invoke(cmd, args); message.success(okMsg)
            setPlanPending(false); setCheckpointPending(false)
            void reloadSessions()
        } catch (e) { message.error(`操作失败：${e instanceof Error ? e.message : String(e)}`) }
    }

    async function handleMemorySave() {
        if (!memKey.trim() || !memContent.trim() || !squad) { message.error('键名与内容必填'); return }
        setMemSaving(true)
        try {
            const input: AnchorSquadMemoryInput = {squadId: squad.id, key: memKey.trim(), content: memContent.trim(), category: memCat}
            await anchorSquadMemory(input)
            message.success('记忆已锚定（下次协作注入生效）')
            setMemKey(''); setMemContent(''); void reloadMemories()
        } catch (e) { message.error(`锚定失败：${e instanceof Error ? e.message : String(e)}`) } finally { setMemSaving(false) }
    }

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
    const elapsed = liveSession && liveSession.status === 'running' ? Math.max(0, now - Number(liveSession.createdAt)) : 0
    const fmtElapsed = `${String(Math.floor(elapsed / 3600000)).padStart(2, '0')}:${String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0')}:${String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0')}`
    const spots = WALKER_SPOTS[mode] || WALKER_SPOTS.orchestrator
    const chatMember = chatCard ? (squad.members.find((m) => m.agentId === chatCard) || null) : null
    void boardTasks

    return (
        <div className="squads squads--detail sw">
            <header className="sw-topbar">
                <button className="sw-topbar__back" onClick={() => nav('/squads-workspace')} aria-label="返回列表"><ArrowLeft size={15}/></button>
                <div className="sw-topbar__logo">{(squad.name || '队').slice(0, 1)}</div>
                <div className="sw-topbar__id">
                    <div className="sw-topbar__name">{squad.name}</div>
                    <div className="sw-topbar__meta">
                        <span className="sw-pill sw-pill--mode">{MODE_META[mode]?.ico} {MODE_META[mode]?.label ?? mode}</span>
                        {liveSession && liveSession.status === 'running' && <span className="sw-pill sw-pill--live"><i className="sw-dot"/>运行中 · {fmtElapsed}</span>}
                        {squad.workspaceDir && <span className="sw-pill sw-pill--muted">📁 {squad.workspaceDir}</span>}
                    </div>
                </div>
                <div className="sw-topbar__spacer"/>
                <div className="sw-crew">
                    {(squad.members || []).map((m, i) => {
                        const st = memberMotion[m.role] === 'working' ? 'working' : isRunning && i === 0 ? 'working' : 'idle'
                        return (
                            <div key={m.id || i} className={`sw-crew__slot${isRunning && st === 'working' ? ' is-active' : ''}`} title={memberLabel(m, agents)}>
                                <PixelAgent appearance={agentAppearanceOf(agents, m.agentId)} size={26} motion={st === 'working'} state={st as 'working'}/>
                            </div>
                        )
                    })}
                </div>
            </header>

            <div className="sw-body">
                <aside className="sw-panel sw-side">
                    <div className="sw-side__cta">
                        <Button variant="solid" size="sm" block onClick={() => selectSessionLocal(null)}><Plus size={13}/> 新建任务</Button>
                        <Button variant="ghost" size="sm" aria-label="团队记忆" title="团队记忆（热更新）" onClick={() => { setAsideOpen(true); setAsideTab('memory'); void reloadMemories() }}><Brain size={14}/></Button>
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
                    <div className="sw-modebar">
                        <div className="sw-modebar__spacer"/>
                        <div className="sw-viewseg">
                            <div className={`sw-viewseg__item${view === 'dialog' ? ' is-on' : ''}`} onClick={() => setView('dialog')}>💬 对话</div>
                            <div className={`sw-viewseg__item${view === 'stage' ? ' is-on' : ''}`} onClick={() => setView('stage')}>🎮 舞台</div>
                        </div>
                    </div>

                    <div className="sw-stage">
                        <div className="sw-scene" dangerouslySetInnerHTML={{__html: sceneSVG(mode)}}/>
                        {(squad.members || []).map((m, i) => {
                            const spot = spots[i % spots.length]
                            const motion = memberMotion[m.role]
                            const anim = motion === 'working' || (isRunning && i === 0) ? 'is-working' : motion === 'speaking' ? 'is-speaking' : 'is-idle'
                            return (
                                <div
                                    key={m.id || i}
                                    className={`sw-walker ${anim}${chatCard === m.agentId ? ' is-selected' : ''}`}
                                    style={{left: `${spot.x}%`, top: `${spot.y}%`}}
                                    onClick={(e) => { e.stopPropagation(); if (!canInject) return; setInjectTarget(m.agentId); setInjectMode('soft'); setChatCard(m.agentId) }}
                                    title={memberLabel(m, agents)}
                                >
                                    <div className="sw-walker__glow"/>
                                    <div className="sw-walker__pa"><PixelAgent appearance={agentAppearanceOf(agents, m.agentId)} size={48} motion={anim !== 'is-idle'} state={anim === 'is-working' ? 'working' : anim === 'is-speaking' ? 'speaking' : 'idle'}/></div>
                                    <div className="sw-walker__name">{memberLabel(m, agents)} · {spot.role}</div>
                                </div>
                            )
                        })}
                        {chatMember && (
                            <div className="sw-chatcard" onClick={(e) => e.stopPropagation()}>
                                <div className="sw-chatcard__head">
                                    <div className="sw-chatcard__ava"><PixelAgent appearance={agentAppearanceOf(agents, chatMember.agentId)} size={32}/></div>
                                    <div className="sw-chatcard__name">{memberLabel(chatMember, agents)}</div>
                                    <button className="sw-chatcard__x" onClick={() => setChatCard(null)}>✕</button>
                                </div>
                                <div className="sw-chatcard__modes">
                                    <span>方式</span>
                                    {([['soft', '打断'], ['hard', '强打断'], ['pre_talk', '预嘱']] as const).map(([v, l]) => (
                                        <button key={v} className={`sw-chatcard__mode${injectMode === v ? ' is-on' : ''}`} onClick={() => setInjectMode(v)}>{l}</button>
                                    ))}
                                    <div className="sw-chatcard__mode-hint">
                                        {injectMode === 'soft' ? '打断：其下一轮生效' : injectMode === 'hard' ? '强打断：优先处理' : '预嘱：任务启动时注入'}
                                    </div>
                                </div>
                                <div className="sw-chatcard__row">
                                    <input
                                        placeholder={`对 ${memberLabel(chatMember, agents)} 说…`}
                                        value={injectText}
                                        onChange={(e) => setInjectText(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') void handleInject() }}
                                    />
                                    <button className="sw-chatcard__send" onClick={() => void handleInject()}>发送</button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="sw-timeline">
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
                                                    <Button variant="solid" size="sm" onClick={() => void gateCall('squad_plan_approve', {sessionId: selected, approved: true}, '计划已批准')}>批准计划</Button>
                                                    <Button variant="outline" size="sm" onClick={() => void gateCall('squad_plan_approve', {sessionId: selected, approved: false}, '已拒绝')}>拒绝</Button>
                                                </>
                                            ) : (
                                                <>
                                                    <Button variant="solid" size="sm" onClick={() => void gateCall('squad_checkpoint_resolve', {sessionId: selected, decision: 'continue'}, '继续执行')}>继续执行</Button>
                                                    <Button variant="outline" size="sm" onClick={() => void gateCall('squad_checkpoint_resolve', {sessionId: selected, decision: 'rework'}, '已要求返工')}>要求返工</Button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                        {selectedSession?.status === 'awaiting_delivery' && (
                            <div className="sw-round sw-round--gate">
                                <div className="sw-round__pa sw-round__pa--user">包</div>
                                <div className="sw-round__body">
                                    <div className="sw-round__head"><span className="sw-round__name">交付</span><span className="sw-badge sw-badge--gate">交付待确认</span></div>
                                    <div className="sw-round__content">
                                        协作已完成，等待交付确认。
                                        <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                            <Button variant="solid" size="sm" onClick={() => void gateCall('squad_delivery_resolve', {sessionId: selected, approved: true}, '已确认交付')}>确认交付</Button>
                                            <Button variant="outline" size="sm" onClick={() => void gateCall('squad_delivery_resolve', {sessionId: selected, approved: false}, '已要求修订')}>要求修订</Button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                        {rounds.map((r, i) => {
                            const badge = ROUND_BADGE[r.kind] || {label: r.kind, cls: 'sys'}
                            const speaker = r.speakerAgentId ? (squad.members.find((m) => m.agentId === r.speakerAgentId)) : null
                            const name = speaker ? memberLabel(speaker, agents) : r.role
                            const motion = speaker ? memberMotion[memberLabel(speaker, agents)] ?? memberMotion[speaker.role] : undefined
                            const anim = motion === 'working' ? 'working' : motion === 'cheer' ? 'cheer' : motion === 'error' ? 'error' : 'idle'
                            return (
                                <div key={i} className={`sw-round${badge.cls === 'sys' ? ' sw-round--sys' : ''}`}>
                                    <div className={`sw-round__pa${speaker && squad.members[0]?.agentId === speaker.agentId ? ' sw-round__pa--lead' : ''}`}>
                                        {speaker
                                            ? <PixelAgent appearance={agentAppearanceOf(agents, speaker.agentId)} size={28} motion={anim !== 'idle'} state={anim as 'idle'}/>
                                            : <span>系</span>}
                                    </div>
                                    <div className="sw-round__body">
                                        <div className="sw-round__head">
                                            <span className="sw-round__name">{name}</span>
                                            <span className={`sw-badge sw-badge--${badge.cls}`}>{badge.label}</span>
                                        </div>
                                        <div className="sw-round__content"><div className="sw-bubble">{renderRoundContent(r.kind, r.content)}</div></div>
                                    </div>
                                </div>
                            )
                        })}
                        {rounds.length === 0 && !isDraft && <div className="sw-round"><div className="sw-round__body"><div className="sw-round__content" style={{color: 'var(--color-foreground-muted)'}}>暂无轮次内容</div></div></div>}
                        {summary && (
                            <div className="sw-round sw-round--highlight">
                                <div className="sw-round__pa sw-round__pa--user">汇</div>
                                <div className="sw-round__body">
                                    <div className="sw-round__head"><span className="sw-round__name">最终汇总</span><span className="sw-badge sw-badge--msg">结论</span></div>
                                    <div className="sw-round__content"><div className="sw-bubble sw-bubble--hl">{summary}</div></div>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="sw-composer">
                        <div className="sw-composer__body">
                            {isDraft ? (
                                <div className="sw-input-row">
                                    <textarea rows={2} placeholder="描述这次要协作完成的任务…" value={prompt} onChange={(e) => setPrompt(e.target.value)}/>
                                    <button className="sw-send sw-send--in" disabled={!prompt.trim() || starting} onClick={() => void handleStart()}>{starting ? '启动中…' : '开始运行'}</button>
                                </div>
                            ) : canInject ? (
                                <>
                                    <div className="sw-composer__row">
                                        <span className="sw-modebar__label">目标</span>
                                        {(squad.members || []).map((m) => (
                                            <div key={m.id || m.agentId} className={`sw-member-pick${injectTarget === m.agentId ? ' is-on' : ''}`} onClick={() => setInjectTarget(m.agentId)}>
                                                <div className="sw-member-pick__pa"><PixelAgent appearance={agentAppearanceOf(agents, m.agentId)} size={20}/></div>
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
                                    <div className="sw-input-row">
                                        <textarea rows={2} placeholder="补充说明、纠偏指令…" value={injectText} onChange={(e) => setInjectText(e.target.value)}/>
                                        <button className="sw-send" disabled={injectBusy || !injectText.trim()} onClick={() => void handleInject()}>{injectBusy ? '发送中…' : '发送'}</button>
                                    </div>
                                </>
                            ) : (
                                <div className="sw-composer__row"><span className="sw-inject-hint">{selectedSession?.status === 'paused' ? '协作已暂停，可在左侧卡片恢复。' : selectedSession?.status === 'awaiting_delivery' ? '交付待确认：请在上方决议条操作。' : '该会话已结束，可重跑或新建任务。'}</span></div>
                            )}
                        </div>
                    </div>
                </main>
            </div>

            <div className={`sw-aside-float${asideOpen ? ' is-open' : ''}`}>
                <aside className="sw-panel sw-aside-panel">
                    <div className="sw-rtabs">
                        {([['members', '成员状态'], ['memory', '团队记忆'], ['decisions', '决策']] as const).map(([k, l]) => (
                            <div key={k} className={`sw-rtabs__item${asideTab === k ? ' is-on' : ''}`} onClick={() => setAsideTab(k)}>{l}</div>
                        ))}
                    </div>
                    <div className="sw-panel__body">
                        {asideTab === 'members' && (squad.members || []).map((m) => {
                            const motion = memberMotion[m.role]
                            const bub = motion === 'working' ? 'work' : motion === 'cheer' ? 'work' : motion === 'error' ? 'think' : 'idle'
                            const label = motion === 'working' ? '执行中' : motion === 'cheer' ? '已完成' : motion === 'error' ? '受阻' : '待命'
                            return (
                                <div key={m.id || m.agentId} className="sw-mrow">
                                    <div className="sw-mrow__pa-wrap">
                                        <div className={`sw-mrow__pa${squad.members[0]?.agentId === m.agentId ? ' sw-mrow__pa--lead' : ''}`}>
                                            <PixelAgent appearance={agentAppearanceOf(agents, m.agentId)} size={34} motion={bub === 'work'} state={motion === 'working' ? 'working' : motion === 'cheer' ? 'cheer' : motion === 'error' ? 'error' : 'idle'}/>
                                        </div>
                                        <div className={`sw-mrow__bubble sw-mrow__bubble--${bub}`}/>
                                    </div>
                                    <div className="sw-mrow__info">
                                        <div className="sw-mrow__name">{memberLabel(m, agents)}{squad.members[0]?.agentId === m.agentId ? ' · 主管' : ''}</div>
                                        <div className="sw-mrow__role">{m.role || '成员'}</div>
                                    </div>
                                    <span className={`sw-mrow__state sw-mrow__state--${bub === 'work' ? 'work' : 'idle'}`}>{label}</span>
                                </div>
                            )
                        })}
                        {asideTab === 'memory' && (
                            <>
                                {memories.map((m) => (
                                    <div key={m.id} className="sw-mem">
                                        <div className="sw-mem__head">
                                            <span className="sw-mem__key">{m.key}</span>
                                            <span className="sw-mem__cat">{m.category}</span>
                                            <Button variant="ghost" size="sm" aria-label="删除记忆" onClick={() => void deleteSquadMemory(m.id, squad!.id).then(() => reloadMemories())}><Trash2 size={12}/></Button>
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
                                        <Button variant="solid" size="sm" loading={memSaving} disabled={!memKey.trim() || !memContent.trim()} onClick={() => void handleMemorySave()}><Send size={13}/> 锚定</Button>
                                    </div>
                                </div>
                            </>
                        )}
                        {asideTab === 'decisions' && (
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
            <button className="sw-aside-toggle" title={asideOpen ? '收起右栏' : '展开右栏'} onClick={() => setAsideOpen((v) => !v)}>{asideOpen ? '❮' : '❯'}</button>
        </div>
    )
}
