/**
 * 会话流跟随滚动（台账 S1：自 chat.tsx 原样迁出 hook 化，行为零改动）。
 *
 * - followBottom=true（跟随模式）时内容增长自动贴底；用户向上滚（滚轮上/拖动滚动条离开
 *   底部）即解除跟随、回看历史不被打扰；手动滚回底部附近自动恢复；发新提问强制恢复。
 * - 跟随贴底一律瞬时赋值 scrollTop（禁用 smooth）：流式 chunk 每 16ms 一批，上一次 smooth
 *   动画未完成即被下一次打断，多次平滑动画互相拉扯正是「抖动」根因；瞬时赋值恒显示最新内容。
 * - 正文为打字机逐字渲染（比数据流滞后）：仅靠数据变化触发贴底会永远追着实际渲染高度跑
 *   （「显示的不是最新内容」的另一层根因），故流式期间用 RAF 循环按**实际渲染高度**贴底。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolStep } from '../session/types'
import type { ChatMessage } from './types'

export function useFollowScroll(opts: {
  isStreaming: boolean
  isRunning: boolean
  messages: ChatMessage[]
  toolSteps: ToolStep[]
  streamingText: string
}) {
  const { isStreaming, isRunning, messages, toolSteps, streamingText } = opts
  const scrollRef = useRef<HTMLDivElement>(null)
  const [followBottom, setFollowBottom] = useState(true)
  const followRafRef = useRef<number | null>(null)
  // 上次 scrollTop：onScroll 判定「用户向上拖动」的基准（程序贴底 scrollTop 只增不减）。
  const lastScrollTopRef = useRef(0)
  // 历史会话加载时瞬时跳到底部，避免 smooth 滚动造成的长列表滑动抖动
  const restoringRef = useRef(false)

  /** 跟随贴底（rAF 合并 + 瞬时赋值）：同一帧多次触发只滚一次。 */
  const scheduleFollowScroll = useCallback(() => {
    if (followRafRef.current != null) return
    followRafRef.current = requestAnimationFrame(() => {
      followRafRef.current = null
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  // 流式期间持续贴底循环：每帧无条件贴底（赋相同值浏览器 no-op，成本可忽略）——
  // 以实际渲染高度为准，任何间隙/高度暴涨下一帧立即补齐，输出中途绝不掉队。
  // 解除跟随（followBottom=false）→ 循环即停；恢复/新提问 → 随依赖重启。
  useEffect(() => {
    if (!(isStreaming || isRunning) || !followBottom) return
    let raf = 0
    const tick = () => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isStreaming, isRunning, followBottom])

  // 新消息 / 工具步骤 / 流式文本变化时：仅「跟随模式」下贴底（瞬时、rAF 合并）；
  // 用户已向上滚动回看历史时不打扰（解除跟随），滚回底部附近自动恢复。
  // 流式期间的打字机逐字增长由上方 RAF 循环覆盖（以实际渲染高度为准）。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (restoringRef.current) {
      // 历史会话回显：瞬时定位到底部，避免整列平滑滑动的视觉抖动
      restoringRef.current = false
      setFollowBottom(true)
      el.scrollTop = el.scrollHeight
      return
    }
    if (followBottom) scheduleFollowScroll()
  }, [messages, toolSteps, streamingText, followBottom, scheduleFollowScroll])

  return { scrollRef, followBottom, setFollowBottom, lastScrollTopRef, scheduleFollowScroll }
}
