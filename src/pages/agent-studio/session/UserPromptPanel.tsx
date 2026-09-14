/**
 * 统一人机交互弹窗（UserPromptPanel，Phase 2a）。
 *
 * 把三类「需要用户决策的主动弹窗」归一到一个组件，按 category 切换标题 / 图标 / 按钮，
 * 复用右下角 antd notification（duration=0，必须由用户决策后才销毁）：
 *  - approval（执行中权限门）：跳过 | 授权执行 | 接管并继续
 *  - exception（失败恢复，档 A）：跳过 | 重试 | 接管并继续
 *  - choice（方案推荐，Choice Chip）：渲染 Agent 给出的选项列表供点选
 *
 * 单 Agent 已强制串行，同一时刻只会有一个 category 活跃，三套通知 key 互不相冲。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  X,
  RotateCcw,
  SkipForward,
  Hand,
  HelpCircle,
  ChevronDown,
} from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { notifyOSWhenHidden } from '@/utils/osNotify'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import type { ApprovalRequest, ChoiceRequest, PlanApprovalRequest, RecoveryRequest } from './types'

interface UserPromptPanelProps {
  /** 授权类请求（非 null 时弹窗）。 */
  approval: ApprovalRequest | null
  /** 异常类请求（非 null 时弹窗）。 */
  recovery: RecoveryRequest | null
  /** 方案推荐类请求（非 null 时弹窗）。 */
  choice: ChoiceRequest | null
  /** 计划审批类请求（非 null 时弹窗）：复合任务规划完成后、执行前挂起，等待用户批准/修改。 */
  planApproval: PlanApprovalRequest | null
  /** 触发交互的智能体名称（用于「哪个智能体」）。 */
  agentName: string
  /** 授权决策回调：approve=授权执行 / skip=跳过 / takeover=授权+补充指示。 */
  onApproval: (decision: 'approve' | 'skip' | 'takeover', guidance?: string) => void
  /** 异常决策回调：retry / skip / takeover / change-approach（takeover/change-approach 携带补充指示或新方案）。 */
  onResolve: (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => void
  /** 方案推荐回调：用户点选的 optionId；走「其他 / 自定义」时携带 customText。 */
  onSubmitChoice: (optionId: string, customText?: string) => void
  /** 计划审批回调：approve=批准执行 / reject=拒绝终止 / revise=按修改意见重规划（携带意见）。 */
  onResolvePlanApproval: (decision: 'approve' | 'reject' | 'revise', guidance?: string) => void
  /**
   * 紧凑模式：右侧「接管」Tab 已展开时，底部弹窗压为纯操作横幅
   * （仅一行原因 + 决策按钮，不含输入框/改方案/详情——这些已在侧栏）。
   */
  compact?: boolean
}

/**
 * HITL 弹窗长文案夹层（唯一滚动点）。
 *
 * 规则：
 * 1. 弹窗整卡不滚、按钮钉底 —— 滚动只发生在本组件 body；
 * 2. 内容放得下收起高度 → 不渲染展开按钮、不限高（无滚动条）；
 * 3. 内容超高 → 收起态限高可滚；展开后撑满弹窗剩余高度（仍只有这一处滚）。
 */
