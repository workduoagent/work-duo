/**
 * 智能体「进入」页（路由 /agent-studio/:id/chat）。
 *
 * 设计：仿 WorkBuddy 对话页的「左侧工具栏 + 中间会话流 + 底部输入」三段式。
 * 本页是智能体的**运行/会话入口**（原「调试」语义升级为「进入」），与新建/编辑向导同级，
 * 属于独立页面。
 *
 * 运行链路：
 *  - Tauri 环境：发送消息调用 Rust `run_agent_task` 命令，前端经 `useAgentSession`
 *    监听 `agent-event` / `agent-awaiting-approval` 等事件流渲染工具步骤与流式回复；
 *    敏感工具触发审批时，在右下角弹出授权通知（ApprovalNotify），决策经 `submit_approval_decision` 回传。
 *  - 非 Tauri 环境：无原生后端，`useAgentSession` 回退到 mock 流，便于浏览器 dev 演示 UI。
 *
 * 其它：
 *  - 工作空间：复用 plugin-dialog 选择本地目录（非 Tauri 回退为手动输入），最近选择存 localStorage；
 *  - 顶部固定「编辑智能体」快捷入口，一键跳回向导页；
 *  - 会话记录仅在内存，刷新即清空（本阶段不做持久化）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Pencil,
  FolderOpen,
  Send,
  Bot,
  Trash2,
  Square,
  Sparkles,
  ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { getAgent, listAgentMcpTools, listAgentSkills } from '@/core/mapper/agent-mapper'
import { agentEditPath } from '@/core/router/paths'
import { isTauri } from '@/core/config'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { useAgentSession } from './session/useAgentSession'
import { ToolStepCard } from './session/ToolStepCard'
import { ApprovalNotify } from './session/ApprovalNotify'
import type { ApprovalDecision, ToolStep } from './session/types'
import type { AgentInfo } from '@/types/core'
import './chat.scss'

const LS_WORKSPACES = 'work-duo:agent-chat-workspaces'

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  createdAt: number
  /** 该轮的深度思考/状态文本（绑定到消息，多轮互不串台）。 */
  thought?: string[]
  /** 该轮的工具调用步骤（绑定到消息，多轮互不串台）。 */
  toolSteps?: ToolStep[]
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
    // 目标文本追加时从当前显示位置继续；重置时从头开始
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

function readWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(LS_WORKSPACES)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function writeWorkspaces(list: string[]) {
  localStorage.setItem(LS_WORKSPACES, JSON.stringify(list.slice(0, 10)))
}

