/**
 * 智能体「进入」页（路由 /agent-studio/:id/chat）。
 *
 * 设计：仿 WorkBuddy 对话页的「左侧会话列表 + 中间会话流 + 底部输入工具条」三段式。
 * 本页是智能体的**运行/会话入口**（原「调试」语义升级为「进入」），与新建/编辑向导同级。
 *
 * 运行链路：
 *  - Tauri 环境：发送消息调用 Rust `run_agent_task` 命令，前端经 `useAgentSession`
 *    监听 `agent-event` / `agent-awaiting-approval` 等事件流渲染工具步骤与流式回复；
 *    敏感工具触发审批时，在右下角弹出授权通知（ApprovalNotify），决策经 `submit_approval_decision` 回传。
 *  - 非 Tauri 环境：无原生后端，`useAgentSession` 回退到 mock 流，便于浏览器 dev 演示 UI。
 *
 * 持久化（来自_site = 'DEBUG_CHAT'）：
 *  - 每次进入自动归属于某个会话（agent_conversation_session），首条提问回填为会话名；
 *  - 每一轮用户提问落一条 agent_conversation_round，回复完成后回填思考/答案/token/耗时；
 *  - 左侧会话列表点击历史，加载该会话的全部轮次渲染为消息流。
 *
 * 工作空间：
 *  - 单个智能体调试页**不提供自定义工作空间选择**，默认解析为
 *    resolveAppData(app_config.workspace_path) + '/' + agent.identifier，
 *    该路径作为 workspace 传给 run_agent_task（不再传 null），不在输入区展示。
 *
 * 多模态 / 语音：
 *  - 若绑定 LLM 的 category === 'multimodal'，底部允许图片粘贴与上传；
 *  - 若绑定了 STT 模型（agent.sttId），底部出现语音输入按钮（Web Speech API）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Pencil,
  Send,
  Bot,
  Loader2,
  Box,
  Trash2,
  Square,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Coins,
  Clock,
  Mic,
  ImagePlus,
  Search,
  Plus,
  MessageSquare,
  Star,
  Folder,
  GitBranch,
  Workflow,
  MoreVertical,
  Archive,
  MessageSquarePlus,
  Pin,
  PinOff,
  ArchiveRestore,
  FilePen,
  FileText,
  Paperclip,
  TriangleAlert,
  RefreshCw,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { appDataDir, resourceDir } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { Button, Modal, Input } from '@/components/ui'
import { getNotifyApi } from '@/components/ui/notifyBridge'
import { notifyOSWhenHidden } from '@/utils/osNotify'
import { stripWinVerbatim, stripWinVerbatimInText } from '@/utils/pathDisplay'
import { useNotify } from '@/components/ui/notify'

import { getAgent, listAgentMcpTools, listAgentSkills } from '@/core/mapper/agent-mapper'
import { listSkills } from '@/core/mapper/skill-mapper'
import { listPlugins } from '@/core/mapper/plugin-mapper'
import { listAgentPlugins } from '@/core/mapper/plugin-mapper'
import type { UserPluginTool } from '@/core/file/plugin-file'
import { listMcps, listMcpTools } from '@/core/mapper/mcp-mapper'
import { getModel } from '@/core/mapper/model-mapper'
import { getRawConfig } from '@/core/mapper/config-mapper'
import {
  createSession,
  listSessions,
  updateSession,
  getSession,
  deleteSession,
  appendRound,
  listRounds,
  updateRound,
  addSessionTokens,
  renameSession,
  setSessionArchived,
  clearSessionProject,
  toggleSessionTop,
  type SessionTreeGroup,
} from '@/core/mapper/agent-session-mapper'
import {
  isSessionRunning,
  isAgentRunning,
  setTerminalHandler,
  setPendingNotifyHandler,
  getRunMeta,
  type RunTerminalInfo,
  type PendingNotifyInfo,
} from './session/runtimeStore'
import {
  listProjects,
  getProject,
  ensureProjectByPath,
  updateProject,
  deleteProject,
} from '@/core/mapper/agent-project-mapper'
import { readProjectMemory, writeProjectMemory } from '@/core/mapper/wd-mem-mapper'
import { agentEditPath } from '@/core/router/paths'
import { isTauri } from '@/core/config'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { useAgentSession } from './session/useAgentSession'
import { TracePanel } from './session/TracePanel'
import { RunDagCanvas } from './session/RunDagCanvas'
import { ToolStepLine } from './session/ToolStepLine'
import { KbSourceList, KbCiteMark, type KbHit } from './session/KbSearchCitations'
import { makeRemarkKbCites } from './session/remarkKbCites'
import { fe } from '@/core/logBridge'
import { DecisionCenter } from './session/DecisionCenter'
import { TakeoverPanel } from './session/TakeoverPanel'
import type { ReadArtifactResult, BranchFromStepInput, BranchStep, PlanDAG, ContextCompactedPayload, ToolStep } from './session/types'
import type {
  AgentInfo,
  AgentConversationSession,
  AgentProject,
} from '@/types/core'
import type { SkillInfo } from '@/core/file/skill-file'
import type { McpToolDefinition } from '@/core/file/mcp-file'
import type {
  BoundMcpServer,
  ChatMessage,
  ChatSegment,
  PendingAttachment,
  SpeechLike,
  SuggestItem,
  SuggestState,
} from './chat/types'
import { ArtifactGallery } from './chat/artifact-ui'
import {
  fileExtIcon,
  FilePathCards,
  LiveTokenCounter,
  MessageActions,
  ThoughtPanel,
  TokenRing,
  useTypewriter,
} from './chat/message-ui'
import {
  DropdownMenu,
  McpPill,
  PluginPill,
  SkillChip,
  WorkspaceChip,
} from './chat/mention-ui'
import { buildSessionTree, roundsToMessages } from './chat/session-helpers'
import {
  attId,
  AVG_TOOL_TOKENS,
  estimateTokens,
  formatConversationDuration,
  formatDuration,
  formatSize,
  formatTime,
  isTextType,
  MAX_FILE,
  MAX_INLINE_IMAGE,
  readFileAsDataURL,
  readFileAsText,
  TEXT_INLINE_LIMIT,
  textPreview,
} from './chat/file-helpers'
import './chat.scss'

/** 解析 app_config.workspace_path（$APPDATA/$RESOURCE 占位）为真实目录，并追加智能体子目录。 */
async function resolveWorkspaceDir(agent: AgentInfo): Promise<string | null> {
  if (!isTauri) return null
  const raw = (await getRawConfig('workspace_path')) ?? '$APPDATA/.workspace'
  // 去引号兜底：历史库可能把 value 存成了带双引号的形式。
  const cleaned = raw.replace(/^"+/, '').replace(/"+$/, '').trim()
  let base = cleaned
  if (base.includes('$APPDATA')) base = base.replace('$APPDATA', await appDataDir())
  if (base.includes('$RESOURCE')) base = base.replace('$RESOURCE', await resourceDir())
  return `${base}/${agent.identifier}`
}

/** K3-2 引用感知正文渲染：消息带 kbSources 时启用内联引标 remark 插件——正文中的 `[N]`
 *  渲染为可悬浮溯源的引标（hover 展示召回片段内容）；无引用数据时与普通 MarkdownRenderer 等价。 */
function CiteAwareMarkdown({ text, kbSources }: { text?: string; kbSources?: KbHit[] }) {
  const remarkExt = useMemo(() => (kbSources?.length ? [makeRemarkKbCites(kbSources)] : undefined), [kbSources])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compsExt = useMemo(
    () =>
      kbSources?.length
        ? {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            'kb-cite': (p: any) => <KbCiteMark cite={p?.cite} hits={kbSources} />,
          }
        : undefined,
    [kbSources],
  )
  // 展示净化：去掉 Rust canonicalize 带来的 Windows 逐字前缀 `\\?\`
  // （模型会把工具返回的路径原样写进正文，不处理就显示成 `\\?\E:\xxx`）。
  return (
    <MarkdownRenderer
      content={stripWinVerbatimInText(text ?? '')}
      remarkPluginsExt={remarkExt}
      componentsExt={compsExt}
    />
  )
}

/** 运行中正文段打字机（用户反馈：流式 chunk 整段刷出=「一句句往外刷」）：
 *  复用 useTypewriter 常速逐字（30ms/字≈33 字/秒，肉眼单字节奏；积压 >200 字按比例
 *  加速追赶防永久滞后）。仅最后一段 active 参与打字；非激活段直接全文渲染
 *  （绕过 hook 首帧空闪）。任务结束切非激活 → 终态一次性全文（既有约定）。 */
function TypewriterMarkdownInner({ text, kbSources }: { text?: string; kbSources?: KbHit[] }) {
  const shown = useTypewriter(text ?? '', true, 30)
  return <CiteAwareMarkdown text={shown} kbSources={kbSources} />
}

function TypewriterMarkdown({
  text,
  active,
  kbSources,
}: {
  text?: string
  active?: boolean
  kbSources?: KbHit[]
}) {
  if (!active) return <CiteAwareMarkdown text={text} kbSources={kbSources} />
  return <TypewriterMarkdownInner text={text} kbSources={kbSources} />
}

/* ------------------------------------------------------------------ *
 * 对话中的文件路径卡片：自动识别 Agent 回复里的文件路径，以内联卡片展示。
 * ---------------------------------------------------------------- */

/** 折叠的「思考与执行过程」块（2026-09-18 体验重构）：
 * 任务结束后，思考旁白、中间叙述文本与全部工具行**按真实时序**收进此处（默认收起），
 * 气泡正文只保留最终交付内容（最后一段模型文本），对话流恢复「一句问答一段回复」的干净形态。
 * thought 段渲染为「- 文本」小行，与工具块穿插（用户期望形式）。 */
