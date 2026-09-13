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
import { useNotify } from '@/components/ui/notify'
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ArtifactRef,
  ChoiceRequest,
  IntentClassified,
  PlanApprovalRequest,
  PlanBranchGenerated,
  PlanStep,
  RecoveryRequest,
  RunAgentTaskInput,
  ThinkingChunk,
  ToolStep,
} from './types'
import { baseName, opAction, opOf, pathFromArgs } from './toolNarrate'

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
  resolveRecovery: (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => Promise<void>
  /** 计划审批门禁（Phase 2b-3）：DAG 规划完成后、执行前挂起，等待用户确认/修改/拒绝；非 null 时渲染计划确认弹窗。 */
  planApproval: PlanApprovalRequest | null
  /** 回传计划审批决策（approve / reject / revise；revise 时携带修改意见）。 */
  resolvePlanApproval: (decision: 'approve' | 'reject' | 'revise', guidance?: string) => Promise<void>
  /** 方案推荐：Agent 主动询问用户（HITL Choice Chip），非 null 时渲染选项弹窗。 */
  pendingChoice: ChoiceRequest | null
  /** 回传方案推荐选择（用户点选的 optionId 唤醒后台挂起的 `native__ask_user_choice`）。 */
  submitChoice: (optionId: string, customText?: string) => Promise<void>
}

