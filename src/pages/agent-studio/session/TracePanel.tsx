import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, GitBranch, Sparkles, Wrench, ShieldAlert, CheckCircle2, XCircle, Loader2, ChevronRight, ChevronDown, AlertTriangle, RefreshCw } from 'lucide-react'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import type { IntentClassified, PlanStep, ThinkingChunk, ToolStep } from './types'

interface TracePanelProps {
  intent?: IntentClassified
  thinking: ThinkingChunk[]
  planSteps: PlanStep[]
  toolSteps: ToolStep[]
  /** #20260919003：任务启动 → 规划就绪的窗口期，空态显示「正在启动」占位而非静态文案。 */
  planning?: boolean
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

export function TracePanel({ intent, thinking, planSteps, toolSteps, planning = false }: TracePanelProps) {
  // 工具调用默认折叠：工具调用很多时全部展开会撑高右栏，默认收起、点击标题展开。
  const [toolsOpen, setToolsOpen] = useState(false)
  // 规划步骤默认全部展开（让用户看到每步详情）；单步可独立收叠。
  const [stepCollapsed, setStepCollapsed] = useState<Record<number, boolean>>({})
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
    </div>
  )
}
