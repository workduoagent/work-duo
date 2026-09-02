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
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Pencil,
  Send,
  Bot,
  Trash2,
  Square,
  Sparkles,
  ChevronRight,
  Copy,
  Volume2,
  RefreshCw,
  Mic,
  ImagePlus,
  Search,
  Plus,
  MessageSquare,
  Star,
} from 'lucide-react'
import { appDataDir, resourceDir } from '@tauri-apps/api/path'
import { Button } from '@/components/ui'
import { AvatarGroup, Avatar } from '@/components/ui/AvatarGroup'
import { useNotify } from '@/components/ui/notify'
import { getAgent, listAgentMcpTools, listAgentSkills } from '@/core/mapper/agent-mapper'
import { listSkills } from '@/core/mapper/skill-mapper'
import { listMcps } from '@/core/mapper/mcp-mapper'
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
} from '@/core/mapper/agent-session-mapper'
import { agentEditPath } from '@/core/router/paths'
import { isTauri } from '@/core/config'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { useAgentSession } from './session/useAgentSession'
import { ToolStepCard } from './session/ToolStepCard'
import { ApprovalNotify } from './session/ApprovalNotify'
import type { ApprovalDecision, ToolStep, ChatAttachmentInput } from './session/types'
import type {
  AgentInfo,
  AgentConversationSession,
  AgentConversationRound,
} from '@/types/core'
import './chat.scss'

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  createdAt: number
  /** 该轮的深度思考/状态文本（绑定到消息，多轮互不串台）。 */
  thought?: string[]
  /** 该轮的工具调用步骤（绑定到消息，多轮互不串台）。 */
  toolSteps?: ToolStep[]
  /** 回复完成时间戳（用于计算对话时长与本条耗时）。 */
  completedAt?: number
  /** 本条回复耗时（ms）。 */
  durationMs?: number
  /** 预估消耗 token 数。 */
  tokenCount?: number
  /** 用户消息附带的图片（多模态）。 */
  images?: ChatAttachmentInput[]
}

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

/** 打字机效果：把完整目标文本逐步显示，避免一次性刷出整段内容。 */
function useTypewriter(text: string, active: boolean, speed = 10) {
  const [displayed, setDisplayed] = useState('')
  const idxRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!active || !text) {
      setDisplayed(text)
      idxRef.current = text.length
      if (timerRef.current) clearTimeout(timerRef.current)
      return
    }
    if (text.startsWith(displayed)) {
      idxRef.current = displayed.length
    } else {
      setDisplayed('')
      idxRef.current = 0
    }
    const step = () => {
      const target = text
      if (idxRef.current >= target.length) return
      idxRef.current += 1
      setDisplayed(target.slice(0, idxRef.current))
      timerRef.current = setTimeout(step, speed)
    }
    timerRef.current = setTimeout(step, speed)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [text, active, speed, displayed])

  return displayed
}

/** 可折叠的思考过程面板：文本思考条目 + 内联工具调用卡片。 */
function ThoughtPanel({
  thoughts,
  toolSteps,
}: {
  thoughts: string[]
  toolSteps: ToolStep[]
}) {
  const [open, setOpen] = useState(false)
  const count = thoughts.length + toolSteps.length
  if (count === 0) return null
  return (
    <div className="agent-chat__thinking-panel">
      <button
        type="button"
        className="agent-chat__thinking-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Sparkles size={14} />
        <span>已深度思考（{count} 步）</span>
        <ChevronRight size={14} className={`agent-chat__thinking-caret${open ? ' is-open' : ''}`} />
      </button>
      {open && (
        <div className="agent-chat__thinking-body">
          {thoughts.map((t, i) => (
            <div key={`n-${i}`} className="agent-chat__thinking-item">
              <span className="agent-chat__thinking-dot" />
              <span className="agent-chat__thinking-note">{t}</span>
            </div>
          ))}
          {toolSteps.map((step) => (
            <ToolStepCard key={step.callId} step={step} />
          ))}
        </div>
      )}
    </div>
  )
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0.0s'
  return `${(ms / 1000).toFixed(1)}s`
}

function formatConversationDuration(ms: number): string {
  if (!ms || ms < 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 简易 token 估算：CJK 字符 ≈ 1 token；其余按空格分词 ≈ 1.3 token/词。 */
function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[一-鿿　-〿぀-ゟ゠-ヿ가-힯]/g) ?? []).length
  const nonCjk = text.replace(/[一-鿿　-〿぀-ゟ゠-ヿ가-힯]/g, ' ')
  const words = nonCjk.trim().split(/\s+/).filter(Boolean).length
  return Math.ceil(cjk + words * 1.3)
}