function HitlClamp({
  children,
  className = '',
  collapsedHeight = 120,
  expandable = false,
  expandLabel = '展开详情',
}: {
  children: ReactNode
  className?: string
  /** 收起态最大高度（px）。 */
  collapsedHeight?: number
  expandable?: boolean
  expandLabel?: string
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => {
      // max-height 不影响 scrollHeight，这里读的是内容真实高度
      setOverflowing(el.scrollHeight > collapsedHeight + 2)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [collapsedHeight, children])

  const showToggle = expandable && (overflowing || open)
  // 收起且超高才限高；放得下或已展开都不设 inline max-height（展开靠 flex 撑满）
  const bodyStyle =
    !open && overflowing ? { maxHeight: collapsedHeight } : undefined

  return (
    <div
      className={`hitl-clamp${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
    >
      <div ref={bodyRef} className="hitl-clamp__body" style={bodyStyle}>
        {children}
      </div>
      {showToggle && (
        <button
          type="button"
          className="hitl-clamp__toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起' : expandLabel}
          <ChevronDown size={12} className={`hitl-clamp__caret${open ? ' is-open' : ''}`} />
        </button>
      )}
    </div>
  )
}

/** 从入参中提取最关键的授权内容行（避免把整段 JSON 堆进通知）。 */
function contentLines(req: ApprovalRequest): Array<{ label: string; value: string }> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(req.args || '{}')
  } catch {
    args = {}
  }
  const lines: Array<{ label: string; value: string }> = []
  if (typeof args.path === 'string') lines.push({ label: '目标路径', value: args.path })
  if (typeof args.command === 'string') lines.push({ label: '执行命令', value: args.command })
  if (typeof args.content === 'string') {
    const c = args.content as string
    lines.push({ label: '写入内容', value: c.length > 160 ? `${c.slice(0, 160)}…` : c })
  }
  if (lines.length === 0) {
    lines.push({ label: '请求参数', value: req.args || '—' })
  }
  return lines
}

export function UserPromptPanel({
  approval,
  recovery,
  choice,
  planApproval,
  agentName,
  onApproval,
  onResolve,
  onSubmitChoice,
  onResolvePlanApproval,
  compact = false,
}: UserPromptPanelProps) {
  const { notification } = useNotify()
  // 用 ref 持有最新回调与补充指示，避免其在 effect 依赖里变化导致通知反复重开。
  const approvalRef = useRef(onApproval)
  approvalRef.current = onApproval
  const resolveRef = useRef(onResolve)
  resolveRef.current = onResolve
  const choiceRef = useRef(onSubmitChoice)
  choiceRef.current = onSubmitChoice
  const planApprovalRef = useRef(onResolvePlanApproval)
  planApprovalRef.current = onResolvePlanApproval
  const approvalGuidanceRef = useRef('')

  // 授权弹窗（approve / skip / takeover）
  useEffect(() => {
    if (!approval) return
    const key = approval.approvalId
    const lines = contentLines(approval)
    approvalGuidanceRef.current = ''
    const allow = () => {
      notification.destroy(key)
      // 补充说明非空时，授权执行等价于「接管并继续」：把补充指示一并注入下一轮，
      // 否则后端按 Approve 处理会静默丢弃 guidance（用户备注不生效）。
      const g = approvalGuidanceRef.current.trim()
      approvalRef.current(g ? 'takeover' : 'approve', g || undefined)
    }
    const skip = () => {
      notification.destroy(key)
      approvalRef.current('skip')
    }
    const takeover = () => {
      notification.destroy(key)
      approvalRef.current('takeover', approvalGuidanceRef.current)
    }
    notification.open({
      key,
      placement: 'bottomRight',
      duration: 0, // 不自动关闭，必须由用户决策
      icon: (
        <span className="agent-approval-note__icon">
          <AlertTriangle size={16} />
        </span>
      ),
      message: '安全拦截 · 敏感操作需要授权',
      description: (
        <div className="agent-approval-note">
          <p className="agent-approval-note__line">
            智能体 <b>{agentName || '未知智能体'}</b> 请求调用工具{' '}
            <b className="agent-approval-note__tool">{approval.toolName}</b>，需要你的授权。
          </p>
          <HitlClamp collapsedHeight={120} expandable expandLabel="展开描述">
            <div className="agent-approval-note__desc agent-approval-note__desc--md">
              <MarkdownRenderer
                content={approval.description || '该操作可能影响你的文件或系统，请确认是否放行。'}
              />
            </div>
          </HitlClamp>
          <ul className="agent-approval-note__args">
            {lines.map((l, i) => (
              <li key={i}>
                <span className="agent-approval-note__label">{l.label}：</span>
                <code className="agent-approval-note__value">{l.value}</code>
              </li>
            ))}
          </ul>
          <Input
            autoComplete="off"
            className="agent-approval-note__input"
            placeholder="（可选）接管并继续时填写补充指示"
            onChange={(e) => {
              approvalGuidanceRef.current = (e.target as HTMLInputElement).value
            }}
          />
        </div>
      ),
      btn: (
        <div className="agent-approval-note__actions">
          <Button
            variant="ghost"
            size="sm"
            className="agent-approval-note__skip"
            onClick={skip}
          >
            <X size={14} />
            跳过
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="agent-approval-note__takeover"
            onClick={takeover}
          >
            <Hand size={14} />
            接管并继续
          </Button>
          <Button
            variant="solid"
            size="sm"
            className="agent-approval-note__allow"
            onClick={allow}
          >
            <Check size={14} />
            授权执行
          </Button>
        </div>
      ),
    })
      // 主窗口未在桌面最前时，额外弹系统原生通知提醒用户需要授权操作。
      notifyOSWhenHidden(
        '安全拦截 · 敏感操作需要授权',
        `智能体 ${agentName || '未知智能体'} 请求调用工具 ${approval.toolName}，需要你的授权`,
      ).catch(() => {})
    return () => {
      notification.destroy(key)
    }
  }, [approval, agentName, notification])

  // 异常弹窗（档 A：跳过 | 重试 | 接管；档 B：跳过 | 重试 | 改方案 | 接管并继续）
  useEffect(() => {
    if (!recovery) return
    const key = `recovery-${recovery.step}`
    const doResolve = (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => {
      notification.destroy(key)
      resolveRef.current(decision, guidance)
    }
    notification.open({
      key,
      placement: 'bottomRight',
      duration: 0, // 不自动关闭，必须由用户决策
      icon: (
        <span className="agent-recovery-note__icon">
          <AlertTriangle size={16} />
        </span>
      ),
      message: '步骤受阻 · 需要你的决策',
      description: <RecoveryContent recovery={recovery} onResolve={doResolve} agentName={agentName} compact={compact} />,
    })
      // 主窗口未在桌面最前时，额外弹系统原生通知提醒用户步骤受阻需决策。
      notifyOSWhenHidden(
        '步骤受阻 · 需要你的决策',
        `智能体 ${agentName || '未知智能体'} 在步骤 ${recovery.step}「${recovery.title}」重试后仍失败，请选择如何处理`,
      ).catch(() => {})
    return () => {
      notification.destroy(key)
    }
  }, [recovery, agentName, notification])

  // 方案推荐弹窗（选项 chip + 「其他 / 自定义」自由文本入口）
  useEffect(() => {
    if (!choice) return
    const key = `choice-${choice.choiceId}`
    const submit = (optionId: string, customText?: string) => {
      notification.destroy(key)
      choiceRef.current(optionId, customText)
    }
    notification.open({
      key,
      placement: 'bottomRight',
      duration: 0, // 不自动关闭，必须由用户点选
      icon: (
        <span className="agent-choice-note__icon">
          <HelpCircle size={16} />
        </span>
      ),
      message: '需要你选择',
      description: <ChoiceContent choice={choice} onSubmit={submit} />,
    })
      // 主窗口未在桌面最前时，额外弹系统原生通知提醒用户需要选择方案。
      notifyOSWhenHidden(
        '需要你选择',
        `智能体 ${agentName || '未知智能体'}：${choice.question}`,
      ).catch(() => {})
    return () => {
      notification.destroy(key)
    }
  }, [choice, notification])

  // 计划审批门禁（Phase 2b-3）：复合任务规划完成后、执行前挂起，等待用户批准/修改/拒绝。
  useEffect(() => {
    if (!planApproval) return
    const key = 'plan-approval'
    const doResolve = (decision: 'approve' | 'reject' | 'revise', guidance?: string) => {
      notification.destroy(key)
      planApprovalRef.current(decision, guidance)
    }
    notification.open({
      key,
      placement: 'bottomRight',
      duration: 0, // 不自动关闭，必须由用户决策
      icon: (
        <span className="agent-plan-note__icon">
          <HelpCircle size={16} />
        </span>
      ),
      message: '计划已生成 · 请审批',
      description: <PlanApprovalContent planApproval={planApproval} onResolve={doResolve} />,
    })
      // 主窗口未在桌面最前时，额外弹系统原生通知提醒用户需要审批计划。
      notifyOSWhenHidden(
        '计划已生成 · 请审批',
        `智能体 ${agentName || '未知智能体'} 已完成任务拆解（${planApproval.tasks.length} 步），等待你批准执行`,
      ).catch(() => {})
    return () => {
      notification.destroy(key)
    }
  }, [planApproval, agentName, notification])

  return null
}

/**
 * 异常恢复弹窗内容：受阻原因 / 已产出 / 失败命令 / 已改动文件展示，按 `tier` 渲染决策按钮。
 *  - 档 A（可恢复）：跳过 | 重试 | 接管并继续（接管带补充指示输入框）。
 *  - 档 B（高风险歧义，自动升档或命中风险关键词）：跳过 | 重试 | 改方案 | 接管并继续，
 *    「改方案」为默认高亮（solid），带新方案输入框，引导用户换思路而非无脑重试。
 * 抽成独立组件以便受控输入框持有自己的 state（notification description 只挂载一次）。
 */
function RecoveryContent({
  recovery,
  onResolve,
  agentName,
  compact = false,
}: {
  recovery: RecoveryRequest
  onResolve: (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => void
  agentName: string
  compact?: boolean
}) {
  const [takeoverText, setTakeoverText] = useState('')
  const [approachText, setApproachText] = useState('')
  const isB = recovery.tier === 'B'
  const reason = recovery.reason || '（无）'
  const summary = recovery.summary || '（无）'

  // 紧凑模式：右侧接管 Tab 已展开，底部只保留一行原因 + 操作按钮（不含输入框/改方案）
  if (compact) {
    return (
      <div className="agent-recovery-note agent-recovery-note--compact">
        <span className="agent-recovery-note__compact-reason" title={reason}>
          <AlertTriangle size={14} />
          <span className="agent-recovery-note__compact-text">{reason}</span>
        </span>
        <div className="agent-recovery-note__actions">
          <Button
            variant="ghost"
            size="sm"
            className="agent-recovery-note__skip"
            onClick={() => onResolve('skip')}
          >
            跳过
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="agent-recovery-note__retry"
            onClick={() => onResolve('retry')}
          >
            重试
          </Button>
          {isB && (
            <Button
              variant="solid"
              size="sm"
              className="agent-recovery-note__change-btn"
              onClick={() => onResolve('change-approach')}
            >
              改方案
            </Button>
          )}
          <Button
            variant={isB ? 'outline' : 'solid'}
            size="sm"
            className="agent-recovery-note__takeover"
            onClick={() => onResolve('takeover')}
          >
            接管并继续
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="agent-recovery-note">
      <p className="agent-recovery-note__line">
        智能体 <b>{agentName || '未知智能体'}</b> 在步骤{' '}
        <b className="agent-recovery-note__step">
          {recovery.step}「{recovery.title}」
        </b>{' '}
        {isB ? '已多次重试仍失败（高风险歧义），请选择如何处理。' : '自动重试后仍失败，请选择如何处理。'}
      </p>
      <div className="agent-recovery-note__reason">
        <span className="agent-recovery-note__label">受阻原因：</span>
        <HitlClamp
          className="agent-recovery-note__clamp"
          collapsedHeight={120}
          expandable
          expandLabel="展开完整原因"
        >
          <div className="agent-recovery-note__value agent-recovery-note__value--md">
            <MarkdownRenderer content={reason} />
          </div>
        </HitlClamp>
      </div>
      <div className="agent-recovery-note__tip">
        工具栈 / 已改动文件 / 失败命令详情见右侧「接管」面板
      </div>
      {summary !== '（无）' && (
        <div className="agent-recovery-note__summary">
          <span className="agent-recovery-note__label">已产出：</span>
          <HitlClamp className="agent-recovery-note__clamp" collapsedHeight={88} expandable expandLabel="展开产出">
            <div className="agent-recovery-note__value agent-recovery-note__value--md">
              <MarkdownRenderer content={summary} />
            </div>
          </HitlClamp>
        </div>
      )}
      {isB && (
        <div className="agent-recovery-note__change">
          <span className="agent-recovery-note__label">改方案（推荐）：描述新思路 / 新方案</span>
          <Input.TextArea
            className="agent-recovery-note__change-input"
            value={approachText}
            onChange={(e) => setApproachText(e.target.value)}
            placeholder="例如：换用另一种实现方式 / 跳过该外部依赖 / 改用 mock 数据…"
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={500}
          />
        </div>
      )}
      <Input
        autoComplete="off"
        className="agent-recovery-note__input"
        value={takeoverText}
        onChange={(e) => setTakeoverText(e.target.value)}
        placeholder="（可选）接管并继续时填写补充指示"
      />
      <div className="agent-recovery-note__actions">
        <Button
          variant="ghost"
          size="sm"
          className="agent-recovery-note__skip"
          onClick={() => onResolve('skip')}
        >
          <SkipForward size={14} />
          跳过
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="agent-recovery-note__retry"
          onClick={() => onResolve('retry')}
        >
          <RotateCcw size={14} />
          重试
        </Button>
        {isB && (
          <Button
            variant="solid"
            size="sm"
            className="agent-recovery-note__change-btn"
            onClick={() => onResolve('change-approach', approachText.trim() || undefined)}
          >
            <Hand size={14} />
            改方案
          </Button>
        )}
        <Button
          variant={isB ? 'outline' : 'solid'}
          size="sm"
          className="agent-recovery-note__takeover"
          onClick={() => onResolve('takeover', takeoverText.trim() || undefined)}
        >
          <Hand size={14} />
          接管并继续
        </Button>
      </div>
    </div>
  )
}

/**
 * 方案推荐弹窗内容：预设选项 chip + 「其他 / 自定义」自由文本入口。
 * 抽成独立组件以便受控输入框持有自己的 state（notification description 只挂载一次）。
 */
function ChoiceContent({
  choice,
  onSubmit,
}: {
  choice: ChoiceRequest
  onSubmit: (optionId: string, customText?: string) => void
}) {
  const [customText, setCustomText] = useState('')
  const trimmed = customText.trim()
  return (
    <div className="agent-choice-note">
      <HitlClamp collapsedHeight={96} expandable expandLabel="展开问题">
        <div className="agent-choice-note__question agent-choice-note__question--md">
          <MarkdownRenderer content={choice.question} />
        </div>
      </HitlClamp>
      <div className="agent-choice-note__options">
        {choice.options.map((o) => (
          <button
            key={o.id}
            type="button"
            className="agent-choice-note__chip"
            onClick={() => onSubmit(o.id)}
          >
            <span className="agent-choice-note__label">{o.label}</span>
            {o.description && (
              <span className="agent-choice-note__desc">{o.description}</span>
            )}
          </button>
        ))}
      </div>
      <div className="agent-choice-note__custom">
        <div className="agent-choice-note__custom-divider">
          <span>或填写自定义方案</span>
        </div>
        <Input.TextArea
          className="agent-choice-note__custom-input"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          placeholder="如果以上选项都不合适，在此填写你的方案…"
          autoSize={{ minRows: 2, maxRows: 4 }}
          maxLength={500}
        />
        <Button
          className="agent-choice-note__custom-submit"
          type="primary"
          size="sm"
          disabled={!trimmed}
          onClick={() => onSubmit('__custom__', trimmed)}
        >
          提交自定义方案
        </Button>
      </div>
    </div>
  )
}

/**
 * 计划审批弹窗内容（Phase 2b-3）：展示规划生成的任务步骤清单（序号 / 标题 / 描述 / 依赖），
 * 提供三个决策：批准执行 / 拒绝终止 / 修改意见（按意见重规划）。
 * 抽成独立组件以便受控输入框持有自己的 state（notification description 只挂载一次）。
 */
function PlanApprovalContent({
  planApproval,
  onResolve,
}: {
  planApproval: PlanApprovalRequest
  onResolve: (decision: 'approve' | 'reject' | 'revise', guidance?: string) => void
}) {
  const [reviseText, setReviseText] = useState('')
  const trimmed = reviseText.trim()
  // depends_on 存的是 task_id，列表按 step 编号渲染；映射成 step 编号展示依赖，避免「依赖：步骤 abc-123」的困惑。
  const stepByTaskId = new Map<number, number>()
  planApproval.tasks.forEach((t) => {
    if (t.taskId) stepByTaskId.set(Number(t.taskId) || t.step, t.step)
  })
  return (
    <div className="agent-plan-note">
      <div className="agent-plan-note__summary agent-plan-note__summary--md">
        <MarkdownRenderer content={planApproval.goalSummary || '（无目标描述）'} />
      </div>
      <HitlClamp collapsedHeight={168} expandable expandLabel="展开全部步骤">
        <ul className="agent-plan-note__steps">
          {planApproval.tasks.map((t) => (
            <li key={t.step} className="agent-plan-note__step">
              <span className="agent-plan-note__step-idx">{t.step}</span>
              <div className="agent-plan-note__step-body">
                <span className="agent-plan-note__step-title">{t.title}</span>
                {t.description && <span className="agent-plan-note__step-desc">{t.description}</span>}
                {t.dependsOn && t.dependsOn.length > 0 && (
                  <span className="agent-plan-note__step-dep">
                    依赖：步骤{' '}
                    {t.dependsOn
                      .map((id) => stepByTaskId.get(Number(id)) ?? id)
                      .join('、')}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </HitlClamp>
      <Input.TextArea
        className="agent-plan-note__revise-input"
        value={reviseText}
        onChange={(e) => setReviseText(e.target.value)}
        placeholder="（可选）点「修改意见」时填写调整要求，例如：第 3 步改为优先用 mock 数据、合并第 2/4 步…"
        autoSize={{ minRows: 2, maxRows: 4 }}
        maxLength={500}
      />
      <div className="agent-plan-note__actions">
        <Button
          variant="ghost"
          size="sm"
          className="agent-plan-note__reject"
          onClick={() => onResolve('reject')}
        >
          <X size={14} />
          拒绝
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="agent-plan-note__revise"
          disabled={!trimmed}
          onClick={() => onResolve('revise', trimmed)}
        >
          修改意见
        </Button>
        <Button
          variant="solid"
          size="sm"
          className="agent-plan-note__approve"
          onClick={() => onResolve('approve')}
        >
          <Check size={14} />
          批准执行
        </Button>
      </div>
    </div>
  )
}
