/**
 * PixelAgent：96×96 整数网格纯 SVG 渲染（v4 写实像素）。
 *
 * - 任意 `size` 等比缩放（viewBox 0 0 64 64，crispEdges）；
 * - `expression` / `pose` 可由外部独立动态控制；`state` 为高层兼容入口；
 * - motion=true 时播放帧动画；false 时输出静帧（保留 expression/pose 外形）。
 */
import { memo, useMemo } from 'react'
import { buildPixelRects } from './layers'
import { normalizeAppearance } from './parse'
import {
  resolveExpressionPose,
  type AgentMotionState,
  type BodyPose,
  type FaceExpression,
  type PixelAgentAppearance,
} from './types'
import './PixelAgent.scss'

export interface PixelAgentProps {
  appearance?: PixelAgentAppearance
  /** 高层动作状态（兼容旧调用；expression/pose 显式传入时优先） */
  state?: AgentMotionState
  /** 面部表情（外部动态控制） */
  expression?: FaceExpression
  /** 身体动作（外部动态控制） */
  pose?: BodyPose
  /** 显示边长（px），任意正数等比缩放 */
  size?: number
  /** 动效开关：快照 / 缩略图必须 false */
  motion?: boolean
  className?: string
}

export const PixelAgent = memo(function PixelAgent({
  appearance,
  state = 'idle',
  expression,
  pose,
  size = 64,
  motion = true,
  className,
}: PixelAgentProps) {
  const cfg = useMemo(() => normalizeAppearance(appearance), [appearance])
  const rects = useMemo(
    () => buildPixelRects(cfg, { state, expression, pose }),
    [cfg, state, expression, pose],
  )
  const resolved = useMemo(() => resolveExpressionPose({ state, expression, pose }), [state, expression, pose])

  // 静帧：去掉所有动画帧矩形；talk 嘴在 anim 里，补一条中性嘴
  const nodes = useMemo(() => {
    if (motion) return rects
    const base = rects.filter((r) => !r.cls)
    if (resolved.expression === 'talk') {
      return [
        ...base,
        { x: 44, y: 28, w: 8, h: 1, fill: '#8B5A55' },
        { x: 45, y: 29, w: 6, h: 1, fill: '#C47A72' },
      ]
    }
    return base
  }, [motion, rects, resolved.expression])

  const cls = [
    'pixel-agent',
    motion ? 'is-motion' : '',
    motion ? `pixel-agent--${resolved.pose}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <svg
      className={cls}
      width={size}
      height={size}
      viewBox="0 0 96 96"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', width: size, height: size }}
    >
      {nodes.map((r, i) => (
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
