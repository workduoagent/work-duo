/**
 * 对话页模块级桥接（台账 S1：自 chat.tsx 顶部原样迁出，逻辑零改动）。
 *
 * 三类「与组件生命周期解耦」的模块级设施：
 *  - chatMod：globalThis 跨 HMR 存活的模块级状态与注入回调槽位（台账 S5 纪律）；
 *  - 终态落库 handler（setTerminalHandler，即 onRunTerminal）：轮次定稿 / 会话状态 /
 *    未命名会话改名 / 完成通知——页面切走或卸载后任务跑完仍照常执行；
 *  - HITL 挂起提醒 handler（setPendingNotifyHandler）。
 * 本文件在 chat.tsx import 时即完成 handler 注册（key 与迁出前一致）。
 */
import { appDataDir, resourceDir } from '@tauri-apps/api/path'
import { Button } from '@/components/ui'
import { getNotifyApi } from '@/components/ui/notifyBridge'
import { notifyOSWhenHidden } from '@/utils/osNotify'
import { getRawConfig } from '@/core/mapper/config-mapper'
import {
  addSessionTokens,
  getSession,
  renameSession,
  updateRound,
  updateSession,
} from '@/core/mapper/agent-session-mapper'
import {
  getRunMeta,
  setPendingNotifyHandler,
  setTerminalHandler,
  type PendingNotifyInfo,
  type RunTerminalInfo,
} from '../session/runtimeStore'
import { isTauri } from '@/core/config'
import type { AgentInfo, AgentConversationSession } from '@/types/core'
import { estimateTokens } from './file-helpers'
import type { SuggestItem } from './types'

/** 解析 app_config.workspace_path（$APPDATA/$RESOURCE 占位）为真实目录，并追加智能体子目录。 */
export async function resolveWorkspaceDir(agent: AgentInfo): Promise<string | null> {
  if (!isTauri) return null
  const raw = (await getRawConfig('workspace_path')) ?? '$APPDATA/.workspace'
  // 去引号兜底：历史库可能把 value 存成了带双引号的形式。
  const cleaned = raw.replace(/^"+/, '').replace(/"+$/, '').trim()
  let base = cleaned
  if (base.includes('$APPDATA')) base = base.replace('$APPDATA', await appDataDir())
  if (base.includes('$RESOURCE')) base = base.replace('$RESOURCE', await resourceDir())
  return `${base}/${agent.identifier}`
}

// 台账 S5：对话页模块级可变状态挂 globalThis（跨 HMR 存活）——否则热更后 Map/ref 重建，
// 「最后查看会话」映射与注入回调丢失（恢复逻辑、通知判定失效一整轮直到下次刷新）。
interface ChatModuleState {
  refreshSessionsRef: (() => void) | null
  lastSessionByAgent: Map<string, string>
  chatViewSessionRef: string | null
  sessionsSnapshot: AgentConversationSession[]
  openSessionRef: ((sid: string, agentId: string) => boolean) | null
}
export const chatMod = ((globalThis as { __wdChatModule?: ChatModuleState }).__wdChatModule ??= {
  refreshSessionsRef: null,
  lastSessionByAgent: new Map(),
  chatViewSessionRef: null,
  sessionsSnapshot: [],
  openSessionRef: null,
})

/**
 * 按智能体记住「最后查看的会话 id」。
 * 对话页随路由切换会卸载，`activeSessionId` 是组件 state 会一起丢；但运行态已存在
 * 模块级 store（按会话 id 隔离）。重挂时用它把会话 id 找回来绑定，运行态即可 1:1 还原
 * ——需求②「切到任何页面再回来，没跑完的任务要恢复成正在进行的界面」。
 */
export const SLASH_COMMANDS: SuggestItem[] = [
  { key: 'cmd:new', token: '/new', label: '新建会话', sub: '开启一个全新对话', group: '指令' },
  { key: 'cmd:clear', token: '/clear', label: '清空对话', sub: '清除当前全部消息', group: '指令' },
  { key: 'cmd:reset', token: '/reset', label: '重置运行态', sub: '中断并复位智能体运行态', group: '指令' },
  { key: 'cmd:help', token: '/help', label: '使用帮助', sub: '查看 @提及 与 /指令 说明', group: '指令' },
]

export const lastSessionByAgent = chatMod.lastSessionByAgent

/**
 * 对话页当前正在查看的会话 id（对话页卸载时为 null）。
 * 终态到达时若「正在查看的不是该会话」（切到别的页面 / 在看别的会话），就弹通知提醒。
 */
/** 以下字段的存取统一走 chatMod.*（globalThis 跨 HMR 存活）。 */

/** 从任意页面跳回某个会话的对话页：已在该智能体对话页则直接切会话，否则走路由。 */
function jumpToSession(agentId: string | null, sessionId: string) {
  if (!agentId) return
  lastSessionByAgent.set(agentId, sessionId)
  if (chatMod.openSessionRef?.(sessionId, agentId)) return
  window.location.hash = `#/agent-studio/${agentId}/chat`
}

/**
 * 终态落库（**模块级注册**，与组件生命周期解耦）：
 * 此前轮次定稿 / 会话状态 / 未命名会话改名全挂在对话页的 useEffect 上，页面一切走
 * 该 useEffect 就永不触发 →「跑完仍叫未命名会话」「历史会话被错排到首位」。
 * 现在由全局事件桥在收到终态事件时直接落库，即便对话页已切走或卸载也照常执行。
 */
