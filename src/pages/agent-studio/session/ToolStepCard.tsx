/**
 * 工具调用折叠卡片（ToolStepCard）。
 *
 * 对应方案步骤 5 的「执行步骤折叠卡片」：单条工具调用以一张可折叠卡片呈现，
 * 头部显示工具名 + 状态徽标（旋转/spinner → 绿勾 / 红叉），点击展开查看入参(args)与结果(result)。
 *
 * 设计：
 *  - running 态用旋转图标（非 CSS 动画依赖外部库，纯 SVG transform）；
 *  - success/failed 用 lucide 的 Check / X；
 *  - sensitive 工具在头部加「需审批」红色小标，提示该步骤曾经过用户授权；
 *  - args / result 以 `<pre>` 展示（保留换行与缩进），过长时容器滚动（限高）。
 */
import { useState } from 'react'
import { Check, ChevronRight, Loader2, X, ShieldAlert } from 'lucide-react'
import type { ToolStep } from './types'
import { ToolResultView } from './ToolResultView'
import './ToolStepCard.scss'

interface ToolStepCardProps {
  step: ToolStep
}

function tryPretty(json?: string): string {
  if (!json) return ''
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

export function ToolStepCard({ step }: ToolStepCardProps) {
  const [open, setOpen] = useState(false)
  const { status, toolLabel, sensitive, args, result } = step

  const statusIcon =
    status === 'running' ? (
      <Loader2 size={14} className="tool-step__spin" />
    ) : status === 'success' ? (
      <Check size={14} className="tool-step__ok" />
    ) : (
      <X size={14} className="tool-step__fail" />
    )

  const statusText =
    status === 'running' ? '执行中' : status === 'success' ? '完成' : '失败'

  return (
    <div className={`tool-step tool-step--${status}`}>
      <button
        type="button"
        className="tool-step__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronRight
          size={14}
          className={`tool-step__caret${open ? ' is-open' : ''}`}
        />
        {statusIcon}
        <span className="tool-step__name">{toolLabel}</span>
        {sensitive && (
          <span className="tool-step__sensitive" title="该操作需经你的审批授权">
            <ShieldAlert size={12} />
            需审批
          </span>
        )}
        <span className="tool-step__status">{statusText}</span>
        {typeof step.durationMs === 'number' && status !== 'running' && (
          <span className="tool-step__dur">{(step.durationMs / 1000).toFixed(1)}s</span>
        )}
      </button>

      {open && (
        <div className="tool-step__body">
          {args && (
            <div className="tool-step__block">
              <div className="tool-step__block-title">调用参数</div>
              <pre className="tool-step__code">{tryPretty(args)}</pre>
            </div>
          )}
          {result && (
            <div className="tool-step__block">
              <div className="tool-step__block-title">
                {status === 'failed' ? '错误信息' : '返回结果'}
              </div>
              <ToolResultView toolName={step.toolName} result={result} variant="block" failed={status === 'failed'} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
