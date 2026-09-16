/**
 * 会话数据转换纯函数（#20260915005 Step 6 自 chat.tsx 原样抽出）。
 *
 * 搬运原则（docs/chat-split-plan.md）：实现、注释一律原样，仅加 export；
 * 零 React 依赖（纯数据转换），渲染层零改动。
 */
import type { ChatAttachmentInput, PlanStep, ToolStep } from '../session/types'
import type { AgentConversationRound, AgentConversationSession, AgentProject } from '@/types/core'
import type { SessionTreeGroup } from '@/core/mapper/agent-session-mapper'
import type { ChatMessage } from './types'
import { estimateTokens } from './file-helpers'

/** 把历史轮次转为消息流（用于点击左侧会话加载）。 */
/** 从历史落库的 raw_messages_json 提取用户消息的多模态图片，重建气泡附件卡片（跨会话恢复）。
 * 仅取最后一条 user 消息的 image_url parts（dataUrl）；JSON 损坏 / 非多模态安全返回 undefined。 */
function extractHistoryAttachments(raw: string | undefined): ChatAttachmentInput[] | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const userMsg = [...parsed]
    .reverse()
    .find((m) => !!m && typeof m === 'object' && (m as Record<string, unknown>).role === 'user') as
    | Record<string, unknown>
    | undefined
  if (!userMsg) return undefined
  const content = userMsg.content
  let parts: unknown[] = []
  if (Array.isArray(content)) {
    parts = content
  } else if (content && typeof content === 'object' && Array.isArray((content as Record<string, unknown>).content)) {
    parts = (content as Record<string, unknown>).content as unknown[]
  } else {
    return undefined
  }
  const imgs: ChatAttachmentInput[] = []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    const imgUrl = (p as Record<string, unknown>).image_url
    const dataUrl = imgUrl && typeof imgUrl === 'object' ? (imgUrl as Record<string, unknown>).url : undefined
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
      imgs.push({ type: 'image', dataUrl })
    }
  }
  return imgs.length ? imgs : undefined
}

export function roundsToMessages(rounds: AgentConversationRound[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const r of rounds) {
    if (r.userQuestion) {
      msgs.push({
        id: `u-${r.id}`,
        role: 'user',
        content: r.userQuestion,
        createdAt: r.startTime ?? Date.now(),
        attachments: extractHistoryAttachments(r.rawMessagesJson),
      })
    }
    // 工具调用汇总 → ToolStep 卡片（历史回显时思考面板可完整还原工具调用过程）。
    // 存储格式来自任务结束时的 updateRound：[{ name, status, args, result, step? }]。
    const toolSteps: ToolStep[] | undefined = Array.isArray(r.toolCallsSummary)
      ? r.toolCallsSummary.map((t, i) => {
          const name = typeof t.name === 'string' ? t.name : ''
          const status = t.status === 'failed' ? 'failed' : 'success'
          return {
            callId: `hist-${r.id}-${i}`,
            toolName: name,
            toolLabel: name.split('__').pop() || name,
            status,
            args: typeof t.args === 'string' ? t.args : undefined,
            result: typeof t.result === 'string' ? t.result : undefined,
            sensitive: false,
            createdAt: r.startTime ?? Date.now(),
            step: typeof t.step === 'number' ? t.step : undefined,
          }
        })
      : undefined
    // 规划步骤结构 → PlanStep[]（与 toolCallsSummary 对称落库；历史回显时重建「步骤 → 工具」嵌套视图）。
    // 存储格式来自任务结束时的 updateRound：[{ step, title, status, summary? }]。
    const planSteps: PlanStep[] | undefined = Array.isArray(r.planStepsSummary)
      ? r.planStepsSummary.reduce<PlanStep[]>((acc, p) => {
          const step = typeof p.step === 'number' ? p.step : Number(p.step)
          if (!Number.isFinite(step)) return acc
          const status = p.status as PlanStep['status'] | undefined
          acc.push({
            step,
            title: typeof p.title === 'string' ? p.title : `步骤 ${step}`,
            status: status ?? 'success',
            summary: typeof p.summary === 'string' ? p.summary : undefined,
          })
          return acc
        }, [])
      : undefined
    msgs.push({
      id: `a-${r.id}`,
      role: 'agent',
      content: r.assistantAnswer ?? '',
      createdAt: r.endTime ?? Date.now(),
      thought: r.thinkingContent ? r.thinkingContent.split('\n') : undefined,
      toolSteps: toolSteps?.length ? toolSteps : undefined,
      planSteps: planSteps?.length ? planSteps : undefined,
      completedAt: r.endTime,
      durationMs: r.startTime && r.endTime ? r.endTime - r.startTime : undefined,
      tokenCount: (r.inputTokens ?? 0) + (r.outputTokens ?? 0) || estimateTokens(r.assistantAnswer ?? ''),
    })
  }
  return msgs
}

/** 从扁平会话列表 + 工程列表构建树状分组（GLOBAL + 各 PROJECT）。 */
export function buildSessionTree(
  list: AgentConversationSession[],
  projects: AgentProject[],
): SessionTreeGroup[] {
  const toItem = (s: AgentConversationSession) => ({
    id: s.id,
    sessionName: s.sessionName,
    totalTurns: s.totalTurns ?? 0,
    updatedAt: Date.parse(s.updatedAt) || 0,
    isTop: s.isTop,
    isArchived: s.isArchive,
    projectId: s.projectId,
  })
  const global = list
    .filter((s) => !s.projectId)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .map(toItem)
  const groups: SessionTreeGroup[] = [
    {
      groupType: 'GLOBAL',
      groupId: 'GLOBAL',
      projectName: '自由会话',
      rootPath: null,
      sessions: global,
    },
  ]
  const byProject = new Map<string, AgentConversationSession[]>()
  for (const s of list) {
    if (!s.projectId) continue
    const arr = byProject.get(s.projectId) ?? []
    arr.push(s)
    byProject.set(s.projectId, arr)
  }
  for (const [pid, arr] of byProject) {
    arr.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    const p = projects.find((x) => x.id === pid)
    groups.push({
      groupType: 'PROJECT',
      groupId: pid,
      projectName: p?.name ?? '未命名工程',
      rootPath: p?.rootPath ?? null,
      isPinned: p?.isPinned,
      isArchived: p?.isArchived,
      sessions: arr.map(toItem),
    })
  }
  return groups
}
