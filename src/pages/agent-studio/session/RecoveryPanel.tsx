/**
 * 步骤级恢复面板（RecoveryPanel）。
 *
 * 当 Rust 运行时某子任务「自动重试耗尽」仍失败、推送 `agent-recovery-needed` 事件挂起时，
 * 本组件在**右下角**弹出一个 antd notification（走 @/components/ui/notify 实例，跟随深浅主题），
 * 不再打断对话阅读。面板提供三个决策按钮：
 *  - 「重试」：从头重跑当前受阻子任务（不携带补充指示）；
 *  - 「跳过」：把该步骤标记为「已跳过」并继续后续步骤；
 *  - 「接管并继续」：把文本框里的补充指示注入当前子任务，引导式重跑。
 *
 * 必须由用户决策后才销毁（duration=0）；决策经 `resolveRecovery` 回传后台挂起的流水线。
 */
import { useEffect, useRef } from 'react'
import { RotateCcw, SkipForward, Hand, AlertTriangle } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import type { RecoveryRequest } from './types'

interface RecoveryPanelProps {
  /** 当前受阻的恢复请求；为 null 时不展示。 */
  recovery: RecoveryRequest | null
  /** 触发恢复的智能体名称（用于「哪个智能体」）。 */
  agentName: string
  /** 决策回调：decision ∈ retry | skip | takeover，takeover 时携带补充指示 guidance。 */
  onResolve: (decision: 'retry' | 'skip' | 'takeover', guidance?: string) => void
}

export function RecoveryPanel({ recovery, agentName, onResolve }: RecoveryPanelProps) {
  const { notification } = useNotify()
  // 用 ref 持有最新回调与补充指示，避免其在 effect 依赖里变化导致通知反复重开。
  const resolveRef = useRef(onResolve)
  resolveRef.current = onResolve
  const guidanceRef = useRef('')

  useEffect(() => {
    if (!recovery) return
    const key = `recovery-${recovery.step}`
    const reason = recovery.reason || '（无）'
    const summary = recovery.summary || '（无）'

    const doResolve = (decision: 'retry' | 'skip' | 'takeover') => {
      notification.destroy(key)
      resolveRef.current(decision, decision === 'takeover' ? guidanceRef.current : undefined)
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
          <Input
            autoComplete="off"
            className="agent-recovery-note__input"
            placeholder="（可选）接管时填写补充指示，引导智能体重跑本步骤"
            onChange={(e) => {
              guidanceRef.current = (e.target as HTMLInputElement).value
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

  return null
}
