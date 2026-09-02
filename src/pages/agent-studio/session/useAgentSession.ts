/**
 * 智能体会话状态机 Hook。
 *
 * 职责（仅前端，不含任何工具执行逻辑）：
 *  - Tauri 环境：监听 Rust 经 `app.emit` 推送的事件流
 *    （`agent-event` / `agent-awaiting-approval` / `agent-task-done` / `agent-task-error`），
 *    把事件归一成 `toolSteps` / `streamingText` / `pendingApproval` 等 UI 状态；
 *    发送消息时调用 `run_agent_task` 命令，审批决策调用 `submit_approval_decision`。
 *  - 非 Tauri 环境：无原生后端，用 `mockRun` 模拟一轮「调用两个工具 + 流式回复」，
 *    让工具流折叠卡片、审批弹窗（不会触发，因 mock 不产敏感工具）等 UI 在浏览器 dev 下也可演示。
 *
 * 设计要点：
 *  - 流式文本按 callId 维度追加：每个 `text_chunk` 序列对应一段助手回复，用 `streamSeq`
 *    区分不同轮次，避免把上一轮的残流混进本轮；
 *  - 工具步骤以 `callId` 为 key 维护 Map，started 新增、finished 原地更新；
 *  - 审批挂起时 `pendingApproval` 置位，弹窗由页面渲染；决策回传后 Rust 继续循环，
 *    前端只需清空 `pendingApproval`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  RunAgentTaskInput,
  ToolStep,
} from './types'

/** 会话对外暴露的实时状态。 */
export interface AgentSessionState {
  /** 当前任务的工具调用步骤列表（按发生顺序）。 */
  toolSteps: ToolStep[]
  /** 当前正在流式输出的助手文本（已拼接完整片段）。 */
  streamingText: string
  /** 本轮是否有文本在流（控制「思考中」动画与光标）。 */
  isStreaming: boolean
  /** 运行状态提示（错误等瞬时信息）。 */
  statusText: string
  /** 思考过程步骤（可折叠展示）。 */
  thoughts: string[]
  /** 是否有任务在后台运行（禁用输入框 / 显示停止态）。 */
  isRunning: boolean
  /** 待用户审批的高危操作（非 null 时弹窗）。 */
  pendingApproval: ApprovalRequest | null
  /** 运行一轮任务（发送用户消息）。 */
  run: (input: RunAgentTaskInput) => Promise<void>
  /** 提交审批决策（允许/拒绝）。 */
  submitDecision: (decision: ApprovalDecision) => Promise<void>
  /** 清空当前会话的所有步骤与文本（新建会话 / 切换智能体时）。 */
  reset: () => void
  /** 取消正在进行的任务（Tauri 下发 cancel 信号；非 Tauri 下仅清状态）。 */
  cancel: () => void
}

function labelOf(toolName: string): string {
  // 去掉命名空间前缀：mcp__mineru__parse → parse；native__edit_file → edit_file
  const parts = toolName.split('__')
  return parts[parts.length - 1] ?? toolName
}

/** 把工具入参 JSON 压缩成可阅读的单行摘要（用于思考过程条目）。 */
function summarizeArgs(raw?: string): string {
  if (!raw) return '（无）'
  try {
    const pretty = JSON.stringify(JSON.parse(raw))
    return pretty.length > 280 ? pretty.slice(0, 280) + '…' : pretty
  } catch {
    return raw.length > 280 ? raw.slice(0, 280) + '…' : raw
  }
}

/** 把工具返回结果压成简短摘要（去除多余空白）。 */
function summarizeResult(raw?: string): string {
  if (!raw) return '（无输出）'
  const text = raw.replace(/\s+/g, ' ').trim()
  return text.length > 180 ? text.slice(0, 180) + '…' : text
}