export default function AgentChatPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message } = useNotify()

  const [agent, setAgent] = useState<AgentInfo | undefined>()
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<string[]>(readWorkspaces)
  const [toolCount, setToolCount] = useState(0)
  const [skillCount, setSkillCount] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)

  const session = useAgentSession()
  const { toolSteps, streamingText, isStreaming, statusText, thoughts, isRunning, pendingApproval, run, submitDecision, reset, cancel } =
    session

  // 最后一条助手消息用打字机效果展示，其他消息直接渲染完整内容
  const lastAgentContent = messages.length > 0 && messages[messages.length - 1].role === 'agent'
    ? messages[messages.length - 1].content
    : ''
  const displayedContent = useTypewriter(lastAgentContent, isStreaming)

  // 加载智能体 + 工具/技能计数
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
      } catch (e) {
        message.error(`加载失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [id, message, navigate])

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
  }, [id, reset])

  // 新消息 / 工具步骤 / 流式文本变化时滚动到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, toolSteps, streamingText])

  async function pickWorkspace() {
    try {
      if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const picked = await open({ directory: true, multiple: false })
        if (typeof picked === 'string') {
          setWorkspace(picked)
          const next = [picked, ...workspaces.filter((w) => w !== picked)]
          setWorkspaces(next)
          writeWorkspaces(next)
        }
      } else {
        const typed = window.prompt('输入工作空间本地目录路径')
        if (typed) {
          setWorkspace(typed)
          const next = [typed, ...workspaces.filter((w) => w !== typed)]
          setWorkspaces(next)
          writeWorkspaces(next)
        }
      }
    } catch (e) {
      message.error(`选择目录失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function clearChat() {
    reset()
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
  }

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || isRunning || !agent) return

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    }
    const agentMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      role: 'agent',
      content: '',
      createdAt: Date.now(),
    }
    setMessages((prev) => [...prev, userMsg, agentMsg])
    setInput('')

    // 启动运行（Tauri 走 run_agent_task；非 Tauri 走 mockRun）。
    void run({ agentId: agent.id, prompt: text, workspace })
  }, [input, isRunning, agent, run, workspace])

  // 将 session 的流式文本/思考/工具步骤同步进「最后一条助手气泡」，
  // 并冻结在各自消息上——新一轮开始前 run() 会清空全局 thoughts/toolSteps，
  // 此时最后一条已换成新轮空的 agent 消息，旧消息因不再是 last 而保留其快照，
  // 从而多轮对话里每轮的「深度思考」都各自可见、互不覆盖。
  useEffect(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === 'agent') {
        return [...prev.slice(0, -1), { ...last, content: streamingText, thought: thoughts, toolSteps }]
      }
      return prev
    })
  }, [streamingText, thoughts, toolSteps])

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

  if (loading) {
    return <div className="agent-chat agent-chat--loading">加载中…</div>
  }
  if (!agent) return null

  return (
    <div className="agent-chat">
      {/* 审批授权：右下角通知形式，不再嵌入对话流 */}
      <ApprovalNotify
        approval={pendingApproval}
        agentName={agent?.name ?? ''}
        onDecision={handleDecision}
      />

      <aside className="agent-chat__side">
        <Button variant="ghost" size="sm" onClick={() => navigate('/agent-studio')}>
          <ArrowLeft size={15} />
          返回列表
        </Button>
        <div className="agent-chat__side-title">
          <Bot size={16} />
          <span>工作空间</span>
        </div>
        <Button variant="soft" size="sm" onClick={pickWorkspace}>
          <FolderOpen size={14} />
          选择目录
        </Button>
        {workspace && <div className="agent-chat__ws-cur">{workspace}</div>}
        {workspaces.length > 0 && (
          <div className="agent-chat__ws-list">
            {workspaces.map((w) => (
              <button
                key={w}
                type="button"
                className={`agent-chat__ws-item${w === workspace ? ' is-active' : ''}`}
                onClick={() => setWorkspace(w)}
                title={w}
              >
                <FolderOpen size={13} />
                <span>{w}</span>
              </button>
            ))}
          </div>
        )}
        <div className="agent-chat__side-foot">
          <Button variant="ghost" size="sm" onClick={clearChat}>
            <Trash2 size={14} />
            清空会话
          </Button>
        </div>
      </aside>

      <section className="agent-chat__main">
        <header className="agent-chat__head">
          <div className="agent-chat__head-info">
            <div className="agent-chat__avatar">
              {agent.logo ? (
                <img src={agent.logo} alt={agent.name} />
              ) : (
                <Bot size={20} />
              )}
            </div>
            <div>
              <div className="agent-chat__name">{agent.name}</div>
              <div className="agent-chat__sub">
                {agent.identifier}
                {agent.autoToolExecMode && ' · 自动执行'}
                {agent.allowSandbox && ' · 沙箱'}
                {(toolCount > 0 || skillCount > 0) &&
                  ` · 已挂 ${toolCount} 工具 / ${skillCount} 技能`}
              </div>
            </div>
          </div>
          <div className="agent-chat__head-actions">
            <Button variant="soft" size="sm" onClick={() => navigate(agentEditPath(agent.id))}>
              <Pencil size={14} />
              编辑智能体
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
                </div>
              </div>
            )
          })}

          {/* 错误/瞬时状态提示 */}
          {statusText && <div className="agent-chat__status">{statusText}</div>}
        </div>

        <footer className="agent-chat__input">
          <textarea
            className="agent-chat__textarea"
            value={input}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            autoComplete="off"
            rows={2}
            disabled={isRunning}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {isRunning ? (
            <Button variant="solid" size="sm" onClick={cancel}>
              <Square size={14} />
              停止
            </Button>
          ) : (
            <Button variant="solid" size="sm" disabled={!input.trim()} onClick={send}>
              <Send size={14} />
              发送
            </Button>
          )}
        </footer>
      </section>
    </div>
  )
}
