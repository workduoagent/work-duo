import {useCallback, useEffect, useRef, useState} from 'react'
import {useNavigate, useParams} from 'react-router-dom'
import {ArrowLeft, Brain, Play, Plus, RotateCcw, Send, Square, Trash2} from 'lucide-react'
import {PauseCircle} from 'lucide-react'
import {listen} from '@tauri-apps/api/event'
import {invoke} from '@tauri-apps/api/core'
import {Button, Empty, Input, Segmented, Select, Spin, Tag} from '@/components/ui'
import {useNotify} from '@/components/ui/notify'
import {getSquad, listSquadSessions, listSquadRounds, deleteSquadSession, listSquadMemories, anchorSquadMemory, deleteSquadMemory, type AnchorSquadMemoryInput} from '@/core/mapper/squad-mapper'
import {listAgents} from '@/core/mapper/agent-mapper'
import type {AgentInfo, SquadInfo, SquadSession, SquadMemory, SquadMemoryCategory} from '@/types/core'
import {RoundBoard, memberLabel, type BoardRound, type SquadBoardView} from './index'

const ACTIVE_STATUSES = ['running', 'paused', 'awaiting_checkpoint', 'awaiting_delivery']
const SESSION_BG: Record<string, string> = {done: 'var(--color-success, #52c41a)', failed: 'var(--color-danger, #ff4d4f)', cancelled: 'var(--color-foreground-muted)'}
const CAT_OPTIONS: {label: string; value: SquadMemoryCategory}[] = [
    {label: '通用', value: 'general'},
    {label: '决策', value: 'decision'},
    {label: '代码范式', value: 'code_pattern'},
]

const STATUS_LABEL: Record<string, string> = {
    running: '运行中', paused: '已暂停', awaiting_checkpoint: '待决议', awaiting_delivery: '待确认交付',
    done: '已完成', failed: '失败', cancelled: '已取消',
}
const STATUS_TAG: Record<string, string> = {
    running: 'processing', paused: 'default', awaiting_checkpoint: 'warning', awaiting_delivery: 'warning',
    done: 'success', failed: 'error', cancelled: 'default',
}