export function useAgentSession(): AgentSessionState {
  const [toolSteps, setToolSteps] = useState<ToolStep[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [thoughts, setThoughts] = useState<string[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)

  // 用 ref 持有最新状态，供 Tauri 事件回调里更新（避免闭包陈旧）。
  const stepsRef = useRef<Map<string, ToolStep>>(new Map())
  const unlistenRef = useRef<UnlistenFn[]>([])
  const cancelRef = useRef<(() => void) | null>(null)
  // isRunning 的实时镜像，用于 run 入口的竞态拦截（useCallback 闭包里的 isRunning 可能是旧值）。
  const isRunningRef = useRef(false)
  // 任务超时保险：若后台任务既没发 done 也没发 error，60s 后自动复位，防止 UI 永久卡住。
  const taskTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setRunning = useCallback((value: boolean) => {
    isRunningRef.current = value
    setIsRunning(value)
  }, [])

  const flushSteps = useCallback(() => {
    setToolSteps(Array.from(stepsRef.current.values()))
  }, [])

  const upsertStep = useCallback(
    (step: ToolStep) => {
      stepsRef.current.set(step.callId, step)
      flushSteps()
    },
    [flushSteps],
  )

  // 非 Tauri：模拟一轮任务（含两个工具步骤 + 流式回复），用于浏览器 dev 演示 UI。
  const mockRun = useCallback(async (input: RunAgentTaskInput) => {
    setRunning(true)
    setStatusText('')
    setThoughts(['（演示模式）将依次调用 2 个工具并生成流式回复'])
    const seq = `mock-${Date.now()}`
    const t0 = Date.now()

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    // 工具 1：读取工作空间结构（只读，非敏感）
    upsertStep({
      callId: `${seq}-1`,
      toolName: 'native__list_directory',
      toolLabel: 'list_directory',
      status: 'running',
      sensitive: false,
      args: JSON.stringify({ path: input.workspace ?? '.' }),
      createdAt: t0,
    })
    await sleep(700)
    upsertStep({
      callId: `${seq}-1`,
      toolName: 'native__list_directory',
      toolLabel: 'list_directory',
      status: 'success',
      sensitive: false,
      args: JSON.stringify({ path: input.workspace ?? '.' }),
      result: JSON.stringify({ entries: ['README.md', 'src/', 'package.json'] }),
      durationMs: 700,
      createdAt: t0,
    })
    setThoughts((prev) => [
      ...prev,
      `决定调用工具 \`list_directory\`，参数：${summarizeArgs(JSON.stringify({ path: input.workspace ?? '.' }))}`,
      '工具 `list_directory` 执行成功：返回目录条目 README.md / src/ / package.json',
    ])

    // 工具 2：写文件（敏感，但 mock 不触发审批弹窗，仅展示步骤）
    const t1 = Date.now()
    upsertStep({
      callId: `${seq}-2`,
      toolName: 'native__write_file',
      toolLabel: 'write_file',
      status: 'running',
      sensitive: true,
      args: JSON.stringify({ path: 'output.md', content: '# 生成结果\n' }),
      createdAt: t1,
    })
    await sleep(600)
    upsertStep({
      callId: `${seq}-2`,
      toolName: 'native__write_file',
      toolLabel: 'write_file',
      status: 'success',
      sensitive: true,
      args: JSON.stringify({ path: 'output.md', content: '# 生成结果\n' }),
      result: JSON.stringify({ bytes: 12 }),
      durationMs: 600,
      createdAt: t1,
    })
    setThoughts((prev) => [
      ...prev,
      `决定调用工具 \`write_file\`，参数：${summarizeArgs(JSON.stringify({ path: 'output.md', content: '# 生成结果\n' }))}`,
      '工具 `write_file` 执行成功：写入 12 字节',
    ])

    // 流式文本回复：一次性给出完整目标文本，由页面打字机效果负责动画展示
    setIsStreaming(true)
    const reply =
      `已收到你的指令：「${input.prompt}」\n\n` +
      `（演示模式）我调用了 2 个工具：列出工作空间目录、生成了 \`output.md\`。\n` +
      `接入真实模型后，这里会输出模型的流式回答，并可在需要时调用已挂载的 MCP 工具与技能。`
    setStreamingText(reply)
    // 给打字机足够的时间播完再结束本轮
    await sleep(Math.min(reply.length * 12 + 200, 2500))
    setIsStreaming(false)
    setRunning(false)
    setStatusText('')
    // 演示模式同样保留思考过程，便于回看（真实 run 在收到 done 时也已保留）
  }, [upsertStep, setRunning])

  const clearTaskTimeout = useCallback(() => {
    if (taskTimeoutRef.current) {
      clearTimeout(taskTimeoutRef.current)
      taskTimeoutRef.current = null
    }
  }, [])

  const startTaskTimeout = useCallback(() => {
    clearTaskTimeout()
    taskTimeoutRef.current = setTimeout(() => {
      console.warn('[agent] 任务超时未收到结束事件，自动复位 UI 状态')
      setRunning(false)
      setIsStreaming(false)
      setStatusText('任务响应超时，请重试')
    }, 60_000)
  }, [clearTaskTimeout])

  const run = useCallback(
    async (input: RunAgentTaskInput) => {
      // 用 ref 实时值拦截，避免 useCallback 闭包里的 isRunning 是旧值。
      if (isRunningRef.current) return
      // 新一轮：清空上一轮的工具步骤、流式文本与思考过程，但保留历史气泡（气泡由页面维护）。
      stepsRef.current.clear()
      flushSteps()
      setStreamingText('')
      setIsStreaming(false)
      setThoughts([])
      setPendingApproval(null)
      setStatusText('')
      clearTaskTimeout()

      if (!isTauri) {
        await mockRun(input)
        return
      }

      setRunning(true)
      startTaskTimeout()
      try {
        // 注意：Rust 命令 `run_agent_task` 的入参是一个名为 `input` 的结构体，
        // 因此必须把字段包在 `input` 键下（Tauri 按参数名匹配，扁平传参会报
        // "missing required key input"）。历史消息由 Rust 侧自行构建，无需传递。
        await invoke('run_agent_task', {
          input: {
            agentId: input.agentId,
            prompt: input.prompt,
            workspace: input.workspace ?? null,
          },
        })
      } catch (e) {
        clearTaskTimeout()
        setRunning(false)
        setStatusText('')
        // 错误交由页面 toast；这里仅把错误作为状态文本短暂提示。
        setStatusText(typeof e === 'string' ? e : '任务启动失败')
      }
    },
    [flushSteps, mockRun, clearTaskTimeout, startTaskTimeout],
  )

  const submitDecision = useCallback(async (decision: ApprovalDecision) => {
    setPendingApproval(null)
    if (!isTauri) return
    try {
      // 与 run_agent_task 同理：命令入参是名为 `decision` 的结构体，必须包在 `decision` 键下。
      await invoke('submit_approval_decision', {
        decision: {
          approvalId: decision.approvalId,
          approved: decision.approved,
          reason: decision.reason ?? null,
        },
      })
    } catch (e) {
      // 决策回传失败仅日志；Rust 侧会超时释放挂起。
      console.error('[agent] submit_approval_decision failed', e)
    }
  }, [isTauri])

  const reset = useCallback(() => {
    stepsRef.current.clear()
    flushSteps()
    setStreamingText('')
    setIsStreaming(false)
    setStatusText('')
    setThoughts([])
    setPendingApproval(null)
    clearTaskTimeout()
    setRunning(false)
  }, [flushSteps, clearTaskTimeout])

  const cancel = useCallback(() => {
    cancelRef.current?.()
    if (isTauri) {
      // 通知 Rust 取消当前任务（best-effort，命令可不存在/忽略）。
      void invoke('cancel_agent_task').catch(() => {})
    }
    clearTaskTimeout()
    setRunning(false)
    setIsStreaming(false)
  }, [isTauri, clearTaskTimeout])

  // 挂载：注册 Tauri 事件监听（仅 Tauri 环境）。
  useEffect(() => {
    if (!isTauri) return
    let mounted = true

    const reg = async () => {
      const offEvent = await listen<AgentEvent>('agent-event', (ev) => {
        const e = ev.payload
        switch (e.type) {
          case 'tool_started':
            if (e.step) {
              const step = { ...e.step, toolLabel: labelOf(e.step.toolName) }
              upsertStep(step)
              // 把「决定调用哪个工具 + 参数」作为思考过程的一条记录（而非独立卡片）
              setThoughts((prev) => [
                ...prev,
                `决定调用工具 \`${step.toolLabel}\`，参数：${summarizeArgs(step.args)}`,
              ])
            }
            break
          case 'tool_finished':
            if (e.step) {
              const step = { ...e.step, toolLabel: labelOf(e.step.toolName) }
              upsertStep(step)
              const ok = step.status === 'success'
              const dur =
                typeof step.durationMs === 'number'
                  ? `（耗时 ${(step.durationMs / 1000).toFixed(1)}s）`
                  : ''
              // 把「工具结果」作为思考过程的一条记录
              setThoughts((prev) => [
                ...prev,
                `工具 \`${step.toolLabel}\` ${ok ? '执行成功' : '执行失败'}${dur}：${summarizeResult(step.result)}`,
              ])
            }
            break
          case 'text_chunk':
            if (e.chunk) {
              const chunk = e.chunk
              // 统一追加增量文本；避免旧逻辑在 chunk.done 时覆盖为当前片段导致前面内容丢失
              if (chunk.text) {
                setStreamingText((prev) => prev + chunk.text)
              }
              if (chunk.done) {
                setIsStreaming(false)
              } else {
                setIsStreaming(true)
              }
            }
            break
          case 'text_done':
            // 后备：若后端未通过 chunk.done 标记结束，仍在此处关闭流式态
            setIsStreaming(false)
            break
          case 'status': {
            // 运行状态归入可折叠思考过程，错误信息仍用 statusText 提示
            const msg = e.message
            if (msg) {
              setThoughts((prev) => [...prev, msg])
            }
            break
          }
          case 'error':
            if (e.message) setStatusText(`错误：${e.message}`)
            break
        }
      })
      const offApproval = await listen<ApprovalRequest>(
        'agent-awaiting-approval',
        (ev) => {
          setPendingApproval(ev.payload)
        },
      )
      const offDone = await listen('agent-task-done', () => {
        clearTaskTimeout()
        setRunning(false)
        setIsStreaming(false)
        setStatusText('')
        // 完成后保留思考过程，方便回看智能体做了什么（新一轮 run 时在入口清空）
      })
      const offErr = await listen<string>('agent-task-error', (ev) => {
        clearTaskTimeout()
        setRunning(false)
        setIsStreaming(false)
        setStatusText(`任务异常：${ev.payload}`)
        // 异常时也保留已产生的思考过程，便于排查失败原因
      })
      if (!mounted) {
        offEvent()
        offApproval()
        offDone()
        offErr()
        return
      }
      unlistenRef.current = [offEvent, offApproval, offDone, offErr]
    }

    void reg()
    return () => {
      mounted = false
      for (const off of unlistenRef.current) off()
      unlistenRef.current = []
    }
  }, [upsertStep, clearTaskTimeout])

  return {
    toolSteps,
    streamingText,
    isStreaming,
    statusText,
    thoughts,
    isRunning,
    pendingApproval,
    run,
    submitDecision,
    reset,
    cancel,
  }
}
