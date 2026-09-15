/**
 * 任务步骤 + 工具调用嵌套时间轴。
 *
 * 设计动机（替代旧版「PlanStepsBar + ToolTimeline」并列两块）：
 *  - 「已深度思考」面板（ThoughtPanel）承载 LLM 的思考/决策过程（含步骤过渡、工具调用决意）；
 *  - 本组件承担 Agent「执行轨迹」：每个规划步骤为一级标题，下面挂该步骤里实际调用的工具卡片。
 *    即「Agent 先确定任务（步骤标题）→ 执行任务时调用了什么工具」的语义顺序。
 *
 * 数据来源：
 *  - `planSteps`：阶段二规划生成的步骤进度（live 轮可用）；
 *  - `toolSteps`：工具调用流水（按 ToolStep.step 字段归组到对应步骤下；
 *    历史回显无 planSteps 时按 toolSteps 的 step 字段反推分组）。
 *
 * 缺省行为：步骤默认展开（让用户看到 Agent 在做什么），整块若有 ≥ 3 步提供「全部折叠/展开」快捷按钮。
 */
import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleSlash,
  ListChecks,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { ToolStepCard } from './ToolStepCard'
import type { PlanStep, ToolStep } from './types'
import './PlanToolTimeline.scss'

interface PlanToolTimelineProps {
  /** 规划步骤（live 轮提供；历史消息通常无）。 */
  planSteps?: PlanStep[]
  /** 工具调用流水（含 step 字段用于归组）。 */
  toolSteps?: ToolStep[]
}

interface Group {
  /** 步骤序号；null 表示无归属（SIMPLE_CHAT 或 step_started 之前的工具）。 */
  step: number | null
  title: string
  status: PlanStep['status']
  summary?: string
  tools: ToolStep[]
}

/** 把 planSteps + toolSteps 组合成分组（步骤顺序按 planSteps 走；缺失步序时按 toolSteps.step 反推）。 */
function buildGroups(planSteps: PlanStep[] | undefined, toolSteps: ToolStep[]): Group[] {
  const groups: Group[] = []
  const toolsByStep = new Map<number, ToolStep[]>()
  const orphanTools: ToolStep[] = []

  for (const t of toolSteps) {
    if (typeof t.step === 'number') {
      const arr = toolsByStep.get(t.step) ?? []
      arr.push(t)
      toolsByStep.set(t.step, arr)
    } else {
      orphanTools.push(t)
    }
  }

  if (planSteps && planSteps.length > 0) {
    for (const ps of planSteps) {
      groups.push({
        step: ps.step,
        title: ps.title,
        status: ps.status,
        summary: ps.summary,
        tools: toolsByStep.get(ps.step) ?? [],
      })
    }
  } else {
    // 历史回显或 SIMPLE_CHAT：按 toolSteps.step 升序建组
    const stepNums = Array.from(toolsByStep.keys()).sort((a, b) => a - b)
    for (const s of stepNums) {
      groups.push({
        step: s,
        title: `步骤 ${s}`,
        status: 'success',
        tools: toolsByStep.get(s) ?? [],
      })
    }
  }

  if (orphanTools.length > 0) {
    // 有规划步骤但工具没挂上：确实是「未归属」；
    // 完全没有规划（如 SIMPLE_CHAT）：不叫「未归属工具」，直接叫「工具调用」，更符合心智。
    const hasPlan = !!(planSteps && planSteps.length > 0)
    groups.push({
      step: null,
      title: hasPlan ? '未归属工具' : '工具调用',
      status: 'success',
      tools: orphanTools,
    })
  }

  return groups
}

function GroupIcon({ status }: { status: PlanStep['status'] }) {
  if (status === 'success') return <CheckCircle2 size={14} className="plan-tool-timeline__ok" />
  if (status === 'failed') return <XCircle size={14} className="plan-tool-timeline__fail" />
  if (status === 'running') return <Loader2 size={14} className="plan-tool-timeline__spin" />
  if (status === 'blocked') return <AlertTriangle size={14} color="var(--color-warning, #F59E0B)" />
  if (status === 'retrying') return <RefreshCw size={14} className="plan-tool-timeline__spin" />
  return <Circle size={14} className="plan-tool-timeline__pending" />
}

