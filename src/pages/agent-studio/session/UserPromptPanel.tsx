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
import { useEffect, useRef } from 'react'
import { AlertTriangle, Check, X, RotateCcw, SkipForward, Hand, HelpCircle } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import type { ApprovalRequest, ChoiceRequest, RecoveryRequest } from './types'

interface UserPromptPanelProps {
  /** 授权类请求（非 null 时弹窗）。 */
  approval: ApprovalRequest | null
  /** 异常类请求（非 null 时弹窗）。 */
  recovery: RecoveryRequest | null
  /** 方案推荐类请求（非 null 时弹窗）。 */
  choice: ChoiceRequest | null
  /** 触发交互的智能体名称（用于「哪个智能体」）。 */
  agentName: string
  /** 授权决策回调：approve=授权执行 / skip=跳过 / takeover=授权+补充指示。 */
  onApproval: (decision: 'approve' | 'skip' | 'takeover', guidance?: string) => void
  /** 异常决策回调：retry / skip / takeover（takeover 时携带补充指示）。 */
  onResolve: (decision: 'retry' | 'skip' | 'takeover', guidance?: string) => void
  /** 方案推荐回调：用户点选的 optionId。 */
  onSubmitChoice: (optionId: string) => void
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
  agentName,
  onApproval,
  onResolve,
  onSubmitChoice,
}: UserPromptPanelProps) {
  const { notification } = useNotify()
  // 用 ref 持有最新回调与补充指示，避免其在 effect 依赖里变化导致通知反复重开。
  const approvalRef = useRef(onApproval)
  approvalRef.current = onApproval
  const resolveRef = useRef(onResolve)
  resolveRef.current = onResolve
  const choiceRef = useRef(onSubmitChoice)
  choiceRef.current = onSubmitChoice
  const approvalGuidanceRef = useRef('')
  const recoveryGuidanceRef = useRef('')

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
          <p className="agent-approval-note__desc">
            {approval.description || '该操作可能影响你的文件或系统，请确认是否放行。'}
          </p>
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
    return () => {
      notification.destroy(key)
    }
  }, [approval, agentName, notification])

  // 异常弹窗（档 A：跳过 | 重试 | 接管）
  useEffect(() => {
    if (!recovery) return
    const key = `recovery-${recovery.step}`
    const reason = recovery.reason || '（无）'
    const summary = recovery.summary || '（无）'
    recoveryGuidanceRef.current = ''
    const doResolve = (decision: 'retry' | 'skip' | 'takeover') => {
      notification.destroy(key)
      resolveRef.current(decision, decision === 'takeover' ? recoveryGuidanceRef.current : undefined)
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
      description: (
        <div className="agent-recovery-note">
          <p className="agent-recovery-note__line">
            智能体 <b>{agentName || '未知智能体'}</b> 在步骤{' '}
            <b className="agent-recovery-note__step">
              {recovery.step}「{recovery.title}」
            </b>{' '}
            自动重试后仍失败，请选择如何处理。
          </p>
          <div className="agent-recovery-note__reason">
            <span className="agent-recovery-note__label">受阻原因：</span>
            <span className="agent-recovery-note__value">{reason}</span>
          </div>
          {summary !== '（无）' && (
            <div className="agent-recovery-note__summary">
              <span className="agent-recovery-note__label">已产出：</span>
              <span className="agent-recovery-note__value">{summary}</span>
            </div>
          )}
          {recovery.failedCommand && (
            <div className="agent-recovery-note__reason">
              <span className="agent-recovery-note__label">失败命令：</span>
              <code className="agent-recovery-note__value">{recovery.failedCommand}</code>
            </div>
          )}
          {recovery.changedFiles && recovery.changedFiles.length > 0 && (
            <div className="agent-recovery-note__summary">
              <span className="agent-recovery-note__label">已改动文件：</span>
              <span className="agent-recovery-note__value">{recovery.changedFiles.join('、')}</span>
            </div>
          )}
          <Input
            autoComplete="off"
            className="agent-recovery-note__input"
            placeholder="（可选）接管时填写补充指示，引导智能体重跑本步骤"
            onChange={(e) => {
              recoveryGuidanceRef.current = (e.target as HTMLInputElement).value
            }}
          />
        </div>
      ),
      btn: (
        <div className="agent-recovery-note__actions">
          <Button
            variant="ghost"
            size="sm"
            className="agent-recovery-note__skip"
            onClick={() => doResolve('skip')}
          >
            <SkipForward size={14} />
            跳过
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="agent-recovery-note__retry"
            onClick={() => doResolve('retry')}
          >
            <RotateCcw size={14} />
            重试
          </Button>
          <Button
            variant="solid"
            size="sm"
            className="agent-recovery-note__takeover"
            onClick={() => doResolve('takeover')}
          >
            <Hand size={14} />
            接管并继续
          </Button>
        </div>
      ),
    })
    return () => {
      notification.destroy(key)
    }
  }, [recovery, agentName, notification])

  // 方案推荐弹窗（选项 chip）
  useEffect(() => {
    if (!choice) return
    const key = `choice-${choice.choiceId}`
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
      description: (
        <div className="agent-choice-note">
          <p className="agent-choice-note__question">{choice.question}</p>
          <div className="agent-choice-note__options">
            {choice.options.map((o) => (
              <button
                key={o.id}
                type="button"
                className="agent-choice-note__chip"
                onClick={() => {
                  notification.destroy(key)
                  choiceRef.current(o.id)
                }}
              >
                <span className="agent-choice-note__label">{o.label}</span>
                {o.description && (
                  <span className="agent-choice-note__desc">{o.description}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      ),
    })
    return () => {
      notification.destroy(key)
    }
  }, [choice, notification])

  return null
}