setTerminalHandler('chat-terminal', (info: RunTerminalInfo) => {
  void (async () => {
    const { sessionId, roundId, lastPrompt, runtime, ok } = info
    try {
      const answer = runtime.streamingText
      const raw = info.usage
      const validUsage = raw && (raw.promptTokens > 0 || raw.completionTokens > 0) ? raw : null
      const inputTokens = validUsage ? raw!.promptTokens : estimateTokens(lastPrompt)
      const outputTokens = validUsage ? raw!.completionTokens : estimateTokens(answer)
      if (roundId) {
        await updateRound(roundId, {
          assistantAnswer: answer,
          thinkingContent: runtime.thoughts.join('\n'),
          toolCallsSummary: runtime.toolSteps.map((s) => ({
            name: s.toolName,
            status: s.status,
            args: s.args,
            result: s.result,
            step: s.step,
          })),
          planStepsSummary: runtime.planSteps.map((s) => ({
            step: s.step,
            title: s.title,
            status: s.status,
            summary: s.summary,
          })),
          // 交错时间线持久化（v26）；引用来源追加为 kb-sources 段。
          segments:
            runtime.kbSources.length > 0
              ? [...runtime.segments, { kind: 'kb-sources' as const, hits: runtime.kbSources }]
              : runtime.segments,
          inputTokens,
          outputTokens,
          endTime: Date.now(),
        })
      }
      await updateSession(sessionId, { status: ok ? 'COMPLETED' : 'ERROR', endTime: Date.now() })
      // Tauri 路径后端已累计真实 usage；无 usage 时用本地估算兜底，避免出现「消耗 0 tokens」。
      if (!validUsage) await addSessionTokens(sessionId, inputTokens, outputTokens)
      // 未命名会话兜底改名（正常发问时已改名，这里防其它途径遗漏）。
      const fresh = await getSession(sessionId)
      const name = (fresh?.sessionName ?? '').trim()
      if ((!name || name === '未命名会话') && lastPrompt) {
        await renameSession(sessionId, lastPrompt.trim().slice(0, 40))
      }
      chatMod.refreshSessionsRef?.()

      // 用户此刻没在看这个会话（切到别的页面 / 在看别的会话）→ 弹提醒，并可一键跳回。
      if (chatMod.chatViewSessionRef !== sessionId) {
        // 紧凑提示（对齐 WorkBuddy 风格）：只给「任务已完成 + 会话名」，不铺正文摘要，
        // 通知高度压到最小；详细内容回到会话里看。
        const finalName = name || lastPrompt.trim().slice(0, 40) || '未命名会话'
        const brief = finalName.length > 24 ? `${finalName.slice(0, 24)}…` : finalName
        const api = getNotifyApi()
        const cfg = {
          message: ok ? '任务已完成' : '任务异常结束',
          description: brief,
          placement: 'bottomRight' as const,
          duration: 0, // 不自动消失，手动关闭（用户要求）
          className: 'agent-task-notify',
          btn: (
            <Button size="sm" onClick={() => jumpToSession(info.agentId, sessionId)}>
              查看
            </Button>
          ),
        }
        if (ok) api?.notification?.success(cfg)
        else api?.notification?.error(cfg)
        // 窗口不在最前时再补一条系统原生通知（聚焦时该函数内部会静默跳过）。
        void notifyOSWhenHidden(ok ? '任务已完成' : '任务异常结束', finalName)
      }
    } catch (e) {
      console.error('[chat] 终态落库失败', e)
    }
  })()
})

/**
 * HITL 挂起提醒（授权 / 计划审批 / 方案选择 / 步骤恢复）：
 * 这些是**阻塞态**——任务暂停等人操作，人不在对话页时任务就默默卡死，必须提醒到位。
 * 通知用固定 key（`pending-<sessionId>`）：同类重推时 antd 会原地替换而不是叠加；
 * 用户点开该会话或提交决策后由组件侧关闭（见 chat.tsx 相关 effect）。
 */
setPendingNotifyHandler('chat-pending-notify', (info: PendingNotifyInfo) => {
  console.info('[chat] pending notify handler', { sessionId: info.sessionId, kind: info.kind, viewing: chatMod.chatViewSessionRef })
  if (chatMod.chatViewSessionRef === info.sessionId) return // 正在看该会话，界面里已有决策面板，不打扰
  const api = getNotifyApi()
  if (!api) return
  // 会话名：优先从当前列表拿，拿不到就用运行元信息里的首问
  const meta = getRunMeta(info.sessionId)
  const sess = chatMod.sessionsSnapshot.find((s) => s.id === info.sessionId)
  const rawName = sess?.sessionName || meta.lastPrompt || '未命名会话'
  const brief = rawName.length > 24 ? `${rawName.slice(0, 24)}…` : rawName
  api.notification.warning({
    key: `pending-${info.sessionId}`, // 固定 key：同类重推原地替换，不叠加
    message: `任务暂停：${info.kind}`,
    description: brief,
    placement: 'bottomRight',
    duration: 0, // 挂起未处理前不自动消失（手动关闭 / 处理后自动收起）
    className: 'agent-task-notify',
    btn: (
      <Button size="sm" onClick={() => jumpToSession(info.agentId, info.sessionId)}>
        去处理
      </Button>
    ),
  })
  void notifyOSWhenHidden(`任务暂停：${info.kind}`, rawName)
})
