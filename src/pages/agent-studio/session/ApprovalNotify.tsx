/**
 * 高危操作授权通知（ApprovalNotify）。
 *
 * 替代原先直接嵌在对话流里的 `ApprovalModal`：当 Rust 运行时准备执行敏感工具
 * （native__edit_file / execute_command / run_python_sandbox 等）而挂起、推送
 * `agent-awaiting-approval` 事件时，本组件在**右下角**弹出一个 antd notification
 * （走 @/components/ui/notify 的 notification 实例，跟随深浅主题），不再打断对话阅读。
 *
 * 固定表达三要素：
 *  - 哪个智能体（agentName，来自页面上下文）
 *  - 调用了什么（request.toolName）
 *  - 需要授权内容（request.description + 关键入参摘要）
 * 底部提供「授权执行 / 拒绝授权」两个决策按钮，必须用户决策后才销毁（duration=0）。
 */
import { useEffect, useRef } from 'react'
import { AlertTriangle, Check, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import type { ApprovalRequest } from './types'

interface ApprovalNotifyProps {
  /** 当前待审批请求；为 null 时不展示。 */
  approval: ApprovalRequest | null
  /** 触发审批的智能体名称（用于「哪个智能体」）。 */
  agentName: string
  /** 决策回调：approved=true 放行；false 拒绝。 */
  onDecision: (approved: boolean, reason?: string) => void
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

export function ApprovalNotify({ approval, agentName, onDecision }: ApprovalNotifyProps) {
  const { notification } = useNotify()
  // 用 ref 持有最新 onDecision，避免其在 effect 依赖里变化导致通知反复重开。
  const decisionRef = useRef(onDecision)
  decisionRef.current = onDecision

  useEffect(() => {
    if (!approval) return
    const key = approval.approvalId
    const lines = contentLines(approval)

    const allow = () => {
      notification.destroy(key)
      decisionRef.current(true)
    }
    const deny = () => {
      notification.destroy(key)
      decisionRef.current(false)
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
          <p className="agent-approval-note__desc">{approval.description || '该操作可能影响你的文件或系统，请确认是否放行。'}</p>
          <ul className="agent-approval-note__args">
            {lines.map((l, i) => (
              <li key={i}>
                <span className="agent-approval-note__label">{l.label}：</span>
                <code className="agent-approval-note__value">{l.value}</code>
              </li>
            ))}
          </ul>
        </div>
      ),
      btn: (
        <div className="agent-approval-note__actions">
          <Button
            variant="ghost"
            size="sm"
            className="agent-approval-note__deny"
            onClick={deny}
          >
            <X size={14} />
            拒绝授权
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

  return null
}