function ProcessCollapse({
  items,
  toolById,
  psOf,
}: {
  items: ChatSegment[]
  toolById: Map<string, ToolStep>
  psOf: (t?: ToolStep) => { verified?: boolean; evidence?: string } | undefined
}) {
  const [open, setOpen] = useState(false)
  const toolCount = items.filter((s) => s.kind === 'tool').length
  return (
    <div className="agent-chat__proc">
      <button type="button" className="agent-chat__proc-head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>思考与执行过程</span>
        {toolCount > 0 && <span className="agent-chat__proc-n">{toolCount} 次工具调用</span>}
      </button>
      {open && (
        <div className="agent-chat__proc-body">
          {items.map((s, i) =>
            s.kind === 'text' ? (
              <div key={i} className="agent-chat__seg-text">
                <MarkdownRenderer content={stripWinVerbatimInText(s.text ?? '')} />
              </div>
            ) : s.kind === 'thought' ? (
              <div key={i} className="agent-chat__seg-thought">
                - {s.text}
              </div>
            ) : (
              (() => {
                const t = toolById.get(s.callId ?? '')
                if (!t) return null
                const ps = psOf(t)
                return (
                  <ToolStepLine
                    key={`${s.callId}-${i}`}
                    step={t}
                    verified={ps?.verified}
                    evidence={ps?.evidence}
                  />
                )
              })()
            ),
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 运行中的思考段（#20260918011 工作空间模式打字机）：
 * 时间线此前把 thought 段当静态文本渲染（旁白/推理整段蹦出）。这里复用现成 useTypewriter
 * 逐字流出——段内文本增量续写时打字机继续推进，已打完的段自然静止（不回退、不重打）。
 */
function ThoughtSegmentLine({ text, active = false }: { text?: string; active?: boolean }) {
  const full = text ?? ''
  // 30ms/字（≈33 字/秒）：8ms 对十几字旁白仅 ~150ms 一闪而过，肉眼感知不到打字机（真机反馈）；
  // 30ms 时一行旁白约 0.6s、一段推理 1.5~3s，节奏清晰可读。
  const shown = useTypewriter(full, active, 30)
  return (
    <div className="agent-chat__seg-thought">
      - {active ? shown : full}
      {active && shown.length < full.length && <span className="agent-chat__type-caret" />}
    </div>
  )
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
const chatMod = ((globalThis as { __wdChatModule?: ChatModuleState }).__wdChatModule ??= {
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
const lastSessionByAgent = chatMod.lastSessionByAgent

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
 * 用户点开该会话或提交决策后由组件侧关闭（见下方 effect）。
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

export default function AgentChatPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message, modal } = useNotify()

  // 当前会话 id 必须先于状态机声明：状态机按会话 id 绑定该会话自己的运行态（TDZ）。
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  // 会话状态机（必须早于任何引用 session.* 的回调/依赖数组，否则 TDZ）。
  const session = useAgentSession(activeSessionId)
  const { toolSteps, segments, lastLlmUsage, streamingText, isStreaming, statusText, thoughts, planSteps, isRunning, pendingApproval, run, submitDecision, reset, cancel, lastTaskUsage, liveTokenUsage, taskError, artifacts, recovery, resolveRecovery, pendingChoice, submitChoice, planApproval, resolvePlanApproval, kbSources } =
    session

  const [agent, setAgent] = useState<AgentInfo | undefined>()
  // 本智能体是否有任务在跑（含当前查看会话）。切到历史会话时输入框 / 发送按钮仍应保持
  // 「任务进行中」的禁用态——否则按钮会被解锁，点下去要被后端「已有任务正在运行」闸门锁掉。
  const agentBusy = isRunning || isAgentRunning(agent?.id)
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  // 输入框高度（px）：默认 48，用户可从顶部拖拽手柄向上扩展，发送后复位。
  const [inputHeight, setInputHeight] = useState(48)
  const [toolCount, setToolCount] = useState(0)
  const [skillCount, setSkillCount] = useState(0)

  // 能力：多模态 / STT
  const [isMultimodal, setIsMultimodal] = useState(false)
  const [hasStt, setHasStt] = useState(false)

  // 底部工具条展示用：MCP 服务（含其工具）/ 技能 / 工作空间
  const [boundMcps, setBoundMcps] = useState<BoundMcpServer[]>([])
  // 当前会话内临时移除的 MCP 服务 id（内存态，不写库；切换/重开会话即复位）
  const [removedMcpIds, setRemovedMcpIds] = useState<Set<string>>(new Set())
  // 当前会话内临时关闭的单个 MCP 工具 id（内存态，不写库）。键为 mcp_tool_definition.id
  const [disabledMcpToolIds, setDisabledMcpToolIds] = useState<Set<string>>(new Set())
  const [boundSkills, setBoundSkills] = useState<SkillInfo[]>([])
  // 底部工具条展示用：已挂载的本地插件（P2 新增）
  const [boundPlugins, setBoundPlugins] = useState<UserPluginTool[]>([])
  /** 临时取消/恢复挂载某个插件（仅当前会话，不写库；随 disabled_plugin_ids 生效）。 */
  const togglePlugin = useCallback((pluginId: string) => {
    setRemovedPluginIds((prev) => {
      const next = new Set(prev)
      if (next.has(pluginId)) next.delete(pluginId)
      else next.add(pluginId)
      return next
    })
  }, [])
  // @提及 候选全集（全量技能 / MCP 服务，不限于本智能体绑定），供输入框随时引用
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])
  const [allMcps, setAllMcps] = useState<Awaited<ReturnType<typeof listMcps>>>([])
  // 全量插件缓存（P2 新增）：供输入框 @提及 候选（不局限于本智能体绑定项）
  const [allPlugins, setAllPlugins] = useState<Awaited<ReturnType<typeof listPlugins>>>([])
  // 输入框 @提及 / /指令 浮层状态
  const [suggest, setSuggest] = useState<SuggestState | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  // @提及 选中的标签（chip）：独立维护，发送时序列化为「@标签」前缀，从文本框剥离避免歧义
  // token = 序列化进 prompt 的稳定标识（优先 skill.identifier，绝不依赖 name 判断）；label = 展示用人类可读名
  const [mentionTags, setMentionTags] = useState<{ key: string; label: string; token: string }[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 当前会话内临时移除的技能 id（内存态，不写库；页面重进/切换智能体即复位）
  const [removedSkillIds, setRemovedSkillIds] = useState<Set<string>>(new Set())
  // 临时取消挂载的插件 id（P2 新增，仅当前会话有效，不写库）：随本轮请求走 disabled_plugin_ids
  const [removedPluginIds, setRemovedPluginIds] = useState<Set<string>>(new Set())
  // 工作空间：默认解析路径（单人调试）+ 当前会话绑定的工程（智能工作空间绑定）。
  // pendingProjectId 非空时，workspaceDir 取该工程 root_path；否则取默认解析路径。
  // 注意：projects 必须声明在 workspaceDir 之前（useMemo 依赖引用，避免 TDZ 编译报错）。
  const [projects, setProjects] = useState<AgentProject[]>([])
  const [defaultWorkspaceDir, setDefaultWorkspaceDir] = useState<string | null>(null)
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null)
  const workspaceDir = useMemo(() => {
    if (pendingProjectId) {
      const p = projects.find((x) => x.id === pendingProjectId)
      if (p) return p.rootPath
    }
    return defaultWorkspaceDir
  }, [pendingProjectId, projects, defaultWorkspaceDir])
  // 绑定 LLM 的上下文窗口（token），用于环形图占比分母
  const [contextLength, setContextLength] = useState<number | undefined>()

  // 会话列表 + 工程列表 + 当前会话
  const [sessions, setSessions] = useState<AgentConversationSession[]>([])
  // （activeSessionId 已在状态机之前声明，此处不再重复）
  const [sessionSearch, setSessionSearch] = useState('')
  // 归档项默认收起；开启后已归档会话 / 工程重新出现在列表（#20260915004 B2）。
  const [showArchived, setShowArchived] = useState(false)

  // 工程记忆编辑器（.wd_mem/MEMORY.md）
  const [memoEditor, setMemoEditor] = useState<{ open: boolean; rootPath: string; name: string } | null>(null)
  const [memoContent, setMemoContent] = useState('')
  const [memoSaving, setMemoSaving] = useState(false)

  // 重命名弹窗（替代 window.prompt，避免 Tauri 拦截 dialog 插件）
  const [renameTarget, setRenameTarget] = useState<{ kind: 'session' | 'project'; id: string; current: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 多模态图片附件
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  // 整窗拖拽吸附：dragDepth 计数嵌套 enter/leave，windowDrag 控制全窗遮罩。
  const [windowDrag, setWindowDrag] = useState(false)
  const dragDepth = useRef(0)
  // 右侧投影面板（图 / 过程 / 产物）：二期方案 C Graph-first，默认关闭、发消息自动展开「图」。
  // 接管不再常驻 Tab，改为 recovery 非空时右栏底部情境升起。
  const [rightOpen, setRightOpen] = useState(false)
  const [rightTab, setRightTab] = useState<'graph' | 'process' | 'artifacts' | 'actions'>('graph')
  // 右栏宽度（可鼠标拖拽调节）：悬浮面板宽度。上限动态 clamp（窗口宽 - 左侧栏 - 主区最小 420px），
  // 窄窗口自动收窄，避免悬浮面板盖满对话区。
  const [rightWidth, setRightWidth] = useState(() => {
    const max = Math.max(340, Math.min(680, window.innerWidth - 220 - 420))
    return Math.min(680, max)
  })
  // 窗口尺寸变化时 clamp 右栏宽度（悬浮面板不再参与 flex 分配，需自行约束）
  useEffect(() => {
    const onResize = () => {
      const max = Math.max(340, Math.min(680, window.innerWidth - 220 - 420))
      setRightWidth((w) => Math.min(w, max))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // 会话分组折叠态（自由会话 / 各工程分组）：仅会话内 UI 态，不持久化
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const toggleGroupFold = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  // 复制单条消息的完整记录（2026-09-18 用户指定位置：气泡底部动作栏）：
  // 正文 + 思考旁白与工具调用**按真实时序穿插**（thought 段「- 文本」+ 工具块），Markdown 格式。
  const copyMessageRecord = useCallback((m: ChatMessage) => {
    const toolById = new Map<string, ToolStep>((m.toolSteps ?? []).map((t) => [t.callId ?? '', t]))
    let body = ''
    if (m.segments?.length) {
      for (const s of m.segments) {
        if (s.kind === 'text') {
          body += `${s.text ?? ''}\n\n`
        } else if (s.kind === 'thought') {
          body += `- ${s.text ?? ''}\n\n`
        } else {
          const t = toolById.get(s.callId ?? '')
          if (t) {
            body += `> **工具** ${t.toolLabel || t.toolName}（${t.status}）\n> 参数：${(t.args ?? '').replace(/\n/g, ' ').slice(0, 300)}\n> 结果：${(t.result ?? '').replace(/\n/g, ' ').slice(0, 300)}\n\n`
          }
        }
      }
    } else {
      body = `${m.content}\n\n`
    }
    if (!m.segments?.length && m.thought?.length) {
      body += `**思考**\n${m.thought.map((t) => `- ${t}`).join('\n')}\n\n`
    }
    const text = `## 🤖 智能体\n\n${body.trim()}`
    void navigator.clipboard
      .writeText(text)
      .then(() => message.success('已复制该条完整记录（含思考与工具调用）'))
      .catch(() => message.error('复制失败：剪贴板不可用'))
  }, [message])
  const resizingRef = useRef(false)
  const resizeElRef = useRef<HTMLDivElement>(null)
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    resizeElRef.current?.classList.add('is-dragging')
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      // 右栏右侧留 14px margin；按指针位置反推右栏宽度；上限随窗口动态 clamp
      const w = window.innerWidth - ev.clientX - 14
      const max = Math.max(340, Math.min(680, window.innerWidth - 220 - 420))
      setRightWidth(Math.min(max, Math.max(300, w)))
    }
    const onUp = () => {
      resizingRef.current = false
      resizeElRef.current?.classList.remove('is-dragging')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }
  // 图片放大预览：点击气泡/待发区缩略图打开
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  // §3.2 产物预览：点击画布节点产物调 read_artifact 命令获取内容，在 Modal 里展示
  const [artifactPreview, setArtifactPreview] = useState<ReadArtifactResult | null>(null)
  const [artifactLoading, setArtifactLoading] = useState(false)

  // §3.2 画布交互回调
  // 点击产物文件 → 调 read_artifact 命令获取内容（文本/图片/目录列表），在 Modal 展示
  const handlePreviewArtifact = useCallback(async (path: string) => {
    if (!isTauri) return
    setArtifactLoading(true)
    setArtifactPreview(null)
    try {
      const result = await invoke<ReadArtifactResult>('read_artifact', {
        path,
        workspace: workspaceDir ?? null,
      })
      setArtifactPreview(result)
    } catch (e) {
      setArtifactPreview({
        path,
        name: path,
        kind: 'error',
        size: 0,
        content: `读取产物失败：${e}`,
        truncated: false,
      })
    } finally {
      setArtifactLoading(false)
    }
  }, [isTauri, workspaceDir])

  // 挂起自动聚焦（处置中心版）：四类 HITL 任一挂起时自动展开右栏并切到「处置」Tab。
  useEffect(() => {
    if (pendingApproval || recovery || pendingChoice || planApproval) {
      setRightOpen(true)
      setRightTab('actions')
    }
  }, [pendingApproval, recovery, pendingChoice, planApproval])

  // 右键「从此步骤分支」→ 调 branch_from_step 命令，后端生成新分支并推 plan_branch 事件
  const handleBranchFromStep = useCallback(async (fromStep: number) => {
    if (!isTauri || !agent?.id) return
    // 构造原方案尾段（step > fromStep 的步骤），供后端对比展示
    const originalTail: BranchStep[] = session.planSteps
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
  }, [isTauri, agent?.id, workspaceDir, session.planSteps])

  // 放弃分支对比
  const handleDismissBranch = useCallback(() => {
    // planBranch 由 session 状态机管理，前端无法直接清空；
    // 这里切回「图」Tab 视觉上隐藏对比横幅。后续可在 useAgentSession 加 dismissPlanBranch 方法。
    setRightTab('graph')
  }, [])

  // 历史会话加载时瞬时跳到底部，避免 smooth 滚动造成的长列表滑动抖动
  const restoringRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileAttachRef = useRef<HTMLInputElement>(null)

  // 兜底：任何拖拽真正结束时（dragend）复位整窗吸附状态。
  // 落在输入框内已在 onDrop 就地复位；此处再防其他边角（如 drop 命中未知落点 / 逻辑遗漏）导致遮罩卡死。
  useEffect(() => {
    const resetWindowDrag = () => {
      dragDepth.current = 0
      setWindowDrag(false)
    }
    window.addEventListener('dragend', resetWindowDrag)
    return () => window.removeEventListener('dragend', resetWindowDrag)
  }, [])

  // 语音输入
  const [recording, setRecording] = useState(false)
  const recognitionRef = useRef<unknown>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  // 流式跟随滚动（用户反馈热修）：
  // - followBottom=true（跟随模式）时内容增长自动贴底；用户向上滚（滚轮上/拖动滚动条离开
  //   底部）即解除跟随、回看历史不被打扰；手动滚回底部附近自动恢复；发新提问强制恢复。
  // - 跟随贴底一律瞬时赋值 scrollTop（禁用 smooth）：流式 chunk 每 16ms 一批，上一次 smooth
  //   动画未完成即被下一次打断，多次平滑动画互相拉扯正是「抖动」根因；瞬时赋值恒显示最新内容。
  // - 正文为打字机逐字渲染（比数据流滞后）：仅靠数据变化触发贴底会永远追着实际渲染高度跑
  //   （「显示的不是最新内容」的另一层根因），故流式期间用 RAF 循环按**实际渲染高度**贴底。
  const [followBottom, setFollowBottom] = useState(true)
  const followRafRef = useRef<number | null>(null)
  // 上次 scrollTop：onScroll 判定「用户向上拖动」的基准（程序贴底 scrollTop 只增不减）。
  const lastScrollTopRef = useRef(0)

  /** 跟随贴底（rAF 合并 + 瞬时赋值）：同一帧多次触发只滚一次。 */
  const scheduleFollowScroll = useCallback(() => {
    if (followRafRef.current != null) return
    followRafRef.current = requestAnimationFrame(() => {
      followRafRef.current = null
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  // 流式期间持续贴底循环：每帧无条件贴底（赋相同值浏览器 no-op，成本可忽略）——
  // 以实际渲染高度为准，任何间隙/高度暴涨下一帧立即补齐，输出中途绝不掉队。
  // 解除跟随（followBottom=false）→ 循环即停；恢复/新提问 → 随依赖重启。
  useEffect(() => {
    if (!(isStreaming || isRunning) || !followBottom) return
    let raf = 0
    const tick = () => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isStreaming, isRunning, followBottom])
  const replyStartRef = useRef<number | null>(null)
  const prevIsRunningRef = useRef(false)
  const roundIdRef = useRef<string | null>(null)
  const roundIndexRef = useRef(0)
  // 标记「本次由『新增子对话』创建的、尚未发过任何消息的空会话」——离开时若仍为 0 轮则清理
  const pendingEmptySessionIdRef = useRef<string | null>(null)
  // 卸载守卫：避免卸载后调用 setState 触发警告
  const mountedRef = useRef(true)
  const lastPromptRef = useRef('')
  const lastTokensRef = useRef<{ input: number; output: number }>({ input: 0, output: 0 })

  /**
   * 渲染期消息派生（台账 S4：消息流单一派生，歼灭双源回填三 hack）。
   *
   * messages 只承担「DB 快照 + 会话骨架」（欢迎语 / 乐观插入 / 终态固化），
   * 运行态正文在**渲染时**合成进最后一条 agent 气泡——不再用 effect 把运行态
   * 写回 messages（旧方案的三个 hack 全部源于「写回」这一步）：
   *  - msgEpoch 强刷：回填 effect 依赖运行态值，DB 重载后值未变不重跑，只能手动
   *    触发；派生 memo 直接依赖 messages 引用，重载即重算，hack 自然消失；
   *  - hasLive 六条件守卫：回填 effect 在空运行态时会误覆盖 DB 快照，需要补丁
   *    拦截；在派生里它是「无运行态就纯展示 DB」的自然分支，不是补丁；
   *  - welcome 守卫：reset() 清空运行态会触发回填 effect 覆盖欢迎语；派生不写回
   *    state，时序不再产生破坏，「欢迎语永不回填」退化为纯语义规则。
   */
  const displayMessages = useMemo<ChatMessage[]>(() => {
    let base = messages
    const last = base[base.length - 1]
    const lastIsAgent = !!last && last.role === 'agent' && last.id !== 'welcome'
    const hasLive =
      isRunning ||
      !!streamingText ||
      thoughts.length > 0 ||
      toolSteps.length > 0 ||
      segments.length > 0 ||
      kbSources.length > 0
    if (hasLive && lastIsAgent) {
      base = [
        ...base.slice(0, -1),
        { ...last, content: streamingText, thought: thoughts, toolSteps, segments, kbSources },
      ]
    }
    // 错误诊断面板附加：独立于 hasLive——失败任务可能零流式产出（运行态全空），
    // 此时也要把 taskError 挂到最后一条 agent 气泡上（20260915006）。
    // 行为优于旧 effect：切会话回来后 store 里的 taskError 仍在 → 错误面板不再丢。
    if (taskError && lastIsAgent) {
      base = [...base.slice(0, -1), { ...base[base.length - 1], error: taskError }]
    }
    return base
  }, [messages, isRunning, streamingText, thoughts, toolSteps, segments, kbSources, taskError])

  const lastAgentContent =
    displayMessages.length > 0 && displayMessages[displayMessages.length - 1].role === 'agent'
      ? displayMessages[displayMessages.length - 1].content
      : ''
  // 气泡正文打字机（非 segments 旧分支/FilePathCards 消费）：30ms/字（≈33 字/秒，肉眼单字节奏），
  // 积压按比例追赶——原默认 10ms/字（100 字/秒）对长回复过快，用户反馈「一句句往外刷」。
  const displayedContent = useTypewriter(lastAgentContent, isStreaming, 30)

  // 加载智能体 + 工具/技能计数 + 能力判定 + 工作空间 + 会话列表
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [a, mcp, skills, plugins] = await Promise.all([
          getAgent(id),
          listAgentMcpTools(id),
          listAgentSkills(id),
          listAgentPlugins(id),
        ])
        if (!alive) return
        if (!a) {
          message.error('智能体不存在或已被删除')
          navigate('/agent-studio', { replace: true })
          return
        }
        setToolCount(mcp.length)
        setSkillCount(skills.length)
        setAgent(a)

        // 多模态判定：绑定 LLM 的 category === 'multimodal'
        if (a.llmId) {
          const m = await getModel(a.llmId)
          if (alive) setIsMultimodal(m?.category === 'multimodal')
          if (alive) {
            const cl = m ? (m.text?.contextLength ?? m.multimodal?.contextLength) : undefined
            setContextLength(typeof cl === 'number' ? cl : undefined)
          }
        } else if (alive) {
          setIsMultimodal(false)
          setContextLength(undefined)
        }
        if (alive) setHasStt(!!a.sttId)

        // MCP 服务（含其绑定工具）+ 技能（底部工具条展示）
        const [allMcps, allSkills, allPlugins] = await Promise.all([listMcps(), listSkills(), listPlugins()])
        // 智能体绑定的 MCP 工具引用：每个 ref 对应一个 mcp_tool_definition
        const serverIds = [...new Set(mcp.map((r) => r.mcpId))]
        // 逐个 MCP 拉取其全部工具定义，按 ref 匹配出「本智能体实际绑定」的工具
        const toolsByMcp: Record<string, McpToolDefinition[]> = {}
        await Promise.all(
          serverIds.map(async (mid) => {
            toolsByMcp[mid] = await listMcpTools(mid)
          }),
        )
        const bound: BoundMcpServer[] = serverIds
          .map((mid) => {
            const info = allMcps.find((m) => m.id === mid)
            const tools = mcp
              .filter((r) => r.mcpId === mid)
              .map((r) => {
                const def = (toolsByMcp[mid] ?? []).find((t) => t.id === r.toolId)
                return {
                  toolId: r.toolId,
                  toolCode: def?.toolCode ?? '',
                  displayName: def?.displayName,
                  description: def?.description,
                }
              })
            return {
              mcpId: mid,
              name: info?.aliasName || info?.mcpName || mid,
              tools,
            }
          })
          .filter((m) => m.tools.length > 0)
        const matched = skills
          .map((s) => allSkills.find((x) => x.id === s.skillId))
          .filter((s): s is NonNullable<typeof s> => !!s)
        if (alive) {
          setBoundMcps(bound)
          setBoundSkills(matched)
          // 已挂载插件（P2 新增）：底部工具条罗列
          setBoundPlugins(plugins)
          // 全量技能 / MCP 服务 / 插件缓存，供输入框 @提及 候选（不局限于本智能体绑定项）
          setAllSkills(allSkills)
          setAllMcps(allMcps)
          setAllPlugins(allPlugins)
        }

        // 工作空间：解析默认路径（单人调试不自定义）
        const ws = await resolveWorkspaceDir(a)
        if (alive) setDefaultWorkspaceDir(ws)

        // 会话列表
        const list = await listSessions(a.identifier)
        if (alive) setSessions(list)
        // 工程列表（智能工作空间绑定：新建向导 / 树状分组 / 目录回显）
        if (alive) setProjects(await listProjects())
      } catch (e) {
        message.error(`加载失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // 首条欢迎语（agent 就绪后注入）
  useEffect(() => {
    if (agent && messages.length === 0 && !loading) {
      setMessages([
        {
          id: 'welcome',
          role: 'agent',
          content: agent.welcomeMessage || `你好，我是 ${agent.name}，有什么可以帮你的？`,
          createdAt: Date.now(),
        },
      ])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, loading])

  // 切换智能体时清空会话状态
  useEffect(() => {
    void cleanupPendingEmptySession()
    // 旧会话若正在跑任务则不清它的运行态（让它后台继续）。
    if (!isSessionRunning(activeSessionId)) reset()
    setMessages([])
    setActiveSessionId(null)
    setRemovedSkillIds(new Set()) // 临时移除的技能随智能体切换复位
    setRemovedMcpIds(new Set()) // 临时移除的 MCP 服务复位
    setDisabledMcpToolIds(new Set()) // 临时关闭的 MCP 工具复位
    roundIndexRef.current = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // 卸载守卫 + 离开会话页时清理未发消息的空会话（刷新 / 路由回列表均走此处）
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void cleanupPendingEmptySession()
    }
  }, [])

  // 新消息 / 工具步骤 / 流式文本变化时：仅「跟随模式」下贴底（瞬时、rAF 合并）；
  // 用户已向上滚动回看历史时不打扰（解除跟随），滚回底部附近自动恢复。
  // 流式期间的打字机逐字增长由上方 RAF 循环覆盖（以实际渲染高度为准）。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (restoringRef.current) {
      // 历史会话回显：瞬时定位到底部，避免整列平滑滑动的视觉抖动
      restoringRef.current = false
      setFollowBottom(true)
      el.scrollTop = el.scrollHeight
      return
    }
    if (followBottom) scheduleFollowScroll()
  }, [messages, toolSteps, streamingText, followBottom, scheduleFollowScroll])

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
    const branch = session.planBranch
    if (!branch || !agent?.id) return
    const head = session.planSteps.filter((s) => s.step <= branch.fromStep)
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
  }, [session.planBranch, agent?.id, workspaceDir, session.planSteps, ensureRound, run])

  /** 切换某个 Skill 的「临时移除」状态（仅内存态，不写库；切换智能体/会话即复位）。 */
  const toggleSkill = useCallback((skillId: string) => {
    setRemovedSkillIds((prev) => {
      const next = new Set(prev)
      if (next.has(skillId)) next.delete(skillId)
      else next.add(skillId)
      return next
    })
  }, [])

  /** 切换某个 MCP 服务的「临时移除」状态（仅内存态，不写库）。 */
  const toggleMcp = useCallback((mcpId: string) => {
    setRemovedMcpIds((prev) => {
      const next = new Set(prev)
      if (next.has(mcpId)) next.delete(mcpId)
      else next.add(mcpId)
      return next
    })
  }, [])

  /** 切换某个 MCP 工具的「临时关闭」状态（仅内存态，不写库）。 */
  const toggleMcpTool = useCallback((toolId: string) => {
    setDisabledMcpToolIds((prev) => {
      const next = new Set(prev)
      if (next.has(toolId)) next.delete(toolId)
      else next.add(toolId)
      return next
    })
  }, [])

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
    // 方案 C：发消息即自动展开右栏并切到「图」（本轮 DAG 主视图），符合 Graph-first 作用域。
    setRightOpen(true)
    setRightTab('graph')
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

  // 将 session 的流式文本/思考/工具步骤同步进「最后一条助手气泡」的效果已删除
  // （台账 S4）：改由 displayMessages 渲染期派生承担，见上方 useMemo。

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

      // 轮次定稿 / 会话状态 / 未命名会话改名的**落库已移到模块级 onRunTerminal**（文件顶部），
      // 与组件生命周期解耦：切页期间任务跑完也照常落库。此处不再重复写库，
      // 否则 addSessionTokens 会被调用两次导致 token 双倍累加。
      roundIdRef.current = null
      // 左侧列表刷新由模块级 handler 经 chatMod.refreshSessionsRef 回调完成（见下方注入），
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

  // 输入框顶部拖拽手柄：向上拖动增大高度（底部锚定，自然向上扩展），而非原生 resize 只能向下拉。
  const startInputResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = inputHeight
    const MIN = 48
    const MAX = 320
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN, Math.min(MAX, startH + (startY - ev.clientY)))
      setInputHeight(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [inputHeight])

  const handleApproval = useCallback(
    (decision: 'approve' | 'skip' | 'takeover', guidance?: string, remember?: boolean) => {
      if (!pendingApproval) return
      void submitDecision({
        approvalId: pendingApproval.approvalId,
        decision,
        guidance,
        // 15007 边审批策略：「本任务内记住」→ grantKey 写入后端授权集
        remember,
        grantKey: pendingApproval.grantKey ?? null,
      })
    },
    [pendingApproval, submitDecision],
  )

  /** 重新生成：以上一轮 user 消息为 prompt 再跑一次，替换当前 agent 回复。 */
  /**
   * 从一段用户消息文本里反解出 @提及 标签（#20260915004 B3）。
   * 与 `getCandidates` 同源：只匹配已知技能 / MCP 服务名称，避免误伤自由文本里的 @。
   * 用于「重新生成」时把首轮临时启用的能力原样带回（send 走的是 mentionTags，regenerate 时它已清空）。
   */
  const resolveMentionTags = useCallback(
    (text: string): { key: string; label: string; token: string }[] => {
      const out: { key: string; label: string; token: string }[] = []
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

  /** 点击左侧历史会话，加载其全部轮次。 */
  const openSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionId) return
      // 【不再清空目标会话的运行态】运行态已按会话隔离，各会话互不影响；保留运行态才能
      // 留住「刚跑完的正文 / 思考 / 图」，切走再回来仍在（此前一清就只剩 DB 快照、
      // 未落库的部分直接消失）。新一轮发送时 run() → beginRun() 本来就会清空，不会残留。
      setActiveSessionId(sessionId)
      setRemovedSkillIds(new Set()) // 切换会话即复位临时移除（重新打开会话恢复全部技能）
      setRemovedMcpIds(new Set()) // 临时移除的 MCP 服务复位
      setDisabledMcpToolIds(new Set()) // 临时关闭的 MCP 工具复位
      try {
        // 回显该会话绑定的工程（工作空间），无则自由对话
        const sess = await getSession(sessionId)
        setPendingProjectId(sess?.projectId ?? null)
        const rounds = await listRounds(sessionId)
        setMessages(roundsToMessages(rounds))
        setMentionTags([]) // 切换会话清空 @提及 标签
        roundIndexRef.current = rounds.length
      } catch (e) {
        message.error(`加载会话失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [activeSessionId, message],
  )

  /** 新建对话：清空当前会话，回到欢迎语。 */
  const newChat = useCallback(() => {
    void cleanupPendingEmptySession()
    // 当前会话若正在跑任务，不清它的运行态（让它在后台继续），仅切到全新会话。
    if (!isSessionRunning(activeSessionId)) reset()
    setActiveSessionId(null)
    setPendingProjectId(null) // 新建对话解绑工程（自由对话）
    setRemovedSkillIds(new Set()) // 新建对话复位临时移除
    setRemovedMcpIds(new Set()) // 临时移除的 MCP 服务复位
    setDisabledMcpToolIds(new Set()) // 临时关闭的 MCP 工具复位
    setMentionTags([]) // 切换/新建会话清空 @提及 标签
    setPendingAttachments([]) // 切换/新建会话清空待发送附件
    setDragOver(false)
    setInput('')
    roundIndexRef.current = 0
    setMessages(
      agent
        ? [
            {
              id: 'welcome',
              role: 'agent',
              content: agent.welcomeMessage || `你好，我是 ${agent.name}，有什么可以帮你的？`,
              createdAt: Date.now(),
            },
          ]
        : [],
    )
  }, [agent, reset])

  /* ---------------- 输入框 @提及 / /指令 ---------------- */

  /** 快捷指令定义（/ 触发）。 */
  const COMMANDS: SuggestItem[] = [
    { key: 'cmd:new', token: '/new', label: '新建会话', sub: '开启一个全新对话', group: '指令' },
    { key: 'cmd:clear', token: '/clear', label: '清空对话', sub: '清除当前全部消息', group: '指令' },
    { key: 'cmd:reset', token: '/reset', label: '重置运行态', sub: '中断并复位智能体运行态', group: '指令' },
    { key: 'cmd:help', token: '/help', label: '使用帮助', sub: '查看 @提及 与 /指令 说明', group: '指令' },
  ]

  /** 解析输入框中位于光标前的激活触发词（@ 或 / 开头、且前导为行首或空白）。 */
  const computeTrigger = (
    text: string,
    caret: number,
  ): { mode: 'mention' | 'command'; start: number; end: number; query: string } | null => {
    let i = caret - 1
    while (i >= 0) {
      const ch = text[i]
      if (ch === ' ' || ch === '\n' || ch === '\t') break
      if (ch === '@' || ch === '/') {
        const prevCh = i > 0 ? text[i - 1] : ''
        const boundary = i === 0 || /\s/.test(prevCh)
        if (!boundary) break // 形如邮箱 foo@bar 不视为触发
        return { mode: ch === '@' ? 'mention' : 'command', start: i, end: caret, query: text.slice(i + 1, caret) }
      }
      i--
    }
    return null
  }

  /** 按模式 + 查询串过滤候选（@ 取技能 + MCP 服务；/ 取快捷指令）。 */
  const getCandidates = (mode: 'mention' | 'command', query: string): SuggestItem[] => {
    const q = query.trim().toLowerCase()
    if (mode === 'command') {
      return COMMANDS.filter((c) => !q || c.token.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
    }
    const skills = allSkills
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          (s.identifier || '').toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q),
      )
      // token 用 skill.identifier（稳定、无空格），label 用 s.name 仅展示；硬化后不再依赖 name 做判断
      .map<SuggestItem>((s) => ({ key: `skill:${s.id}`, token: s.identifier || s.name, label: s.name, sub: s.description || '技能', group: '技能' }))
    const mcps = allMcps
      .filter((m) => !q || (m.aliasName || m.mcpName || '').toLowerCase().includes(q))
      .map<SuggestItem>((m) => {
        const name = m.aliasName || m.mcpName || m.id
        return { key: `mcp:${m.id}`, token: name, label: name, sub: 'MCP 服务', group: 'MCP 服务' }
      })
    // 插件候选（P2 新增）：token 用 identifier（稳定无空格），label 用 name 仅展示
    const plugins = allPlugins
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.identifier.toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q),
      )
      .map<SuggestItem>((p) => ({
        key: `plugin:${p.id}`,
        token: p.identifier || p.name,
        label: p.name,
        sub: '插件',
        group: '插件',
      }))
    return [...skills, ...mcps, ...plugins]
  }

  /** 依据当前文本与光标位置刷新浮层；命中候选则展开，否则收起。 */
  const syncSuggest = (text: string, caret: number) => {
    const trig = computeTrigger(text, caret)
    if (!trig) {
      setSuggest(null)
      return
    }
    const items = getCandidates(trig.mode, trig.query)
    if (items.length === 0) {
      setSuggest(null)
      return
    }
    setSuggest((prev) => {
      const p = prev
      // 触发词签名未变（仅光标微调）时保留当前高亮，避免方向键被 keyup 重置
      const keepIndex = p && p.mode === trig.mode && p.query === trig.query && p.index < items.length ? p.index : 0
      return { ...trig, items, index: keepIndex }
    })
  }

  /** 选中 @提及 候选：把触发词从文本框剥离，改为生成一个可移除的 Tag（chip）。 */
  const applyMention = (item: SuggestItem) => {
    if (!suggest) return
    // 从文本框删除「@query」片段（标签已独立承载，避免空格歧义）
    const next = input.slice(0, suggest.start) + input.slice(suggest.end)
    setInput(next)
    setMentionTags((prev) => {
      if (prev.some((t) => t.key === item.key)) return prev // 去重：同一技能/MCP 不重复添加
      // 写入 chip：label 展示人类名，token 携带 identifier（send 序列化与 regenerate 反解都按 token 匹配）
      return [...prev, { key: item.key, label: item.label, token: item.token }]
    })
    setSuggest(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        const caret = suggest.start
        el.setSelectionRange(caret, caret)
      }
    })
  }

  /** 选中 / 指令：立即执行对应动作。 */
  const runCommand = (item: SuggestItem) => {
    setSuggest(null)
    setInput('')
    setMentionTags([])
    switch (item.key) {
      case 'cmd:new':
        newChat()
        break
      case 'cmd:clear':
        reset()
        setMessages(
          agent
            ? [{ id: 'welcome', role: 'agent', content: agent.welcomeMessage || `你好，我是 ${agent.name}，有什么可以帮你的？`, createdAt: Date.now() }]
            : [],
        )
        break
      case 'cmd:reset':
        reset()
        break
      case 'cmd:help':
        setHelpOpen(true)
        break
    }
  }

  /** 输入框内容变化：写回 state 并刷新浮层。 */
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    syncSuggest(val, e.target.selectionStart ?? val.length)
  }

  /** 光标移动（点击 / 方向键）：重新判定触发词，离开触发词则收起浮层。 */
  const handleCaretMove = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    syncSuggest(el.value, el.selectionStart ?? el.value.length)
  }

  /** 键盘事件：浮层展开时方向键导航、Enter/Tab 选中、Esc 收起；否则保持原 Enter 发送逻辑。 */
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest && suggest.items.length > 0) {
      const n = suggest.items.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSuggest((s) => (s ? { ...s, index: (s.index + 1) % n } : s))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSuggest((s) => (s ? { ...s, index: (s.index - 1 + n) % n } : s))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const item = suggest.items[suggest.index]
        if (item) {
          if (suggest.mode === 'mention') applyMention(item)
          else runCommand(item)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSuggest(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const removeSession = useCallback(
    async (sessionId: string, e?: React.MouseEvent) => {
      e?.stopPropagation()
      try {
        await deleteSession(sessionId)
        const list = await listSessions(agent?.identifier ?? '')
        setSessions(list)
        if (activeSessionId === sessionId) newChat()
      } catch (err) {
        message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [agent, activeSessionId, newChat, message],
  )

  /* ---------------- 智能工作空间绑定：新建向导 / 工程操作 ---------------- */

  /** 刷新会话列表与工程列表。 */
  const refreshSessions = useCallback(async () => {
    if (!agent) return
    const list = await listSessions(agent.identifier)
    setSessions(list)
  }, [agent])
  const refreshProjects = useCallback(async () => {
    setProjects(await listProjects())
  }, [])
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshSessions(), refreshProjects()])
  }, [refreshSessions, refreshProjects])

  // 把会话列表刷新能力注入模块级终态落库流程：任务在后台跑完并改名/定稿后，
  // 由模块级 handler 回调这里刷新左侧列表（未挂载时跳过，回来时会从库重载）。
  useEffect(() => {
    chatMod.refreshSessionsRef = () => {
      void refreshSessions()
    }
    return () => {
      chatMod.refreshSessionsRef = null
    }
  }, [refreshSessions])

  // 记住当前智能体最后查看的会话（供切页回来恢复）。
  useEffect(() => {
    if (agent?.id && activeSessionId) lastSessionByAgent.set(agent.id, activeSessionId)
  }, [agent?.id, activeSessionId])

  // 供模块级终态逻辑判断「用户此刻是否在看这个会话」（决定是否弹完成提醒）。
  // 同时：用户点开该会话即收起它的「任务暂停」通知（界面里已有决策面板，不必再弹）。
  useEffect(() => {
    chatMod.chatViewSessionRef = activeSessionId
    if (activeSessionId) getNotifyApi()?.notification?.destroy(`pending-${activeSessionId}`)
  }, [activeSessionId])
  useEffect(() => {
    return () => {
      chatMod.chatViewSessionRef = null
    }
  }, [])

  // 供通知上「查看」按钮直接切会话（仅当当前就停在该智能体的对话页时生效）。
  useEffect(() => {
    chatMod.openSessionRef = (sid: string, aid: string) => {
      if (agent?.id !== aid) return false
      void openSession(sid)
      return true
    }
    return () => {
      chatMod.openSessionRef = null
    }
  }, [agent?.id, openSession])

  // 同步会话列表快照给模块级提醒逻辑（取会话名用）
  useEffect(() => {
    chatMod.sessionsSnapshot = sessions
  }, [sessions])

  // 挂起通知收起（其二）：提交决策后挂起态解除 → 精准关掉对应那条通知。
  useEffect(() => {
    const hasPending = !!(pendingApproval || recovery || pendingChoice || planApproval)
    if (!hasPending && activeSessionId) {
      getNotifyApi()?.notification?.destroy(`pending-${activeSessionId}`)
    }
  }, [pendingApproval, recovery, pendingChoice, planApproval, activeSessionId])

  // 切页回来（对话页重挂）：恢复上次查看的会话。
  // **刻意不走 openSession**——它会 resetRuntime 清掉该会话的运行态，把正在跑的任务
  // 的进度抹掉；这里只加载历史轮次并绑定会话 id，运行态由模块级 store 原样带出。
  const restoredSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!agent?.id || activeSessionId) return
    if (restoredSessionRef.current === agent.id) return
    const prev = lastSessionByAgent.get(agent.id)
    if (!prev) return
    restoredSessionRef.current = agent.id
    void (async () => {
      try {
        const sess = await getSession(prev)
        setPendingProjectId(sess?.projectId ?? null)
        const rounds = await listRounds(prev)
        setMessages(roundsToMessages(rounds))
        roundIndexRef.current = rounds.length
        setActiveSessionId(prev)
      } catch {
        // 会话可能已被删除：忽略，停留在「新建对话」
      }
    })()
  }, [agent?.id, activeSessionId])

  // 方案B：监听会话压缩完成事件，重读会话表使顶栏环形图随压缩回落。
  // 后端压缩时已把估算节省量从累计 prompt token 回退（持久化），这里仅重读最新值，
  // 保证「上下文占比」在压缩后下降、不再只增不减。
  useEffect(() => {
    let off: UnlistenFn | undefined
    let cancelled = false
    void listen<ContextCompactedPayload>('agent-context-compacted', (ev) => {
      if (ev.payload?.success) refreshSessions()
    }).then((fn) => {
      if (!cancelled) off = fn
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [refreshSessions])

  /** 欢迎语（按当前智能体）。 */
  const welcomeMessages = useCallback(
    (): ChatMessage[] =>
      agent
        ? [
            {
              id: 'welcome',
              role: 'agent',
              content: agent.welcomeMessage || `你好，我是 ${agent.name}，有什么可以帮你的？`,
              createdAt: Date.now(),
            },
          ]
        : [],
    [agent],
  )

  /** 清理「新增子对话」产生的空会话：尚未发过任何消息（0 轮）则删除该行。 */
  const cleanupPendingEmptySession = useCallback(async () => {
    const id = pendingEmptySessionIdRef.current
    if (!id) return
    pendingEmptySessionIdRef.current = null
    try {
      const rounds = await listRounds(id)
      if (rounds.length === 0) {
        await deleteSession(id)
        if (mountedRef.current) await refreshSessions()
      }
    } catch {
      // 清理失败不影响主流程
    }
  }, [listRounds, deleteSession, refreshSessions])

  /** 工程头「新增子对话」：基于已有工程新建并进入会话。 */
  const startProjectSession = useCallback(
    async (projectId: string) => {
      const proj = projects.find((p) => p.id === projectId) ?? (await getProject(projectId))
      if (!proj) {
        message.error('工程不存在')
        return
      }
      // 若上一次「新增子对话」后没发消息就又点了新增，先清掉那个空会话
      await cleanupPendingEmptySession()
      // 当前会话若正在跑任务，不清它的运行态（让它后台继续），仅新建并切到新会话。
      if (!isSessionRunning(activeSessionId)) reset()
      setActiveSessionId(null)
      setRemovedSkillIds(new Set())
      setRemovedMcpIds(new Set())
      setDisabledMcpToolIds(new Set())
      roundIndexRef.current = 0
      setPendingProjectId(projectId)
      setMessages(welcomeMessages())
      try {
        const sess = await createSession(agent?.identifier ?? '', undefined, { projectId })
        setActiveSessionId(sess.id)
        pendingEmptySessionIdRef.current = sess.id
        await refreshSessions()
      } catch (err) {
        message.error(`创建会话失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [agent, projects, reset, welcomeMessages, refreshSessions, message, cleanupPendingEmptySession],
  )

  /** 输入框工作空间胶囊：选择 / 更改绑定目录（即时重绑当前会话为工程）。 */
  const changeWorkspaceDir = useCallback(async () => {
    if (!isTauri) return
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择工作空间目录' })
      if (!selected || typeof selected !== 'string') return
      const proj = await ensureProjectByPath(selected)
      await refreshProjects()
      setPendingProjectId(proj.id)
      if (activeSessionId) await updateSession(activeSessionId, { projectId: proj.id })
      await refreshSessions()
    } catch (err) {
      message.error(`目录不可用：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [isTauri, activeSessionId, refreshProjects, refreshSessions, message])

  /** 输入框工作空间胶囊：清除绑定（回到自由对话）。 */
  const clearWorkspaceBinding = useCallback(async () => {
    setPendingProjectId(null)
    if (activeSessionId) {
      // 必须用 clearSessionProject：updateSession 对 project_id 走 COALESCE，传 null 不会真正解绑（#20260915004 B1）。
      await clearSessionProject(activeSessionId)
      await refreshSessions()
    }
  }, [activeSessionId, refreshSessions])

  /* ---------------- 会话行操作：重命名 / 置顶 / 归档 / 删除 ---------------- */
  const renameSessionHandler = useCallback((s: AgentConversationSession) => {
    setRenameTarget({ kind: 'session', id: s.id, current: s.sessionName ?? '' })
    setRenameValue(s.sessionName ?? '')
  }, [])
  const toggleSessionTopHandler = useCallback(
    async (s: AgentConversationSession) => {
      try {
        await toggleSessionTop(s.id, !s.isTop)
        await refreshSessions()
      } catch (err) {
        message.error(`操作失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refreshSessions, message],
  )
  const archiveSessionHandler = useCallback(
    async (s: AgentConversationSession) => {
      try {
        await setSessionArchived(s.id, !s.isArchive)
        await refreshSessions()
      } catch (err) {
        message.error(`操作失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refreshSessions, message],
  )

  /* ---------------- 工程头操作：新增子对话 / 重命名 / 置顶 / 归档 / 删除 ---------------- */
  const openMemoEditor = useCallback(async (group: SessionTreeGroup) => {
    const rootPath = group.rootPath ?? ''
    if (!rootPath) return
    setMemoEditor({ open: true, rootPath, name: group.projectName })
    setMemoContent('读取中…')
    const content = await readProjectMemory(rootPath)
    setMemoContent(content ?? '')
  }, [])
  const saveMemoEditor = useCallback(async () => {
    if (!memoEditor) return
    setMemoSaving(true)
    try {
      await writeProjectMemory(memoEditor.rootPath, memoContent)
      message.success('项目记忆已保存')
      setMemoEditor(null)
    } catch (err) {
      message.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setMemoSaving(false)
    }
  }, [memoEditor, memoContent, message])

  const renameProjectHandler = useCallback((p: AgentProject) => {
    setRenameTarget({ kind: 'project', id: p.id, current: p.name })
    setRenameValue(p.name)
  }, [])

  const confirmRename = useCallback(async () => {
    if (!renameTarget) return
    const next = renameValue.trim()
    try {
      if (renameTarget.kind === 'session') {
        await renameSession(renameTarget.id, next || renameTarget.current || '未命名会话')
        await refreshSessions()
      } else {
        await updateProject(renameTarget.id, { name: next || renameTarget.current })
        await refreshAll()
      }
      setRenameTarget(null)
    } catch (err) {
      message.error(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [renameTarget, renameValue, refreshSessions, refreshAll, message])
  const pinProjectHandler = useCallback(
    async (p: AgentProject) => {
      try {
        await updateProject(p.id, { isPinned: !p.isPinned })
        await refreshProjects()
      } catch (err) {
        message.error(`操作失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refreshProjects, message],
  )
  const archiveProjectHandler = useCallback(
    async (p: AgentProject) => {
      try {
        await updateProject(p.id, { isArchived: !p.isArchived })
        await refreshProjects()
      } catch (err) {
        message.error(`操作失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refreshProjects, message],
  )
  const deleteProjectHandler = useCallback(
    (p: AgentProject) => {
      modal.confirm({
        title: '删除工程',
        content: `删除工程「${p.name}」将级联清除其下所有会话与轮次，此操作不可恢复。`,
        okText: '删除',
        okButtonProps: { danger: true },
        onOk: async () => {
          try {
            await deleteProject(p.id)
            if (activeSessionId) {
              const sess = sessions.find((s) => s.id === activeSessionId)
              if (sess?.projectId === p.id) newChat()
            }
            await refreshAll()
          } catch (err) {
            message.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
          }
        },
      })
    },
    [activeSessionId, sessions, newChat, refreshAll, message, modal],
  )

  // ---- 附件（图片 / 文本 / 文件）----
  /** 把文件分片上传到后端 `workspace/.attachments/`，返回落地路径（Tauri 环境）。
   *  非 Tauri（dev/mock）环境无原生落盘能力，回退为 base64 内联（仅小文件）。 */
  const stageFile = useCallback(
    async (file: File): Promise<string> => {
      if (!isTauri) {
        if (file.size > MAX_INLINE_IMAGE) throw new Error('非 Tauri 环境不支持超大文件')
        const dataUrl = await readFileAsDataURL(file)
        const comma = dataUrl.indexOf(',')
        return dataUrl.slice(comma + 1)
      }
      const CHUNK = 4 * 1024 * 1024
      const stageId = await invoke<string>('begin_stage_attachment', {
        name: file.name,
        mime: file.type || 'application/octet-stream',
      })
      try {
        for (let off = 0; off < file.size; off += CHUNK) {
          const slice = file.slice(off, Math.min(off + CHUNK, file.size))
          const buf = await slice.arrayBuffer()
          await invoke('append_stage_chunk', { stageId, data: new Uint8Array(buf) })
        }
        return await invoke<string>('commit_stage_attachment', {
          stageId,
          workspace: workspaceDir ?? null,
        })
      } catch (e) {
        await invoke('abort_stage_attachment', { stageId }).catch(() => {})
        throw e
      }
    },
    [isTauri, workspaceDir, message],
  )

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      for (const file of list) {
        const size = file.size
        try {
          // 图片：≤20MB 多模态 dataUrl 内联；超大图片走分片落盘（file 类型，agent 用 native__read_file 看）。
          if (file.type.startsWith('image/') && size <= MAX_INLINE_IMAGE) {
            const dataUrl = await readFileAsDataURL(file)
            setPendingAttachments((prev) => [
              ...prev,
              { id: attId(), type: 'image', dataUrl, name: file.name, size },
            ])
            continue
          }
          if (size > MAX_FILE) {
            message.error(`「${file.name}」超过 500MB，已忽略`)
            continue
          }
          // 文本（≤200KB）直接内联；其余（二进制 / 超大文本 / 超大图片）分片落盘。
          if (isTextType(file) && size <= TEXT_INLINE_LIMIT && !file.type.startsWith('image/')) {
            const text = await readFileAsText(file)
            setPendingAttachments((prev) => [
              ...prev,
              { id: attId(), type: 'text', content: text, name: file.name, mime: file.type || 'text/plain', size },
            ])
            continue
          }
          const path = await stageFile(file)
          setPendingAttachments((prev) => [
            ...prev,
            {
              id: attId(),
              type: 'file',
              name: file.name,
              mime: file.type || 'application/octet-stream',
              size,
              path,
            },
          ])
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          message.error(`「${file.name}」处理失败：${msg}`)
        }
      }
    },
    [message, stageFile],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const it of Array.from(items)) {
        // 任意文件（不再仅限图片，也不再要求多模态模型）——文本/文件附件任意模型可用
        const file = it.getAsFile()
        if (file) files.push(file)
      }
      if (files.length) {
        e.preventDefault()
        addFiles(files)
      }
    },
    [addFiles],
  )

  /** 复制错误详情到剪贴板（错误诊断面板用）。 */
  const copyError = useCallback((text: string) => {
    if (!navigator.clipboard) {
      message.error('当前环境不支持自动复制')
      return
    }
    navigator.clipboard
      .writeText(text)
      .then(() => message.success('已复制错误详情'), () => message.error('复制失败，请手动选择文本'))
  }, [message])

  // ---- STT 语音输入 ----
  const toggleVoice = useCallback(() => {
    const SR = (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
      .SpeechRecognition as
      | (new () => SpeechLike)
      | undefined
    const Impl = SR ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechLike })
      .webkitSpeechRecognition
    if (!Impl) {
      message.warning('当前浏览器不支持语音输入')
      return
    }
    if (recording) {
      ;(recognitionRef.current as SpeechLike | null)?.stop()
      setRecording(false)
      return
    }
    const rec = new Impl()
    rec.lang = 'zh-CN'
    rec.interimResults = true
    rec.onresult = (ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      let text = ''
      for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript
      setInput(text)
    }
    rec.onend = () => setRecording(false)
    rec.onerror = () => setRecording(false)
    recognitionRef.current = rec
    rec.start()
    setRecording(true)
  }, [recording, message])

  // 左侧树状分组（GLOBAL + 各 PROJECT），随搜索过滤
  // 注意：useMemo 必须在任何早退 return 之前调用，否则两次渲染 hook 数量不一致（React 报错）。
  const sessionTree = useMemo(() => buildSessionTree(sessions, projects), [sessions, projects])
  const filteredTree = useMemo(
    () => {
      const q = sessionSearch.trim().toLowerCase()
      return sessionTree
        // 默认隐藏已归档工程组（开启「显示归档」才出现）
        .filter((g) => showArchived || !g.isArchived)
        .map((g) => ({
          ...g,
          sessions: g.sessions.filter((s) => {
            if (!showArchived && s.isArchived) return false // 默认隐藏已归档会话
            if (q && !(s.sessionName ?? '').toLowerCase().includes(q)) return false
            return true
          }),
        }))
        .filter((g) => g.sessions.length > 0)
    },
    [sessionTree, sessionSearch, showArchived],
  )

  if (loading) {
    return <div className="agent-chat agent-chat--loading">加载中…</div>
  }
  if (!agent) return null

  // 当前会话已消耗 token（提示词 + 对话），用于底部环形图占比
  const activeSession = sessions.find((s) => s.id === activeSessionId)

  return (
    <div
      className="agent-chat"
      // 输入框实际高度（用户可拖拽拉高，最高 320px）作为 CSS 变量下发，
      // 供主内容区 / 右侧执行轨迹面板 / 宽度拖柄动态避让，避免拉高后输入框遮挡这些区域。
      style={
        {
          '--input-h': `${inputHeight}px`,
          '--right-w': `${rightWidth}px`,
        } as React.CSSProperties
      }
      onDragEnter={(e) => {
        // 整窗拖拽吸附：用 depth 计数嵌套 enter/leave，避免子元素冒泡导致遮罩闪烁。
        if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
          dragDepth.current += 1
          if (!windowDrag) setWindowDrag(true)
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDragLeave={() => {
        // 不依赖 dataTransfer.types（部分浏览器在 dragleave 时清空 types），
        // 只要当前处于整窗拖拽吸附态就计数离开，避免遮罩卡死。
        if (!windowDrag) return
        dragDepth.current -= 1
        if (dragDepth.current <= 0) {
          dragDepth.current = 0
          setWindowDrag(false)
        }
      }}
      onDrop={(e) => {
        // 仅处理落在输入框之外的拖放；输入框内的 drop 已被其自身 onDrop 阻止冒泡。
        if (!(e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files'))) return
        e.preventDefault()
        dragDepth.current = 0
        setWindowDrag(false)
        const files = Array.from(e.dataTransfer.files ?? [])
        if (files.length) addFiles(files)
      }}
    >
      {/* 整窗拖拽吸附遮罩 */}
      {windowDrag && (
        <div className="agent-chat__drop-mask">
          <div className="agent-chat__drop-mask-inner">
            <Paperclip size={28} />
            <span>松开以添加附件</span>
          </div>
        </div>
      )}
      {/* 四类 HITL 决策（授权/恢复/选择/计划审批）统一走右栏「处置」Tab（弹窗改版 Phase 2） */}

      {/* 左侧会话列表 */}
      <aside className="agent-chat__side">
        <div className="agent-chat__side-head">
          <div className="agent-chat__side-nav">
            <Button
              variant="ghost"
              size="sm"
              className="agent-chat__icon-btn"
              title="返回列表"
              onClick={() => navigate('/agent-studio')}
            >
              <ArrowLeft size={16} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="agent-chat__icon-btn"
              title="编辑智能体"
              onClick={() => navigate(agentEditPath(agent.id))}
            >
              <Pencil size={16} />
            </Button>
          </div>
          <div className="agent-chat__new-wrap">
            <Button variant="solid" size="sm" className="agent-chat__new" onClick={() => newChat()}>
              <Plus size={14} />
              新建对话
            </Button>
            {memoEditor && (
              <Modal
                open={memoEditor.open}
                onOpenChange={(o) => {
                  if (!o) setMemoEditor(null)
                }}
                title={`编辑项目记忆 · ${memoEditor.name}`}
                width={720}
                footer={
                  <>
                    <Button onClick={() => setMemoEditor(null)}>取消</Button>
                    <Button type="primary" loading={memoSaving} onClick={saveMemoEditor}>
                      保存
                    </Button>
                  </>
                }
              >
                <div style={{ fontSize: 12, color: 'var(--color-foreground-muted)', marginBottom: 8 }}>
                  落盘于工程根目录 <code>.wd_mem/MEMORY.md</code>，智能体会将其作为长期记忆注入上下文（兼容旧 project_memory.md）。
                </div>
                <Input.TextArea
                  value={memoContent}
                  onChange={(e) => setMemoContent(e.target.value)}
                  autoSize={{ minRows: 16, maxRows: 28 }}
                  placeholder="记录项目架构、关键拓扑与避坑经验（Markdown）"
                  style={{ fontFamily: 'var(--font-mono, monospace)' }}
                />
              </Modal>
            )}
            {renameTarget && (
              <Modal
                open={!!renameTarget}
                onOpenChange={(o) => {
                  if (!o) setRenameTarget(null)
                }}
                title={renameTarget.kind === 'session' ? '重命名会话' : '重命名工程'}
                width={420}
                footer={
                  <>
                    <Button onClick={() => setRenameTarget(null)}>取消</Button>
                    <Button type="primary" onClick={confirmRename}>
                      确定
                    </Button>
                  </>
                }
              >
                <Input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onPressEnter={confirmRename}
                  placeholder={renameTarget.kind === 'session' ? '会话名称' : '工程名称'}
                  maxLength={80}
                />
              </Modal>
            )}
            {helpOpen && (
              <Modal
                open={helpOpen}
                onOpenChange={(o) => {
                  if (!o) setHelpOpen(false)
                }}
                title="输入框使用帮助"
                width={480}
                footer={<Button type="primary" onClick={() => setHelpOpen(false)}>知道了</Button>}
              >
                <div className="agent-chat__help">
                  <p className="agent-chat__help-title">@ 提及</p>
                  <p className="agent-chat__help-text">
                    在输入框输入 <code>@</code> 唤起技能与 MCP 服务列表，按关键词筛选后回车或点击插入，
                    用于提示智能体本轮优先调用某项能力（如 <code>@文档润色</code>）。
                  </p>
                  <p className="agent-chat__help-title">/ 快捷指令</p>
                  <ul className="agent-chat__help-list">
                    <li><code>/new</code> — 新建会话，开启全新对话</li>
                    <li><code>/clear</code> — 清空当前全部消息</li>
                    <li><code>/reset</code> — 中断并复位智能体运行态</li>
                    <li><code>/help</code> — 查看本说明</li>
                  </ul>
                  <p className="agent-chat__help-text">
                    浮层展开时：<code>↑</code>/<code>↓</code> 切换、<code>Enter</code>/<code>Tab</code> 选中、<code>Esc</code> 收起。
                  </p>
                </div>
              </Modal>
            )}
          </div>
        </div>
        <div className="agent-chat__search">
          <Search size={14} />
          <input
            value={sessionSearch}
            placeholder="搜索会话"
            autoComplete="off"
            onChange={(e) => setSessionSearch(e.target.value)}
          />
        </div>
        <label className="agent-chat__archive-toggle" title="显示已归档的会话与工程">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          显示归档
        </label>
        <div className="agent-chat__session-list">
          {filteredTree.length === 0 && (
            <div className="agent-chat__session-empty">暂无历史会话</div>
          )}
          {filteredTree.map((group) => (
            <div
              className={`agent-chat__group${group.groupType === 'PROJECT' ? ' agent-chat__group--project' : ''}`}
              key={group.groupId}
            >
              {group.groupType === 'PROJECT' ? (
                <div className={group.isArchived ? 'agent-chat__group-head is-archived' : 'agent-chat__group-head'}>
                  <button
                    type="button"
                    className={`agent-chat__group-fold${collapsedGroups.has(group.groupId) ? ' is-collapsed' : ''}`}
                    title={collapsedGroups.has(group.groupId) ? '展开会话' : '收叠会话'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleGroupFold(group.groupId)
                    }}
                  >
                    {collapsedGroups.has(group.groupId) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  </button>
                  <Folder size={13} className="agent-chat__group-icon" />
                  <div className="agent-chat__group-info">
                    {/* tooltip 展示用干净路径（rootPath 本身可能带 `\\?\` 逐字前缀） */}
                    <span className="agent-chat__group-name" title={stripWinVerbatim(group.rootPath ?? '')}>
                      {group.projectName}
                    </span>
                  </div>
                  <DropdownMenu
                    align="right"
                    title="工程操作"
                    items={[
                      { label: '新增子对话', icon: <MessageSquarePlus size={13} />, onClick: () => void startProjectSession(group.groupId) },
                      { label: '编辑项目记忆', icon: <FilePen size={13} />, onClick: () => void openMemoEditor(group) },
                      { label: group.isPinned ? '取消置顶' : '置顶工程', icon: group.isPinned ? <PinOff size={13} /> : <Pin size={13} />, onClick: () => void pinProjectHandler({ id: group.groupId, name: group.projectName, rootPath: group.rootPath ?? '', isPinned: !!group.isPinned, isArchived: false, lastActiveAt: 0, createdAt: 0, updatedAt: 0 } as AgentProject) },
                      { label: '重命名工程', icon: <Pencil size={13} />, onClick: () => void renameProjectHandler({ id: group.groupId, name: group.projectName, rootPath: group.rootPath ?? '', isPinned: !!group.isPinned, isArchived: !!group.isArchived, lastActiveAt: 0, createdAt: 0, updatedAt: 0 } as AgentProject) },
                      { label: group.isArchived ? '取消归档工程' : '归档工程', icon: group.isArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />, onClick: () => void archiveProjectHandler({ id: group.groupId, name: group.projectName, rootPath: group.rootPath ?? '', isPinned: !!group.isPinned, isArchived: !!group.isArchived, lastActiveAt: 0, createdAt: 0, updatedAt: 0 } as AgentProject) },
                      { label: '删除工程（级联）', icon: <Trash2 size={13} />, danger: true, onClick: () => void deleteProjectHandler({ id: group.groupId, name: group.projectName, rootPath: group.rootPath ?? '', isPinned: !!group.isPinned, isArchived: !!group.isArchived, lastActiveAt: 0, createdAt: 0, updatedAt: 0 } as AgentProject) },
                    ]}
                    trigger={
                      <span className="agent-chat__group-more" title="工程操作">
                        <MoreVertical size={13} />
                      </span>
                    }
                  />
                </div>
              ) : (
                <div className="agent-chat__group-head agent-chat__group-head--global">
                  <button
                    type="button"
                    className={`agent-chat__group-fold${collapsedGroups.has(group.groupId) ? ' is-collapsed' : ''}`}
                    title={collapsedGroups.has(group.groupId) ? '展开会话' : '收叠会话'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleGroupFold(group.groupId)
                    }}
                  >
                    {collapsedGroups.has(group.groupId) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  </button>
                  <MessageSquare size={13} className="agent-chat__group-icon" />
                  <span className="agent-chat__group-name">{group.projectName}</span>
                </div>
              )}
              {collapsedGroups.has(group.groupId) && (
                <div className="agent-chat__group-collapsed-hint">
                  已收叠 · {group.sessions.length} 个会话
                </div>
              )}
              {!collapsedGroups.has(group.groupId) && group.sessions.map((s) => (
                <div
                  key={s.id}
                  className={`agent-chat__session${s.id === activeSessionId ? ' is-active' : ''}${s.isArchived ? ' is-archived' : ''}`}
                  onClick={() => openSession(s.id)}
                >
                <div className="agent-chat__session-main">
                  <div className="agent-chat__session-text">
                      <div className="agent-chat__session-name">
                        {s.sessionName || '未命名会话'}
                        {s.isTop && <Star size={12} className="agent-chat__session-top" />}
                        {s.isArchived && <Archive size={11} className="agent-chat__session-arch" />}
                      </div>
                      <div className="agent-chat__session-time">
                        {s.totalTurns > 0 ? `${s.totalTurns} 轮 · ` : ''}
                        {formatTime(s.updatedAt ? s.updatedAt : undefined)}
                      </div>
                    </div>
                    {/* 活动会话的运行/待确认状态位：为后续多任务后台执行预留每会话状态展示 */}
                    {s.id === activeSessionId && (pendingApproval || pendingChoice || planApproval) && (
                      <span className="agent-chat__session-badge agent-chat__session-badge--await" title="任务挂起，等待你确认 / 选择 / 审批">
                        待确认
                      </span>
                    )}
                    {/* loading 指示按【会话自身】是否在跑来判断：切到历史会话时不会跟着
                        当前会话跑过来（运行态已按会话隔离）；仅当正查看该会话且处于挂起
                        决策时才让位给「待确认」徽标。 */}
                    {isSessionRunning(s.id) && !(s.id === activeSessionId && (pendingApproval || pendingChoice || planApproval)) && (
                      <Loader2 size={13} className="agent-chat__session-spin" />
                    )}
                  </div>
                  <div className="agent-chat__session-ops" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu
                      align="right"
                      items={[
                        { label: '重命名', icon: <Pencil size={13} />, onClick: () => void renameSessionHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: false, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' }) },
                        { label: s.isTop ? '取消置顶' : '置顶', icon: s.isTop ? <PinOff size={13} /> : <Pin size={13} />, onClick: () => void toggleSessionTopHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: false, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' }) },
                        { label: s.isArchived ? '取消归档' : '归档', icon: s.isArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />, onClick: () => void archiveSessionHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: s.isArchived, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' }) },
                        { label: '删除会话', icon: <Trash2 size={13} />, danger: true, onClick: () => void removeSession(s.id) },
                      ]}
                      trigger={
                        <span className="agent-chat__session-more" title="更多操作">
                          <MoreVertical size={13} />
                        </span>
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      {/* 中间会话区 */}
      <section className="agent-chat__main">
        <div
          className="agent-chat__scroll"
          ref={scrollRef}
          onWheel={(e) => {
            // 用户滚轮意图：向上滚 = 立即解除跟随（回看历史不被拉回）；向下滚回底部附近 = 恢复跟随。
            if (e.deltaY < 0) {
              setFollowBottom(false)
            } else {
              const el = scrollRef.current
              if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
                setFollowBottom(true)
                scheduleFollowScroll()
              }
            }
          }}
          onScroll={() => {
            // 解除跟随只认「真实的用户向上滚动」：
            //  - scrollTop 减小（程序贴底只会单调增到最大值）且明显远离底部（>120px）
    //    = 用户拖动滚动条/触摸板向上 → 解除；
            //  - 内容收缩导致的 scrollTop 钳制 distance=0，不会误判。
            // 手动滚回底部附近恢复跟随；数据增长不触发 scroll 事件，不会误解除。
            const el = scrollRef.current
            if (!el) return
            const st = el.scrollTop
            const distance = el.scrollHeight - st - el.clientHeight
            if (st < lastScrollTopRef.current - 2 && distance > 120) setFollowBottom(false)
            if (distance <= 8) setFollowBottom(true)
            lastScrollTopRef.current = st
          }}
        >
          {displayMessages.map((m, idx) => {
            const isLastAgent = idx === displayMessages.length - 1 && m.role === 'agent'
            const content = isLastAgent ? displayedContent : m.content
            const conversationMs =
              m.completedAt && displayMessages[0]?.createdAt
                ? m.completedAt - displayMessages[0].createdAt
                : 0
            return (
              <div key={m.id} className={`agent-chat__msg agent-chat__msg--${m.role}`}>
                <div
                  className={`agent-chat__avatar agent-chat__avatar--msg${
                    m.role === 'user' ? ' agent-chat__avatar--user' : ''
                  }`}
                >
                  {m.role === 'agent' ? (
                    agent.logo ? (
                      <img src={agent.logo} alt={agent.name} />
                    ) : (
                      <Bot size={18} />
                    )
                  ) : (
                    '我'
                  )}
                </div>
                <div className="agent-chat__content">
                  {m.role === 'agent' && (
                    <div className="agent-chat__msg-head">
                      <span className="agent-chat__msg-name">{agent.name}</span>
                      {m.completedAt && (
                        <div className="agent-chat__msg-meta">
                          <span title="本次消耗 token 数">
                            <Coins size={13} />
                            {m.tokenCount ?? estimateTokens(content)} tokens
                          </span>
                          <span title="对话总时长">
                            <MessageSquare size={13} />
                            {formatConversationDuration(conversationMs)}
                          </span>
                          <span title="本轮耗时">
                            <Clock size={13} />
                            {formatDuration(m.durationMs ?? 0)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="agent-chat__imgs">
                      {m.attachments.map((att, i) =>
                        att.type === 'image' ? (
                          <img
                            key={i}
                            src={att.dataUrl}
                            alt={att.name ?? `img-${i}`}
                            className="agent-chat__img"
                            onClick={() => att.dataUrl && setPreviewSrc(att.dataUrl)}
                          />
                        ) : (
                          <span key={i} className={`agent-chat__attach-chip agent-chat__attach-chip--${att.type}`}>
                            {att.type === 'text' ? (
                              <FileText size={14} />
                            ) : (
                              fileExtIcon(att.name)
                            )}
                            <span className="agent-chat__attach-chip-name">
                              {att.name ?? (att.type === 'file' ? '文件' : '文本')}
                            </span>
                            {typeof att.size === 'number' && att.size > 0 && (
                              <span className="agent-chat__attach-chip-size">{formatSize(att.size)}</span>
                            )}
                            {att.type === 'file' && att.path && (
                              <span className="agent-chat__attach-chip-path" title={att.path}>
                                {att.path}
                              </span>
                            )}
                            {att.type === 'text' && att.content && (
                              <span className="agent-chat__attach-chip-preview">
                                {textPreview(att.content)}
                              </span>
                            )}
                          </span>
                        ),
                      )}
                    </div>
                  )}
                  {m.role === 'agent' && m.segments && m.segments.length > 0 ? (
                    (() => {
                      const segs = m.segments
                      const toolById = new Map<string, ToolStep>(
                        (m.toolSteps ?? []).map((t) => [t.callId ?? '', t]),
                      )
                      const psOf = (t?: ToolStep) =>
                        t ? m.planSteps?.find((p) => p.step === t.step) : undefined
                      const renderTool = (callId: string | undefined, i: number) => {
                        const t = toolById.get(callId ?? '')
                        if (!t) return null
                        const ps = psOf(t)
                        return (
                          <ToolStepLine
                            key={`${callId}-${i}`}
                            step={t}
                            verified={ps?.verified}
                            evidence={ps?.evidence}
                          />
                        )
                      }
                      const renderText = (text: string | undefined, i: number) => (
                        <div key={i} className="agent-chat__seg-text">
                          <TypewriterMarkdown
                            text={text}
                            active={isLastAgent && (isStreaming || isRunning) && i === segs.length - 1}
                            kbSources={m.kbSources}
                          />
                        </div>
                      )
                      // 运行中（最后一条且流式/运行态）：交错时间线全展开（旁白行+工具块穿插）。
                      // 思考段（推理 + 旁白）走打字机逐字流出；已打完的段保持全文不动。
                      if (isLastAgent && (isStreaming || isRunning)) {
                        const live = isStreaming || isRunning
                        return (
                          <div className="agent-chat__timeline">
                            {segs.map((s, i) =>
                              s.kind === 'thought' ? (
                                // 仅最后一个段参与打字（串行）：被新段顶替的段由 hook 非激活分支直接补全，
                                // 避免多行并发打字（#20260918011 真机反馈）。
                                <ThoughtSegmentLine key={i} text={s.text} active={live && i === segs.length - 1} />
                              ) : s.kind === 'text' ? (
                                renderText(s.text, i)
                              ) : (
                                renderTool(s.callId, i)
                              ),
                            )}
                          </div>
                        )
                      }
                      // 已结束：最后一个 text 段作为正文气泡（最终交付），其余段收进折叠块。
                      // K3-2 热修：text 段意外为空时回退 m.content（终态固化已写入全文），
                      // 双路皆空才显示占位——任何情况下正文气泡不得为空。
                      let lastTextIdx = -1
                      for (let i = segs.length - 1; i >= 0; i--) {
                        if (segs[i].kind === 'text') {
                          lastTextIdx = i
                          break
                        }
                      }
                      const collapsed = segs.filter((_, i) => i !== lastTextIdx)
                      const finalText =
                        (lastTextIdx >= 0 ? (segs[lastTextIdx].text ?? '') : '') || m.content
                      return (
                        <>
                          {collapsed.length > 0 && (
                            <ProcessCollapse
                              items={collapsed}
                              toolById={toolById}
                              psOf={psOf}
                            />
                          )}
                          <div className="agent-chat__bubble">
                            {finalText ? (
                              <CiteAwareMarkdown text={finalText} kbSources={m.kbSources} />
                            ) : (
                              <span className="agent-chat__thinking">（智能体未返回文本内容）</span>
                            )}
                          </div>
                          {/* K3-2 任务级引用来源：本轮知识检索命中的去重溯源列表（气泡底部，不进折叠块）。 */}
                          <KbSourceList hits={m.kbSources} />
                        </>
                      )
                    })()
                  ) : (
                    <>
                  {(m.thought?.length ?? 0) > 0 && (
                    <ThoughtPanel
                      thoughts={m.thought ?? []}
                      active={isLastAgent && (isStreaming || isRunning)}
                    />
                  )}
                  {m.role === 'agent' && (m.toolSteps?.length ?? 0) > 0 && (
                    <div className="agent-chat__tools">
                      {m.toolSteps!.map((t) => {
                        // 工具步归属的某个规划步骤（用 ToolStep.step 反查），用于显示「已验证/暂定」角标。
                        const ps = m.planSteps?.find((p) => p.step === t.step)
                        return (
                          <ToolStepLine
                            key={t.callId}
                            step={t}
                            verified={ps?.verified}
                            evidence={ps?.evidence}
                          />
                        )
                      })}
                    </div>
                  )}
                  <div className="agent-chat__bubble">
                    {m.role === 'agent' ? (
                      content ? (
                        <MarkdownRenderer content={stripWinVerbatimInText(content)} />
                      ) : isLastAgent && (isStreaming || isRunning) ? (
                        // 「思考中…」只属于最后一条 agent 气泡（页面级 running 状态）：
                        // 历史轮正文为空（如 MCP 轮次未回填）时套用 running 会全部误显
                        // 「思考中…」，应如实显示未返回文本（2026-09-21 用户实锤）。
                        <span className="agent-chat__thinking">思考中…</span>
                      ) : (
                        <span className="agent-chat__thinking">（智能体未返回文本内容）</span>
                      )
                    ) : (
                      <span className="agent-chat__plain">{m.content}</span>
                    )}
                  </div>
                    </>
                  )}
                  {m.role === 'agent' && m.error && (
                    <div className="agent-chat__error-panel">
                      <div className="agent-chat__error-head">
                        <TriangleAlert size={16} />
                        <span className="agent-chat__error-title">任务执行出错</span>
                        <span className="agent-chat__error-time">{formatTime(m.error.at)}</span>
                      </div>
                      <pre className="agent-chat__error-body">{m.error.message}</pre>
                      <div className="agent-chat__error-actions">
                        <Button variant="ghost" size="sm" onClick={() => copyError(m.error!.message)}>
                          复制错误详情
                        </Button>
                        {/* 恢复挂起与整轮错误常态互斥（error 终态会清 recovery）；残留时给入口直达右栏 */}
                        {recovery && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setRightOpen(true)
                              setRightTab('process')
                            }}
                          >
                            查看恢复面板
                          </Button>
                        )}
                        {/* 整轮级失败：同一 user prompt 原地重跑（复用 regenerate，不重发消息） */}
                        <Button
                          variant="solid"
                          size="sm"
                          disabled={isRunning}
                          onClick={() => handleRegenerate(m.id)}
                        >
                          <RefreshCw size={14} />
                          重试本轮
                        </Button>
                      </div>
                    </div>
                  )}
                  {/* 文件路径卡片：从正文提取路径渲染。打字进行中（最后一条且流式）不渲染——
                      否则正文里的路径先打完整，卡片会提前挂出打断阅读（#20260918011 真机反馈）。 */}
                  {m.role === 'agent' && !(isLastAgent && isStreaming) && (
                    <FilePathCards content={isLastAgent ? displayedContent : m.content} />
                  )}
                  {m.role === 'agent' && m.completedAt && (
                    <MessageActions
                      msg={m}
                      agent={agent}
                      onRegenerate={() => handleRegenerate(m.id)}
                      onCopyFull={() => void copyMessageRecord(m)}
                    />
                  )}
                </div>
              </div>
            )
          })}
          {statusText && <div className="agent-chat__status">{statusText}</div>}
        </div>

        {/* 底部输入工具条：仿 WorkBuddy 的大圆角输入框，工具按钮内嵌在框底 */}
        <footer className="agent-chat__input">
          {/* 待处置提醒卡（方案 B 轻量）：贴输入框上方、与输入框同宽居中；挂起期间常驻，点击直达「处置」Tab */}
          {(pendingApproval || recovery || pendingChoice || planApproval) && (
            <button
              type="button"
              className="agent-chat__action-banner"
              onClick={() => {
                setRightOpen(true)
                setRightTab('actions')
              }}
            >
              <TriangleAlert size={14} />
              <span>
                {pendingApproval
                  ? '有敏感操作待授权，需要你的决策'
                  : recovery
                    ? `步骤 ${recovery.step}「${recovery.title}」受阻，需要你的决策`
                    : pendingChoice
                      ? '智能体需要你选择一个方案'
                      : '计划已生成，等待你审批'}
              </span>
              <span className="agent-chat__action-banner-go">前往处置 →</span>
            </button>
          )}
          <div
            className={`agent-chat__input-box${dragOver ? ' agent-chat__input-box--drag' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              if (!dragOver) setDragOver(true)
            }}
            onDragLeave={(e) => {
              // 仅当真正离开 input-box 整体时收起（避免子元素冒泡误触发）
              if (e.currentTarget === e.target) setDragOver(false)
            }}
            onDrop={(e) => {
              // 在输入框内落盘：阻止冒泡到整窗处理器，避免重复添加。
              e.preventDefault()
              e.stopPropagation()
              setDragOver(false)
              // 关键：落在输入框内时，根容器 onDrop 被冒泡阻断、不会执行，
              // 必须就地复位整窗拖拽吸附状态，否则遮罩会卡死（文件已进输入框但遮罩不消失）。
              dragDepth.current = 0
              setWindowDrag(false)
              const files = Array.from(e.dataTransfer.files ?? [])
              if (files.length) addFiles(files)
            }}
          >
            <div
              className="agent-chat__input-resizer"
              title="向上拖动调整输入框高度"
              onMouseDown={startInputResize}
            />
            <textarea
              ref={textareaRef}
              className="agent-chat__textarea"
              value={input}
              placeholder={mentionTags.length ? '' : '输入消息，Enter 发送，Shift+Enter 换行；输入 @ 提及技能/MCP，/ 唤起快捷指令'}
              autoComplete="off"
              rows={2}
              disabled={agentBusy}
              style={{ height: inputHeight }}
              onChange={handleInputChange}
              onPaste={onPaste}
              onClick={handleCaretMove}
              onKeyUp={handleCaretMove}
              onKeyDown={handleInputKeyDown}
            />

            {/* @提及 已选标签（chip）：独立于文本框，发送时序列化为「@标签」前缀 */}
            {mentionTags.length > 0 && (
              <div className="agent-chat__mentions">
                {mentionTags.map((t) => (
                  <span key={t.key} className="agent-chat__mention">
                    <span className="agent-chat__mention-label">{t.label}</span>
                    <button
                      type="button"
                      className="agent-chat__mention-close"
                      aria-label="移除提及"
                      disabled={isRunning}
                      onClick={() => setMentionTags((prev) => prev.filter((x) => x.key !== t.key))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* @提及 / /指令 建议浮层：随光标处的触发词展开，键盘 + 鼠标均可选中 */}
            {suggest && suggest.items.length > 0 && (
              <div className="agent-chat__suggest" role="listbox">
                {(() => {
                  const groups: Record<string, SuggestItem[]> = {}
                  for (const it of suggest.items) (groups[it.group] ||= []).push(it)
                  let flatIndex = -1
                  return Object.entries(groups).map(([g, list]) => (
                    <div key={g} className="agent-chat__suggest-group">
                      <div className="agent-chat__suggest-head">{g}</div>
                      {list.map((it) => {
                        flatIndex += 1
                        const idx = flatIndex
                        const active = idx === suggest.index
                        return (
                          <div
                            key={it.key}
                            role="option"
                            aria-selected={active}
                            className={`agent-chat__suggest-item${active ? ' is-active' : ''}`}
                            onMouseEnter={() => setSuggest((s) => (s ? { ...s, index: idx } : s))}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              if (suggest.mode === 'mention') applyMention(it)
                              else runCommand(it)
                            }}
                          >
                            <span className="agent-chat__suggest-label">{it.label}</span>
                            {it.sub && <span className="agent-chat__suggest-sub">{it.sub}</span>}
                          </div>
                        )
                      })}
                    </div>
                  ))
                })()}
              </div>
            )}

            {pendingAttachments.length > 0 && (
              <div className="agent-chat__attachments">
                {pendingAttachments.map((att) => (
                  <div key={att.id} className={`agent-chat__attach agent-chat__attach--${att.type}`}>
                    {att.type === 'image' ? (
                      <img
                        className="agent-chat__attach-thumb"
                        src={att.dataUrl}
                        alt={att.name ?? '图片'}
                        onClick={() => att.dataUrl && setPreviewSrc(att.dataUrl)}
                      />
                    ) : (
                      <span className="agent-chat__attach-icon">
                        {att.type === 'text' ? <FileText size={16} /> : fileExtIcon(att.name)}
                      </span>
                    )}
                    <span className="agent-chat__attach-name" title={att.name}>
                      {att.name ?? (att.type === 'file' ? '文件' : '文本')}
                    </span>
                    {typeof att.size === 'number' && att.size > 0 && (
                      <span className="agent-chat__attach-size">{formatSize(att.size)}</span>
                    )}
                    {att.type === 'file' && att.path && (
                      <span className="agent-chat__attach-path" title={att.path}>
                        {att.path}
                      </span>
                    )}
                    {att.type === 'text' && att.content && (
                      <span className="agent-chat__attach-preview">{textPreview(att.content)}</span>
                    )}
                    {att.type === 'image' && !isMultimodal && (
                      <span className="agent-chat__attach-warn" title="当前模型非多模态，图片不会被识别">
                        !
                      </span>
                    )}
                    <button
                      type="button"
                      className="agent-chat__attach-remove"
                      aria-label="移除附件"
                      disabled={isRunning}
                      onClick={() => setPendingAttachments((prev) => prev.filter((x) => x.id !== att.id))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="agent-chat__toolbar">
              <div className="agent-chat__toolbar-left">
                <WorkspaceChip
                  project={projects.find((x) => x.id === pendingProjectId)}
                  onPickDir={() => void changeWorkspaceDir()}
                  onChangeDir={() => void changeWorkspaceDir()}
                  onClear={() => void clearWorkspaceBinding()}
                />
                {agent.allowSandbox && (
                  <span className="agent-chat__chip agent-chat__chip--sandbox">沙箱权限</span>
                )}
                {boundSkills.length > 0 && (
                  <>
                    {/* 合并为单一列表并按移除态排序，避免跨组卸载/重挂导致焦点回弹闪动；
                       同一 skill.id 始终是同一个 DOM 节点，仅顺序在 active(前)/removed(后) 间移动 */}
                    {[...boundSkills]
                      .sort(
                        (a, b) =>
                          Number(removedSkillIds.has(a.id)) -
                          Number(removedSkillIds.has(b.id)),
                      )
                      .map((skill) => (
                        <SkillChip
                          key={skill.id}
                          skill={skill}
                          removed={removedSkillIds.has(skill.id)}
                          onToggle={toggleSkill}
                        />
                      ))}
                  </>
                )}
                {boundMcps.length > 0 && (
                  <>
                    {[...boundMcps]
                      .sort(
                        (a, b) =>
                          Number(removedMcpIds.has(a.mcpId)) -
                          Number(removedMcpIds.has(b.mcpId)),
                      )
                      .map((mcp) => (
                        <McpPill
                          key={mcp.mcpId}
                          mcp={mcp}
                          removed={removedMcpIds.has(mcp.mcpId)}
                          disabledToolIds={disabledMcpToolIds}
                          onToggleRemove={toggleMcp}
                          onToggleTool={toggleMcpTool}
                        />
                      ))}
                  </>
                )}
                {/* 已挂载插件（P2 新增）：图标胶囊（长名用 icon 代替），悬浮 Pop 列详情 + 临时取消挂载 */}
                {boundPlugins.length > 0 && (
                  <PluginPill
                    plugins={boundPlugins}
                    removedIds={removedPluginIds}
                    onToggleRemove={togglePlugin}
                  />
                )}
              </div>

              <div className="agent-chat__toolbar-right">
                <LiveTokenCounter usage={liveTokenUsage} running={isRunning} />
                <TokenRing
                  windowTokens={lastLlmUsage?.promptTokens ?? 0}
                  sessionPrompt={activeSession?.totalPromptTokens ?? 0}
                  sessionCompletion={activeSession?.totalCompletionTokens ?? 0}
                  sessionTools={activeSession?.toolsTokens ?? 0}
                  limit={contextLength}
                />
                {isMultimodal && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="上传图片"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImagePlus size={18} />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  title="上传文件（图片 / 文本 / 文档等，任意模型可用）"
                  onClick={() => fileAttachRef.current?.click()}
                >
                  <Paperclip size={18} />
                </Button>
                {hasStt && (
                  <Button
                    variant={recording ? 'solid' : 'ghost'}
                    size="sm"
                    title={recording ? '停止语音输入' : '语音输入'}
                    onClick={toggleVoice}
                  >
                    <Mic size={18} className={recording ? 'agent-chat__mic-on' : ''} />
                  </Button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? [])
                    addFiles(files)
                    e.target.value = ''
                  }}
                />
                <input
                  ref={fileAttachRef}
                  type="file"
                  accept="*/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? [])
                    addFiles(files)
                    e.target.value = ''
                  }}
                />
                {isRunning ? (
                  <Button variant="solid" size="sm" title="停止" onClick={cancel}>
                    <Square size={16} />
                  </Button>
                ) : (
                  <Button
                    variant="solid"
                    size="sm"
                    title={agentBusy ? '已有任务在运行' : '发送'}
                    disabled={!input.trim() || agentBusy}
                    onClick={send}
                  >
                    <Send size={16} />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </footer>

      </section>

      {/* 右侧投影面板：图（本轮 DAG）/ 过程 / 产物（方案 C Graph-first） */}
      {rightOpen ? (
        <>
          <div className="agent-chat__resize" ref={resizeElRef} onMouseDown={startResize} title="拖拽调节宽度" />
          <aside className="agent-chat__right" style={{ width: rightWidth }}>
          <div className="agent-chat__right-tabs">
            <button
              type="button"
              className={`agent-chat__right-tab ${rightTab === 'graph' ? 'is-active' : ''}`}
              onClick={() => setRightTab('graph')}
            >
              <Workflow size={13} />
              图
            </button>
            <button
              type="button"
              className={`agent-chat__right-tab ${rightTab === 'process' ? 'is-active' : ''}`}
              onClick={() => setRightTab('process')}
            >
              <GitBranch size={13} />
              过程
            </button>
            <button
              type="button"
              className={`agent-chat__right-tab ${rightTab === 'artifacts' ? 'is-active' : ''}`}
              onClick={() => setRightTab('artifacts')}
            >
              <Box size={13} />
              产物（{artifacts.length}）
            </button>
            {/* 处置 Tab（弹窗改版 Phase 1）：授权/恢复决策迁移入口；角标=待处置数量 */}
            <button
              type="button"
              className={`agent-chat__right-tab ${rightTab === 'actions' ? 'is-active' : ''}`}
              onClick={() => setRightTab('actions')}
            >
              <TriangleAlert size={13} />
              处置
              {(pendingApproval || recovery || pendingChoice || planApproval) && (
                <span className="agent-chat__right-tab-badge">
                  {(pendingApproval ? 1 : 0) +
                    (recovery ? 1 : 0) +
                    (pendingChoice ? 1 : 0) +
                    (planApproval ? 1 : 0)}
                </span>
              )}
            </button>
            <button
              type="button"
              className="agent-chat__right-collapse"
              title="收起面板"
              onClick={() => setRightOpen(false)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="agent-chat__right-body">
            {rightTab === 'graph' ? (
              <RunDagCanvas
                planSteps={planSteps}
                toolSteps={toolSteps}
                artifacts={artifacts}
                planBranch={session.planBranch}
                planning={session.planning}
                onPreviewArtifact={handlePreviewArtifact}
                onBranchFromStep={handleBranchFromStep}
                onApplyBranch={handleApplyBranch}
                onDismissBranch={handleDismissBranch}
              />
            ) : rightTab === 'process' ? (
              <TracePanel
                intent={session.trace.intent}
                thinking={session.trace.thinking}
                planSteps={planSteps}
                toolSteps={toolSteps}
                planning={session.planning}
              />
            ) : rightTab === 'actions' ? (
              <DecisionCenter
                approval={pendingApproval}
                recovery={recovery}
                choice={pendingChoice}
                planApproval={planApproval}
                agentName={agent?.name ?? ''}
                onApproval={handleApproval}
                onResolve={resolveRecovery}
                onSubmitChoice={submitChoice}
                onResolvePlanApproval={resolvePlanApproval}
              />
            ) : (
              <ArtifactGallery artifacts={artifacts} isTauri={isTauri} />
            )}
          </div>
          {/* 接管详情条：工具栈 / 已改动文件 / 失败命令（决策键已迁至「处置」Tab） */}
          {recovery && (
            <div className="agent-chat__right-recovery">
              <TakeoverPanel recovery={recovery} onPreviewArtifact={handlePreviewArtifact} />
            </div>
          )}
        </aside>
        </>
      ) : (
        <button
          type="button"
          className="agent-chat__right-reopen"
          title="展开执行图"
          onClick={() => setRightOpen(true)}
        >
          <ChevronLeft size={14} />
          <span>执行图</span>
        </button>
      )}

      {/* 图片放大预览（点击气泡/待发区缩略图打开） */}
      <Modal
        open={previewSrc !== null}
        onOpenChange={(o) => {
          if (!o) setPreviewSrc(null)
        }}
        title="图片预览"
        width="min(92vw, 1100px)"
        centered
      >
        {previewSrc && (
          <img
            src={previewSrc}
            alt="预览"
            className="agent-chat__img-preview"
            onClick={() => setPreviewSrc(null)}
          />
        )}
      </Modal>

      {/* §3.2 产物预览：点击画布节点产物调 read_artifact 命令获取内容 */}
      <Modal
        open={artifactPreview !== null || artifactLoading}
        onOpenChange={(o) => {
          if (!o) {
            setArtifactPreview(null)
            setArtifactLoading(false)
          }
        }}
        title={artifactPreview ? `产物预览：${artifactPreview.name}` : '正在读取产物…'}
        width="min(92vw, 1000px)"
        centered
      >
        {artifactLoading && <div className="agent-chat__artifact-loading">正在读取文件内容…</div>}
        {artifactPreview && (
          <div className="agent-chat__artifact-preview">
            {artifactPreview.kind === 'image' && artifactPreview.dataUrl && (
              <img src={artifactPreview.dataUrl} alt={artifactPreview.name} className="agent-chat__artifact-img" />
            )}
            {artifactPreview.kind === 'text' && (
              <>
                <pre className="agent-chat__artifact-text">{artifactPreview.content}</pre>
                {artifactPreview.truncated && (
                  <div className="agent-chat__artifact-truncated">内容过长已截断，完整内容请打开原文件查看</div>
                )}
              </>
            )}
            {artifactPreview.kind === 'directory' && (
              <div className="agent-chat__artifact-dir">
                <div className="agent-chat__artifact-dir-head">目录内容（{artifactPreview.entries?.length ?? 0} 项）</div>
                <ul>
                  {(artifactPreview.entries ?? []).map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </div>
            )}
            {(artifactPreview.kind === 'binary' || artifactPreview.kind === 'error' || artifactPreview.kind === 'not_found') && (
              <div className="agent-chat__artifact-msg">{artifactPreview.content}</div>
            )}
            <div className="agent-chat__artifact-meta">
              <span>类型：{artifactPreview.kind}</span>
              {artifactPreview.size > 0 && <span>大小：{(artifactPreview.size / 1024).toFixed(1)} KB</span>}
              <span>路径：{artifactPreview.path}</span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
