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
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, X, RotateCcw, SkipForward, Hand, HelpCircle } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { notifyOSWhenHidden } from '@/utils/osNotify'
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
  /** 异常决策回调：retry / skip / takeover / change-approach（takeover/change-approach 携带补充指示或新方案）。 */
  onResolve: (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => void
  /** 方案推荐回调：用户点选的 optionId；走「其他 / 自定义」时携带 customText。 */
  onSubmitChoice: (optionId: string, customText?: string) => void
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
      description: <RecoveryContent recovery={recovery} onResolve={doResolve} agentName={agentName} />,
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
}: {
  recovery: RecoveryRequest
  onResolve: (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => void
  agentName: string
}) {
  const [takeoverText, setTakeoverText] = useState('')
  const [approachText, setApproachText] = useState('')
  const isB = recovery.tier === 'B'
  const reason = recovery.reason || '（无）'
  const summary = recovery.summary || '（无）'
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
      <p className="agent-choice-note__question">{choice.question}</p>
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
