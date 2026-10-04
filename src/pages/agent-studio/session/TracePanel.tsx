import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, GitBranch, Sparkles, Wrench, ShieldAlert, CheckCircle2, XCircle, Loader2, ChevronRight, ChevronDown, AlertTriangle, RefreshCw, History } from 'lucide-react'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import type { IntentClassified, PlanStep, ThinkingChunk, ToolStep } from './types'
import { listRunTraces, getRunTrace, exportRunPackage, buildEventFork, type RunTraceIndexItem, type RunTraceFull, type BuildEventForkOutput } from '@/core/mapper/agent-run-trace-mapper'
import { open } from '@tauri-apps/plugin-dialog'

interface TracePanelProps {
  intent?: IntentClassified
  thinking: ThinkingChunk[]
  planSteps: PlanStep[]
  toolSteps: ToolStep[]
  /** #20260919003：任务启动 → 规划就绪的窗口期，空态显示「正在启动」占位而非静态文案。 */
  planning?: boolean
  /** 台账 D4：当前会话 id——提供时启用「历史运行回放」下拉（查 agent_run_trace 归档）。 */
  sessionId?: string
  /** 台账 D4 收官：事件级分叉——确认后由 chat 层合成轮次并 run。 */
  onForkFromEvent?: (req: { prompt: string; initialContext: string }) => void | Promise<void>
}

const LAYER_META: Record<ThinkingChunk['layer'], { label: string; color: string }> = {
  plan: { label: '规划', color: 'var(--color-trace-plan, #6366F1)' },
  exec: { label: '执行', color: 'var(--color-trace-exec, #3B82F6)' },
  selfcheck: { label: '自检', color: 'var(--color-trace-selfcheck, #F59E0B)' },
  chat: { label: '思考', color: 'var(--color-trace-chat, #8B5CF6)' },
}

const RISK_META: Record<string, { label: string; color: string }> = {
  low: { label: '低风险', color: 'var(--color-success, #10B981)' },
  medium: { label: '中风险', color: 'var(--color-info, #3B82F6)' },
  high: { label: '高风险', color: 'var(--color-warning, #F59E0B)' },
  critical: { label: '极高风险', color: 'var(--color-error, #EF4444)' },
}

function StepStatusIcon({ status }: { status?: PlanStep['status'] }) {
  if (status === 'running') return <Loader2 size={13} className="agent-trace__spin" />
  if (status === 'success') return <CheckCircle2 size={13} color="var(--color-success, #10B981)" />
  if (status === 'failed') return <XCircle size={13} color="var(--color-error, #EF4444)" />
  if (status === 'blocked') return <AlertTriangle size={13} color="var(--color-warning, #F59E0B)" />
  if (status === 'retrying') return <RefreshCw size={13} className="agent-trace__spin" />
  return <span className="agent-trace__dot" />
}

// #20260918011 打字机揭示（v2 常速版）：实测网关会把 reasoning 增量攒成大坨突发下发，
// 追赶式揭示（v1）会让每坨瞬间打完——观感仍是「一阵一阵刷」。v2 改常速逐字（≈60 字/秒）：
// 开放中的思考块匀速吐字（积压 >120 字按比例加速，滞后上限约 2s）；闭合后快速收尾（≈0.4s）。
// 仅最后一个思考块需要动画，历史块直接全文（与 message-ui 的 useTypewriter 同款防堆叠模式）。
function useTypedText(text: string, active: boolean, groupKey: number) {
  const [shown, setShown] = useState('')
  const idxRef = useRef(0)
  const textRef = useRef(text)
  const activeRef = useRef(active)
  const keyRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  textRef.current = text
  activeRef.current = active

  useEffect(() => {
    if (keyRef.current === null) {
      // 首挂：已有内容直接全显（历史回放不动画），后续新增内容从零开始打字
      keyRef.current = groupKey
      idxRef.current = textRef.current.length
      setShown(textRef.current)
      return
    }
    if (keyRef.current !== groupKey) {
      // 换思考块（新一轮开始 / 轨迹清空）：从零开始打新块
      keyRef.current = groupKey
      idxRef.current = 0
      setShown('')
    }
  }, [groupKey])

  useEffect(() => {
    const tick = () => {
      const target = textRef.current
      if (idxRef.current > target.length) idxRef.current = target.length
      if (idxRef.current >= target.length) {
        timerRef.current = null
        return
      }
      const remaining = target.length - idxRef.current
      const step = activeRef.current
        ? remaining > 120
          ? Math.ceil(remaining / 120)
          : 1
        : Math.max(2, Math.ceil(remaining / 25))
      idxRef.current = Math.min(target.length, idxRef.current + step)
      setShown(target.slice(0, idxRef.current))
      timerRef.current = setTimeout(tick, 16)
    }
    // 仅在无运行中定时器且有欠账时启动，避免高频 text 更新堆叠定时器（同 useTypewriter 模式）
    if (timerRef.current == null && idxRef.current < textRef.current.length) {
      timerRef.current = setTimeout(tick, 16)
    }
  }, [text, active])

  // 组件卸载时清理定时器，避免向已卸载组件 setState
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return shown
}

