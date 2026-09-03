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
  X,
  RotateCcw,
  Folder,
  MoreVertical,
  Archive,
  MessageSquarePlus,
  Pin,
  PinOff,
  ArchiveRestore,
  FilePen,
  FolderEdit,
  Unlink,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { appDataDir, resourceDir } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { Button, Switch, Modal, Input } from '@/components/ui'
import { Avatar } from '@/components/ui/AvatarGroup'
import { useNotify } from '@/components/ui/notify'
import { getAgent, listAgentMcpTools, listAgentSkills } from '@/core/mapper/agent-mapper'
import { listSkills } from '@/core/mapper/skill-mapper'
import { readSkillLogoBase64 } from '@/core/file/skillFs'
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
  toggleSessionTop,
  type SessionTreeGroup,
} from '@/core/mapper/agent-session-mapper'
import {
  listProjects,
  getProject,
  ensureProjectByPath,
  updateProject,
  deleteProject,
  leafDirName,
} from '@/core/mapper/agent-project-mapper'
import { readProjectMemory, writeProjectMemory } from '@/core/mapper/wd-mem-mapper'
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
  AgentProject,
} from '@/types/core'
import type { SkillInfo } from '@/core/file/skill-file'
import type { McpToolDefinition } from '@/core/file/mcp-file'
import './chat.scss'

/** 输入框底部工具条里展示的「单个 MCP 服务」及其绑定工具（用于临时移除 / 工具开关）。 */
interface BoundMcpTool {
  /** mcp_tool_definition.id（Rust 过滤键）。 */
  toolId: string
  /** 工具代码 / 展示名。 */
  toolCode: string
  displayName?: string
  description?: string
}
interface BoundMcpServer {
  mcpId: string
  name: string
  tools: BoundMcpTool[]
}

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

/** 打字机效果：把完整目标文本逐步显示，避免一次性刷出整段内容。
 *  自适应追赶：落后目标文本较多时按比例加速吐字（终态一次性推送全文时约 0.5s 追平），
 *  流式小步追加时仍保持 10ms/字符的细腻节奏。 */
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
      const remaining = target.length - idxRef.current
      // 落后超过 200 字符时按比例追赶（约 50 步内追平），否则逐字符推进
      idxRef.current += remaining > 200 ? Math.ceil(remaining / 50) : 1
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
    // 工具调用汇总 → ToolStep 卡片（历史回显时思考面板可完整还原工具调用过程）。
    // 存储格式来自任务结束时的 updateRound：[{ name, status, args, result }]。
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
          }
        })
      : undefined
    msgs.push({
      id: `a-${r.id}`,
      role: 'agent',
      content: r.assistantAnswer ?? '',
      createdAt: r.endTime ?? Date.now(),
      thought: r.thinkingContent ? r.thinkingContent.split('\n') : undefined,
      toolSteps: toolSteps?.length ? toolSteps : undefined,
      completedAt: r.endTime,
      durationMs: r.startTime && r.endTime ? r.endTime - r.startTime : undefined,
      tokenCount: (r.inputTokens ?? 0) + (r.outputTokens ?? 0) || estimateTokens(r.assistantAnswer ?? ''),
    })
  }
  return msgs
}

/** 技能头像 + 临时移除/恢复按钮。
 *  - Logo 优先读技能根目录 logo.<ext>（readSkillLogoBase64），读不到回退首字，与 Skill Hub 一致；
 *  - 悬停（未移除态）显示 × 可临时移除；已移除态显示 ↺ 可恢复；均为纯前端内存态，不写库。 */
function SkillChip({
  skill,
  removed,
  onToggle,
}: {
  skill: SkillInfo
  removed: boolean
  onToggle: (id: string) => void
}) {
  const [logo, setLogo] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void readSkillLogoBase64(skill.identifier)
      .then((url) => {
        if (active) setLogo(url)
      })
      .catch(() => {
        if (active) setLogo(null)
      })
    return () => {
      active = false
    }
  }, [skill.identifier])

  return (
    <span
      className={`agent-chat__skill-chip${removed ? ' is-removed' : ''}`}
      title={removed ? `已临时移除：${skill.name}（点击恢复）` : `${skill.name}（点击临时移除）`}
    >
      <Avatar size={24} src={logo ?? undefined} style={{ background: 'var(--color-warning)' }}>
        {logo ? '' : (skill.name || skill.identifier || '').slice(0, 1)}
      </Avatar>
      <button
        type="button"
        className="agent-chat__skill-toggle"
        // 阻止点击时焦点从输入框转移，避免切换后焦点回弹导致输入框蓝色光晕闪动
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onToggle(skill.id)}
        title={removed ? '恢复此技能' : '临时移除此技能（仅当前会话）'}
        aria-label={removed ? '恢复技能' : '临时移除技能'}
      >
        {removed ? <RotateCcw size={10} /> : <X size={10} />}
      </button>
    </span>
  )
}