/** 单个工具 / 技能定义占用的上下文 token 估算值（工具定义理论上固定，移除 Skill / 停用 MCP 时下调）。 */
const AVG_TOOL_TOKENS = 300

/** 根据占比（0~1）返回绿色→黄色→红色的渐变色（越接近上限越红）。 */
function ringColor(ratio: number): string {
  const p = Math.max(0, Math.min(1, ratio))
  const green: [number, number, number] = [82, 196, 26] // --color-success
  const yellow: [number, number, number] = [250, 173, 20] // --color-warning
  const red: [number, number, number] = [255, 77, 79] // --color-danger
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)
  let from: [number, number, number]
  let to: [number, number, number]
  let t: number
  if (p < 0.5) {
    from = green
    to = yellow
    t = p / 0.5
  } else {
    from = yellow
    to = red
    t = (p - 0.5) / 0.5
  }
  return `rgb(${lerp(from[0], to[0], t)}, ${lerp(from[1], to[1], t)}, ${lerp(from[2], to[2], t)})`
}

/** token 环形图 + 悬浮明细：已消耗上下文（提示词 + 对话 + 工具）占上下文限制的比例。
 * 单一环，无中心数字，越接近 100% 颜色由绿→黄→红；悬浮显示上下文总数 / 输入占比 / 对话占比 / 工具占比。 */