export function TracePanel({ intent, thinking, planSteps, toolSteps, planning = false, sessionId, onForkFromEvent }: TracePanelProps) {
  // 工具调用默认折叠：工具调用很多时全部展开会撑高右栏，默认收起、点击标题展开。
  const [toolsOpen, setToolsOpen] = useState(false)
  // 规划步骤默认全部展开（让用户看到每步详情）；单步可独立收叠。
  const [stepCollapsed, setStepCollapsed] = useState<Record<number, boolean>>({})
  // 台账 D4：历史运行回放——null=当前运行；选中归档 run 时加载落盘事件渲染简版时间线。
  const [history, setHistory] = useState<RunTraceIndexItem[] | null>(null)
  const [replay, setReplay] = useState<RunTraceFull | null>(null)
  const [replayLoading, setReplayLoading] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    let alive = true
    listRunTraces({ sessionId, limit: 20 })
      .then((rows) => {
        if (alive && rows.length > 0) setHistory(rows)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId])

  const loadReplay = async (runId: string) => {
    if (runId === '__current__') {
      setReplay(null)
      return
    }
    setReplayLoading(true)
    try {
      setReplay(await getRunTrace(runId))
    } finally {
      setReplayLoading(false)
    }
  }

  // 台账 D4 第三步：任务交付包导出——选中归档 run 后一键导出（目录由用户选择）。
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const handleExport = async () => {
    if (!replay || exporting) return
    try {
      const dir = await open({ directory: true, multiple: false, recursive: true, title: '选择交付包保存目录' })
      if (!dir || typeof dir !== 'string') return
      setExporting(true)
      setExported(null)
      const out = await exportRunPackage(replay.runId, dir)
      setExported(`✓ 已导出：${out.packageDir}（产物 ${out.artifactCount} · 审批 ${out.approvalCount}）`)
    } catch (e) {
      setExported(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  // 台账 D4 收官：事件级分叉——选分叉点 → 合成续跑指令（预览确认）→ chat 层开新一轮。
  const [forkTs, setForkTs] = useState(0)
  const [forkPreview, setForkPreview] = useState<BuildEventForkOutput | null>(null)
  const [forkBusy, setForkBusy] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)
  // 分叉点候选：工具完成 / 产物 / 审批 / 计划生成（时间升序；纯文本流事件不入选）。
  const forkPoints = useMemo(() => {
    const evs = (replay?.events ?? []) as Array<Record<string, unknown>>
    const pts: { ts: number; label: string }[] = []
    for (const e of evs) {
      const ev = String(e.event ?? '')
      const payload = (e.payload ?? {}) as Record<string, unknown>
      const ts = Number(e.ts_ms ?? 0)
      const ty = String(payload.type ?? '')
      let label = ''
      if (ev === 'agent-artifact-created') {
        const names = ((payload.artifacts as Array<{ path?: string }> | undefined) ?? [])
          .map((a) => a.path?.split(/[\\/]/).pop() ?? '')
          .filter(Boolean)
          .join('、')
        label = `📦 产物 ${names || '(未知)'}`
      } else if (ev === 'agent-awaiting-approval') {
        label = `🛡 审批 ${String(payload.approvalId ?? '')}`
      } else if (ty === 'tool_finished') {
        label = `🔧 ${String(payload.toolName ?? '工具')} 完成`
      } else if (ty === 'plan_generated') {
        label = '🗺 计划生成'
      }
      if (label) pts.push({ ts, label: `${new Date(ts).toLocaleTimeString()} · ${label}` })
    }
    return pts
  }, [replay])
  const handleForkBuild = async () => {
    if (!replay || forkBusy) return
    setForkBusy(true)
    setForkError(null)
    try {
      setForkPreview(await buildEventFork(replay.runId, forkTs))
    } catch (e) {
      setForkError(`分叉合成失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setForkBusy(false)
    }
  }

  const hasData = intent || thinking.length > 0 || planSteps.length > 0 || toolSteps.length > 0

  const toggleStep = (step: number) => {
    setStepCollapsed((prev) => ({ ...prev, [step]: !prev[step] }))
  }

  // #20260918011：流式 delta 逐 chunk 追加（done=false），同层连续 chunk 拼接为一个思考块
  //（done=true 收尾闭合）——数据结构与渲染分离，渲染层再做逐字揭示。
  const groups = useMemo(() => {
    const gs: Array<{ layer: ThinkingChunk['layer']; text: string; open: boolean }> = []
    for (const t of thinking) {
      const lastGroup = gs[gs.length - 1]
      if (lastGroup && lastGroup.layer === t.layer && lastGroup.open && !t.done) {
        lastGroup.text += t.text
      } else {
        gs.push({ layer: t.layer, text: t.text, open: !t.done })
      }
    }
    return gs
  }, [thinking])

  // 打字机目标：仅最后一个思考块参与动画；轨迹清空（plan_generated 换幕）→ 世代+1 强制从头打。
  const prevLenRef = useRef(0)
  const genRef = useRef(0)
  if (groups.length < prevLenRef.current) genRef.current += 1
  prevLenRef.current = groups.length
  const lastGroup = groups.length > 0 ? groups[groups.length - 1] : undefined
  const typed = useTypedText(
    lastGroup?.text ?? '',
    lastGroup?.open ?? false,
    genRef.current * 1000 + groups.length - 1,
  )

  if (!hasData) {
    return (
      <div className="agent-trace">
        <div className="agent-trace__empty">
          {planning
            ? '⏳ 正在启动任务：意图分类与规划中，新轨迹就绪后在此展示…'
            : '运行一次任务后，这里会展示执行轨迹：意图分类 → 规划 → 工具调用 → 分层思考。'}
        </div>
      </div>
    )
  }

  return (
    <div className="agent-trace">
      {/* 台账 D4：历史运行回放（有归档时显示；选中后本面板切换为落盘事件时间线） */}
      {history && history.length > 0 && (
        <section className="agent-trace__section">
          <div className="agent-trace__section-head">
            <History size={13} />
            <span>历史运行</span>
          </div>
          <select
            className="agent-trace__replay-select"
            value={replay?.runId ?? '__current__'}
            onChange={(e) => void loadReplay(e.target.value)}
          >
            <option value="__current__">当前运行</option>
            {history.map((h) => (
              <option key={h.runId} value={h.runId}>
                {new Date(h.startedAt ?? h.finishedAt).toLocaleTimeString()} ·{' '}
                {h.replyHead.slice(0, 24) || '(无正文)'} · {h.eventCount} 事件
              </option>
            ))}
          </select>
          {replayLoading && <div className="agent-trace__replay-hint">加载中…</div>}
          {/* 台账 D4 第三步：交付包导出（仅归档 run 可导出；当前运行须终态落盘后经历史选择） */}
          {replay && !replayLoading && (
            <div className="agent-trace__export">
              <button className="agent-trace__export-btn" disabled={exporting} onClick={() => void handleExport()}>
                {exporting ? '⏳ 导出中…' : '📦 导出交付包'}
              </button>
              {exported && <div className="agent-trace__export-hint">{exported}</div>}
            </div>
          )}
          {/* 台账 D4 收官：事件级分叉——选分叉点合成续跑指令，确认后在原会话开新一轮 */}
          {replay && !replayLoading && onForkFromEvent && (
            <div className="agent-trace__fork">
              <select
                className="agent-trace__replay-select"
                value={forkTs}
                onChange={(e) => {
                  setForkTs(Number(e.target.value))
                  setForkPreview(null)
                  setForkError(null)
                }}
              >
                <option value={0}>⎇ 分叉点：run 末尾（全量进展）</option>
                {forkPoints.map((fp) => (
                  <option key={fp.ts} value={fp.ts}>
                    ⎇ 分叉点：{fp.label}
                  </option>
                ))}
              </select>
              {!forkPreview ? (
                <button
                  className="agent-trace__export-btn"
                  disabled={forkBusy}
                  onClick={() => void handleForkBuild()}
                >
                  {forkBusy ? '⏳ 合成中…' : '⎇ 生成分叉续跑'}
                </button>
              ) : (
                <div className="agent-trace__fork-preview">
                  <div className="agent-trace__fork-prompt">
                    {forkPreview.prompt.length > 400
                      ? `${forkPreview.prompt.slice(0, 400)}…`
                      : forkPreview.prompt}
                  </div>
                  <div className="agent-trace__fork-actions">
                    <button
                      className="agent-trace__export-btn"
                      disabled={forkBusy}
                      onClick={() => {
                        void onForkFromEvent({ prompt: forkPreview.prompt, initialContext: forkPreview.initialContext })
                        setForkPreview(null)
                      }}
                    >
                      ✓ 确认续跑
                    </button>
                    <button className="agent-trace__export-btn" onClick={() => setForkPreview(null)}>
                      ✕ 取消
                    </button>
                  </div>
                </div>
              )}
              {forkError && <div className="agent-trace__export-hint">{forkError}</div>}
            </div>
          )}
        </section>
      )}

      {replay ? (
        <section className="agent-trace__section">
          <div className="agent-trace__section-head">
            <Bot size={13} />
            <span>回放时间线（{replay.events.length} 事件 · {replay.counts.promptTokens}+{replay.counts.completionTokens} tokens）</span>
          </div>
          <div className="agent-trace__replay">
            {replay.events.map((e, i) => {
              const p = e.payload as Record<string, unknown> | undefined
              const type = String(p?.type ?? e.event ?? '?')
              const summary =
                type === 'tool_started' || type === 'tool_finished'
                  ? String((p?.step as Record<string, unknown> | undefined)?.toolName ?? '')
                  : type === 'status'
                    ? String(p?.message ?? '')
                    : type === 'host_exec_output'
                      ? String((p?.hostOutput as Record<string, unknown> | undefined)?.chunk ?? '').trim()
                      : ''
              return (
                <div key={i} className="agent-trace__replay-row">
                  <span className="agent-trace__replay-idx">{i + 1}</span>
                  <span className="agent-trace__replay-type">{type}</span>
                  <span className="agent-trace__replay-sum">{summary.slice(0, 80)}</span>
                </div>
              )
            })}
            {replay.reply && (
              <div className="agent-trace__replay-reply">
                <div className="agent-trace__block-title">最终回复</div>
                <MarkdownRenderer content={replay.reply} className="agent-trace__plan-card-md" />
              </div>
            )}
          </div>
        </section>
      ) : (
        <>
      {/* 意图分类节点 */}
      {intent && (
        <section className="agent-trace__section">
          <div className="agent-trace__section-head">
            <Sparkles size={13} />
            <span>意图分类</span>
          </div>
          <div className="agent-trace__intent">
            <span
              className={`agent-trace__badge ${
                intent.intentType === 'COMPOSITE_TASK' ? 'agent-trace__badge--composite' : 'agent-trace__badge--simple'
              }`}
            >
              {intent.intentType === 'COMPOSITE_TASK' ? '复合任务' : '简单对话'}
            </span>
            <span className="agent-trace__reason">{intent.reason || '（无说明）'}</span>
            {intent.riskLevel && RISK_META[intent.riskLevel] && (
              <span className="agent-trace__risk" style={{ color: RISK_META[intent.riskLevel].color }}>
                <ShieldAlert size={12} />
                {RISK_META[intent.riskLevel].label}
              </span>
            )}
          </div>
        </section>
      )}

      {/* 分层思考 */}
      {thinking.length > 0 && (
        <section className="agent-trace__section">
          <div className="agent-trace__section-head">
            <Bot size={13} />
            <span>分层思考</span>
          </div>
          <div className="agent-trace__thinking">
            {groups.map((g, i) => {
              const meta = LAYER_META[g.layer] ?? LAYER_META.exec
              const isLast = i === groups.length - 1
              const text = isLast ? typed : g.text
              // 揭示中（或思考块仍开放等待后续 delta）显示打字光标
              const typing = isLast && (typed.length < g.text.length || g.open)
              return (
                <div key={i} className="agent-trace__think" style={{ borderLeftColor: meta.color }}>
                  <span className="agent-trace__think-tag" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                  <span className="agent-trace__think-text">
                    {text}
                    {typing && <span className="agent-trace__think-caret" />}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 规划步骤（响应式卡片 + 可收叠 + Markdown 内容） */}
      {planSteps.length > 0 && (
        <section className="agent-trace__section">
          <div className="agent-trace__section-head">
            <GitBranch size={13} />
            <span>规划步骤（{planSteps.filter((s) => s.status === 'success').length}/{planSteps.length}）</span>
          </div>
          <div className="agent-trace__plan">
            {planSteps.map((s) => {
              const collapsed = stepCollapsed[s.step] ?? false
              const hasContent = !!(s.summary || s.description)
              return (
                <div key={s.step} className={`agent-trace__plan-card agent-trace__plan-card--${s.status}`}>
                  <button
                    type="button"
                    className="agent-trace__plan-card-head"
                    onClick={() => toggleStep(s.step)}
                    aria-expanded={!collapsed}
                  >
                    <span className="agent-trace__plan-card-num">{s.step}</span>
                    <StepStatusIcon status={s.status} />
                    <span className="agent-trace__plan-card-title">{s.title}</span>
                    {s.status === 'success' && (
                      s.verified ? (
                        <span
                          className="agent-trace__verify agent-trace__verify--ok"
                          title={s.evidence ? `已验证：${s.evidence}` : '已验证：通过本步声明的 success_criteria 客观校验'}
                        >
                          <CheckCircle2 size={11} /> 已验证
                        </span>
                      ) : (
                        <span
                          className="agent-trace__verify agent-trace__verify--provisional"
                          title={s.evidence ? `暂定：${s.evidence}` : '暂定：无客观依据，建议人工确认'}
                        >
                          <AlertTriangle size={11} /> 暂定
                        </span>
                      )
                    )}
                    {hasContent && (
                      <span className="agent-trace__plan-card-caret">
                        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      </span>
                    )}
                  </button>
                  {!collapsed && hasContent && (
                    <div className="agent-trace__plan-card-body">
                      <MarkdownRenderer
                        content={s.description ? `**${s.description}**\n\n${s.summary ?? ''}` : (s.summary ?? '')}
                        className="agent-trace__plan-card-md"
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 工具调用时间轴（默认折叠） */}
      {toolSteps.length > 0 && (
        <section className="agent-trace__section">
          <div
            className="agent-trace__section-head agent-trace__section-head--btn"
            onClick={() => setToolsOpen((v) => !v)}
          >
            <Wrench size={13} />
            <span>工具调用（{toolSteps.length}）</span>
            <ChevronRight size={12} className={`agent-trace__caret${toolsOpen ? ' is-open' : ''}`} />
          </div>
          {toolsOpen && (
            <div className="agent-trace__tools">
              {toolSteps.map((t) => (
                <div key={t.callId} className="agent-trace__tool">
                  <StepStatusIcon status={t.status === 'success' ? 'success' : t.status === 'failed' ? 'failed' : 'running'} />
                  <span className="agent-trace__tool-name">{t.toolLabel}</span>
                  {typeof t.durationMs === 'number' && (
                    <span className="agent-trace__tool-dur">{(t.durationMs / 1000).toFixed(1)}s</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
        </>
      )}
    </div>
  )
}
