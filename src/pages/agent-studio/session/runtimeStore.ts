/**
 * 智能体会话运行时状态仓库（状态层重构核心）。
 *
 * 为什么需要它（对应两个长期问题）：
 *  - 「切到历史会话后，正在跑的任务的 loading 跟着走、还在历史会话界面继续输出」：
 *    因为运行态此前是**一份**组件级 useState，而 Tauri 事件是**智能体级**（不带会话 id），
 *    切会话后事件仍往这唯一一份状态里写 → 串台。这里改成**按会话 id 隔离**的 store：
 *    事件只写「正在运行的那个会话」的条目，界面只读「当前查看的那个会话」的条目，
 *    两者不同则互不干扰。
 *  - 「切走再回来只剩残缺快照 / 跑完不改名」：此前状态随组件卸载清零、监听随卸载注销，
 *    终态事件被漏接。这里把状态放模块级 store、监听**全局只注册一次**（永不注销），
 *    页面卸载期间事件照收、状态照累加，回来时重新绑定即可 1:1 还原。
 *
 * 设计：不改路由 / 不改布局，纯 TypeScript 状态层，避免触碰页面骨架引发布局回归。
 */
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@/core/config'
import type { ChatSegment } from '@/pages/agent-studio/chat/types'
import {
  dedupeKbHits,
  parseKbResult,
  type KbHit,
} from './KbSearchCitations'
import { baseName, opAction, opOf, pathFromArgs } from './toolNarrate'
import type {
  AgentEvent,
  ApprovalRequest,
  ArtifactRef,
  ChoiceRequest,
  IntentClassified,
  PlanApprovalRequest,
  PlanBranchGenerated,
  PlanStep,
  RecoveryRequest,
  ThinkingChunk,
  ToolStep,
} from './types'

/** 单个会话的运行态（全部可序列化，供界面渲染）。 */
export interface RuntimeState {
  toolSteps: ToolStep[]
  segments: ChatSegment[]
  streamingText: string
  isStreaming: boolean
  statusText: string
  thoughts: string[]
  planSteps: PlanStep[]
  planning: boolean
  isRunning: boolean
  pendingApproval: ApprovalRequest | null
  liveTokenUsage: { promptTokens: number; completionTokens: number } | null
  taskError: { message: string; at: number } | null
  artifacts: ArtifactRef[]
  traceIntent: IntentClassified | undefined
  traceThinking: ThinkingChunk[]
  planBranch: PlanBranchGenerated | null
  recovery: RecoveryRequest | null
  pendingChoice: ChoiceRequest | null
  planApproval: PlanApprovalRequest | null
  kbSources: KbHit[]
  lastLlmUsage: { promptTokens: number; completionTokens: number } | null
}

/** 单会话的非响应式辅助数据（不参与渲染，但必须按会话隔离，否则同样会串台）。 */
interface RuntimeRefs {
  /** tool_call_id → 步骤（用于 finished 原地更新） */
  steps: Map<string, ToolStep>
  /** K3-2 本轮 kb_search 命中聚合池 */
  kbHits: Map<string, KbHit>
  agentId: string | null
  /** 本轮 round id（终态写库用） */
  roundId: string | null
  /** 本轮用户问题（未命名会话改名用） */
  lastPrompt: string
  /** 当前活跃子任务序号 */
  currentStep: number | null
  /** thinking 增量是否正在续写末行 */
  reasoningOpen: boolean
  /** 最近一轮真实 token 用量（agent-task-done 带出） */
  lastTaskUsage: { promptTokens: number; completionTokens: number } | null
  /** 是否处于授权/选择挂起（用于安全定时器跳过） */
  pendingHold: boolean
}

export interface RunTerminalInfo {
  sessionId: string
  agentId: string | null
  roundId: string | null
  lastPrompt: string
  runtime: RuntimeState
  ok: boolean
  usage: { promptTokens: number; completionTokens: number } | null
}

type TerminalHandler = (info: RunTerminalInfo) => void

function emptyState(): RuntimeState {
  return {
    toolSteps: [],
    segments: [],
    streamingText: '',
    isStreaming: false,
    statusText: '',
    thoughts: [],
    planSteps: [],
    planning: false,
    isRunning: false,
    pendingApproval: null,
    liveTokenUsage: null,
    taskError: null,
    artifacts: [],
    traceIntent: undefined,
    traceThinking: [],
    planBranch: null,
    recovery: null,
    pendingChoice: null,
    planApproval: null,
    kbSources: [],
    lastLlmUsage: null,
  }
}

