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
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ArtifactRef,
  IntentClassified,
  PlanBranchGenerated,
  PlanStep,
  RecoveryRequest,
  RunAgentTaskInput,
  ThinkingChunk,
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
  /** 三层流水线：任务步骤进度条（阶段二规划生成，运行中实时更新状态）。 */
  planSteps: PlanStep[]
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
  /** 最近一轮任务的真实 token 用量（后端取自 LLM `usage`，经 `agent-task-done` 带出）。
   *  Tauri 环境由事件填充；dev/mock 无后端时为 null，页面据此回退到估算值。 */
  lastTaskUsage: MutableRefObject<{ promptTokens: number; completionTokens: number } | null>
  /** 本次任务的实时 token 用量（后端经 `agent-token-update` 增量推送，运行中累计）。
   *  响应式状态，驱动顶栏计数卡实时跳数；无任务运行（或 dev/mock）时为 null。 */
  liveTokenUsage: {
    promptTokens: number
    completionTokens: number
  } | null
  /** 最近一轮任务的异常信息（由 `agent-task-error` 写入），供页面渲染「错误诊断面板」（展示+复制；重试/跳过留 Phase 2）。 */
  taskError: { message: string; at: number } | null
  /** 本次任务产生的文件产物（各子任务成功闭环后由 `agent-artifact-created` 累计推送），驱动「产物画廊」。 */
  artifacts: ArtifactRef[]
  /** 轨迹视图聚合数据：意图分类 + 分层思考（plan/exec/selfcheck）。与已有 planSteps/toolSteps 组合成完整轨迹。 */
  trace: { intent?: IntentClassified; thinking: ThinkingChunk[] }
  /** §3.2 分支重规划结果（双分支对比横幅 + 应用按钮）。非 null 时画布渲染对比视图。 */
  planBranch: PlanBranchGenerated | null
  /** 步骤级恢复：子任务自动重试耗尽仍失败时挂起，等待用户决策（重试/跳过/接管）；非 null 时渲染恢复面板。 */
  recovery: RecoveryRequest | null
  /** 回传步骤级恢复决策（retry / skip / takeover；takeover 时携带补充指示）。 */
  resolveRecovery: (decision: 'retry' | 'skip' | 'takeover', guidance?: string) => Promise<void>
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
  // 三层流水线：阶段二规划生成的步骤进度条（plan_generated 填充，step_started/finished 更新状态）。
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null)
  // 本次任务的实时 token 用量（后端经 `agent-token-update` 增量推送，运行中累计）；
  // 响应式状态，驱动顶栏计数卡实时跳数。任务开始/reset 时清空，完成时由 `agent-task-done` 终值同步。
  const [liveTokenUsage, setLiveTokenUsage] = useState<{
    promptTokens: number
    completionTokens: number
  } | null>(null)

  // 最近一轮任务的异常信息（由 `agent-task-error` 写入），供页面渲染「错误诊断面板」。
  // 仅承载展示用数据，重试/跳过等恢复操作留到 Phase 2。
  const [taskError, setTaskError] = useState<{ message: string; at: number } | null>(null)
  // 本次任务产生的文件产物（子任务成功闭环后由 `agent-artifact-created` 累计推送），驱动「产物画廊」。
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([])
  // 轨迹视图：意图分类结果（intent_classified）与分层思考片段（thinking_chunk）。
  const [traceIntent, setTraceIntent] = useState<IntentClassified | undefined>(undefined)
  const [traceThinking, setTraceThinking] = useState<ThinkingChunk[]>([])
  // §3.2 分支重规划结果（plan_branch_generated 事件携带，驱动画布对比横幅 + 应用按钮）。
  const [planBranch, setPlanBranch] = useState<PlanBranchGenerated | null>(null)
  // 步骤级恢复：子任务自动重试耗尽仍失败时挂起，等待用户决策（重试/跳过/接管）。
  const [recovery, setRecovery] = useState<RecoveryRequest | null>(null)

  // 用 ref 持有最新状态，供 Tauri 事件回调里更新（避免闭包陈旧）。
  const stepsRef = useRef<Map<string, ToolStep>>(new Map())
  const unlistenRef = useRef<UnlistenFn[]>([])
  const cancelRef = useRef<(() => void) | null>(null)
  // isRunning 的实时镜像，用于 run 入口的竞态拦截（useCallback 闭包里的 isRunning 可能是旧值）。
  const isRunningRef = useRef(false)
  // 任务兜底保险：后端正常情况下一定会通过 `agent-task-done` / `agent-task-error`
  // 主动复位 UI（多轮智能体任务可能耗时数分钟）。此超时仅用于 Rust 进程异常（panic）
  // 导致终态事件丢失的极端场景，时长设得足够长（20 分钟），避免把仍在运行的后端误判为「超时」。
  const taskTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 最近一轮任务的真实 token 用量（后端取自 LLM usage，经 agent-task-done 带出）；
  // Tauri 环境由事件填充，dev/mock 无后端时为 null，页面据此回退到估算值。
  const lastTaskUsageRef = useRef<{ promptTokens: number; completionTokens: number } | null>(null)
  // 当前活跃子任务序号（按 step_started/finished 维护）：用于给 tool_started/finished
  // 打 `step` 标签，前端把工具按所属步骤归组渲染成「步骤 → 工具」嵌套视图。
  const currentStepRef = useRef<number | null>(null)

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

  // 终态清扫：任务结束（done/error/兜底超时）时，把仍停留在 running 的步骤收敛为 failed，
  // 避免后端在 429 等异常路径上漏发 step_finished/tool_finished 时，UI 永久显示「转圈 loading」。
  // 这是前端状态机对 UI 一致性的兜底责任——即便后端事件流有缺口，也不应卡死。
  const finalizeStuckSteps = useCallback(() => {
    let toolChanged = false
    stepsRef.current.forEach((step, key) => {
      if (step.status === 'running') {
        stepsRef.current.set(key, {
          ...step,
          status: 'failed',
          result: step.result ?? '（任务已结束，但未收到该工具步骤的完成信号，已自动标记为失败）',
        })
        toolChanged = true
      }
    })
    if (toolChanged) flushSteps()
    setPlanSteps((prev) => {
      if (!prev.some((t) => t.status === 'running')) return prev
      return prev.map((t) =>
        t.status === 'running'
          ? {
              ...t,
              status: 'failed',
              summary: t.summary ?? '（任务已结束，但该规划步骤未收到完成信号，已自动标记为失败）',
            }
          : t,
      )
    })
  }, [flushSteps])

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
    // 仅作极端兜底（见 taskTimeoutRef 注释）：正常多轮任务不会触发。
    taskTimeoutRef.current = setTimeout(() => {
      console.warn('[agent] 任务超过 20 分钟未收到结束事件，疑似后端异常，复位 UI 状态')
      setRunning(false)
      setIsStreaming(false)
      setStatusText('长时间未收到后端结束信号，任务可能仍在后台运行，可点击「停止」后重新发起')
      // 兜底收敛残留的 running 步骤，避免永久 loading
      finalizeStuckSteps()
    }, 20 * 60_000)
  }, [clearTaskTimeout, finalizeStuckSteps])

  const run = useCallback(
    async (input: RunAgentTaskInput) => {
      // 用 ref 实时值拦截，避免 useCallback 闭包里的 isRunning 是旧值。
      if (isRunningRef.current) return
      // 新一轮：清空上一轮的工具步骤、流式文本与思考过程，但保留历史气泡（气泡由页面维护）。
      stepsRef.current.clear()
      flushSteps()
      currentStepRef.current = null
      setStreamingText('')
      setIsStreaming(false)
      setThoughts([])
      setPlanSteps([])
      setPendingApproval(null)
      setStatusText('')
      setLiveTokenUsage(null)
      setTaskError(null)
      setArtifacts([])
      // 每轮任务重置轨迹（意图 + 分层思考）：避免上一题的轨迹泄漏/混进本轮。
      // 与 planSteps/artifacts 同批清空；reset() 在切/新建会话时也清这两份。
      setTraceIntent(undefined)
      setTraceThinking([])
      setPlanBranch(null)
      setRecovery(null)
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
            attachments: input.attachments ?? [],
            sessionId: input.sessionId ?? null,
            roundId: input.roundId ?? null,
            // 临时移除的技能 id（会话内有效，不写库）；Rust load_config 据此从工具集剔除
            disabledSkillIds: input.disabledSkillIds ?? [],
            // 临时移除的 MCP 服务 / 其下单个工具（会话内有效，不写库）
            disabledMcpIds: input.disabledMcpIds ?? [],
            disabledMcpToolIds: input.disabledMcpToolIds ?? [],
            // 临时启用的技能 / MCP 服务（`@` 提及触发）；Rust load_config 据此把未绑定能力临时并入工具集
            enabledSkillIds: input.enabledSkillIds ?? [],
            enabledMcpIds: input.enabledMcpIds ?? [],
            // §3.2 分支重跑：直接采用前端计划（跳过 LLM 规划），并标记 head 预完成 + 初始上下文。
            planOverride: input.planOverride ?? undefined,
            preCompleted: input.preCompleted ?? [],
            initialContext: input.initialContext ?? '',
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
    setLiveTokenUsage(null)
    setTaskError(null)
    setArtifacts([])
    setTraceIntent(undefined)
    setTraceThinking([])
    setPlanBranch(null)
    setRecovery(null)
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

  // 步骤级恢复：回传决策（retry / skip / takeover）给后台挂起的流水线。
  // 不在下发时乐观收起面板——后端接到决策后会 emit step_started（retry/takeover）
  // 或 step_finished（skip），或本轮以 agent-task-done/error 结束，这些事件统一清面板；
  // 若网络异常未复位，面板保留、后端仍在挂起等待，用户可再次点击，避免死锁。
  const resolveRecovery = useCallback(
    async (decision: 'retry' | 'skip' | 'takeover', guidance?: string) => {
      if (!isTauri) return
      try {
        await invoke('resolve_subtask', {
          input: {
            decision,
            guidance: guidance ?? null,
          },
        })
      } catch (e) {
        console.error('[agent] resolve_subtask failed', e)
      }
    },
    [isTauri],
  )

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
              const step = { ...e.step, toolLabel: labelOf(e.step.toolName), step: currentStepRef.current ?? undefined }
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
              const step = { ...e.step, toolLabel: labelOf(e.step.toolName), step: currentStepRef.current ?? undefined }
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
          case 'plan_generated':
            // 阶段二规划生成：渲染步骤进度条（全部 pending）
            if (e.plan?.tasks) {
              setPlanSteps(e.plan.tasks)
            }
            break
          case 'step_started':
            if (typeof e.plan?.step === 'number') {
              const s = e.plan.step
              currentStepRef.current = s
            setPlanSteps((prev) =>
              prev.map((t) => (t.step === s ? { ...t, status: 'running' } : t)),
            )
            // 重试/接管分支：后端先复位该步骤为 running 再重跑，这里收起恢复面板。
            setRecovery((prev) => (prev && prev.step === s ? null : prev))
          }
          break
          case 'step_finished':
            if (typeof e.plan?.step === 'number') {
              const s = e.plan.step
              const st = e.plan.status ?? 'success'
              const sum = e.plan.summary
              if (currentStepRef.current === s) currentStepRef.current = null
              setPlanSteps((prev) =>
                prev.map((t) =>
                  t.step === s ? { ...t, status: st, summary: sum ?? t.summary } : t,
                ),
              )
              // 跳过分支：被跳过的步骤不会再 emit step_started，这里直接收起恢复面板。
              setRecovery((prev) => (prev && prev.step === s ? null : prev))
            }
            break
          case 'intent_classified':
            if (e.intent) setTraceIntent(e.intent)
            break
          case 'thinking_chunk':
            if (e.chunk) {
              setTraceThinking((prev) => [
                ...prev,
                {
                  layer: (e.chunk?.layer as ThinkingChunk['layer']) ?? 'exec',
                  text: e.chunk!.text,
                  done: e.chunk!.done,
                },
              ])
            }
            break
          case 'plan_branch_generated':
            if (e.branch) setPlanBranch(e.branch)
            break
        }
      })
      const offApproval = await listen<ApprovalRequest>(
        'agent-awaiting-approval',
        (ev) => {
          setPendingApproval(ev.payload)
        },
      )
      const offDone = await listen<{ promptTokens: number; completionTokens: number }>(
        'agent-task-done',
        (ev) => {
          // 记录本轮真实 token 用量（后端取自 LLM usage，跨 ReAct 轮累计），供页面展示替代估算。
          lastTaskUsageRef.current = ev.payload ?? null
          // 终值同步到实时计数卡（simple_chat 等不推送 token_update 的路径也能拿到终值）。
          setLiveTokenUsage(ev.payload ?? null)
          clearTaskTimeout()
          setRunning(false)
          setIsStreaming(false)
          setStatusText('')
          setRecovery(null)
          // 终态清扫：收敛残留的 running 步骤（见 finalizeStuckSteps 注释）
          finalizeStuckSteps()
          // 完成后保留思考过程，方便回看智能体做了什么（新一轮 run 时在入口清空）
        },
      )
      const offErr = await listen<string>('agent-task-error', (ev) => {
        clearTaskTimeout()
        setRunning(false)
        setIsStreaming(false)
        setStatusText(`任务异常：${ev.payload}`)
        setRecovery(null)
        // 终态清扫：异常结束时同样收敛残留的 running 步骤
        finalizeStuckSteps()
        // 异常时也保留已产生的思考过程，便于排查失败原因
        // 把错误写入响应式状态，驱动页面「错误诊断面板」展示（含复制）。
        setTaskError({ message: ev.payload, at: Date.now() })
      })
      // 步骤级恢复：子任务自动重试耗尽仍失败，挂起等待用户决策（重试/跳过/接管）。
      const offRecovery = await listen<RecoveryRequest>(
        'agent-recovery-needed',
        (ev) => {
          setRecovery(ev.payload)
        },
      )
      // 实时 token 用量增量（运行中累计推送，驱动顶栏计数卡跳数）。
      const offToken = await listen<{ promptTokens: number; completionTokens: number }>(
        'agent-token-update',
        (ev) => {
          if (ev.payload) setLiveTokenUsage(ev.payload)
        },
      )
      // 子任务产物登记（成功闭环并写库后推送），累计进「产物画廊」。
      const offArtifact = await listen<{ step: number; artifacts: ArtifactRef[] }>(
        'agent-artifact-created',
        (ev) => {
          if (ev.payload?.artifacts?.length) {
            setArtifacts((prev) => {
              // 去重（同 artifact_id 不重复 append），其余追加。
              const seen = new Set(prev.map((a) => a.artifactId))
              return [...prev, ...ev.payload.artifacts.filter((a) => !seen.has(a.artifactId))]
            })
          }
        },
      )
      // §3.2 分支重规划结果（branch_from_step 命令完成后推送），驱动画布对比横幅 + 应用按钮。
      const offPlanBranch = await listen<PlanBranchGenerated>(
        'agent-plan-branch',
        (ev) => {
          if (ev.payload) setPlanBranch(ev.payload)
        },
      )
      if (!mounted) {
        offEvent()
        offApproval()
        offDone()
        offErr()
        offToken()
        offArtifact()
        offRecovery()
        offPlanBranch()
        return
      }
      unlistenRef.current = [offEvent, offApproval, offDone, offErr, offToken, offArtifact, offRecovery, offPlanBranch]
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
    planSteps,
    isRunning,
    pendingApproval,
    run,
    submitDecision,
    reset,
    cancel,
    lastTaskUsage: lastTaskUsageRef,
    liveTokenUsage,
    taskError,
    artifacts,
    recovery,
    resolveRecovery,
    trace: { intent: traceIntent, thinking: traceThinking },
    planBranch,
  }
}
