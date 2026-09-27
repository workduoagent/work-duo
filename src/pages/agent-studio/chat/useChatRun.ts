/**
 * 对话运行链路（台账 S1：自 chat.tsx 原样迁出 hook 化，行为零改动）。
 *
 * 覆盖：ensureRound（轮次落库 / 未命名会话首问改名 / toolsTokens 估算）、
 * send（@提及 前缀序列化 + 临时移除/临时启用集合随请求下发）、handleRegenerate
 * （从消息文本反解 @提及，#20260915004 B3）、执行图分支联动（handleBranchFromStep /
 * handleApplyBranch / handleDismissBranch）、终态固化 effect（台账 S4 保留说明见下）。
 * onRunTerminal（模块级终态落库）在 chat/terminal-bridge.tsx。
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { fe } from '@/core/logBridge'
import { isTauri } from '@/core/config'
import {
  appendRound,
  createSession,
  getSession,
  listSessions,
  renameSession,
  updateSession,
} from '@/core/mapper/agent-session-mapper'
import { listMcps } from '@/core/mapper/mcp-mapper'
import { listPlugins } from '@/core/mapper/plugin-mapper'
import type { SkillInfo } from '@/core/file/skill-file'
import { useAgentSession } from '../session/useAgentSession'
import type { BranchFromStepInput, BranchStep, PlanDAG } from '../session/types'
import type { AgentInfo, AgentConversationSession } from '@/types/core'
import { useAttachments } from './useAttachments'
import { AVG_TOOL_TOKENS, estimateTokens } from './file-helpers'
import type { BoundMcpServer, ChatMessage } from './types'

type AgentSessionState = ReturnType<typeof useAgentSession>
type MentionTag = { key: string; label: string; token: string }

export function useChatRun(opts: {
  /** 会话状态机切片（chat.tsx useAgentSession 的相关字段）。 */
  session: Pick<
    AgentSessionState,
    | 'isRunning'
    | 'streamingText'
    | 'thoughts'
    | 'toolSteps'
    | 'segments'
    | 'kbSources'
    | 'planSteps'
    | 'planBranch'
    | 'run'
    | 'reset'
    | 'lastTaskUsage'
  >
  agent: AgentInfo | undefined
  activeSessionId: string | null
  setActiveSessionId: Dispatch<SetStateAction<string | null>>
  setSessions: Dispatch<SetStateAction<AgentConversationSession[]>>
  pendingProjectId: string | null
  workspaceDir: string | null
  input: string
  setInput: Dispatch<SetStateAction<string>>
  setInputHeight: (h: number) => void
  messages: ChatMessage[]
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  mentionTags: MentionTag[]
  setMentionTags: Dispatch<SetStateAction<MentionTag[]>>
  pendingAttachments: ReturnType<typeof useAttachments>['pendingAttachments']
  setPendingAttachments: ReturnType<typeof useAttachments>['setPendingAttachments']
  removedSkillIds: Set<string>
  removedMcpIds: Set<string>
  disabledMcpToolIds: Set<string>
  removedPluginIds: Set<string>
  toolCount: number
  skillCount: number
  boundMcps: BoundMcpServer[]
  allSkills: SkillInfo[]
  allMcps: Awaited<ReturnType<typeof listMcps>>
  allPlugins: Awaited<ReturnType<typeof listPlugins>>
  setFollowBottom: Dispatch<SetStateAction<boolean>>
  lastAgentContent: string
  setRightTab: (t: 'graph' | 'process' | 'artifacts' | 'actions') => void
  /** 「新增子对话」空会话标记：一旦发起发送即取消待清理（防异步过程中离开误删）。 */
  pendingEmptySessionIdRef: { current: string | null }
}) {
  const {
    agent,
    activeSessionId,
    setActiveSessionId,
    setSessions,
    pendingProjectId,
    workspaceDir,
    input,
    setInput,
    setInputHeight,
    messages,
    setMessages,
    mentionTags,
    setMentionTags,
    pendingAttachments,
    setPendingAttachments,
    removedSkillIds,
    removedMcpIds,
    disabledMcpToolIds,
    removedPluginIds,
    toolCount,
    skillCount,
    boundMcps,
    allSkills,
    allMcps,
    allPlugins,
    setFollowBottom,
    lastAgentContent,
    setRightTab,
    pendingEmptySessionIdRef,
  } = opts
  const { isRunning, streamingText, thoughts, toolSteps, segments, kbSources, planSteps, planBranch, run, reset, lastTaskUsage } =
    opts.session

  const replyStartRef = useRef<number | null>(null)
  const prevIsRunningRef = useRef(false)
  const roundIdRef = useRef<string | null>(null)
  const roundIndexRef = useRef(0)
  const lastPromptRef = useRef('')
  const lastTokensRef = useRef<{ input: number; output: number }>({ input: 0, output: 0 })

  /** 持久化一轮：确保有会话 → 追加 round → 记录 roundId / 序号。 */
  const ensureRound = useCallback(
    async (prompt: string): Promise<string | null> => {
      // 一旦发起发送，立即取消「空会话待清理」标记，避免异步过程中离开误删
      pendingEmptySessionIdRef.current = null
      if (!agent) return null
      let sessionId = activeSessionId
      if (!sessionId) {
        const sess = await createSession(agent.identifier, prompt.slice(0, 40), {
          projectId: pendingProjectId,
        })
        sessionId = sess.id
        setActiveSessionId(sess.id)
        // 估算工具 / Skill 定义占用的上下文 token（理论固定，移除 Skill / 停用 MCP 时下调）
        // 已临时移除的 Skill / MCP 服务 / 单个 MCP 工具不再计入工具集，分别扣减。
        const removedMcpToolCount = boundMcps
          .filter((m) => removedMcpIds.has(m.mcpId))
          .reduce((sum, m) => sum + m.tools.length, 0)
        const effToolCount = toolCount - removedMcpToolCount - disabledMcpToolIds.size
        const effSkillCount = skillCount - removedSkillIds.size
        const toolsTokens = Math.round((effToolCount + effSkillCount) * AVG_TOOL_TOKENS)
        await updateSession(sess.id, { toolsTokens })
        const list = await listSessions(agent.identifier)
        setSessions(list.map((s) => (s.id === sess.id ? { ...s, toolsTokens } : s)))
      } else {
        // 需求①：首问即用「问题」给会话命名并落库。
        // 覆盖「新增子对话」等其它途径建出来的「未命名会话」——此前只在任务跑完时
        // 才改名（且切页/中断就永不触发），导致列表里长期挂着「未命名会话」。
        const cur = await getSession(sessionId)
        const name = (cur?.sessionName ?? '').trim()
        if (!name || name === '未命名会话') {
          const next = prompt.trim().slice(0, 40)
          await renameSession(sessionId, next)
          setSessions((prev) =>
            prev.map((s) => (s.id === sessionId ? { ...s, sessionName: next } : s)),
          )
        }
      }
      const round = await appendRound({
        sessionId: sessionId!,
        llmCode: agent.llmId,
        roundIndex: roundIndexRef.current,
        userQuestion: prompt,
        startTime: Date.now(),
      })
      roundIdRef.current = round.id
      roundIndexRef.current += 1
      return sessionId
    },
    [agent, activeSessionId, toolCount, skillCount, removedSkillIds, removedMcpIds, disabledMcpToolIds, boundMcps, pendingProjectId],
  )

  // 应用分支：把「原方案 head（from_step 之前）+ 新分支 tail」合并成完整计划，
  // head 标记为预完成（后端跳过执行、沿用其结果），调用 run_agent_task 用新分支实际重跑任务。
  const handleApplyBranch = useCallback(async () => {
    const branch = planBranch
    if (!branch || !agent?.id) return
    const head = planSteps.filter((s) => s.step <= branch.fromStep)
    const tasks = [
      ...head.map((s) => ({
        step: s.step,
        task_id: s.taskId ?? `head-${s.step}`,
        title: s.title,
        description: s.description ?? '',
        depends_on: s.dependsOn ?? [],
      })),
      ...branch.branchTasks.map((t) => ({
        step: t.step,
        task_id: t.taskId,
        title: t.title,
        description: t.description,
        depends_on: t.dependsOn,
      })),
    ]
    const planOverride: PlanDAG = {
      goal_summary: branch.goalSummary || '应用分支重规划',
      tasks,
    }
    const preCompleted = head.map((s) => s.taskId ?? `head-${s.step}`)
    const initialContext = head
      .map((s) => `步骤 ${s.step}「${s.title}」已完成（分支重跑沿用其结果）`)
      .join('\n')
    const prompt = branch.goalSummary || '应用分支重规划'
    // 起新一轮（沿用当前会话，新建 round 以便记忆召回与 token 持久化），再带 plan_override 重跑。
    const sid = await ensureRound(prompt)
    if (!sid) return
    try {
      await run({
        agentId: agent.id,
        prompt,
        workspace: workspaceDir ?? null,
        sessionId: sid,
        roundId: roundIdRef.current ?? undefined,
        planOverride,
        preCompleted,
        initialContext,
      })
    } catch (e) {
      console.error('[agent] apply branch 失败：', e)
    }
  }, [planBranch, agent?.id, workspaceDir, planSteps, ensureRound, run])

  /**
   * 从一段用户消息文本里反解出 @提及 标签（#20260915004 B3）。
   * 与 `getCandidates` 同源：只匹配已知技能 / MCP 服务名称，避免误伤自由文本里的 @。
   * 用于「重新生成」时把首轮临时启用的能力原样带回（send 走的是 mentionTags，regenerate 时它已清空）。
   */
  const resolveMentionTags = useCallback(
    (text: string): MentionTag[] => {
      const out: MentionTag[] = []
      const seen = new Set<string>()
      const add = (key: string, label: string, token: string) => {
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ key, label, token })
        }
      }
      const tokens = text.match(/@[\p{L}\p{N}_-]+/gu) ?? []
      for (const tk of tokens) {
        const name = tk.slice(1)
        if (!name) continue
        // 硬化：优先按 identifier 精确匹配，绝不依赖 name 判断（name 含空格会被截断、重名歧义、改名失链）
        const sk =
          allSkills.find((s) => (s.identifier || '') === name) ?? allSkills.find((s) => s.name === name)
        if (sk) {
          add(`skill:${sk.id}`, sk.name, sk.identifier || sk.name)
          continue
        }
        const mc = allMcps.find((m) => (m.aliasName || m.mcpName || m.id) === name)
        if (mc) {
          const mcName = mc.aliasName || mc.mcpName || mc.id
          add(`mcp:${mc.id}`, mcName, mcName)
          continue
        }
        // 插件（P2 新增）：identifier 稳定无空格，优先精确匹配；name 仅历史兼容兜底
        const pl =
          allPlugins.find((p) => p.identifier === name) ?? allPlugins.find((p) => p.name === name)
        if (pl) {
          add(`plugin:${pl.id}`, pl.name, pl.identifier || pl.name)
        }
      }
      return out
    },
    [allSkills, allMcps, allPlugins],
  )

  const send = useCallback(() => {
    // 序列化：@标签 作为前缀，再拼接自由文本；token 用 skill.identifier（稳定、无空格），label 仅用于展示
    const mentionPrefix = mentionTags.map((t) => `@${t.token}`).join(' ')
    const text = [mentionPrefix, input.trim()].filter(Boolean).join(' ').trim()
    if (!text || isRunning || !agent) return

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
      images: pendingAttachments.some((a) => a.type === 'image')
        ? pendingAttachments.filter((a) => a.type === 'image')
        : undefined,
      attachments: pendingAttachments.length ? pendingAttachments : undefined,
    }
    const agentMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      role: 'agent',
      content: '',
      createdAt: Date.now(),
    }
    setMessages((prev) => [...prev, userMsg, agentMsg])
    setInput('')
    setMentionTags([])
    setInputHeight(48)
    setPendingAttachments([])
    lastPromptRef.current = text

    replyStartRef.current = Date.now()
    // 新提问 = 用户明确要看最新内容：恢复跟随模式（此前可能因回看历史已解除）
    setFollowBottom(true)
    // 用户约定（2026-09-26）：执行图不再随发消息自动展开，由用户手动打开；
    // 运行中改由悬浮按钮的呼吸灯提醒「图里有内容」（见 agent-chat__right-reopen--pulse）。
    const attachments = pendingAttachments
    const disabledSkillIds = [...removedSkillIds]
    const disabledMcpIds = [...removedMcpIds]
    const disabledMcpToolIdsArr = [...disabledMcpToolIds]
    // 临时取消挂载的插件（P2 新增）：随本轮请求传给 Rust，从插件工具集中剔除
    const disabledPluginIdsArr = [...removedPluginIds]
    // `@` 提及 → 本轮临时启用：从 mentionTags 解析出技能 / MCP 服务 id（key 形如 skill:<id> / mcp:<id>）
    const enabledSkillIds = mentionTags
      .filter((t) => t.key.startsWith('skill:'))
      .map((t) => t.key.slice('skill:'.length))
    const enabledMcpIds = mentionTags
      .filter((t) => t.key.startsWith('mcp:'))
      .map((t) => t.key.slice('mcp:'.length))
    // 插件（P2 新增）：@提及 触发本轮临时启用（可含未绑定插件，Rust 侧受 10 个上限兜底）
    const enabledPluginIds = mentionTags
      .filter((t) => t.key.startsWith('plugin:'))
      .map((t) => t.key.slice('plugin:'.length))
    void ensureRound(text).then((sid) => {
      void run({
        agentId: agent.id,
        prompt: text,
        workspace: workspaceDir,
        attachments,
        // 修复：使用 ensureRound 返回的真实会话 id，避免闭包捕获到尚未更新的 stale activeSessionId（首条消息时为 null）
        sessionId: sid ?? undefined,
        roundId: roundIdRef.current ?? undefined,
        // 临时移除的技能 / MCP 服务 / MCP 工具：随本轮请求传给 Rust，从智能体工具集中剔除
        disabledSkillIds,
        disabledMcpIds,
        disabledMcpToolIds: disabledMcpToolIdsArr,
        disabledPluginIds: disabledPluginIdsArr,
        // `@` 提及触发：本轮临时启用未绑定（或重新启用已移除）的技能 / MCP 服务
        enabledSkillIds,
        enabledMcpIds,
        enabledPluginIds,
      })
    })
  }, [input, isRunning, agent, run, workspaceDir, pendingAttachments, ensureRound, removedSkillIds, removedMcpIds, disabledMcpToolIds, removedPluginIds, mentionTags])

  /** 重新生成：以上一轮 user 消息为 prompt 再跑一次，替换当前 agent 回复。 */
  const handleRegenerate = useCallback(
    (msgId: string) => {
      const idx = messages.findIndex((m) => m.id === msgId)
      if (idx <= 0 || !agent) return
      const userMsg = messages[idx - 1]
      if (userMsg.role !== 'user') return
      reset()
      setMessages((prev) => {
        const base = prev.slice(0, idx)
        return [
          ...base,
          {
            id: `a-${Date.now()}`,
            role: 'agent',
            content: '',
            createdAt: Date.now(),
          },
        ]
      })
      replyStartRef.current = Date.now()
      lastPromptRef.current = userMsg.content
      const disabledSkillIds = [...removedSkillIds]
      const disabledMcpIds = [...removedMcpIds]
      const disabledMcpToolIdsArr = [...disabledMcpToolIds]
      // 临时取消挂载的插件（P2 新增）：重生成时同样生效
      const disabledPluginIdsArr = [...removedPluginIds]
      // 修复（#20260915004 B3）：重新生成时 @@提及 文本已序列化进 userMsg.content，但 mentionTags 已清空。
      // 从内容反解出本轮临时启用的技能 / MCP，与 send 对齐，避免「重生成丢失 @提及」。
      const tags = resolveMentionTags(userMsg.content)
      const enabledSkillIds = tags.filter((t) => t.key.startsWith('skill:')).map((t) => t.key.slice('skill:'.length))
      const enabledMcpIds = tags.filter((t) => t.key.startsWith('mcp:')).map((t) => t.key.slice('mcp:'.length))
      const enabledPluginIds = tags.filter((t) => t.key.startsWith('plugin:')).map((t) => t.key.slice('plugin:'.length))
      setMentionTags(tags) // 回填 chips，UI 重显本次启用的 @提及
      void ensureRound(userMsg.content).then((sid) => {
        void run({
          agentId: agent.id,
          prompt: userMsg.content,
          workspace: workspaceDir,
          // 修复：使用 ensureRound 返回的真实会话 id
          sessionId: sid ?? undefined,
          roundId: roundIdRef.current ?? undefined,
          // 临时移除的技能 / MCP 服务 / MCP 工具在本轮同样生效
          disabledSkillIds,
          disabledMcpIds,
          disabledMcpToolIds: disabledMcpToolIdsArr,
          disabledPluginIds: disabledPluginIdsArr,
          // 临时启用的技能 / MCP 服务 / 插件（@提及 触发），与 send 完全对齐
          enabledSkillIds,
          enabledMcpIds,
          enabledPluginIds,
        })
      })
    },
    [messages, agent, reset, run, workspaceDir, ensureRound, removedSkillIds, removedMcpIds, disabledMcpToolIds, removedPluginIds, resolveMentionTags],
  )

  // 右键「从此步骤分支」→ 调 branch_from_step 命令，后端生成新分支并推 plan_branch 事件
  const handleBranchFromStep = useCallback(
    async (fromStep: number) => {
      if (!isTauri || !agent?.id) return
      // 构造原方案尾段（step > fromStep 的步骤），供后端对比展示
      const originalTail: BranchStep[] = planSteps
        .filter((s) => s.step > fromStep)
        .map((s) => ({
          step: s.step,
          taskId: s.taskId ?? '',
          title: s.title,
          description: s.description ?? '',
          dependsOn: s.dependsOn ?? [],
        }))
      const input: BranchFromStepInput = {
        agentId: agent.id,
        workspace: workspaceDir ?? null,
        fromStep,
        goalSummary: `从步骤 ${fromStep} 起重新规划后续步骤`,
        originalTail,
      }
      try {
        await invoke('branch_from_step', { input })
      } catch (e) {
        console.error('[agent] branch_from_step 失败：', e)
      }
    },
    [isTauri, agent?.id, workspaceDir, planSteps],
  )

  // 放弃分支对比
  const handleDismissBranch = useCallback(() => {
    // planBranch 由 session 状态机管理，前端无法直接清空；
    // 这里切回「图」Tab 视觉上隐藏对比横幅。后续可在 useAgentSession 加 dismissPlanBranch 方法。
    setRightTab('graph')
  }, [setRightTab])

  // 任务结束（完成/异常/取消）时，补全耗时、token 与历史持久化。
  // 【台账 S4 保留说明】终态「固化写回 messages」必须保留：displayMessages 派生只覆盖
  // 最后一条气泡，而下一轮 send → beginRun 会清空运行态——若此刻历史气泡仍是骨架
  // （content 空），上一轮正文会瞬间消失。固化后 messages 自含最终值，运行态清零不影响历史显示。
  useEffect(() => {
    if (prevIsRunningRef.current && !isRunning) {
      const completedAt = Date.now()
      const durationMs = replyStartRef.current ? completedAt - replyStartRef.current : undefined
      replyStartRef.current = null
      const answer = streamingText || lastAgentContent
      // 真实 token 用量：Tauri 路径下后端已在 run_task 中把本轮 LLM 真实 usage
      // （跨所有 ReAct 轮累计的 prompt+completion）写回会话表，并经 agent-task-done 事件带出；
      // 此处优先采用，避免前端「仅首尾文本」估算严重低估。dev/mock 无后端时回退估算。
      // 但若网关未在流中返回 usage（后端带回 0/0），则视为无效、回退估算，避免出现「消耗 0 tokens」。
      const rawUsage = isTauri ? lastTaskUsage.current : null
      const realUsage =
        rawUsage && (rawUsage.promptTokens > 0 || rawUsage.completionTokens > 0) ? rawUsage : null
      const inputTokens = realUsage ? realUsage.promptTokens : estimateTokens(lastPromptRef.current)
      const outputTokens = realUsage ? realUsage.completionTokens : estimateTokens(answer)
      lastTokensRef.current = { input: inputTokens, output: outputTokens }

      // 轮次定稿 / 会话状态 / 未命名会话改名的**落库已移到模块级 onRunTerminal**（terminal-bridge），
      // 与组件生命周期解耦：切页期间任务跑完也照常落库。此处不再重复写库，
      // 否则 addSessionTokens 会被调用两次导致 token 双倍累加。
      roundIdRef.current = null
      // 左侧列表刷新由模块级 handler 经 chatMod.refreshSessionsRef 回调完成（chat.tsx 注入），
      // 此处不直接调用，避免引用尚未声明的 refreshSessions。

      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'agent') {
          // K3-2 热修诊断：终态正文空屏定位（经 agent_get_run_logs 可回看）。
          const segTexts = (last.segments ?? []).filter((s) => s.kind === 'text')
          void fe.info(
            'chat',
            `终态诊断: content=${(last.content ?? '').length}字 segs=${(last.segments ?? []).length} text段=${segTexts.length} 最后text=${segTexts.length ? (segTexts[segTexts.length - 1].text ?? '').length : 0}字 kbSources=${last.kbSources?.length ?? 0} streamingText=${streamingText.length}`,
          )
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              content: answer,
              thought: thoughts,
              toolSteps,
              segments,
              kbSources,
              completedAt,
              durationMs,
              tokenCount: inputTokens + outputTokens,
            },
          ]
        }
        return prev
      })
    }
    prevIsRunningRef.current = isRunning
  }, [isRunning, streamingText, thoughts, toolSteps, segments, kbSources, lastAgentContent, isTauri, lastTaskUsage])

  return {
    send,
    handleRegenerate,
    handleApplyBranch,
    handleBranchFromStep,
    handleDismissBranch,
    roundIndexRef,
    // 事件级分叉（台账 D4 收官）：chat.tsx 的 handleForkFromEvent 复用轮次落库与 run 通路
    ensureRound,
    roundIdRef,
  }
}