function emptyRefs(): RuntimeRefs {
  return {
    steps: new Map(),
    kbHits: new Map(),
    agentId: null,
    roundId: null,
    lastPrompt: '',
    currentStep: null,
    reasoningOpen: false,
    lastTaskUsage: null,
    pendingHold: false,
  }
}

/** 冻结的空态：getSnapshot 对未创建条目返回它，保证引用稳定（useSyncExternalStore 要求）。 */
const EMPTY: RuntimeState = Object.freeze(emptyState())

interface Entry {
  rt: RuntimeState
  refs: RuntimeRefs
}

const entries = new Map<string, Entry>()
const subscribers = new Set<() => void>()
const terminalHandlers = new Set<TerminalHandler>()

/** 正在运行任务的会话 / 智能体（事件路由依据：事件不带会话 id）。 */
let runningSessionId: string | null = null
let runningAgentId: string | null = null

let bridgeStarted = false

function notify() {
  for (const cb of subscribers) cb()
}

/* ------------------------------ 对外 API ------------------------------ */

export function subscribeRuntime(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

/** 读取某会话的运行态快照（未创建则返回冻结空态，引用稳定）。 */
export function getRuntimeSnapshot(sessionId: string | null): RuntimeState {
  if (!sessionId) return EMPTY
  return entries.get(sessionId)?.rt ?? EMPTY
}

/** 取（必要时创建）某会话的可写条目。 */
function entryOf(sessionId: string, create: boolean): Entry | undefined {
  let e = entries.get(sessionId)
  if (!e && create) {
    e = { rt: emptyState(), refs: emptyRefs() }
    entries.set(sessionId, e)
  }
  return e
}

/** 更新某会话运行态（不可变替换 + 通知订阅者）。 */
export function mutateRuntime(sessionId: string, fn: (rt: RuntimeState, refs: RuntimeRefs) => RuntimeState) {
  const e = entryOf(sessionId, true)
  if (!e) return
  e.rt = fn(e.rt, e.refs)
  notify()
}

/** 清空某会话运行态（切换/新建会话时只清目标会话，不影响别的会话在跑的任务）。 */
export function resetRuntime(sessionId: string) {
  const e = entryOf(sessionId, false)
  if (!e) return
  e.rt = emptyState()
  e.refs = emptyRefs()
  notify()
}

export function getRunningSessionId(): string | null {
  return runningSessionId
}

export function isSessionRunning(sessionId: string | null): boolean {
  if (!sessionId) return false
  return entries.get(sessionId)?.rt.isRunning === true
}

/** 该智能体是否有任务在跑（用于输入框禁用：同一智能体一次只能跑一个任务）。 */
export function isAgentRunning(agentId: string | null | undefined): boolean {
  if (!agentId || !runningAgentId) return false
  return runningAgentId === agentId && runningSessionId !== null
}

/** 标记某会话开始运行（run 入口调用；事件据此路由）。 */
export function beginRun(sessionId: string, agentId: string | null, meta: { roundId?: string | null; lastPrompt?: string }) {
  runningSessionId = sessionId
  runningAgentId = agentId
  const e = entryOf(sessionId, true)
  if (e) {
    e.refs.agentId = agentId
    e.refs.roundId = meta.roundId ?? e.refs.roundId
    if (meta.lastPrompt !== undefined) e.refs.lastPrompt = meta.lastPrompt
    e.refs.steps.clear()
    e.refs.kbHits.clear()
    e.refs.currentStep = null
    e.refs.reasoningOpen = false
    e.refs.lastTaskUsage = null
    e.refs.pendingHold = false
    e.rt = { ...emptyState(), isRunning: true, planning: true }
  }
  notify()
}

/** 结束运行态（终态事件或取消时调用）。 */
export function endRun() {
  runningSessionId = null
  runningAgentId = null
}

export function setRunMeta(sessionId: string, meta: { roundId?: string | null; lastPrompt?: string }) {
  const e = entryOf(sessionId, true)
  if (!e) return
  if (meta.roundId !== undefined) e.refs.roundId = meta.roundId
  if (meta.lastPrompt !== undefined) e.refs.lastPrompt = meta.lastPrompt
}

export function getRunMeta(sessionId: string): { roundId: string | null; lastPrompt: string; agentId: string | null } {
  const e = entries.get(sessionId)
  return {
    roundId: e?.refs.roundId ?? null,
    lastPrompt: e?.refs.lastPrompt ?? '',
    agentId: e?.refs.agentId ?? null,
  }
}

/** 取某会话 refs（供 hook 内部读取非响应式数据）。 */
export function getRefs(sessionId: string): RuntimeRefs | undefined {
  return entries.get(sessionId)?.refs
}

/** 注册终态处理器（供页面做落库：轮次定稿 / 会话状态 / 改名 / 列表刷新）。 */
export function onRunTerminal(cb: TerminalHandler): () => void {
  terminalHandlers.add(cb)
  return () => terminalHandlers.delete(cb)
}

function fireTerminal(info: RunTerminalInfo) {
  for (const cb of terminalHandlers) {
    try {
      cb(info)
    } catch (e) {
      console.error('[runtime] terminal handler failed', e)
    }
  }
}

/* --------------------------- 事件 → 状态转换 --------------------------- */

function labelOf(toolName: string): string {
  const parts = toolName.split('__')
  return parts[parts.length - 1] ?? toolName
}

function flushSteps(rt: RuntimeState, refs: RuntimeRefs): RuntimeState {
  return { ...rt, toolSteps: Array.from(refs.steps.values()) }
}

/** 终态清扫：把仍停留 running 的步骤收敛为 failed，避免永久转圈。 */
function finalizeStuckSteps(rt: RuntimeState, refs: RuntimeRefs): RuntimeState {
  let next = rt
  let changed = false
  refs.steps.forEach((step, key) => {
    if (step.status === 'running') {
      refs.steps.set(key, {
        ...step,
        status: 'failed',
        result: step.result ?? '（任务已结束，但未收到该工具步骤的完成信号，已自动标记为失败）',
      })
      changed = true
    }
  })
  if (changed) next = flushSteps(next, refs)
  if (next.planSteps.some((t) => t.status === 'running')) {
    next = {
      ...next,
      planSteps: next.planSteps.map((t) =>
        t.status === 'running'
          ? { ...t, status: 'failed', summary: t.summary ?? '（任务已结束，但该规划步骤未收到完成信号，已自动标记为失败）' }
          : t,
      ),
    }
  }
  return next
}

function applyAgentEvent(rt: RuntimeState, refs: RuntimeRefs, e: AgentEvent): RuntimeState {
  switch (e.type) {
    case 'tool_started':
      if (e.step) {
        const step = { ...e.step, toolLabel: labelOf(e.step.toolName), step: refs.currentStep ?? undefined }
        refs.steps.set(step.callId, step)
        const op = step.op ?? opOf(step.toolName)
        const target = baseName(step.path ?? pathFromArgs(step.args))
        const object = target && target !== '.' ? ` ${target}` : ''
        const narration = `正在${opAction(op)}${object}`
        rt = flushSteps(rt, refs)
        rt = { ...rt, thoughts: [...rt.thoughts, narration] }
        rt = {
          ...rt,
          segments: [
            ...rt.segments,
            { kind: 'thought' as const, text: narration },
            { kind: 'tool' as const, callId: step.callId },
          ],
        }
      }
      break
    case 'tool_finished':
      if (e.step) {
        const step = { ...e.step, toolLabel: labelOf(e.step.toolName), step: refs.currentStep ?? undefined }
        refs.steps.set(step.callId, step)
        if (step.toolName === 'native__kb_search' && step.status === 'success') {
          const parsed = parseKbResult(step.result)
          if (parsed) {
            for (const h of parsed.hits) {
              if (!h?.id) continue
              refs.kbHits.set(h.id, h)
            }
          }
        }
        rt = flushSteps(rt, refs)
        if (step.status !== 'success') {
          const op = step.op ?? opOf(step.toolName)
          const target = baseName(step.path ?? pathFromArgs(step.args))
          const object = target && target !== '.' ? `（${target}）` : ''
          const reason = (step.result ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
          const failNote = `${opAction(op)}失败${object}${reason ? `：${reason}` : ''}`
          rt = { ...rt, thoughts: [...rt.thoughts, failNote] }
          rt = { ...rt, segments: [...rt.segments, { kind: 'thought' as const, text: failNote }] }
        }
      }
      break
    case 'text_chunk':
      if (e.chunk) {
        const chunk = e.chunk
        if (chunk.text) {
          rt = { ...rt, streamingText: rt.streamingText + chunk.text }
          const last = rt.segments[rt.segments.length - 1]
          rt = last && last.kind === 'text'
            ? { ...rt, segments: [...rt.segments.slice(0, -1), { kind: 'text' as const, text: (last.text ?? '') + chunk.text }] }
            : { ...rt, segments: [...rt.segments, { kind: 'text' as const, text: chunk.text }] }
        }
        rt = { ...rt, isStreaming: !chunk.done }
      }
      break
    case 'text_done':
      rt = { ...rt, isStreaming: false }
      break
    case 'status':
      if (e.message) {
        rt = { ...rt, thoughts: [...rt.thoughts, e.message] }
        rt = { ...rt, segments: [...rt.segments, { kind: 'thought' as const, text: e.message }] }
      }
      break
    case 'error':
      if (e.message) rt = { ...rt, statusText: `错误：${e.message}` }
      break
    case 'plan_generated':
      refs.steps.clear()
      rt = flushSteps(rt, refs)
      rt = { ...rt, artifacts: [], traceIntent: undefined, traceThinking: [], planning: false, planApproval: null }
      if (e.plan?.tasks) rt = { ...rt, planSteps: e.plan.tasks }
      break
    case 'step_started':
      if (typeof e.plan?.step === 'number') {
        const s = e.plan.step
        refs.currentStep = s
        rt = { ...rt, planSteps: rt.planSteps.map((t) => (t.step === s ? { ...t, status: 'running' } : t)) }
        rt = { ...rt, recovery: rt.recovery && rt.recovery.step === s ? null : rt.recovery }
      }
      break
    case 'step_finished':
      if (typeof e.plan?.step === 'number') {
        const s = e.plan.step
        const st = e.plan.status ?? 'success'
        const sum = e.plan.summary
        const verified = typeof e.plan.verified === 'boolean' ? e.plan.verified : undefined
        const evidence = typeof e.plan.evidence === 'string' ? e.plan.evidence : undefined
        if (refs.currentStep === s) refs.currentStep = null
        rt = {
          ...rt,
          planSteps: rt.planSteps.map((t) =>
            t.step === s ? { ...t, status: st, summary: sum ?? t.summary, verified, evidence } : t,
          ),
        }
        rt = { ...rt, recovery: rt.recovery && rt.recovery.step === s ? null : rt.recovery }
      }
      break
    case 'step_blocked':
      if (typeof e.plan?.step === 'number') {
        const s = e.plan.step
        const sum = e.plan.summary
        rt = {
          ...rt,
          planSteps: rt.planSteps.map((t) => (t.step === s ? { ...t, status: 'blocked', summary: sum ?? t.summary } : t)),
        }
      }
      break
    case 'step_retrying':
      if (typeof e.plan?.step === 'number') {
        const s = e.plan.step
        rt = { ...rt, planSteps: rt.planSteps.map((t) => (t.step === s ? { ...t, status: 'retrying' } : t)) }
      }
      break
    case 'intent_classified':
      if (e.intent) rt = { ...rt, traceIntent: e.intent }
      break
    case 'thinking_chunk':
      if (e.chunk) {
        const chunk = e.chunk
        rt = {
          ...rt,
          traceThinking: [
            ...rt.traceThinking,
            { layer: (chunk?.layer as ThinkingChunk['layer']) ?? 'exec', text: chunk!.text, done: chunk!.done },
          ],
        }
        if (chunk.done && !chunk.text) {
          refs.reasoningOpen = false
        } else if (chunk.text && !chunk.done) {
          const wasOpen = refs.reasoningOpen
          refs.reasoningOpen = true
          rt = wasOpen && rt.thoughts.length > 0
            ? { ...rt, thoughts: [...rt.thoughts.slice(0, -1), rt.thoughts[rt.thoughts.length - 1] + chunk.text] }
            : { ...rt, thoughts: [...rt.thoughts, chunk.text] }
          const lastSeg = rt.segments[rt.segments.length - 1]
          rt = wasOpen && lastSeg && lastSeg.kind === 'thought'
            ? { ...rt, segments: [...rt.segments.slice(0, -1), { kind: 'thought' as const, text: (lastSeg.text ?? '') + chunk.text }] }
            : { ...rt, segments: [...rt.segments, { kind: 'thought' as const, text: chunk.text }] }
        } else if (chunk.text) {
          refs.reasoningOpen = false
          rt = { ...rt, thoughts: [...rt.thoughts, chunk.text] }
          rt = { ...rt, segments: [...rt.segments, { kind: 'thought' as const, text: chunk.text }] }
        }
      }
      break
    case 'plan_branch_generated':
      if (e.branch) rt = { ...rt, planBranch: e.branch }
      break
  }
  return rt
}

/* ------------------------------ 全局事件桥 ------------------------------ */
/* 监听在模块级只注册一次，页面卸载不注销——这是「切走再回来不丢事件」的关键。 */

export function ensureRuntimeBridge() {
  if (!isTauri || bridgeStarted) return
  bridgeStarted = true

  /** 事件统一路由到「正在运行的会话」；没有运行中的任务则忽略（避免污染其它会话）。 */
  const route = (fn: (rt: RuntimeState, refs: RuntimeRefs) => RuntimeState) => {
    const id = runningSessionId
    if (!id) return
    mutateRuntime(id, fn)
  }

  void listen<AgentEvent>('agent-event', (ev) => {
    route((rt, refs) => applyAgentEvent(rt, refs, ev.payload))
  })

  void listen<ApprovalRequest>('agent-awaiting-approval', (ev) => {
    route((rt, refs) => {
      refs.pendingHold = true
      return {
        ...rt,
        pendingApproval: ev.payload,
        statusText: '⏸ 等待授权：请在弹窗中选择允许 / 拒绝，任务已暂停',
      }
    })
  })

  void listen<{ promptTokens: number; completionTokens: number }>('agent-task-done', (ev) => {
    const id = runningSessionId
    if (!id) return
    mutateRuntime(id, (rt, refs) => {
      refs.lastTaskUsage = ev.payload ?? null
      refs.pendingHold = false
      let next: RuntimeState = {
        ...rt,
        liveTokenUsage: ev.payload ?? null,
        isRunning: false,
        isStreaming: false,
        statusText: '',
        recovery: null,
        planApproval: null,
        planning: false,
        kbSources: dedupeKbHits([...refs.kbHits.values()]),
      }
      refs.kbHits.clear()
      next = finalizeStuckSteps(next, refs)
      // 终态落库交给页面注册的 handler（改名 / 轮次定稿 / 会话状态 / 列表刷新），
      // 与组件生命周期解耦——切页期间任务跑完也能正确定稿。
      fireTerminal({
        sessionId: id,
        agentId: refs.agentId,
        roundId: refs.roundId,
        lastPrompt: refs.lastPrompt,
        runtime: next,
        ok: true,
        usage: ev.payload ?? null,
      })
      endRun()
      return next
    })
  })

  void listen<string>('agent-task-error', (ev) => {
    const id = runningSessionId
    if (!id) return
    mutateRuntime(id, (rt, refs) => {
      refs.pendingHold = false
      let next: RuntimeState = {
        ...rt,
        isRunning: false,
        isStreaming: false,
        statusText: `任务异常：${ev.payload}`,
        recovery: null,
        planApproval: null,
        planning: false,
        taskError: { message: ev.payload, at: Date.now() },
      }
      next = finalizeStuckSteps(next, refs)
      fireTerminal({
        sessionId: id,
        agentId: refs.agentId,
        roundId: refs.roundId,
        lastPrompt: refs.lastPrompt,
        runtime: next,
        ok: false,
        usage: null,
      })
      endRun()
      return next
    })
  })

  void listen<RecoveryRequest>('agent-recovery-needed', (ev) => {
    route((rt) => ({ ...rt, recovery: ev.payload }))
  })

  void listen<ChoiceRequest>('agent-choice-needed', (ev) => {
    route((rt, refs) => {
      refs.pendingHold = true
      return { ...rt, pendingChoice: ev.payload }
    })
  })

  void listen<PlanApprovalRequest>('agent-plan-approval-needed', (ev) => {
    route((rt, refs) => {
      refs.pendingHold = true
      return {
        ...rt,
        planApproval: ev.payload,
        statusText: '⏸ 计划待确认：请在弹窗中批准 / 修改 / 拒绝，任务已暂停',
      }
    })
  })

  void listen<{ promptTokens: number; completionTokens: number }>('agent-token-update', (ev) => {
    if (ev.payload) route((rt) => ({ ...rt, liveTokenUsage: ev.payload }))
  })

  void listen<{ promptTokens: number; completionTokens: number }>('agent-llm-usage', (ev) => {
    if (ev.payload) route((rt) => ({ ...rt, lastLlmUsage: ev.payload }))
  })

  void listen<{ step: number; artifacts: ArtifactRef[] }>('agent-artifact-created', (ev) => {
    if (ev.payload?.artifacts?.length) {
      route((rt) => {
        const seen = new Set(rt.artifacts.map((a) => a.artifactId))
        return { ...rt, artifacts: [...rt.artifacts, ...ev.payload.artifacts.filter((a) => !seen.has(a.artifactId))] }
      })
    }
  })

  void listen<PlanBranchGenerated>('agent-plan-branch', (ev) => {
    if (ev.payload) route((rt) => ({ ...rt, planBranch: ev.payload }))
  })
}
