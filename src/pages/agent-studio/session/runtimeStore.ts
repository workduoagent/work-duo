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

/**
 * 模块可变状态整体挂到 **globalThis**（跨 Vite HMR 热更新存活）。
 *
 * 为什么必须这样：本模块会被 Vite HMR 重执行（开发期每次编辑都触发），模块作用域
 * 整个重建——若状态放模块级，会出现三连灾难：①运行中任务的全部运行态直接丢失；
 * ②Tauri 监听被重复注册，每个事件被处理多次（曾表现为「一次任务弹多条完成通知」）；
 * ③新旧两份注册表脱节，旧监听写旧状态、新代码读新状态 → 事件流断裂，**通知再也不弹**。
 * 挂 globalThis 后重执行时复用同一份状态与标记，彻底规避。
 */
interface RuntimeGlobalState {
  entries: Map<string, Entry>
  subscribers: Set<() => void>
  terminalHandlers: Map<string, TerminalHandler>
  pendingHandlers: Map<string, PendingHandler>
  lastPendingKind: Map<string, string>
  /** 正在运行任务的会话 / 智能体（事件路由依据：事件不带会话 id）。 */
  runningSessionId: string | null
  runningAgentId: string | null
  /** 事件桥是否已注册（跨 HMR 存活，保证只注册一次）。 */
  bridgeStarted: boolean
}

const __wdGlobal = globalThis as unknown as { __wdRuntimeStore?: RuntimeGlobalState }
const S: RuntimeGlobalState = __wdGlobal.__wdRuntimeStore ?? (__wdGlobal.__wdRuntimeStore = {
  entries: new Map<string, Entry>(),
  subscribers: new Set<() => void>(),
  terminalHandlers: new Map<string, TerminalHandler>(),
  pendingHandlers: new Map<string, PendingHandler>(),
  lastPendingKind: new Map<string, string>(),
  runningSessionId: null,
  runningAgentId: null,
  bridgeStarted: false,
})

const { entries, subscribers, terminalHandlers, pendingHandlers, lastPendingKind } = S

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
  return S.runningSessionId
}

export function isSessionRunning(sessionId: string | null): boolean {
  if (!sessionId) return false
  return entries.get(sessionId)?.rt.isRunning === true
}

/** 该智能体是否有任务在跑（用于输入框禁用：同一智能体一次只能跑一个任务）。 */
export function isAgentRunning(agentId: string | null | undefined): boolean {
  if (!agentId || !S.runningAgentId) return false
  return S.runningAgentId === agentId && S.runningSessionId !== null
}

