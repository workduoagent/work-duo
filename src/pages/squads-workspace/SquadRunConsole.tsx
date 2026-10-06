/**
 * 运行控制台（F038 从 squads-workspace/index.tsx 抽出）。
 *
 * 抽离原因：该组件原本内嵌在 `SquadEditorModal`（540-1985）内部，但它与编辑器
 * **完全无关**——自己持有 13 个 state（prompt/running/rounds/summary/门禁pending/
 * 插话四件套）、自己注册事件订阅、独立成一个 Modal/内嵌面板。混在编辑器里使
 * `SquadEditorModal` 膨胀到 1400+ 行，也让两者的状态归属边界模糊。
 *
 * 本文件由 index.tsx **原样搬运**而来（未做任何 JSX 改写），依赖的外部符号
 * 在下方显式 import。index.tsx 侧改为 `export {SquadRunConsole}` re-export，
 * 对外 API 不变。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, Segmented, Select, Spin, Tag } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { invoke } from '@tauri-apps/api/core'
import { Play } from 'lucide-react'
import { PixelAgent } from '@/components/ui/pixel-agent'
import { agentAppearanceOf, MODE_OPTIONS } from './squad-shared'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type { AgentMotionState } from '@/components/ui/pixel-agent'
import { subscribeSquadRunEvents } from './useSquadRunEvents'
import { roundTagMeta } from './roundTags'
import { MetricsRoundView } from './MetricsRoundView'
import type { AgentInfo, SquadInfo } from '@/types/core'

export interface SquadRoundView {
    role: string
    kind: string
    content: string
    speakerAgentId?: string | null
}

export function SquadRunConsole({
                            open,
                            squad,
                               agents,
                            onClose,
                            embedded = false,
                        }: {
    open: boolean
    agents: AgentInfo[]
    squad: SquadInfo
    onClose: () => void
    embedded?: boolean
}) {
    const {message} = useNotify()
    const [prompt, setPrompt] = useState('')
    const [running, setRunning] = useState(false)
    const [rounds, setRounds] = useState<SquadRoundView[]>([])
    const [summary, setSummary] = useState('')
    const [memberMotion, setMemberMotion] = useState<Record<string, AgentMotionState>>({})
    const [planPending, setPlanPending] = useState(false)
    const [checkpointPending, setCheckpointPending] = useState(false)
    const [deliveryPending, setDeliveryPending] = useState(false)
    // S2：插话输入（打断 / 预嘱）
    const [injectTarget, setInjectTarget] = useState('')
    const [injectMode, setInjectMode] = useState<'soft' | 'hard' | 'pre_talk'>('soft')
    const [injectText, setInjectText] = useState('')
    const [injectBusy, setInjectBusy] = useState(false)
    const sessionIdRef = useRef<string | null>(null)
    const unlistenRef = useRef<UnlistenFn[]>([])

    const cleanup = useCallback(() => {
        for (const off of unlistenRef.current) off()
        unlistenRef.current = []
    }, [])

    useEffect(() => {
        if (!open) {
            cleanup()
            setRounds([])
            setSummary('')
            setRunning(false)
            setMemberMotion({})
            setPlanPending(false)
            setCheckpointPending(false)
            setDeliveryPending(false)
            setInjectTarget('')
            setInjectText('')
            sessionIdRef.current = null
        }
    }, [open, cleanup])

    useEffect(() => () => cleanup(), [cleanup])

    async function handleRun() {
        const p = prompt.trim()
        if (!p) {
            message.error('请描述协作任务')
            return
        }
        setRounds([])
        setSummary('')
        setRunning(true)
        sessionIdRef.current = null
        try {
            // F039：事件订阅收敛到共用层（原先此处与 SquadDetailPage 各写一遍，
            // 已漂移出「delivery 门禁只在列表页处理」的行为差异）
            unlistenRef.current = await subscribeSquadRunEvents<AgentMotionState>({
                squadId: squad.id,
                acceptRound: (pl) => !(sessionIdRef.current && pl.sessionId !== sessionIdRef.current),
                setRounds: (updater) => setRounds(updater),
                onPlanPending: () => setPlanPending(true),
                onCheckpointPending: () => setCheckpointPending(true),
                onDeliveryPending: () => setDeliveryPending(true),
                setSummary,
                // 直接透传 setState（类型即Record<string, AgentMotionState>），
                // 不要包一层箭头函数——那会让 updater 的参数类型被推断成宽泛的string
                setMemberMotion,
                // 成员动作态用默认枚举映射（working/cheer/error/handoff）
                onSessionStarted: (sessionId) => {
                    sessionIdRef.current = sessionId
                },
                onSessionDone: () => {
                    setRunning(false)
                    cleanup()
                },
            })
            await invoke('run_squad_task', { input: { squad_id: squad.id, prompt: p } })
        } catch (e) {
            message.error(`启动失败：${e instanceof Error ? e.message : String(e)}`)
            setRunning(false)
            cleanup()
        }
    }

    async function handleInject() {
        const text = injectText.trim()
        if (!text) {
            message.error('请输入要补充的内容')
            return
        }
        if (!injectTarget) {
            message.error('请选择插话目标（成员）')
            return
        }
        if (!sessionIdRef.current) {
            message.error('协作尚未开始，无法插话')
            return
        }
        const targetMember = squad.members.find((m) => m.agentId === injectTarget)
        setInjectBusy(true)
        try {
            await invoke<string>('squad_inject_send', {
                squadId: squad.id,
                sessionId: sessionIdRef.current,
                taskId: injectTarget,
                content: text,
                mode: injectMode,
            })
            const modeLabel = injectMode === 'pre_talk' ? '预嘱已入队，将在其任务启动时生效' : '已打断，将在该成员下一轮生效'
            message.success(`已送达 ${targetMember?.role || injectTarget}：${modeLabel}`)
            setInjectText('')
        } catch (e) {
            message.error(`插话失败：${e instanceof Error ? e.message : String(e)}`)
        } finally {
            setInjectBusy(false)
        }
    }

    const panelContent = (
        <>
            <div className="squad-console">
                <div className="squad-console__input">
                    <Input.TextArea
                        autoComplete="off"
                        rows={3}
                        placeholder="描述这次要协作完成的任务…"
                        value={prompt}
                        disabled={running}
                        onChange={(e) => setPrompt(e.target.value)}
                    />
                    <Button variant="solid" onClick={handleRun} disabled={running}>
                        <Play size={14}/> {running ? '协作进行中…' : '运行协作'}
                    </Button>
                </div>

                <div className="squad-console__board">
                    {rounds.length === 0 && !running && !summary && (
                        <div className="squad-console__empty">运行后将在此显示成员讨论 / 子任务交付与最终汇总</div>
                    )}
                    <Spin spinning={running && rounds.length === 0}>
                        {rounds.map((r, i) => {
                            const meta = roundTagMeta(r.kind)
                            return (
                                <div className={`squad-round squad-round--${r.kind}`} key={i}>
                                    <div className="squad-round__head">
                                        {(() => {
                                            const member = squad.members.find((m) => m.role === r.role)
                                            if (!member) return null
                                            const st: AgentMotionState = r.kind === 'handoff' ? 'handoff' : memberMotion[member.role] ?? 'idle'
                                            return <PixelAgent appearance={agentAppearanceOf(agents, member.agentId)} state={st} size={24} className="squad-round__avatar"/>
                                        })()}
                                        <Tag variant={meta.variant}>{meta.label}</Tag>
                                        <span className="squad-round__role">{r.role}</span>
                                    </div>
                                    {r.kind === 'metrics' ? (
                                        <MetricsRoundView content={r.content}/>
                                    ) : (
                                        <div className="squad-round__content">{r.content}</div>
                                    )}
                                </div>
                            )
                        })}
                    {planPending && (
                        <div className="squad-round squad-round--system" style={{border: '1px solid var(--color-warning, #faad14)'}}>
                            <div className="squad-round__head"><Tag color="orange">L1 计划门禁</Tag></div>
                            <div className="squad-round__content">委派计划已生成，等待你的批准。</div>
                            <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                <Button variant="solid" onClick={() => {
                                    setPlanPending(false)
                                    void invoke<{ok: boolean}>('squad_plan_approve', { sessionId: sessionIdRef.current, approved: true })
                                }}>
                                    批准执行
                                </Button>
                                <Button variant="ghost" onClick={() => {
                                    setPlanPending(false)
                                    void invoke('squad_plan_approve', { sessionId: sessionIdRef.current, approved: false })
                                }}>
                                    拒绝
                                </Button>
                            </div>
                        </div>
                    )}
                    {checkpointPending && (
                        <div className="squad-round squad-round--system" style={{border: '1px solid var(--color-warning, #faad14)'}}>
                            <div className="squad-round__head"><Tag color="orange">L2 检查点</Tag></div>
                            <div className="squad-round__content">本波任务已完成，等待你的决议。返工将重跑本波全部任务（其上游交接保留）。</div>
                            <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                <Button variant="solid" onClick={() => {
                                    setCheckpointPending(false)
                                    void invoke<{ok: boolean}>('squad_checkpoint_resolve', { sessionId: sessionIdRef.current, decision: 'continue' })
                                }}>
                                    继续
                                </Button>
                                <Button variant="ghost" onClick={() => {
                                    setCheckpointPending(false)
                                    void invoke('squad_checkpoint_resolve', { sessionId: sessionIdRef.current, decision: 'rework' })
                                }}>
                                    返工本波
                                </Button>
                            </div>
                        </div>
                    )}
                    {deliveryPending && (
                        <div className="squad-round squad-round--system" style={{border: '1px solid var(--color-primary, #1677ff)'}}>
                            <div className="squad-round__head"><Tag color="gold">L4 交付确认</Tag></div>
                            <div className="squad-round__content">Delivery Pack 已生成（含成员执行证据与成本账目）。确认后协作收尾；要求修订将按取消收尾（产物保留在交接箱）。</div>
                            <div style={{display: 'flex', gap: 8, marginTop: 8}}>
                                <Button variant="solid" onClick={() => {
                                    setDeliveryPending(false)
                                    void invoke<{ok: boolean}>('squad_delivery_resolve', { sessionId: sessionIdRef.current, approved: true })
                                }}>
                                    确认交付
                                </Button>
                                <Button variant="ghost" onClick={() => {
                                    setDeliveryPending(false)
                                    void invoke('squad_delivery_resolve', { sessionId: sessionIdRef.current, approved: false })
                                }}>
                                    要求修订
                                </Button>
                            </div>
                        </div>
                    )}
                    </Spin>
                    {summary && (
                        <div className="squad-round squad-round--summary squad-round--final">
                            <div className="squad-round__head">
                                <Tag color="gold">最终汇总</Tag>
                            </div>
                            <div className="squad-round__content">{summary}</div>
                        </div>
                    )}
                </div>

                {/* S2（§4.11）：插话输入——运行中打断 / 未启动预嘱；目标为小分队成员 */}
                <div className="squad-console__inject">
                    <Select
                        style={{minWidth: 150}}
                        placeholder="插话目标"
                        value={injectTarget || undefined}
                        onChange={(v) => setInjectTarget(v)}
                        options={squad.members.map((m) => ({value: m.agentId, label: m.role || m.agentId}))}
                    />
                    <Segmented
                        value={injectMode}
                        onChange={(v) => setInjectMode(v as 'soft' | 'hard' | 'pre_talk')}
                        options={[
                            {value: 'soft', label: '打断'},
                            {value: 'hard', label: '强打断'},
                            {value: 'pre_talk', label: '预嘱'},
                        ]}
                    />
                    <Input
                        autoComplete="off"
                        placeholder={injectMode === 'pre_talk' ? '任务启动前要交代的要求…' : '运行中要补充 / 纠偏的话…'}
                        value={injectText}
                        maxLength={2000}
                        onChange={(e) => setInjectText(e.target.value)}
                        onPressEnter={() => void handleInject()}
                    />
                    <Button variant="soft" onClick={() => void handleInject()} disabled={injectBusy || !running}>
                        送达
                    </Button>
                </div>
            </div>
        </>
    )

    if (embedded) {
        return <div className="squad-page-panel">{panelContent}</div>
    }

    return (
        <Modal
            open={open}
            onOpenChange={onClose}
            title={`运行 · ${squad.name}`}
            description={`协作模式：${MODE_OPTIONS.find((o) => o.value === squad.mode)?.label ?? squad.mode}`}
            width={760}
            footer={
                <Button variant="ghost" onClick={onClose}>
                    关闭
                </Button>
            }
        >
            {panelContent}
        </Modal>
    )
}