/**
 * 智能体调试页（路由 /agent-studio/:id/chat）。
 *
 * 设计：仿 WorkBuddy 对话页的「左侧工具栏 + 中间会话流 + 底部输入」三段式。
 * 本版为「纯 UI 原型」（调用层见 src/core/agent/chat.ts）：
 *  - 不真正发起模型请求，回复由 buildMockReply 生成并打字机式流式呈现；
 *  - 工作空间：复用 plugin-dialog 选择本地目录（非 Tauri 回退为手动输入），最近选择存 localStorage；
 *  - 顶部固定「编辑智能体」快捷入口，一键跳回向导页；
 *  - 会话记录仅在内存，刷新即清空（原型阶段不做持久化）。
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
} from 'lucide-react'
import { Button } from '@/components/ui'
import { useNotify } from '@/components/ui/notify'
import { getAgent, listAgentMcpTools, listAgentSkills } from '@/core/mapper/agent-mapper'
import { agentEditPath } from '@/core/router/paths'
import { isTauri } from '@/core/config'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import {
  buildMockReply,
  streamText,
  type AgentChatMessage,
} from '@/core/agent/chat'
import type { AgentInfo } from '@/types/core'
import './chat.scss'

const LS_WORKSPACES = 'work-duo:agent-chat-workspaces'

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
  const [messages, setMessages] = useState<AgentChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<string[]>(readWorkspaces)
  const [toolCount, setToolCount] = useState(0)
  const [skillCount, setSkillCount] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<(() => void) | null>(null)

  // 加载智能体 + 工具/技能计数（供模拟回复回显）
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
        setAgent(a)
        setToolCount(mcp.length)
        setSkillCount(skills.length)
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

  // 首条消息：欢迎语
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
  }, [agent, loading, messages.length])

  // 新消息滚动到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  // 卸载时取消正在进行的流式
  useEffect(() => () => cancelRef.current?.(), [])

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
    cancelRef.current?.()
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
    if (!text || sending || !agent) return
    const userMsg: AgentChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
    }
    const agentMsgId = `a-${Date.now()}`
    const agentMsg: AgentChatMessage = {
      id: agentMsgId,
      role: 'agent',
      content: '',
      createdAt: Date.now(),
      pending: true,
    }
    setMessages((prev) => [...prev, userMsg, agentMsg])
    setInput('')
    setSending(true)

    const full = buildMockReply({
      agentName: agent.name,
      modelName: agent.llmId,
      toolCount,
      skillCount,
      userText: text,
    })

    cancelRef.current = streamText(
      full,
      (partial) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === agentMsgId ? { ...m, content: partial } : m)),
        ),
      () => {
        setMessages((prev) =>
          prev.map((m) => (m.id === agentMsgId ? { ...m, pending: false } : m)),
        )
        setSending(false)
        cancelRef.current = null
      },
    )
  }, [input, sending, agent, toolCount, skillCount])

  if (loading) {
    return <div className="agent-chat agent-chat--loading">加载中…</div>
  }
  if (!agent) return null

  return (
    <div className="agent-chat">
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
              </div>
            </div>
          </div>
          <Button variant="soft" size="sm" onClick={() => navigate(agentEditPath(agent.id))}>
            <Pencil size={14} />
            编辑智能体
          </Button>
        </header>

        <div className="agent-chat__scroll" ref={scrollRef}>
          {messages.map((m) => (
            <div
              key={m.id}
              className={`agent-chat__msg agent-chat__msg--${m.role}`}
            >
              <div className="agent-chat__bubble">
                {m.role === 'agent' ? (
                  m.content ? (
                    <MarkdownRenderer content={m.content} />
                  ) : (
                    <span className="agent-chat__thinking">思考中…</span>
                  )
                ) : (
                  <span className="agent-chat__plain">{m.content}</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <footer className="agent-chat__input">
          <textarea
            className="agent-chat__textarea"
            value={input}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            autoComplete="off"
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <Button
            variant="solid"
            size="sm"
            loading={sending}
            disabled={!input.trim()}
            onClick={send}
          >
            <Send size={14} />
            发送
          </Button>
        </footer>
      </section>
    </div>
  )
}