/** 小分队工作台：左=会话栏（新建/运行卡/历史卡），右=黑板 + 输入区（插话/门禁/记忆热更新）。 */
export default function SquadDetailPage() {
    const nav = useNavigate()
    const {message} = useNotify()
    const {id} = useParams()

    const [squad, setSquad] = useState<SquadInfo | undefined>(undefined)
    const [agents, setAgents] = useState<AgentInfo[]>([])
    const [loading, setLoading] = useState(true)

    const [sessions, setSessions] = useState<SquadSession[]>([])
    const [selected, setSelected] = useState<string | null>(null) // null = 新任务草稿
    const [rounds, setRounds] = useState<BoardRound[]>([])
    const [board, setBoard] = useState<SquadBoardView | null>(null)
    const [summary, setSummary] = useState('')

    const [prompt, setPrompt] = useState('')
    const [starting, setStarting] = useState(false)
    const sessionIdRef = useRef<string | null>(null)

    const [injectTarget, setInjectTarget] = useState<string>('')
    const [injectMode, setInjectMode] = useState<'soft' | 'hard' | 'pre_talk'>('soft')
    const [injectText, setInjectText] = useState('')
    const [injectBusy, setInjectBusy] = useState(false)

    const [memOpen, setMemOpen] = useState(false)
    const [memories, setMemories] = useState<SquadMemory[]>([])
    const [memKey, setMemKey] = useState('')
    const [memContent, setMemContent] = useState('')
    const [memCat, setMemCat] = useState<SquadMemoryCategory>('general')
    const [memSaving, setMemSaving] = useState(false)

    const [planPending, setPlanPending] = useState(false)
    const [checkpointPending, setCheckpointPending] = useState(false)

    const selectedSession = sessions.find((s) => s.id === selected) || null

    const reloadSessions = useCallback(async () => {
        if (!id) return
        try { setSessions(await listSquadSessions(id)) } catch { /* 轮询容错 */ }
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
                const [sq, ags, sess] = await Promise.all([
                    id ? getSquad(id) : Promise.resolve(undefined),
                    listAgents(),
                    id ? listSquadSessions(id) : Promise.resolve([] as SquadSession[]),
                ])
                if (!alive) return
                setSquad(sq)
                setAgents(ags)
                setSessions(sess)
                const active = sess.find((x) => ACTIVE_STATUSES.includes(x.status))
                if (active) setSelected(active.id)
            } finally {
                if (alive) setLoading(false)
            }
        })()
        return () => { alive = false }
    }, [id])

    // 30s 会话列表轮询（呼吸灯/状态背景）
    useEffect(() => {
        const t = setInterval(() => void reloadSessions(), 30000)
        return () => clearInterval(t)
    }, [reloadSessions])

    // 记忆热更新：锚定事件即时刷新
    useEffect(() => {
        let un: (() => void) | undefined
        void listen<{item: SquadMemory}>('agent-squad-memory-anchored', () => { void reloadMemories() }).then((f) => { un = f })
        return () => un?.()
    }, [reloadMemories])

    // 选中会话：拉轮次 + 黑板
    const openSessionRounds = useCallback(async (sid: string | null) => {
        setRounds([])
        setBoard(null)
        setSummary('')
        setPlanPending(false)
        setCheckpointPending(false)
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

    function selectSession(sid: string | null) {
        setSelected(sid)
        sessionIdRef.current = sid
        void openSessionRounds(sid)
    }

    // 运行期事件常驻订阅
    useEffect(() => {
        if (!squad) return
        const offs: Array<() => void> = []
        void (async () => {
            offs.push(await listen<{squadId: string; sessionId: string}>('agent-squad-session-started', (e) => {
                if (e.payload.squadId !== squad.id) return
                sessionIdRef.current = e.payload.sessionId
                setSelected(e.payload.sessionId)
                setRounds([])
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
                void reloadSessions()
            }))
        })()
        return () => offs.forEach((f) => f())
    }, [squad, reloadSessions])

    async function handleStart() {
        const p = prompt.trim()
        if (!p || !squad) return
        setStarting(true)
        setSelected(null)
        sessionIdRef.current = null
        try {
            await invoke('run_squad_task', {input: {squad_id: squad.id, prompt: p}})
            setPrompt('')
            message.success('协作已启动')
        } catch (e) {
            message.error(`启动失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
            setStarting(false)
        }
    }

    async function handleRerun(s: SquadSession) {
        if (!s.title?.trim()) { message.error('该会话没有可重跑的指令'); return }
        try {
            await invoke('run_squad_task', {input: {squad_id: squad!.id, prompt: s.title}})
            message.success('已按原指令重新发起协作')
        } catch (e) {
            message.error(`重跑失败：${e instanceof Error ? e.message : String(e)}`)
        }
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
        } catch (e) {
            message.error(`插话失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
            setInjectBusy(false)
        }
    }

    async function gateCall(cmd: string, args: Record<string, unknown>, okMsg: string) {
        try {
            await invoke(cmd, args)
            message.success(okMsg)
            setPlanPending(false)
            setCheckpointPending(false)
            void reloadSessions()
        } catch (e) {
            message.error(`操作失败：${e instanceof Error ? e.message : String(e)}`)
        }
    }

    async function handleMemorySave() {
        if (!memKey.trim() || !memContent.trim() || !squad) { message.error('键名与内容必填'); return }
        setMemSaving(true)
        try {
            const input: AnchorSquadMemoryInput = {squadId: squad.id, key: memKey.trim(), content: memContent.trim(), category: memCat}
            await anchorSquadMemory(input)
            message.success('记忆已锚定（下次协作注入生效）')
            setMemKey(''); setMemContent('')
            void reloadMemories()
        } catch (e) {
            message.error(`锚定失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
            setMemSaving(false)
        }
    }

    if (loading) return <div className="squads squads--detail"><Spin spinning wrapperClassName="squads__spin"/></div>

    if (!squad) {
        return (
            <div className="squads squads--detail">
                <div className="squad-detail__bar">
                    <Button variant="ghost" size="sm" onClick={() => nav('/squads-workspace')}><ArrowLeft size={14}/> 返回列表</Button>
                </div>
                <div className="squad-detail__missing">未找到该小分队（可能已被删除）。</div>
            </div>
        )
    }

    const isDraft = !selectedSession
    const isRunningSel = selectedSession ? ACTIVE_STATUSES.includes(selectedSession.status) : false
    const canInject = isRunningSel && selectedSession!.status !== 'paused'

    return (
        <div className="squads squads--detail squad-ws">
            <aside className="squad-ws__side">
                <Button
                    variant={isDraft ? 'solid' : 'soft'}
                    size="sm"
                    block
                    onClick={() => selectSession(null)}
                >
                    <Plus size={14}/> 新建任务
                </Button>
                <div className="squad-ws__sessions">
                    {sessions.length === 0 && <div className="squad-ws__side-empty">还没有协作记录</div>}
                    {sessions.map((s) => {
                        const active = ACTIVE_STATUSES.includes(s.status)
                        return (
                            <div
                                key={s.id}
                                className={`squad-ws__card${selected === s.id ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
                                style={active ? undefined : {borderLeftColor: SESSION_BG[s.status] || 'transparent'}}
                                onClick={() => selectSession(s.id)}
                            >
                                <div className="squad-ws__card-head">
                                    {active && <i className={`squad-ws__pulse${s.status === 'running' ? ' is-go' : ''}`}/>}
                                    <span className="squad-ws__card-title">{s.title || '（无标题任务）'}</span>
                                </div>
                                <div className="squad-ws__card-meta">
                                    <Tag color={STATUS_TAG[s.status]}>{STATUS_LABEL[s.status] ?? s.status}</Tag>
                                    <span className="squad-ws__card-time">{new Date(s.createdAt).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})}</span>
                                </div>
                                <div className="squad-ws__card-ops" onClick={(e) => e.stopPropagation()}>
                                    {s.status === 'running' && (
                                        <Button variant="ghost" size="sm" aria-label="暂停" title="暂停" onClick={() => void invoke('squad_pause', {squadId: squad.id}).then(() => reloadSessions())}><PauseCircle size={14}/></Button>
                                    )}
                                    {s.status === 'paused' && (
                                        <Button variant="ghost" size="sm" aria-label="恢复" title="恢复" onClick={() => void invoke('squad_resume', {squadId: squad.id}).then(() => reloadSessions())}><Play size={14}/></Button>
                                    )}
                                    {active && (
                                        <Button variant="ghost" size="sm" aria-label="停止协作" title="停止协作" onClick={() => void invoke('cancel_squad_task', {squadId: squad.id}).then(() => reloadSessions())}><Square size={14}/></Button>
                                    )}
                                    {!active && (
                                        <Button variant="ghost" size="sm" aria-label="重跑" title="按原指令重跑" onClick={() => void handleRerun(s)}><RotateCcw size={14}/></Button>
                                    )}
                                    {!active && (
                                        <Button variant="ghost" size="sm" aria-label="删除记录" title="删除记录" onClick={() => void deleteSquadSession(s.id).then(() => { if (selected === s.id) selectSession(null); void reloadSessions() })}><Trash2 size={14}/></Button>
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </div>
            </aside>

            <main className="squad-ws__main">
                <div className="squad-ws__board">
                    {isDraft ? (
                        <div className="squad-ws__draft-hint">
                            <Empty description="填写下方指令并「开始运行」；运行卡片会在启动后自动生成"/>
                        </div>
                    ) : (
                        <RoundBoard rounds={rounds} summary={summary} board={board}/>
                    )}
                </div>

                {(planPending || checkpointPending) && (
                    <div className="squad-ws__gate">
                        {planPending && (
                            <>
                                <span>📋 协作计划待批准</span>
                                <Button variant="solid" size="sm" onClick={() => void gateCall('squad_plan_approve', {sessionId: selected, approved: true}, '计划已批准')}>批准</Button>
                                <Button variant="outline" size="sm" onClick={() => void gateCall('squad_plan_approve', {sessionId: selected, approved: false}, '已拒绝')}>拒绝</Button>
                            </>
                        )}
                        {checkpointPending && (
                            <>
                                <span>⏸️ 检查点待决议</span>
                                <Button variant="solid" size="sm" onClick={() => void gateCall('squad_checkpoint_resolve', {sessionId: selected, decision: 'continue'}, '继续执行')}>继续</Button>
                                <Button variant="outline" size="sm" onClick={() => void gateCall('squad_checkpoint_resolve', {sessionId: selected, decision: 'rework'}, '已要求返工')}>返工</Button>
                            </>
                        )}
                    </div>
                )}
                {selectedSession?.status === 'awaiting_delivery' && (
                    <div className="squad-ws__gate">
                        <span>📦 交付待确认</span>
                        <Button variant="solid" size="sm" onClick={() => void gateCall('squad_delivery_resolve', {sessionId: selected, approved: true}, '已确认交付')}>确认交付</Button>
                        <Button variant="outline" size="sm" onClick={() => void gateCall('squad_delivery_resolve', {sessionId: selected, approved: false}, '已要求修订')}>要求修订</Button>
                    </div>
                )}

                <div className="squad-ws__composer">
                    {memOpen && (
                        <div className="squad-ws__mem">
                            <div className="squad-ws__mem-list">
                                {memories.length === 0 && <div className="squad-ws__side-empty">暂无团队记忆</div>}
                                {memories.map((m) => (
                                    <div key={m.id} className="squad-ws__mem-item">
                                        <span className="squad-ws__mem-key">{m.key}</span>
                                        <span className="squad-ws__mem-content">{m.content}</span>
                                        <Button variant="ghost" size="sm" aria-label="删除记忆" onClick={() => void deleteSquadMemory(m.id, squad!.id).then(() => reloadMemories())}><Trash2 size={13}/></Button>
                                    </div>
                                ))}
                            </div>
                            <div className="squad-ws__mem-add">
                                <Input autoComplete="off" placeholder="键名，如：统一返回结构" value={memKey} onChange={(e) => setMemKey(e.target.value)}/>
                                <Input.TextArea autoComplete="off" rows={2} placeholder="记忆内容…" value={memContent} onChange={(e) => setMemContent(e.target.value)}/>
                                <div className="squad-ws__mem-row">
                                    <Select
                                        className="squad-ws__mem-cat"
                                        value={memCat}
                                        onChange={(v) => setMemCat(v as SquadMemoryCategory)}
                                        options={CAT_OPTIONS}
                                    />
                                    <Button variant="solid" size="sm" loading={memSaving} onClick={() => void handleMemorySave()}>锚定</Button>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="squad-ws__composer-row">
                        {isDraft ? (
                            <>
                                <Input.TextArea
                                    autoComplete="off"
                                    rows={2}
                                    placeholder="描述这次要协作完成的任务…"
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                />
                                <Button variant="solid" onClick={() => void handleStart()} loading={starting} disabled={!prompt.trim()} title="开始运行协作">
                                    <Play size={14}/> 开始运行
                                </Button>
                            </>
                        ) : canInject ? (
                            <>
                                <Select
                                    className="squad-ws__inject-target"
                                    placeholder="插话目标"
                                    value={injectTarget || undefined}
                                    onChange={(v) => setInjectTarget(String(v))}
                                    options={(squad?.members || []).map((m) => ({label: memberLabel(m, agents), value: m.agentId}))}
                                />
                                <Segmented
                                    value={injectMode}
                                    onChange={(v) => setInjectMode(v as 'soft' | 'hard' | 'pre_talk')}
                                    options={[{label: '打断', value: 'soft'}, {label: '强打断', value: 'hard'}, {label: '预嘱', value: 'pre_talk'}]}
                                />
                                <Input
                                    autoComplete="off"
                                    placeholder="补充 / 纠偏内容…"
                                    value={injectText}
                                    onChange={(e) => setInjectText(e.target.value)}
                                    onPressEnter={() => void handleInject()}
                                />
                                <Button variant="soft" onClick={() => void handleInject()} loading={injectBusy} title="发送插话"><Send size={14}/></Button>
                            </>
                        ) : (
                            <div className="squad-ws__composer-note">
                                {selectedSession?.status === 'paused' ? '协作已暂停，可在左侧卡片恢复。' : '该会话已结束，可在左侧卡片重跑或新建任务。'}
                            </div>
                        )}
                        <Button
                            variant={memOpen ? 'solid' : 'ghost'}
                            size="sm"
                            aria-label="团队记忆（热更新）"
                            title="团队记忆（保存后下次协作即时生效）"
                            onClick={() => { setMemOpen((v) => !v); if (!memOpen) void reloadMemories() }}
                        >
                            <Brain size={15}/>
                        </Button>
                    </div>
                </div>
            </main>
        </div>
    )
}
