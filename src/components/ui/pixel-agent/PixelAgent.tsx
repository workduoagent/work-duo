/**
 * PixelAgent：32×32 整数网格纯 SVG 渲染（v2 游戏级）。
 *
 * - motion=true（弹窗预览）时按 state 挂 is-motion + 状态类，CSS 驱动帧动画；
 * - motion=false（快照 / 缩略图）时过滤掉 B 帧矩形（pa-fb），保留 A 帧静态成像；
 * - fill 渲染期解析成 hex（buildPixelRects 内完成），不引用 CSS 变量。
 */
import { memo, useMemo } from 'react'
import { buildPixelRects } from './layers'
import { normalizeAppearance } from './parse'
import type { AgentMotionState, PixelAgentAppearance } from './types'
import './PixelAgent.scss'

export interface PixelAgentProps {
  appearance?: PixelAgentAppearance
  /** 动作状态（驱动表情与姿态），默认 idle */
  state?: AgentMotionState
  /** 逻辑像素边长，默认 64（弹窗预览 192） */
  size?: number
  /** 动效开关：快照 / 缩略图必须 false */
  motion?: boolean
  className?: string
}

export const PixelAgent = memo(function PixelAgent({
  appearance,
  state = 'idle',
  size = 64,
  motion = true,
  className,
}: PixelAgentProps) {
  const cfg = useMemo(() => normalizeAppearance(appearance), [appearance])
  const rects = useMemo(() => buildPixelRects(cfg, motion ? state : 'idle'), [cfg, motion, state])
  const visible = motion ? rects : rects.filter((r) => !r.cls?.includes('pa-fb'))
  const cls = [
    'pixel-agent',
    motion ? 'is-motion' : '',
    motion ? `pixel-agent--${state}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <svg
      className={cls}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {visible.map((r, i) => (
        <rect
          key={i}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          fill={r.fill}
          className={r.cls}
        />
      ))}
    </svg>
  )
})
