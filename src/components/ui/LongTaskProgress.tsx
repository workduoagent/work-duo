import { useEffect, useRef, useState } from 'react'
import './LongTaskProgress.scss'

/**
 * 长耗时任务进度（F048）。
 *
 * 背景：导入类操作（Skill ZIP 解包、模型 JSON 解析、MCP 配置导入）动辄数百
 * 毫秒到数秒，此前界面**完全静止**——只有按钮转圈，用户不知道是在读文件、
 * 解析还是写库，更不知道还要等多久。而沙箱 Python 的 `createWithProgress`
 * 已有成熟形态（分阶段文案 + 百分比 + 平滑推进），体验割裂。
 *
 * 本组件把这套形态抽出来复用，核心是两件事：
 *  1. **阶段可见**：调用方按进度推 `step(stage)`，用户知道「现在在做什么」；
 *  2. **进度平滑**：真实进度往往长时间不动（ZIP 解包无法中途报进度），
 *     故用 `tick` 定时器让进度条缓慢逼近目标值，给出「仍在进行」的感知
 *     （与沙箱页 startTick/stopTick 同思路）。
 *
 * 用法：
 *   const p = useLongTask()
 *   p.start('正在读取文件…')
 *   p.step(35, '正在解析配置…')
 *   p.finish('导入完成')
 *   p.fail('导入失败：…')
 */
export interface LongTaskStep {
  /** 0-100 真实进度 */
  pct: number
  /** 当前阶段文案 */
  msg: string
  /** 失败信息（非空即进入错误态） */
  error: string
}

export interface UseLongTask extends LongTaskStep {
  running: boolean
  /** 开始一个新任务（重置进度与错误） */
  start: (msg?: string) => void
  /** 推进到指定进度与阶段 */
  step: (pct: number, msg?: string) => void
  /** 平滑推进到 pct（不立即跳，用于长耗时单步） */
  easeTo: (pct: number, msg?: string) => void
  /** 完成 */
  finish: (msg?: string) => void
  /** 失败 */
  fail: (error: string) => void
  /** 重置到初始态 */
  reset: () => void
}

const IDLE: LongTaskStep = { pct: 0, msg: '', error: '' }

export function useLongTask(): UseLongTask {
  const [state, setState] = useState<LongTaskStep>(IDLE)
  const [running, setRunning] = useState(false)
  const timer = useRef<number | null>(null)
  // 用 ref 存当前值，供定时器闭包读取最新进度（避免每次重建 timer）
  const target = useRef(0)

  const stopTick = () => {
    if (timer.current != null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
  }

  // 组件卸载时务必清理定时器，否则会对已卸载组件 setState
  useEffect(() => stopTick, [])

  const startTick = (ceiling: number) => {
    stopTick()
    timer.current = window.setInterval(() => {
      setState((p) => {
        // 缓动逼近 ceiling：剩余距离越小走得越慢，且永不超过 ceiling
        if (p.pct >= ceiling) return p
        const remain = ceiling - p.pct
        const inc = Math.max(0.6, remain * 0.08)
        return { ...p, pct: Math.min(ceiling, p.pct + inc) }
      })
    }, 120)
  }

  const start = (msg = '正在处理…') => {
    stopTick()
    target.current = 90
    setState({ pct: 4, msg, error: '' })
    setRunning(true)
    startTick(90)
  }

  const step = (pct: number, msg?: string) => {
    target.current = Math.max(0, pct)
    stopTick()
    setState((p) => ({ pct: Math.min(100, pct), msg: msg ?? p.msg, error: '' }))
    // 未到 100 时继续平滑推进，给「仍在进行」感知
    if (pct < 100) startTick(Math.max(pct, target.current))
  }

  const easeTo = (pct: number, msg?: string) => {
    target.current = Math.max(0, pct)
    if (msg) setState((p) => ({ ...p, msg }))
    startTick(target.current)
  }

  const finish = (msg = '完成') => {
    stopTick()
    setState({ pct: 100, msg, error: '' })
    setRunning(false)
  }

  const fail = (error: string) => {
    stopTick()
    setState((p) => ({ ...p, error }))
    setRunning(false)
  }

  const reset = () => {
    stopTick()
    target.current = 0
    setState(IDLE)
    setRunning(false)
  }

  return { ...state, running, start, step, easeTo, finish, fail, reset }
}

/** 进度条展示（供 useLongTask 的结果渲染）。 */
export function LongTaskProgress({ pct, msg, error }: Partial<LongTaskStep>) {
  if (!msg && !error) return null
  // 夹取到 0-100：调用方若传入越界值，宽度会溢出容器、读屏会读出「150%」
  const safePct = Math.min(100, Math.max(0, Math.round(pct ?? 0)))
  return (
    <div className={`app-long-task${error ? ' is-error' : ''}`}>
      <div
        className="app-long-task__bar"
        role="progressbar"
        aria-valuenow={safePct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="app-long-task__fill" style={{ width: `${safePct}%` }} />
      </div>
      <div className="app-long-task__msg">{error || msg}</div>
    </div>
  )
}
