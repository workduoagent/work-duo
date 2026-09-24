/**
 * 智能体会话状态机 Hook（状态层重构版）。
 *
 * 与旧版的本质区别：运行态**不再放在组件 useState 里**，而是放模块级
 * `runtimeStore`（按会话 id 隔离）。本 Hook 只做「绑定 + 订阅 + 动作下发」：
 *  - 读：订阅 store，返回【当前查看会话】的运行态 → 切到历史会话时读到的是该会话
 *    自己的状态，正在跑的会话不会串过来（修复「loading 跟着走 / 在历史会话继续输出」）；
 *  - 写：事件由全局桥（只注册一次、永不注销）写进【正在运行的会话】条目，
 *    页面卸载期间照常累加 → 切回来重新绑定即 1:1 还原（修复「切走再回来只剩残缺快照」）。
 *
 * 对外接口与旧版保持一致，页面消费方式不变。
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type MutableRefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ChatSegment } from '@/pages/agent-studio/chat/types'
import { isTauri } from '@/core/config'
import type {
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
import type { KbHit } from './KbSearchCitations'
import {
  beginRun,
  endRun,
  ensureRuntimeBridge,
  getRefs,
  getRuntimeSnapshot,
  isAgentRunning,
  mutateRuntime,
  resetRuntime,
  subscribeRuntime,
  type RuntimeState,
} from './runtimeStore'

/** 会话对外暴露的实时状态（与旧版一致）。 */
export interface AgentSessionState {
  toolSteps: ToolStep[]
  segments: ChatSegment[]
  lastLlmUsage: { promptTokens: number; completionTokens: number } | null
  streamingText: string
  isStreaming: boolean
  statusText: string
  thoughts: string[]
  planSteps: PlanStep[]
  planning: boolean
  isRunning: boolean
  pendingApproval: ApprovalRequest | null
  run: (input: RunAgentTaskInput) => Promise<void>
  submitDecision: (decision: ApprovalDecision) => Promise<void>
  reset: () => void
  cancel: () => void
  lastTaskUsage: MutableRefObject<{ promptTokens: number; completionTokens: number } | null>
  liveTokenUsage: { promptTokens: number; completionTokens: number } | null
  taskError: { message: string; at: number } | null
  artifacts: ArtifactRef[]
  trace: { intent?: IntentClassified; thinking: ThinkingChunk[] }
  planBranch: PlanBranchGenerated | null
  recovery: RecoveryRequest | null
  resolveRecovery: (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => Promise<void>
  planApproval: PlanApprovalRequest | null
  resolvePlanApproval: (decision: 'approve' | 'reject' | 'revise', guidance?: string) => Promise<void>
  pendingChoice: ChoiceRequest | null
  submitChoice: (optionId: string, customText?: string) => Promise<void>
  kbSources: KbHit[]
}

/** 长任务兜底告警时长（仅提示，不结束任务）。 */
const LONG_RUN_WARN_MS = 20 * 60_000

export function useAgentSession(sessionId: string | null): AgentSessionState {
  // 绑定当前查看会话：读的是「该会话自己的」运行态。
  const rt: RuntimeState = useSyncExternalStore(subscribeRuntime, () => getRuntimeSnapshot(sessionId))

  // 全局事件桥：模块级只注册一次，页面卸载不注销（切走期间事件照收）。
  useEffect(() => {
    ensureRuntimeBridge()
  }, [])

  // 长任务兜底告警（仅写提示文本，不翻转运行态）。
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!rt.isRunning || !sessionId) {
      if (warnTimerRef.current) {
        clearTimeout(warnTimerRef.current)
        warnTimerRef.current = null
      }
      return
    }
    warnTimerRef.current = setTimeout(() => {
      mutateRuntime(sessionId, (s) =>
        s.isRunning
          ? { ...s, statusText: '⏳ 任务已运行超过 20 分钟仍未收到结束信号，可能仍在后台执行；如需中断请点「停止」' }
          : s,
      )
    }, LONG_RUN_WARN_MS)
    return () => {
      if (warnTimerRef.current) {
        clearTimeout(warnTimerRef.current)
        warnTimerRef.current = null
      }
    }
  }, [rt.isRunning, sessionId])

  const run = useCallback(
    async (input: RunAgentTaskInput) => {
      const sid = input.sessionId ?? sessionId
      if (!sid) return
      // 同一智能体一次只能跑一个任务（后端也有闸门锁）。
      if (isAgentRunning(input.agentId ?? null)) return
      beginRun(sid, input.agentId ?? null, { roundId: input.roundId ?? null, lastPrompt: input.prompt })

      if (!isTauri) {
        // dev/mock：无后端，直接给一段演示态并收尾。
        mutateRuntime(sid, (s) => ({
          ...s,
          thoughts: ['（演示模式）无原生后端，未真正执行任务'],
          planning: false,
          isRunning: false,
        }))
        endRun()
        return
      }
      try {
        await invoke('run_agent_task', {
          input: {
            agentId: input.agentId,
            prompt: input.prompt,
            workspace: input.workspace ?? null,
            attachments: input.attachments ?? [],
            sessionId: input.sessionId ?? null,
            roundId: input.roundId ?? null,
            disabledSkillIds: input.disabledSkillIds ?? [],
            disabledMcpIds: input.disabledMcpIds ?? [],
            disabledMcpToolIds: input.disabledMcpToolIds ?? [],
            enabledSkillIds: input.enabledSkillIds ?? [],
            enabledMcpIds: input.enabledMcpIds ?? [],
            enabledPluginIds: input.enabledPluginIds ?? [],
            disabledPluginIds: input.disabledPluginIds ?? [],
            planOverride: input.planOverride ?? undefined,
            preCompleted: input.preCompleted ?? [],
            initialContext: input.initialContext ?? '',
          },
        })
      } catch (e) {
        const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : '任务启动失败'
        endRun()
        mutateRuntime(sid, (s) => ({ ...s, isRunning: false, isStreaming: false, planning: false, statusText: msg }))
      }
    },
    [sessionId],
  )

  const submitDecision = useCallback(
    async (decision: ApprovalDecision) => {
      const sid = sessionId
      if (sid) mutateRuntime(sid, (s) => ({ ...s, pendingApproval: null, statusText: '' }))
      if (!isTauri) return
      try {
        await invoke('submit_approval_decision', {
          decision: {
            approvalId: decision.approvalId,
            decision: decision.decision,
            guidance: decision.guidance ?? null,
            remember: decision.remember ?? false,
            grantKey: decision.grantKey ?? null,
          },
        })
      } catch (e) {
        console.error('[agent] submit_approval_decision failed', e)
      }
    },
    [sessionId],
  )

  const reset = useCallback(() => {
    // 只清「当前绑定会话」自己的运行态；别的会话在跑的任务不受影响。
    if (sessionId) resetRuntime(sessionId)
  }, [sessionId])

  const cancel = useCallback(() => {
    const sid = sessionId
    if (!sid) return
    const agentId = getRefs(sid)?.agentId ?? null
    mutateRuntime(sid, (s) => ({ ...s, pendingChoice: null }))
    if (!isTauri) {
      mutateRuntime(sid, (s) => ({ ...s, isRunning: false, isStreaming: false, planning: false }))
      endRun()
      return
    }
    void invoke('cancel_agent_task', { agentId }).catch(() => {})
    // 取消是 best-effort：3s 兜底强制复位，避免「停止」后按钮卡死。
    setTimeout(() => {
      mutateRuntime(sid, (s) =>
        s.isRunning ? { ...s, isRunning: false, isStreaming: false, planning: false, statusText: '' } : s,
      )
      endRun()
    }, 3000)
  }, [sessionId])

  const resolveRecovery = useCallback(
    async (decision: 'retry' | 'skip' | 'takeover' | 'change-approach', guidance?: string) => {
      const sid = sessionId
      if (sid) mutateRuntime(sid, (s) => ({ ...s, recovery: null }))
      if (!isTauri) return
      const agentId = sid ? getRefs(sid)?.agentId ?? null : null
      try {
        await invoke('resolve_subtask', { agentId, input: { decision, guidance: guidance ?? null } })
      } catch (e) {
        console.error('[agent] resolve_subtask failed', e)
      }
    },
    [sessionId],
  )

  const resolvePlanApproval = useCallback(
    async (decision: 'approve' | 'reject' | 'revise', guidance?: string) => {
      const sid = sessionId
      if (sid) mutateRuntime(sid, (s) => ({ ...s, planApproval: null }))
      if (!isTauri) return
      try {
        await invoke('submit_plan_decision', { input: { decision, guidance: guidance ?? null } })
      } catch (e) {
        console.error('[agent] submit_plan_decision failed', e)
      }
    },
    [sessionId],
  )

  const submitChoice = useCallback(
    async (optionId: string, customText?: string) => {
      const sid = sessionId
      const choice = sid ? getRuntimeSnapshot(sid).pendingChoice : null
      if (sid) mutateRuntime(sid, (s) => ({ ...s, pendingChoice: null }))
      if (!isTauri || !choice) return
      try {
        await invoke('submit_choice_decision', {
          input: { choiceId: choice.choiceId, optionId, customText: customText ?? null },
        })
      } catch (e) {
        console.error('[agent] submit_choice_decision failed', e)
      }
    },
    [sessionId],
  )

  // lastTaskUsage 是 ref 形态（页面读 .current），这里用 getter 透传 store 里的值。
  const lastTaskUsage = useMemo<MutableRefObject<{ promptTokens: number; completionTokens: number } | null>>(
    () => ({
      get current() {
        return sessionId ? getRefs(sessionId)?.lastTaskUsage ?? null : null
      },
    }),
    [sessionId],
  )

  return {
    toolSteps: rt.toolSteps,
    segments: rt.segments,
    lastLlmUsage: rt.lastLlmUsage,
    streamingText: rt.streamingText,
    isStreaming: rt.isStreaming,
    statusText: rt.statusText,
    thoughts: rt.thoughts,
    planSteps: rt.planSteps,
    planning: rt.planning,
    isRunning: rt.isRunning,
    pendingApproval: rt.pendingApproval,
    run,
    submitDecision,
    reset,
    cancel,
    lastTaskUsage,
    liveTokenUsage: rt.liveTokenUsage,
    taskError: rt.taskError,
    artifacts: rt.artifacts,
    trace: { intent: rt.traceIntent, thinking: rt.traceThinking },
    planBranch: rt.planBranch,
    recovery: rt.recovery,
    resolveRecovery,
    planApproval: rt.planApproval,
    resolvePlanApproval,
    pendingChoice: rt.pendingChoice,
    submitChoice,
    kbSources: rt.kbSources,
  }
}

/** 供页面判断某会话是否在跑（会话列表 loading 指示用，按会话隔离）。 */
export function useIsSessionRunning(sessionId: string | null): boolean {
  const rt = useSyncExternalStore(subscribeRuntime, () => getRuntimeSnapshot(sessionId))
  return rt.isRunning
}