/** 标记某会话开始运行（run 入口调用；事件据此路由）。 */
export function beginRun(sessionId: string, agentId: string | null, meta: { roundId?: string | null; lastPrompt?: string }) {
  S.runningSessionId = sessionId
  S.runningAgentId = agentId
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
  S.runningSessionId = null
  S.runningAgentId = null
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

/**
 * 注册终态处理器（**按 key 幂等替换**，供页面做落库 / 完成提醒）。
 *
 * 必须按 key 替换而非叠加：调用方（chat.tsx）是组件模块，其模块级注册语句在
 * Vite HMR（react-refresh 热替换）下会随模块重执行而反复运行 —— 若用 Set 叠加，
 * 开发时每改一次该文件就多一个处理器，**一次任务完成会弹出 N 条重复通知**（真机实锤）。
 */
export function setTerminalHandler(key: string, cb: TerminalHandler) {
  terminalHandlers.set(key, cb)
}

function fireTerminal(info: RunTerminalInfo) {
  for (const cb of terminalHandlers.values()) {
    try {
      cb(info)
    } catch (e) {
      console.error('[runtime] terminal handler failed', e)
    }
  }
}

/* --------------------- HITL 挂起提醒（授权/审批/选择/恢复） --------------------- */

/** 挂起事件 → 人类可读类别（通知标题用）。 */
const PENDING_EVENT_KINDS: Record<string, string> = {
  'agent-awaiting-approval': '高危操作授权',
  'agent-recovery-needed': '步骤恢复决策',
  'agent-choice-needed': '方案选择',
  'agent-plan-approval-needed': '计划审批',
}

export interface PendingNotifyInfo {
  sessionId: string
  agentId: string | null
  kind: string
}

type PendingHandler = (info: PendingNotifyInfo) => void

// pendingHandlers / lastPendingKind 两张 Map 挂在共享状态 S 上（跨 HMR 存活），见文件头部。

/**
 * 注册挂起提醒处理器（**按 key 幂等替换**，防 HMR 重复注册——同 setTerminalHandler）。
 * 触发时机：授权 / 计划审批 / 方案选择 / 步骤恢复等 HITL 挂起事件到达。
 */
export function setPendingNotifyHandler(key: string, cb: PendingHandler) {
  pendingHandlers.set(key, cb)
}

function firePendingNotify(sessionId: string, event: string) {
  const kind = PENDING_EVENT_KINDS[event] ?? '需要你确认'
  if (lastPendingKind.get(sessionId) === kind) return
  lastPendingKind.set(sessionId, kind)
  console.info('[runtime] pending notify', { sessionId, kind, handlers: pendingHandlers.size })
  const info: PendingNotifyInfo = {
    sessionId,
    agentId: entries.get(sessionId)?.refs.agentId ?? null,
    kind,
  }
  for (const cb of pendingHandlers.values()) {
    try {
      cb(info)
    } catch (e) {
      console.error('[runtime] pending notify handler failed', e)
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
      // statusText 一并清：修改后重新出计划时，旧的「⏸ 计划待确认…」提示不能残留
      rt = { ...rt, artifacts: [], traceIntent: undefined, traceThinking: [], planning: false, planApproval: null, statusText: '' }
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
  // bridgeStarted 挂在 globalThis 的共享状态 S 上（跨 HMR 存活），保证只注册一次。
  if (!isTauri || S.bridgeStarted) return
  S.bridgeStarted = true

  /** 事件统一路由到「正在运行的会话」；没有运行中的任务则忽略（避免污染其它会话）。 */
  const route = (fn: (rt: RuntimeState, refs: RuntimeRefs) => RuntimeState) => {
    const id = S.runningSessionId
    if (!id) return
    mutateRuntime(id, fn)
  }

  void listen<AgentEvent>('agent-event', (ev) => {
    route((rt, refs) => applyAgentEvent(rt, refs, ev.payload))
  })

  void listen<ApprovalRequest>('agent-awaiting-approval', (ev) => {
    const id = S.runningSessionId
    if (!id) return
    mutateRuntime(id, (rt, refs) => {
      refs.pendingHold = true
      return {
        ...rt,
        pendingApproval: ev.payload,
        statusText: '⏸ 等待授权：请在弹窗中选择允许 / 拒绝，任务已暂停',
      }
    })
    // HITL 阻塞态：任务暂停等人操作。用户没在看该会话时必须提醒到位，否则任务默默卡死。
    firePendingNotify(id, 'agent-awaiting-approval')
  })

  void listen<{ promptTokens: number; completionTokens: number }>('agent-task-done', (ev) => {
    const id = S.runningSessionId
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
      lastPendingKind.delete(id) // 新一轮任务在同一会话挂起时仍可再次提醒
      return next
    })
  })

  void listen<string>('agent-task-error', (ev) => {
    const id = S.runningSessionId
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
      lastPendingKind.delete(id)
      return next
    })
  })

  void listen<RecoveryRequest>('agent-recovery-needed', (ev) => {
    const id = S.runningSessionId
    if (!id) return
    mutateRuntime(id, (rt) => ({ ...rt, recovery: ev.payload }))
    firePendingNotify(id, 'agent-recovery-needed')
  })

  void listen<ChoiceRequest>('agent-choice-needed', (ev) => {
    const id = S.runningSessionId
    if (!id) return
    mutateRuntime(id, (rt, refs) => {
      refs.pendingHold = true
      return { ...rt, pendingChoice: ev.payload }
    })
    firePendingNotify(id, 'agent-choice-needed')
  })

  void listen<PlanApprovalRequest>('agent-plan-approval-needed', (ev) => {
    const id = S.runningSessionId
    if (!id) return
    mutateRuntime(id, (rt, refs) => {
      refs.pendingHold = true
      return {
        ...rt,
        planApproval: ev.payload,
        statusText: '⏸ 计划待确认：请在弹窗中批准 / 修改 / 拒绝，任务已暂停',
      }
    })
    firePendingNotify(id, 'agent-plan-approval-needed')
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