function StepHead({ group, open, onToggle }: { group: Group; open: boolean; onToggle: () => void }) {
  const doneCount = group.tools.filter((t) => t.status === 'success').length
  const failCount = group.tools.filter((t) => t.status === 'failed').length
  return (
    <button
      type="button"
      className="plan-tool-timeline__head"
      onClick={onToggle}
      aria-expanded={open}
    >
      <ChevronRight
        size={13}
        className={`plan-tool-timeline__caret${open ? ' is-open' : ''}`}
      />
      <GroupIcon status={group.status} />
      <span className="plan-tool-timeline__title">
        {group.step !== null ? `步骤 ${group.step}：${group.title}` : group.title}
      </span>
      {group.tools.length > 0 && (
        <span className="plan-tool-timeline__counts">
          {group.tools.length} 个工具{doneCount > 0 || failCount > 0 ? `（${doneCount}✓` : ''}
          {failCount > 0 ? ` / ${failCount}✗` : doneCount > 0 ? '）' : ''}
        </span>
      )}
    </button>
  )
}

export function PlanToolTimeline({ planSteps, toolSteps = [] }: PlanToolTimelineProps) {
  const groups = useMemo(() => buildGroups(planSteps, toolSteps), [planSteps, toolSteps])

  // 步骤默认折叠（工具调用内容很多、默认展开会一直撑高对话区，影响阅读）；
  // 顶部摘要仍显示「N步 · M工具（✓/✗）」与步骤头状态，用户按需展开单个步骤或「全部展开」。
  type CollapsedMap = Partial<Record<number | 'orphan', boolean>>
  const [collapsed, setCollapsed] = useState<CollapsedMap>({})
  const [allCollapsed, setAllCollapsed] = useState(true)

  if (groups.length === 0) return null

  const toggle = (key: number | 'orphan') => {
    if (allCollapsed) {
      setAllCollapsed(false)
      setCollapsed({})
      return
    }
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const totalTools = toolSteps.length
  const totalDone = toolSteps.filter((t) => t.status === 'success').length
  const totalFailed = toolSteps.filter((t) => t.status === 'failed').length

  return (
    <div className="plan-tool-timeline">
      <div className="plan-tool-timeline__topbar">
        <ListChecks size={13} />
        <span>执行轨迹</span>
        <span className="plan-tool-timeline__topbar-meta">
          {planSteps?.length ? `${planSteps.length} 步 · ` : ''}
          {totalTools} 个工具
          {(totalDone > 0 || totalFailed > 0) && (
            <span className="plan-tool-timeline__topbar-stats">
              （<span className="plan-tool-timeline__ok">{totalDone}✓</span>
              {totalFailed > 0 && (
                <>
                  {' / '}
                  <span className="plan-tool-timeline__fail">{totalFailed}✗</span>
                </>
              )}
              ）
            </span>
          )}
        </span>
        {groups.length >= 2 && (
          <button
            type="button"
            className="plan-tool-timeline__collapse-all"
            onClick={() => {
              if (allCollapsed) {
                setAllCollapsed(false)
                setCollapsed({})
              } else {
                setAllCollapsed(true)
                setCollapsed({})
              }
            }}
          >
            {allCollapsed ? (
              <>
                <CircleSlash size={11} /> 全部展开
              </>
            ) : (
              <>
                <CircleSlash size={11} /> 全部折叠
              </>
            )}
          </button>
        )}
      </div>
      <ol className="plan-tool-timeline__list">
        {groups.map((g) => {
          const key = g.step ?? 'orphan'
          const open = allCollapsed ? false : !collapsed[key]
          return (
            <li key={key} className={`plan-tool-timeline__group plan-tool-timeline__group--${g.status}`}>
              <StepHead group={g} open={open} onToggle={() => toggle(key)} />
              {open && (
                <div className="plan-tool-timeline__body">
                  {g.tools.length === 0 ? (
                    <div className="plan-tool-timeline__empty">
                      {g.status === 'running' ? '工具调用中…' : '该步骤无工具调用'}
                    </div>
                  ) : (
                    g.tools.map((t) => <ToolStepCard key={t.callId} step={t} />)
                  )}
                  {g.summary && g.tools.length > 0 && (
                    <div className="plan-tool-timeline__summary">{g.summary}</div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}