function labelOf(toolName: string): string {
  // 去掉命名空间前缀：mcp__mineru__parse → parse；native__edit_file → edit_file
  const parts = toolName.split('__')
  return parts[parts.length - 1] ?? toolName
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
  // 方案推荐：Agent 主动询问用户（HITL Choice Chip），挂起等待选择。
  const [pendingChoice, setPendingChoice] = useState<ChoiceRequest | null>(null)
  // 计划审批门禁（Phase 2b-3）：DAG 规划完成后、执行前挂起，等待用户确认/修改/拒绝。
  const [planApproval, setPlanApproval] = useState<PlanApprovalRequest | null>(null)

  // 统一消息实例：启动拦截（并发互斥）等需要「显式提示」的场景走 modal，
  // 不走通用 toast（连点「运行」被后端主闸门拦截时，用户应明确看到原因）。
  const { modal } = useNotify()

  // 用 ref 持有最新状态，供 Tauri 事件回调里更新（避免闭包陈旧）。
  const stepsRef = useRef<Map<string, ToolStep>>(new Map())
  const unlistenRef = useRef<UnlistenFn[]>([])
  const cancelRef = useRef<(() => void) | null>(null)
  // isRunning 的实时镜像，用于 run 入口的竞态拦截（useCallback 闭包里的 isRunning 可能是旧值）。
  const isRunningRef = useRef(false)
  // pendingApproval 的实时镜像：授权挂起期用于暂停安全定时器护栏，避免「超时误判后端异常」。
  const pendingApprovalRef = useRef(false)
  // pendingChoice 的实时镜像：供 submitChoice 回调里读取最新值（避免闭包陈旧）。
  const pendingChoiceRef = useRef<ChoiceRequest | null>(null)
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

  // 统一设置 pendingApproval 并同步 ref 镜像（避免在多处手动维护 ref 漏写）。
  const applyPendingApproval = useCallback((v: ApprovalRequest | null) => {
    pendingApprovalRef.current = v !== null
    setPendingApproval(v)
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
    setThoughts((prev) => [...prev, '正在查看目录', '目录内容已获取：README.md / src/ / package.json'])

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
    setThoughts((prev) => [...prev, '正在写入文件 output.md', '文件已生成'])

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
    // 设计原则：定时器只告警、不结束任务 —— isRunning（发送按钮可用态）只能由后端终态
    // 事件（agent-task-done / agent-task-error）或用户主动「停止」翻转，定时器无权翻转。
    // 否则一旦超时但 Rust 后端仍在运行，前端却把发送按钮解禁，用户可往未结束的任务再发消息，不合理。
    taskTimeoutRef.current = setTimeout(() => {
      if (pendingApprovalRef.current) return // 仍在等授权 → 合法暂停，继续等，不当后端异常
      console.warn('[agent] 任务超过 20 分钟未收到结束事件，仅作告警，不复位运行态')
      // 非破坏性提示：后端可能仍健康运行，发送按钮保持禁用，由用户主动「停止」结束。
      setStatusText('⏳ 任务已运行超过 20 分钟仍未收到结束信号，可能仍在后台执行；如需中断请点「停止」')
      // 不调 setRunning(false) / setIsStreaming(false) / finalizeStuckSteps（避免解禁输入框、误杀在跑任务）
    }, 20 * 60_000)
  }, [clearTaskTimeout])

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
      applyPendingApproval(null)
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
      pendingChoiceRef.current = null
      setPendingChoice(null)
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
        const msg =
          typeof e === 'string'
            ? e
            : e instanceof Error
              ? e.message
              : '任务启动失败'

        // 并发互斥：后端 spawn 前主闸门已拦截重复启动，返回精确中文文案
        // 「已有任务正在运行，请先等待其完成或点击停止。」——此时原任务仍在跑，
        // 绝不能清 isRunning（否则输入框被错误解锁、停止按钮消失），只做显式提示。
        if (msg.includes('已有任务正在运行') || msg.includes('正在运行')) {
          modal.warning({
            title: '已有任务在运行',
            content: msg,
            okText: '我知道了',
          })
          return
        }

        // 其他启动失败：复位运行态，并把错误作为状态文本短暂提示（交由页面渲染）。
        setRunning(false)
        setStatusText('')
        setStatusText(msg)
      }
    },
    [flushSteps, mockRun, clearTaskTimeout, startTaskTimeout],
  )

  const submitDecision = useCallback(async (decision: ApprovalDecision) => {
    applyPendingApproval(null)
    // 决策后清除「等待授权」提示，任务恢复运行。
    setStatusText('')
    // 决策回传后恢复安全定时器（覆盖后续可能耗时的步骤）。
    startTaskTimeout()
    if (!isTauri) return
    try {
      // 与 run_agent_task 同理：命令入参是名为 `decision` 的结构体，必须包在 `decision` 键下。
      await invoke('submit_approval_decision', {
        decision: {
          approvalId: decision.approvalId,
          decision: decision.decision,
          guidance: decision.guidance ?? null,
        },
      })
    } catch (e) {
      // 决策回传失败仅日志；Rust 侧会超时释放挂起。
      console.error('[agent] submit_approval_decision failed', e)
    }
  }, [isTauri, startTaskTimeout])

  // 计划审批门禁（Phase 2b-3）：回传决策（approve / reject / revise）给后台挂起的计划审批中枢。
  // 不在下发时乐观收起面板——后端接到决策后会 emit plan_generated（approve）或本轮以
  // task-done/error 结束（reject/cancel），这些事件统一清面板；若网络异常未复位，面板保留、
  // 后端仍在挂起等待，用户可再次点击，避免死锁。
  const resolvePlanApproval = useCallback(
    async (decision: 'approve' | 'reject' | 'revise', guidance?: string) => {
      if (!isTauri) return
      try {
        await invoke('submit_plan_decision', {
          input: {
            decision,
            guidance: guidance ?? null,
          },
        })
      } catch (e) {
        console.error('[agent] submit_plan_decision failed', e)
      }
    },
    [isTauri],
  )

  // 方案推荐：回传用户所选 optionId（或自定义文本），唤醒后台挂起的 `native__ask_user_choice`。
  const submitChoice = useCallback(
    async (optionId: string, customText?: string) => {
      const choice = pendingChoiceRef.current
      setPendingChoice(null)
      if (!isTauri || !choice) return
      try {
        await invoke('submit_choice_decision', {
          input: { choiceId: choice.choiceId, optionId, customText: customText ?? null },
        })
      } catch (e) {
        console.error('[agent] submit_choice_decision failed', e)
      }
    },
    [isTauri],
  )

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
    setPlanApproval(null)
    pendingChoiceRef.current = null
    setPendingChoice(null)
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
    pendingChoiceRef.current = null
    setPendingChoice(null)
    setRunning(false)
    setIsStreaming(false)
  }, [isTauri, clearTaskTimeout])

  // 步骤级恢复：回传决策（retry / skip / takeover）给后台挂起的流水线。
  // 不在下发时乐观收起面板——后端接到决策后会 emit step_started（retry/takeover）
  // 或 step_finished（skip），或本轮以 agent-task-done/error 结束，这些事件统一清面板；
  // 若网络异常未复位，面板保留、后端仍在挂起等待，用户可再次点击，避免死锁。
  const resolveRecovery = useCallback(
    async (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => {
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
              // 思考旁白：用自然语言表述「正在做什么」，不出现工具名（如 write_file）。
              const op = step.op ?? opOf(step.toolName)
              const target = baseName(step.path ?? pathFromArgs(step.args))
              const object = target && target !== '.' ? ` ${target}` : ''
              setThoughts((prev) => [...prev, `正在${opAction(op)}${object}`])
            }
            break
          case 'tool_finished':
            if (e.step) {
              const step = { ...e.step, toolLabel: labelOf(e.step.toolName), step: currentStepRef.current ?? undefined }
              upsertStep(step)
              // 成功不追加旁白（工具行已体现结果），仅失败时补一条人性化说明。
              if (step.status !== 'success') {
                const op = step.op ?? opOf(step.toolName)
                const target = baseName(step.path ?? pathFromArgs(step.args))
                const object = target && target !== '.' ? `（${target}）` : ''
                const reason = (step.result ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
                setThoughts((prev) => [
                  ...prev,
                  `${opAction(op)}失败${object}${reason ? `：${reason}` : ''}`,
                ])
              }
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
            // 计划审批门禁已通过（approve/带意见修改后批准）：收起计划确认弹窗。
            setPlanApproval(null)
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
          // 授权挂起：暂停 20 分钟安全定时器（这是合法暂停，非后端异常），并给出明确等待态。
          clearTaskTimeout()
          applyPendingApproval(ev.payload)
          setStatusText('⏸ 等待授权：请在弹窗中选择允许 / 拒绝，任务已暂停')
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
          setPlanApproval(null)
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
        setPlanApproval(null)
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
      // 方案推荐：Agent 主动询问用户（HITL Choice Chip），挂起等待选择（选项 chip 弹窗）。
      const offChoice = await listen<ChoiceRequest>(
        'agent-choice-needed',
        (ev) => {
          pendingChoiceRef.current = ev.payload
          setPendingChoice(ev.payload)
        },
      )
      // 计划审批门禁（Phase 2b-3）：DAG 规划完成后、执行前推计划清单，挂起等待用户确认/修改/拒绝。
      const offPlanApproval = await listen<PlanApprovalRequest>(
        'agent-plan-approval-needed',
        (ev) => {
          // 审批挂起：暂停 20 分钟安全定时器（合法暂停，非后端异常），并给出明确等待态。
          clearTaskTimeout()
          setPlanApproval(ev.payload)
          setStatusText('⏸ 计划待确认：请在弹窗中批准 / 修改 / 拒绝，任务已暂停')
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
        offChoice()
        offPlanApproval()
        offPlanBranch()
        return
      }
      unlistenRef.current = [offEvent, offApproval, offDone, offErr, offToken, offArtifact, offRecovery, offChoice, offPlanApproval, offPlanBranch]
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
    planApproval,
    resolvePlanApproval,
    pendingChoice,
    submitChoice,
    trace: { intent: traceIntent, thinking: traceThinking },
    planBranch,
  }
}