/** MCP 服务的文字胶囊 + 悬浮 Pop（移除整个服务 / 单个工具开关）。
 *  - 无头像，纯文字胶囊；多个 MCP 排列在 Skill 之后；
 *  - 悬浮弹出层显示该服务下全部绑定工具，可逐个开/关；
 *  - 移除整个服务或关闭工具均为会话内内存态，不写库；切换/重开会话即恢复。 */
function McpPill({
  mcp,
  removed,
  disabledToolIds,
  onToggleRemove,
  onToggleTool,
}: {
  mcp: BoundMcpServer
  removed: boolean
  disabledToolIds: Set<string>
  onToggleRemove: (mcpId: string) => void
  onToggleTool: (toolId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 工具条在页面底部，弹层向上展开（锚定 bottom，避免溢出视口下沿）
  const [pos, setPos] = useState<{ bottom: number; left: number }>({ bottom: 0, left: 0 })

  const show = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      // 弹层底部贴合胶囊顶部上方 6px；靠近右边界时左移避免溢出视口
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 260))
      setPos({ bottom: window.innerHeight - r.top + 6, left })
    }
    setOpen(true)
  }, [])

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setOpen(false), 140)
  }, [])

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
  }, [])

  return (
    <span
      ref={ref}
      className={`agent-chat__mcp-pill${removed ? ' is-removed' : ''}`}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <span className="agent-chat__mcp-label">{mcp.name}</span>
      {removed ? (
        <button
          type="button"
          className="agent-chat__mcp-toggle"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleRemove(mcp.mcpId)}
          title="恢复此 MCP 服务"
          aria-label="恢复 MCP 服务"
        >
          <RotateCcw size={10} />
        </button>
      ) : (
        <button
          type="button"
          className="agent-chat__mcp-toggle agent-chat__mcp-toggle--remove"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleRemove(mcp.mcpId)}
          title="临时移除整个 MCP 服务（仅当前会话）"
          aria-label="临时移除 MCP 服务"
        >
          <X size={10} />
        </button>
      )}

      {open && !removed && (
        <div
          className="agent-chat__mcp-pop"
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
        >
          <div className="agent-chat__mcp-pop-card">
            <div className="agent-chat__mcp-pop-head">
              <span className="agent-chat__mcp-pop-title">{mcp.name}</span>
              <button
                type="button"
                className="agent-chat__mcp-pop-remove"
                onClick={() => onToggleRemove(mcp.mcpId)}
              >
                移除服务
              </button>
            </div>
            <div className="agent-chat__mcp-pop-tools">
              {mcp.tools.map((t) => (
                <label key={t.toolId} className="agent-chat__mcp-tool">
                  <Switch
                    size="small"
                    checked={!disabledToolIds.has(t.toolId)}
                    onChange={() => onToggleTool(t.toolId)}
                  />
                  <span className="agent-chat__mcp-tool-name" title={t.description}>
                    {t.displayName || t.toolCode}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * 通用点击外部关闭的下拉菜单
 * ---------------------------------------------------------------- */
interface MenuItem {
  label: string
  onClick: () => void
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
}
function DropdownMenu({
  trigger,
  items,
  align = 'right',
  title,
}: {
  trigger: React.ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      // 触发器与浮层（已 portal 到 body）都算内部，点击外部才关闭
      if (wrapRef.current && !wrapRef.current.contains(t) && menuRef.current && !menuRef.current.contains(t)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  // 点击触发器：用触发器实际位置 + fixed 定位。浮层 portal 到 body，
  // 彻底逃逸任何祖先 transform / overflow 裁剪，避免定位大幅偏移。
  const handleClick = () => {
    const el = triggerRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      const width = 168
      const left = align === 'right' ? r.right - width : r.left
      setPos({ top: r.bottom + 4, left: Math.max(8, left) })
    }
    setOpen((o) => !o)
  }
  return (
    <div className="agent-chat__menu-wrap" ref={wrapRef}>
      <span className="agent-chat__menu-trigger" ref={triggerRef} onClick={handleClick}>
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={`agent-chat__menu${align === 'right' ? ' is-right' : ''}`}
            style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: 168 }}
          >
            {title && <div className="agent-chat__menu-title">{title}</div>}
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                className={`agent-chat__menu-item${it.danger ? ' is-danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false)
                  it.onClick()
                }}
              >
                {it.icon && <span className="agent-chat__menu-icon">{it.icon}</span>}
                <span className="agent-chat__menu-label">{it.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 输入框左侧的工作空间胶囊：
 *  - 未绑定目录 → 显示「选择目录」入口（任务态，可选为工程）
 *  - 已绑定目录 → 显示目录名（工程态，可更改 / 清除）
 * ---------------------------------------------------------------- */
function WorkspaceChip({
  project,
  onPickDir,
  onChangeDir,
  onClear,
}: {
  project?: AgentProject
  onPickDir: () => void
  onChangeDir: () => void
  onClear: () => void
}) {
  // 未绑定：任务态，点击选择目录即可升级为工程
  if (!project) {
    return (
      <span
        className="agent-chat__chip agent-chat__chip--pick"
        title="选择工作目录（选中后本会话绑定为工程）"
        onClick={onPickDir}
      >
        <Folder size={12} />
        选择目录
      </span>
    )
  }
  // 已绑定：工程态，显示目录名，可更改 / 清除
  return (
    <DropdownMenu
      align="left"
      trigger={
        <span className="agent-chat__chip agent-chat__chip--workspace" title={project.rootPath}>
          <Folder size={12} />
          {leafDirName(project.rootPath)}
        </span>
      }
      items={[
        { label: '更改工作目录', icon: <FolderEdit size={13} />, onClick: onChangeDir },
        { label: '清除绑定（自由对话）', icon: <Unlink size={13} />, onClick: onClear, danger: true },
      ]}
    />
  )
}

/** 从扁平会话列表 + 工程列表构建树状分组（GLOBAL + 各 PROJECT）。 */
function buildSessionTree(
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
      sessions: arr.map(toItem),
    })
  }
  return groups
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

  // 底部工具条展示用：MCP 服务（含其工具）/ 技能 / 工作空间
  const [boundMcps, setBoundMcps] = useState<BoundMcpServer[]>([])
  // 当前会话内临时移除的 MCP 服务 id（内存态，不写库；切换/重开会话即复位）
  const [removedMcpIds, setRemovedMcpIds] = useState<Set<string>>(new Set())
  // 当前会话内临时关闭的单个 MCP 工具 id（内存态，不写库）。键为 mcp_tool_definition.id
  const [disabledMcpToolIds, setDisabledMcpToolIds] = useState<Set<string>>(new Set())
  const [boundSkills, setBoundSkills] = useState<SkillInfo[]>([])
  // 当前会话内临时移除的技能 id（内存态，不写库；页面重进/切换智能体即复位）
  const [removedSkillIds, setRemovedSkillIds] = useState<Set<string>>(new Set())
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sessionSearch, setSessionSearch] = useState('')

  // 工程记忆编辑器（.wd_mem/project_memory.md）
  const [memoEditor, setMemoEditor] = useState<{ open: boolean; rootPath: string; name: string } | null>(null)
  const [memoContent, setMemoContent] = useState('')
  const [memoSaving, setMemoSaving] = useState(false)

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
  const { toolSteps, streamingText, isStreaming, statusText, thoughts, isRunning, pendingApproval, run, submitDecision, reset, cancel, lastTaskUsage } =
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

        // MCP 服务（含其绑定工具）+ 技能（底部工具条展示）
        const [allMcps, allSkills] = await Promise.all([listMcps(), listSkills()])
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
    reset()
    setMessages([])
    setActiveSessionId(null)
    setRemovedSkillIds(new Set()) // 临时移除的技能随智能体切换复位
    setRemovedMcpIds(new Set()) // 临时移除的 MCP 服务复位
    setDisabledMcpToolIds(new Set()) // 临时关闭的 MCP 工具复位
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
    [agent, activeSessionId, toolCount, skillCount, removedSkillIds, removedMcpIds, disabledMcpToolIds, boundMcps, pendingProjectId],
  )

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
    const disabledSkillIds = [...removedSkillIds]
    const disabledMcpIds = [...removedMcpIds]
    const disabledMcpToolIdsArr = [...disabledMcpToolIds]
    void ensureRound(text).then(() => {
      void run({
        agentId: agent.id,
        prompt: text,
        workspace: workspaceDir,
        attachments,
        sessionId: activeSessionId ?? undefined,
        roundId: roundIdRef.current ?? undefined,
        // 临时移除的技能 / MCP 服务 / MCP 工具：随本轮请求传给 Rust，从智能体工具集中剔除
        disabledSkillIds,
        disabledMcpIds,
        disabledMcpToolIds: disabledMcpToolIdsArr,
      })
    })
  }, [input, isRunning, agent, run, workspaceDir, pendingImages, ensureRound, removedSkillIds, removedMcpIds, disabledMcpToolIds])

  // 将 session 的流式文本/思考/工具步骤同步进「最后一条助手气泡」
  useEffect(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      // 欢迎语是静态提示，不参与流式回填：避免 reset() 清空 streamingText 后
      // 把欢迎语覆盖成空内容，导致界面误显示「思考中…」
      if (!last || last.role !== 'agent' || last.id === 'welcome') return prev
      return [...prev.slice(0, -1), { ...last, content: streamingText, thought: thoughts, toolSteps }]
    })
  }, [streamingText, thoughts, toolSteps])

  // 任务结束（完成/异常/取消）时，补全耗时、token 与历史持久化
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

      // 回填历史轮次
      if (roundIdRef.current && activeSessionId) {
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
        const sid = activeSessionId
        void (async () => {
          await updateSession(sid, {
            status: statusText ? 'ERROR' : 'COMPLETED',
            endTime: completedAt,
          })
          let fresh = await getSession(sid)
          // Tauri 路径：后端已在 run_task 累计真实 prompt/completion 到会话表，直接读回；
          // dev/mock 路径：本地按估算累加（与旧逻辑一致）。
          let toolsTokens: number | undefined
          if (!isTauri) {
            await addSessionTokens(sid, inputTokens, outputTokens)
            const after = await getSession(sid)
            if (after) {
              fresh = after
              toolsTokens = Math.round(
                (toolCount -
                  boundMcps
                    .filter((m) => removedMcpIds.has(m.mcpId))
                    .reduce((sum, m) => sum + m.tools.length, 0) -
                  disabledMcpToolIds.size +
                  (skillCount - removedSkillIds.size)) *
                  AVG_TOOL_TOKENS,
              )
            }
          }
          // 未命名会话（多为「工程 / 项目目录」下新建的子对话）：首轮完成后用第一个问题命名
          const wasUnnamed = !fresh?.sessionName || fresh.sessionName.trim() === ''
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sid) return s
              const b = fresh ?? s
              let name = b.sessionName
              if (wasUnnamed && lastPromptRef.current) {
                name = lastPromptRef.current.trim().slice(0, 40)
              }
              return {
                ...b,
                sessionName: name || b.sessionName,
                // Tauri 路径 tools_tokens 由后端动态重算；dev 路径本地估算
                toolsTokens: isTauri ? b.toolsTokens : (toolsTokens ?? b.toolsTokens),
              }
            }),
          )
          // 把首轮命名回写库（仅当原本未命名）
          if (wasUnnamed && lastPromptRef.current) {
            await renameSession(sid, lastPromptRef.current.trim().slice(0, 40))
          }
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
  }, [isRunning, streamingText, thoughts, toolSteps, lastAgentContent, statusText, activeSessionId, removedSkillIds, removedMcpIds, disabledMcpToolIds, boundMcps, toolCount, skillCount, isTauri, lastTaskUsage])

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
      const disabledSkillIds = [...removedSkillIds]
      const disabledMcpIds = [...removedMcpIds]
      const disabledMcpToolIdsArr = [...disabledMcpToolIds]
      void ensureRound(userMsg.content).then(() => {
        void run({
          agentId: agent.id,
          prompt: userMsg.content,
          workspace: workspaceDir,
          sessionId: activeSessionId ?? undefined,
          roundId: roundIdRef.current ?? undefined,
          // 临时移除的技能 / MCP 服务 / MCP 工具在本轮同样生效
          disabledSkillIds,
          disabledMcpIds,
          disabledMcpToolIds: disabledMcpToolIdsArr,
        })
      })
    },
    [messages, agent, reset, run, workspaceDir, ensureRound, removedSkillIds, removedMcpIds, disabledMcpToolIds],
  )

  /** 点击左侧历史会话，加载其全部轮次。 */
  const openSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionId) return
      reset()
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
    setPendingProjectId(null) // 新建对话解绑工程（自由对话）
    setRemovedSkillIds(new Set()) // 新建对话复位临时移除
    setRemovedMcpIds(new Set()) // 临时移除的 MCP 服务复位
    setDisabledMcpToolIds(new Set()) // 临时关闭的 MCP 工具复位
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

  /** 工程头「新增子对话」：基于已有工程新建并进入会话。 */
  const startProjectSession = useCallback(
    async (projectId: string) => {
      const proj = projects.find((p) => p.id === projectId) ?? (await getProject(projectId))
      if (!proj) {
        message.error('工程不存在')
        return
      }
      reset()
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
        await refreshSessions()
      } catch (err) {
        message.error(`创建会话失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [agent, projects, reset, welcomeMessages, refreshSessions, message],
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
      await updateSession(activeSessionId, { projectId: null })
      await refreshSessions()
    }
  }, [activeSessionId, refreshSessions])

  /* ---------------- 会话行操作：重命名 / 置顶 / 归档 / 删除 ---------------- */
  const renameSessionHandler = useCallback(
    async (s: AgentConversationSession) => {
      const name = window.prompt('重命名会话', s.sessionName ?? '')
      if (name === null) return
      try {
        await renameSession(s.id, name.trim() || s.sessionName || '未命名会话')
        await refreshSessions()
      } catch (err) {
        message.error(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refreshSessions, message],
  )
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

  const renameProjectHandler = useCallback(
    async (p: AgentProject) => {
      const name = window.prompt('重命名工程', p.name)
      if (name === null) return
      try {
        await updateProject(p.id, { name: name.trim() || p.name })
        await refreshAll()
      } catch (err) {
        message.error(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [refreshAll, message],
  )
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
    async (p: AgentProject) => {
      if (!window.confirm(`删除工程「${p.name}」将级联清除其下所有会话与轮次，确认？`)) return
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
    [activeSessionId, sessions, newChat, refreshAll, message],
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

  // 左侧树状分组（GLOBAL + 各 PROJECT），随搜索过滤
  // 注意：useMemo 必须在任何早退 return 之前调用，否则两次渲染 hook 数量不一致（React 报错）。
  const sessionTree = useMemo(() => buildSessionTree(sessions, projects), [sessions, projects])
  const filteredTree = useMemo(
    () =>
      sessionTree
        .map((g) => ({
          ...g,
          sessions: g.sessions.filter((s) =>
            (s.sessionName ?? '').toLowerCase().includes(sessionSearch.trim().toLowerCase()),
          ),
        }))
        .filter((g) => g.sessions.length > 0),
    [sessionTree, sessionSearch],
  )

  if (loading) {
    return <div className="agent-chat agent-chat--loading">加载中…</div>
  }
  if (!agent) return null

  // 当前会话已消耗 token（提示词 + 对话），用于底部环形图占比
  const activeSession = sessions.find((s) => s.id === activeSessionId)

  return (
    <div className="agent-chat">
      {/* 审批授权：右下角通知形式，不再嵌入对话流 */}
      <ApprovalNotify approval={pendingApproval} agentName={agent?.name ?? ''} onDecision={handleDecision} />

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
                  落盘于工程根目录 <code>.wd_mem/project_memory.md</code>，智能体会将其作为长期记忆注入上下文。
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
                <div className="agent-chat__group-head">
                  <Folder size={13} className="agent-chat__group-icon" />
                  <div className="agent-chat__group-info">
                    <span className="agent-chat__group-name" title={group.rootPath ?? ''}>
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
                  <MessageSquare size={13} className="agent-chat__group-icon" />
                  <span className="agent-chat__group-name">{group.projectName}</span>
                </div>
              )}
              {group.sessions.map((s) => (
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
                        {s.isArchived && <Archive size={11} className="agent-chat__session-arch" />}
                      </div>
                      <div className="agent-chat__session-time">
                        {s.totalTurns > 0 ? `${s.totalTurns} 轮 · ` : ''}
                        {formatTime(s.updatedAt ? s.updatedAt : undefined)}
                      </div>
                    </div>
                  </div>
                  <div className="agent-chat__session-ops" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu
                      align="right"
                      items={[
                        { label: '重命名', icon: <Pencil size={13} />, onClick: () => void renameSessionHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: false, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' }) },
                        { label: s.isTop ? '取消置顶' : '置顶', icon: s.isTop ? <PinOff size={13} /> : <Pin size={13} />, onClick: () => void toggleSessionTopHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: false, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' }) },
                        { label: s.isArchived ? '取消归档' : '归档', icon: s.isArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />, onClick: () => void archiveSessionHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: false, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' }) },
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
                      ) : isStreaming || isRunning ? (
                        <span className="agent-chat__thinking">思考中…</span>
                      ) : (
                        <span className="agent-chat__thinking">（智能体未返回文本内容）</span>
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
