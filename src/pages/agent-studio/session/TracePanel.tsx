import { useState } from 'react'
import { Bot, GitBranch, Sparkles, Wrench, ShieldAlert, CheckCircle2, XCircle, Loader2, ChevronRight, ChevronDown } from 'lucide-react'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import type { IntentClassified, PlanStep, ThinkingChunk, ToolStep } from './types'

interface TracePanelProps {
  intent?: IntentClassified
  thinking: ThinkingChunk[]
  planSteps: PlanStep[]
  toolSteps: ToolStep[]
}

const LAYER_META: Record<ThinkingChunk['layer'], { label: string; color: string }> = {
  plan: { label: '规划', color: 'var(--color-trace-plan, #6366F1)' },
  exec: { label: '执行', color: 'var(--color-trace-exec, #3B82F6)' },
  selfcheck: { label: '自检', color: 'var(--color-trace-selfcheck, #F59E0B)' },
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
  return <span className="agent-trace__dot" />
}

export function TracePanel({ intent, thinking, planSteps, toolSteps }: TracePanelProps) {
  // 工具调用默认折叠：工具调用很多时全部展开会撑高右栏，默认收起、点击标题展开。
  const [toolsOpen, setToolsOpen] = useState(false)
  // 规划步骤默认全部展开（让用户看到每步详情）；单步可独立收叠。
  const [stepCollapsed, setStepCollapsed] = useState<Record<number, boolean>>({})
  const hasData = intent || thinking.length > 0 || planSteps.length > 0 || toolSteps.length > 0

  const toggleStep = (step: number) => {
    setStepCollapsed((prev) => ({ ...prev, [step]: !prev[step] }))
  }

  if (!hasData) {
    return (
      <div className="agent-trace">
        <div className="agent-trace__empty">运行一次任务后，这里会展示执行轨迹：意图分类 → 规划 → 工具调用 → 分层思考。</div>
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
            {thinking.map((t, i) => {
              const meta = LAYER_META[t.layer] ?? LAYER_META.exec
              return (
                <div key={i} className="agent-trace__think" style={{ borderLeftColor: meta.color }}>
                  <span className="agent-trace__think-tag" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                  <span className="agent-trace__think-text">{t.text}</span>
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