function TokenRing({
  promptTokens,
  completionTokens,
  toolsTokens,
  limit,
}: {
  promptTokens: number
  completionTokens: number
  toolsTokens: number
  limit?: number
}) {
  const size = 22
  const stroke = 3
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const used = promptTokens + completionTokens + toolsTokens
  const ratio = limit && limit > 0 ? used / limit : 0
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = c * clamped
  const color = used > 0 ? ringColor(ratio) : 'var(--color-border)'
  const pct = limit && limit > 0 ? Math.round(ratio * 100) : null
  const total = Math.max(1, used)
  const inputPct = Math.round((promptTokens / total) * 100)
  const completionPct = Math.round((completionTokens / total) * 100)
  const toolPct = Math.round((toolsTokens / total) * 100)
  return (
    <span
      className="agent-chat__token-ring"
      tabIndex={0}
      title={
        pct !== null
          ? `已消耗 ${used} / ${limit} tokens（${pct}%）`
          : `已消耗 ${used} tokens`
      }
    >
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-border)" strokeWidth={stroke} fill="none" />
        {used > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${c}`}
            strokeDashoffset={0}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="agent-chat__token-pop">
        <div className="agent-chat__token-pop-title">
          上下文总数：{used} tokens{pct !== null ? `（${pct}% 窗口）` : ''}
        </div>
        <div className="agent-chat__token-pop-row">
          <span>输入占比</span>
          <span>{inputPct}%</span>
        </div>
        <div className="agent-chat__token-pop-row">
          <span>对话占比</span>
          <span>{completionPct}%</span>
        </div>
        <div className="agent-chat__token-pop-row">
          <span>工具占比</span>
          <span>{toolPct}%</span>
        </div>
      </span>
    </span>
  )
}

/** 单条助手消息底部的操作按钮 + 元数据。 */
function MessageActions({
  msg,
  agent,
  firstMessageAt,
  onRegenerate,
}: {
  msg: ChatMessage
  agent: AgentInfo
  firstMessageAt?: number
  onRegenerate: () => void
}) {
  const { message } = useNotify()

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(msg.content)
      message.success('已复制')
    } catch {
      message.error('复制失败')
    }
  }, [msg.content, message])

  const handleSpeak = useCallback(() => {
    if (!window.speechSynthesis) {
      message.warning('当前环境不支持朗读')
      return
    }
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(msg.content)
    u.lang = 'zh-CN'
    window.speechSynthesis.speak(u)
  }, [msg.content, message])

  const conversationMs = msg.completedAt && firstMessageAt ? msg.completedAt - firstMessageAt : 0

  return (
    <div className="agent-chat__msg-footer">
      <div className="agent-chat__msg-actions">
        <button type="button" title="复制正文" onClick={handleCopy}>
          <Copy size={14} />
          <span>复制</span>
        </button>
        {agent.ttsId && (
          <button type="button" title="朗读" onClick={handleSpeak}>
            <Volume2 size={14} />
            <span>朗读</span>
          </button>
        )}
        <button type="button" title="重新生成" onClick={onRegenerate}>
          <RefreshCw size={14} />
          <span>重新生成</span>
        </button>
      </div>
      <div className="agent-chat__msg-meta">
        <span>消耗 {msg.tokenCount ?? estimateTokens(msg.content)} tokens</span>
        <span>对话 {formatConversationDuration(conversationMs)}</span>
        <span>耗时 {formatDuration(msg.durationMs ?? 0)}</span>
      </div>
    </div>
  )
}

/** 把历史轮次转为消息流（用于点击左侧会话加载）。 */
function roundsToMessages(rounds: AgentConversationRound[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const r of rounds) {
    if (r.userQuestion) {
      msgs.push({
        id: `u-${r.id}`,
        role: 'user',
        content: r.userQuestion,
        createdAt: r.startTime ?? Date.now(),
      })
    }
    msgs.push({
      id: `a-${r.id}`,
      role: 'agent',
      content: r.assistantAnswer ?? '',
      createdAt: r.endTime ?? Date.now(),
      thought: r.thinkingContent ? r.thinkingContent.split('\n') : undefined,
      completedAt: r.endTime,
      durationMs: r.startTime && r.endTime ? r.endTime - r.startTime : undefined,
      tokenCount: (r.inputTokens ?? 0) + (r.outputTokens ?? 0) || estimateTokens(r.assistantAnswer ?? ''),
    })
  }
  return msgs
}

export default function AgentChatPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message } = useNotify()

  const [agent, setAgent] = useState<AgentInfo | undefined>()
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [toolCount, setToolCount] = useState(0)
  const [skillCount, setSkillCount] = useState(0)

  // 能力：多模态 / STT
  const [isMultimodal, setIsMultimodal] = useState(false)
  const [hasStt, setHasStt] = useState(false)

  // 底部工具条展示用：MCP 服务别名列表 / 技能名列表 / 工作空间路径
  const [mcpServers, setMcpServers] = useState<string[]>([])
  const [skillNames, setSkillNames] = useState<string[]>([])
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
  // 绑定 LLM 的上下文窗口（token），用于环形图占比分母
  const [contextLength, setContextLength] = useState<number | undefined>()

  // 会话列表 + 当前会话
  const [sessions, setSessions] = useState<AgentConversationSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionSearch, setSessionSearch] = useState('')

  // 多模态图片附件
  const [pendingImages, setPendingImages] = useState<ChatAttachmentInput[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 语音输入
  const [recording, setRecording] = useState(false)
  const recognitionRef = useRef<unknown>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const replyStartRef = useRef<number | null>(null)
  const prevIsRunningRef = useRef(false)
  const roundIdRef = useRef<string | null>(null)
  const roundIndexRef = useRef(0)
  const lastPromptRef = useRef('')
  const lastTokensRef = useRef<{ input: number; output: number }>({ input: 0, output: 0 })

  const session = useAgentSession()
  const { toolSteps, streamingText, isStreaming, statusText, thoughts, isRunning, pendingApproval, run, submitDecision, reset, cancel } =
    session

  const lastAgentContent =
    messages.length > 0 && messages[messages.length - 1].role === 'agent'
      ? messages[messages.length - 1].content
      : ''
  const displayedContent = useTypewriter(lastAgentContent, isStreaming)

  // 加载智能体 + 工具/技能计数 + 能力判定 + 工作空间 + 会话列表
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [a, mcp, skills] = await Promise.all([
          getAgent(id),
          listAgentMcpTools(id),
          listAgentSkills(id),
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

        // MCP 服务别名 + 技能名（底部 Avatar.Group 展示）
        const [allMcps, allSkills] = await Promise.all([listMcps(), listSkills()])
        const serverIds = [...new Set(mcp.map((r) => r.mcpId))]
        const servers = serverIds
          .map((mid) => allMcps.find((m) => m.id === mid))
          .filter((m): m is NonNullable<typeof m> => !!m)
          .map((m) => m.aliasName || m.mcpName)
        const names = skills
          .map((s) => allSkills.find((x) => x.id === s.skillId))
          .filter((s): s is NonNullable<typeof s> => !!s)
          .map((s) => s.name)
        if (alive) {
          setMcpServers(servers)
          setSkillNames(names)
        }

        // 工作空间：解析默认路径（单人调试不自定义）
        const ws = await resolveWorkspaceDir(a)
        if (alive) setWorkspaceDir(ws)

        // 会话列表
        const list = await listSessions(a.identifier)
        if (alive) setSessions(list)
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
    reset()
    setMessages([])
    setActiveSessionId(null)
    roundIndexRef.current = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // 新消息 / 工具步骤 / 流式文本变化时滚动到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, toolSteps, streamingText])

  /** 持久化一轮：确保有会话 → 追加 round → 记录 roundId / 序号。 */
  const ensureRound = useCallback(
    async (prompt: string): Promise<void> => {
      if (!agent) return
      let sessionId = activeSessionId
      if (!sessionId) {
        const sess = await createSession(agent.identifier, prompt.slice(0, 40))
        sessionId = sess.id
        setActiveSessionId(sess.id)
        // 估算工具 / Skill 定义占用的上下文 token（理论固定，移除 Skill / 停用 MCP 时下调）
        const toolsTokens = Math.round((toolCount + skillCount) * AVG_TOOL_TOKENS)
        await updateSession(sess.id, { toolsTokens })
        const list = await listSessions(agent.identifier)
        setSessions(list.map((s) => (s.id === sess.id ? { ...s, toolsTokens } : s)))
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
    },
    [agent, activeSessionId, toolCount, skillCount],
  )

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || isRunning || !agent) return

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
      images: pendingImages.length ? pendingImages : undefined,
    }
    const agentMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      role: 'agent',
      content: '',
      createdAt: Date.now(),
    }
    setMessages((prev) => [...prev, userMsg, agentMsg])
    setInput('')
    setPendingImages([])
    lastPromptRef.current = text

    replyStartRef.current = Date.now()
    const attachments = pendingImages
    void ensureRound(text).then(() => {
      void run({ agentId: agent.id, prompt: text, workspace: workspaceDir, attachments, sessionId: activeSessionId ?? undefined, roundId: roundIdRef.current ?? undefined })
    })
  }, [input, isRunning, agent, run, workspaceDir, pendingImages, ensureRound])

  // 将 session 的流式文本/思考/工具步骤同步进「最后一条助手气泡」
  useEffect(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'agent') {
        return [...prev.slice(0, -1), { ...last, content: streamingText, thought: thoughts, toolSteps }]
      }
      return prev
    })
  }, [streamingText, thoughts, toolSteps])

  // 任务结束（完成/异常/取消）时，补全耗时、token 与历史持久化
  useEffect(() => {
    if (prevIsRunningRef.current && !isRunning) {
      const completedAt = Date.now()
      const durationMs = replyStartRef.current ? completedAt - replyStartRef.current : undefined
      replyStartRef.current = null
      const answer = streamingText || lastAgentContent
      const inputTokens = estimateTokens(lastPromptRef.current)
      const outputTokens = estimateTokens(answer)
      lastTokensRef.current = { input: inputTokens, output: outputTokens }

      // 回填历史轮次
      if (roundIdRef.current) {
        void updateRound(roundIdRef.current, {
          assistantAnswer: answer,
          thinkingContent: thoughts.join('\n'),
          toolCallsSummary: toolSteps.map((s) => ({
            name: s.toolName,
            status: s.status,
            args: s.args,
            result: s.result,
          })),
          inputTokens,
          outputTokens,
          endTime: completedAt,
        })
        roundIdRef.current = null
      }
      // 累计 token（提示词 + 对话）并回填会话状态
      if (activeSessionId) {
        void (async () => {
          await addSessionTokens(activeSessionId, inputTokens, outputTokens)
          await updateSession(activeSessionId, {
            status: statusText ? 'ERROR' : 'COMPLETED',
            endTime: completedAt,
          })
          // 重新读取会话以刷新环形图占比：
          //  - Tauri 路径：后端在每轮 run_task 已按当前 MCP/Skill 工具数动态重算并回写 tools_tokens，
          //    因此中途移除 Skill / 停用 MCP 后，这里读到的 tools_tokens 已自动下调。
          //  - 浏览器 dev / mock 路径无后端，回退到本地按当前 toolCount+skillCount 估算。
          const fresh = await getSession(activeSessionId)
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== activeSessionId) return s
              if (!fresh) {
                // 兜底：本地累加（与后端保持一致）
                return {
                  ...s,
                  totalPromptTokens: (s.totalPromptTokens ?? 0) + inputTokens,
                  totalCompletionTokens: (s.totalCompletionTokens ?? 0) + outputTokens,
                }
              }
              const toolsTokens = isTauri
                ? fresh.toolsTokens
                : Math.round((toolCount + skillCount) * AVG_TOOL_TOKENS)
              return { ...fresh, toolsTokens: toolsTokens ?? fresh.toolsTokens }
            }),
          )
        })()
      }

      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'agent') {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              content: answer,
              thought: thoughts,
              toolSteps,
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
  }, [isRunning, streamingText, thoughts, toolSteps, lastAgentContent, statusText, activeSessionId])

  const handleDecision = useCallback(
    (approved: boolean, reason?: string) => {
      if (!pendingApproval) return
      const decision: ApprovalDecision = {
        approvalId: pendingApproval.approvalId,
        approved,
        reason,
      }
      void submitDecision(decision)
    },
    [pendingApproval, submitDecision],
  )

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
      void ensureRound(userMsg.content).then(() => {
        void run({ agentId: agent.id, prompt: userMsg.content, workspace: workspaceDir, sessionId: activeSessionId ?? undefined, roundId: roundIdRef.current ?? undefined })
      })
    },
    [messages, agent, reset, run, workspaceDir, ensureRound],
  )

  /** 点击左侧历史会话，加载其全部轮次。 */
  const openSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionId) return
      reset()
      setActiveSessionId(sessionId)
      try {
        const rounds = await listRounds(sessionId)
        setMessages(roundsToMessages(rounds))
        roundIndexRef.current = rounds.length
      } catch (e) {
        message.error(`加载会话失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [activeSessionId, reset, message],
  )

  /** 新建对话：清空当前会话，回到欢迎语。 */
  const newChat = useCallback(() => {
    reset()
    setActiveSessionId(null)
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

  const removeSession = useCallback(
    async (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation()
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

  // ---- 多模态图片 ----
  const addImageFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      setPendingImages((prev) => [
        ...prev,
        { type: 'image', dataUrl: reader.result as string, name: file.name },
      ])
    }
    reader.readAsDataURL(file)
  }, [])

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!isMultimodal) return
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of Array.from(items)) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile()
          if (file) addImageFile(file)
        }
      }
    },
    [isMultimodal, addImageFile],
  )

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

  if (loading) {
    return <div className="agent-chat agent-chat--loading">加载中…</div>
  }
  if (!agent) return null

  const filteredSessions = sessions.filter((s) =>
    (s.sessionName ?? '').toLowerCase().includes(sessionSearch.trim().toLowerCase()),
  )

  // 当前会话已消耗 token（提示词 + 对话），用于底部环形图占比
  const activeSession = sessions.find((s) => s.id === activeSessionId)

  return (
    <div className="agent-chat">
      {/* 审批授权：右下角通知形式，不再嵌入对话流 */}
      <ApprovalNotify approval={pendingApproval} agentName={agent?.name ?? ''} onDecision={handleDecision} />

      {/* 左侧会话列表 */}
      <aside className="agent-chat__side">
        <Button variant="solid" size="sm" className="agent-chat__new" onClick={newChat}>
          <Plus size={14} />
          新建对话
        </Button>
        <div className="agent-chat__search">
          <Search size={14} />
          <input
            value={sessionSearch}
            placeholder="搜索会话"
            autoComplete="off"
            onChange={(e) => setSessionSearch(e.target.value)}
          />
        </div>
        <div className="agent-chat__session-list">
          {filteredSessions.length === 0 && (
            <div className="agent-chat__session-empty">暂无历史会话</div>
          )}
          {filteredSessions.map((s) => (
            <div
              key={s.id}
              className={`agent-chat__session${s.id === activeSessionId ? ' is-active' : ''}`}
              onClick={() => openSession(s.id)}
            >
              <div className="agent-chat__session-main">
                <MessageSquare size={15} />
                <div className="agent-chat__session-text">
                  <div className="agent-chat__session-name">
                    {s.sessionName || '未命名会话'}
                    {s.isTop && <Star size={12} className="agent-chat__session-top" />}
                  </div>
                  <div className="agent-chat__session-time">{formatTime(s.createdAt ? Date.parse(s.createdAt) : undefined)}</div>
                </div>
              </div>
              <button
                type="button"
                className="agent-chat__session-del"
                title="删除会话"
                onClick={(e) => removeSession(s.id, e)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* 中间会话区 */}
      <section className="agent-chat__main">
        <header className="agent-chat__head">
          <div className="agent-chat__head-info">
            <div className="agent-chat__avatar">
              {agent.logo ? <img src={agent.logo} alt={agent.name} /> : <Bot size={20} />}
            </div>
            <div>
              <div className="agent-chat__name">{agent.name}</div>
              <div className="agent-chat__sub">
                {agent.identifier}
                {agent.autoToolExecMode && ' · 自动执行'}
                {agent.allowSandbox && ' · 沙箱'}
                {(toolCount > 0 || skillCount > 0) && ` · 已挂 ${toolCount} 工具 / ${skillCount} 技能`}
              </div>
            </div>
          </div>
          <div className="agent-chat__head-actions">
            <Button variant="soft" size="sm" onClick={() => navigate(agentEditPath(agent.id))}>
              <Pencil size={14} />
              编辑智能体
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate('/agent-studio')}>
              <ArrowLeft size={15} />
              返回列表
            </Button>
          </div>
        </header>

        <div className="agent-chat__scroll" ref={scrollRef}>
          {messages.map((m, idx) => {
            const isLastAgent = idx === messages.length - 1 && m.role === 'agent'
            const content = isLastAgent ? displayedContent : m.content
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
                  {m.images && m.images.length > 0 && (
                    <div className="agent-chat__imgs">
                      {m.images.map((img, i) => (
                        <img key={i} src={img.dataUrl} alt={img.name ?? `img-${i}`} className="agent-chat__img" />
                      ))}
                    </div>
                  )}
                  {((m.thought?.length ?? 0) + (m.toolSteps?.length ?? 0) > 0) && (
                    <ThoughtPanel thoughts={m.thought ?? []} toolSteps={m.toolSteps ?? []} />
                  )}
                  <div className="agent-chat__bubble">
                    {m.role === 'agent' ? (
                      content ? (
                        <MarkdownRenderer content={content} />
                      ) : (
                        <span className="agent-chat__thinking">思考中…</span>
                      )
                    ) : (
                      <span className="agent-chat__plain">{m.content}</span>
                    )}
                  </div>
                  {m.role === 'agent' && m.completedAt && (
                    <MessageActions
                      msg={m}
                      agent={agent}
                      firstMessageAt={messages[0]?.createdAt}
                      onRegenerate={() => handleRegenerate(m.id)}
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
          <div className="agent-chat__input-box">
            <textarea
              className="agent-chat__textarea"
              value={input}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              autoComplete="off"
              rows={2}
              disabled={isRunning}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />

            {isMultimodal && pendingImages.length > 0 && (
              <div className="agent-chat__pending-imgs">
                {pendingImages.map((img, i) => (
                  <div key={i} className="agent-chat__pending-img">
                    <img src={img.dataUrl} alt={img.name ?? `img-${i}`} />
                    <button
                      type="button"
                      onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="agent-chat__toolbar">
              <div className="agent-chat__toolbar-left">
                {agent.allowSandbox && (
                  <span className="agent-chat__chip agent-chat__chip--sandbox">沙箱权限</span>
                )}
                {mcpServers.length > 0 && (
                  <AvatarGroup maxCount={4} size={24}>
                    {mcpServers.map((name) => (
                      <Avatar key={name} style={{ background: 'var(--color-primary)' }}>
                        {name.slice(0, 1)}
                      </Avatar>
                    ))}
                  </AvatarGroup>
                )}
                {skillNames.length > 0 && (
                  <AvatarGroup maxCount={4} size={24}>
                    {skillNames.map((name) => (
                      <Avatar key={name} style={{ background: 'var(--color-warning)' }}>
                        {name.slice(0, 1)}
                      </Avatar>
                    ))}
                  </AvatarGroup>
                )}
              </div>

              <div className="agent-chat__toolbar-right">
                <TokenRing
                  promptTokens={activeSession?.totalPromptTokens ?? 0}
                  completionTokens={activeSession?.totalCompletionTokens ?? 0}
                  toolsTokens={activeSession?.toolsTokens ?? 0}
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
                    files.forEach(addImageFile)
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
                    title="发送"
                    disabled={!input.trim()}
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
    </div>
  )
}

/** Web Speech API 的最小类型（浏览器原生，未包含在 DOM lib 的完整定义时兜底）。 */
interface SpeechLike {
  lang: string
  interimResults: boolean
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}
