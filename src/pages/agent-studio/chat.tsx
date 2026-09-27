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
  Paperclip,
} from 'lucide-react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Modal } from '@/components/ui'
import { getNotifyApi } from '@/components/ui/notifyBridge'
import { useNotify } from '@/components/ui/notify'

import { isAgentRunning } from './session/runtimeStore'
import { isTauri } from '@/core/config'
import { useAgentSession } from './session/useAgentSession'
import { useAgentProfile } from './chat/useAgentProfile'
import { useMentionSuggest } from './chat/useMentionSuggest'
import { useAttachments } from './chat/useAttachments'
import { SLASH_COMMANDS } from './chat/terminal-bridge'
import { useFollowScroll } from './chat/useFollowScroll'
import { useRightPanel } from './chat/useRightPanel'
import { useChatRun } from './chat/useChatRun'
import { useSessionWorkspace } from './chat/useSessionWorkspace'
import { SessionSidebar } from './chat/SessionSidebar'
import { MessageList } from './chat/MessageList'
import { ChatComposer } from './chat/ChatComposer'
import type { ContextCompactedPayload, ToolStep } from './session/types'
import type { AgentConversationSession, AgentProject } from '@/types/core'
import type { ChatMessage, SpeechLike } from './chat/types'
import { RightPanel } from './chat/RightPanel'
import {
  useTypewriter,
} from './chat/message-ui'
import './chat.scss'

export default function AgentChatPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message, modal } = useNotify()

  // 当前会话 id 必须先于状态机声明：状态机按会话 id 绑定该会话自己的运行态（TDZ）。
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  // 会话/工程列表：useAgentProfile 与 useSessionWorkspace 都要写，先于二者声明（TDZ）。
  const [sessions, setSessions] = useState<AgentConversationSession[]>([])
  const [projects, setProjects] = useState<AgentProject[]>([])
  // 会话状态机（必须早于任何引用 session.* 的回调/依赖数组，否则 TDZ）。
  const session = useAgentSession(activeSessionId)
  const { toolSteps, segments, lastLlmUsage, streamingText, isStreaming, statusText, thoughts, isRunning, pendingApproval, run, submitDecision, reset, cancel, lastTaskUsage, liveTokenUsage, taskError, recovery, pendingChoice, planApproval, kbSources } =
    session

  // ---- 智能体档案加载（台账 S1：hook 化 → chat/useAgentProfile）----
  const {
    agent,
    loading,
    toolCount,
    skillCount,
    isMultimodal,
    hasStt,
    contextLength,
    boundMcps,
    boundSkills,
    boundPlugins,
    allSkills,
    allMcps,
    allPlugins,
    defaultWorkspaceDir,
  } = useAgentProfile({ id, message, setSessions, setProjects })
  // 本智能体是否有任务在跑（含当前查看会话）。切到历史会话时输入框 / 发送按钮仍应保持
  // 「任务进行中」的禁用态——否则按钮会被解锁，点下去要被后端「已有任务正在运行」闸门锁掉。
  const agentBusy = isRunning || isAgentRunning(agent?.id)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  // 输入框高度（px）：默认 48，用户可从顶部拖拽手柄向上扩展，发送后复位。
  const [inputHeight, setInputHeight] = useState(48)
  // 当前会话内临时移除的 MCP 服务 id（内存态，不写库；切换/重开会话即复位）
  const [removedMcpIds, setRemovedMcpIds] = useState<Set<string>>(new Set())
  // 当前会话内临时关闭的单个 MCP 工具 id（内存态，不写库）。键为 mcp_tool_definition.id
  const [disabledMcpToolIds, setDisabledMcpToolIds] = useState<Set<string>>(new Set())
  /** 临时取消/恢复挂载某个插件（仅当前会话，不写库；随 disabled_plugin_ids 生效）。 */
  const togglePlugin = useCallback((pluginId: string) => {
    setRemovedPluginIds((prev) => {
      const next = new Set(prev)
      if (next.has(pluginId)) next.delete(pluginId)
      else next.add(pluginId)
      return next
    })
  }, [])
  // 输入框 @提及 / /指令 浮层状态
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
  // （projects / sessions state 已上移至 activeSessionId 附近：useAgentProfile 先于此处使用其 setter。）
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null)
  const workspaceDir = useMemo(() => {
    if (pendingProjectId) {
      const p = projects.find((x) => x.id === pendingProjectId)
      if (p) return p.rootPath
    }
    return defaultWorkspaceDir
  }, [pendingProjectId, projects, defaultWorkspaceDir])

  // ---- 右栏 UI 态（台账 S1：hook 化 → chat/useRightPanel）----
  const {
    rightOpen,
    setRightOpen,
    rightTab,
    setRightTab,
    rightWidth,
    resizeElRef,
    startResize,
    previewSrc,
    setPreviewSrc,
    artifactPreview,
    setArtifactPreview,
    artifactLoading,
    setArtifactLoading,
    handlePreviewArtifact,
  } = useRightPanel({ pendingApproval, recovery, pendingChoice, planApproval, workspaceDir })
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
  // 图片放大预览：点击气泡/待发区缩略图打开（状态在 useRightPanel）

  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileAttachRef = useRef<HTMLInputElement>(null)


  // 语音输入
  const [recording, setRecording] = useState(false)
  const recognitionRef = useRef<unknown>(null)

  // ---- 会话流跟随滚动（台账 S1：hook 化 → chat/useFollowScroll）----
  const { scrollRef, setFollowBottom, lastScrollTopRef, scheduleFollowScroll } =
    useFollowScroll({ isStreaming, isRunning, messages, toolSteps, streamingText })
  // 标记「本次由『新增子对话』创建的、尚未发过任何消息的空会话」——离开时若仍为 0 轮则清理
  const pendingEmptySessionIdRef = useRef<string | null>(null)

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

  // ---- 附件与拖拽吸附（台账 S1：逻辑抽至 chat/useAttachments）----
  const {
    pendingAttachments,
    setPendingAttachments,
    dragOver,
    setDragOver,
    windowDrag,
    setWindowDrag,
    dragDepth,
    addFiles,
    onPaste,
  } = useAttachments({ workspaceDir, notifyError: message.error })

  // ---- 运行链路（台账 S1：hook 化 → chat/useChatRun）----
  const {
    send,
    handleRegenerate,
    handleApplyBranch,
    handleBranchFromStep,
    handleDismissBranch,
    roundIndexRef,
  } = useChatRun({
    session: {
      isRunning,
      streamingText,
      thoughts,
      toolSteps,
      segments,
      kbSources,
      planSteps: session.planSteps,
      planBranch: session.planBranch,
      run,
      reset,
      lastTaskUsage,
    },
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
  })

  // ---- 会话/工作空间域（台账 S1：hook 化 → chat/useSessionWorkspace）----
  const {
    sessionSearch,
    setSessionSearch,
    showArchived,
    setShowArchived,
    filteredTree,
    collapsedGroups,
    toggleGroupFold,
    renameTarget,
    setRenameTarget,
    renameValue,
    setRenameValue,
    confirmRename,
    memoEditor,
    setMemoEditor,
    memoContent,
    setMemoContent,
    memoSaving,
    saveMemoEditor,
    openMemoEditor,
    openSession,
    newChat,
    removeSession,
    startProjectSession,
    renameSessionHandler,
    toggleSessionTopHandler,
    archiveSessionHandler,
    pinProjectHandler,
    renameProjectHandler,
    archiveProjectHandler,
    deleteProjectHandler,
    changeWorkspaceDir,
    clearWorkspaceBinding,
    refreshSessions,
  } = useSessionWorkspace({
    agent,
    agentId: id,
    activeSessionId,
    setActiveSessionId,
    setMessages,
    reset,
    roundIndexRef,
    pendingEmptySessionIdRef,
    projects,
    setProjects,
    sessions,
    setSessions,
    pendingProjectId,
    setPendingProjectId,
    setInput,
    setMentionTags,
    setPendingAttachments,
    setDragOver,
    setRemovedSkillIds,
    setRemovedMcpIds,
    setDisabledMcpToolIds,
    message,
    modal,
  })

  // 指令动作表经 ref 延迟绑定：hook 需先于 newChat 声明（newChat 内使用 hook 返回值），
  // 而 newChat 等动作定义在其后——ref 转发解开这一循环。
  const commandActionRef = useRef<(key: string) => void>(() => {})
  const {
    suggest,
    setSuggest,
    handleInputChange,
    handleCaretMove,
    handleInputKeyDown,
    applyMention,
    runCommand,
  } = useMentionSuggest(
    input,
    setInput,
    textareaRef,
    setMentionTags,
    {
      skills: allSkills,
      mcps: allMcps,
      plugins: allPlugins,
      commands: SLASH_COMMANDS,
      runCommandAction: (key) => commandActionRef.current(key),
    },
    send,
  )

  // 将 session 的流式文本/思考/工具步骤同步进「最后一条助手气泡」的效果已删除
  // （台账 S4）：改由 displayMessages 渲染期派生承担，见上方 useMemo。

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

  // 挂起通知收起（其二）：提交决策后挂起态解除 → 精准关掉对应那条通知。
  useEffect(() => {
    const hasPending = !!(pendingApproval || recovery || pendingChoice || planApproval)
    if (!hasPending && activeSessionId) {
      getNotifyApi()?.notification?.destroy(`pending-${activeSessionId}`)
    }
  }, [pendingApproval, recovery, pendingChoice, planApproval, activeSessionId])

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

// 斜杠指令动作表（每次渲染刷新闭包，newChat / reset / agent 均为最新值）
commandActionRef.current = (key: string) => {
  switch (key) {
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
      <SessionSidebar
        agent={agent}
        navigate={navigate}
        newChat={newChat}
        memoEditor={memoEditor}
        setMemoEditor={setMemoEditor}
        memoSaving={memoSaving}
        saveMemoEditor={saveMemoEditor}
        memoContent={memoContent}
        setMemoContent={setMemoContent}
        renameTarget={renameTarget}
        setRenameTarget={setRenameTarget}
        renameValue={renameValue}
        setRenameValue={setRenameValue}
        confirmRename={confirmRename}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
        sessionSearch={sessionSearch}
        setSessionSearch={setSessionSearch}
        showArchived={showArchived}
        setShowArchived={setShowArchived}
        filteredTree={filteredTree}
        collapsedGroups={collapsedGroups}
        toggleGroupFold={toggleGroupFold}
        activeSessionId={activeSessionId}
        openSession={openSession}
        pendingApproval={!!pendingApproval}
        pendingChoice={!!pendingChoice}
        planApproval={!!planApproval}
        startProjectSession={startProjectSession}
        openMemoEditor={openMemoEditor}
        pinProjectHandler={pinProjectHandler}
        renameProjectHandler={renameProjectHandler}
        archiveProjectHandler={archiveProjectHandler}
        deleteProjectHandler={deleteProjectHandler}
        removeSession={removeSession}
        renameSessionHandler={renameSessionHandler}
        toggleSessionTopHandler={toggleSessionTopHandler}
        archiveSessionHandler={archiveSessionHandler}
      />

      {/* 中间会话区 */}
      <section className="agent-chat__main">
        <MessageList
          displayMessages={displayMessages}
          displayedContent={displayedContent}
          agent={agent}
          scrollRef={scrollRef}
          lastScrollTopRef={lastScrollTopRef}
          setFollowBottom={setFollowBottom}
          scheduleFollowScroll={scheduleFollowScroll}
          isStreaming={isStreaming}
          isRunning={isRunning}
          statusText={statusText}
          recovery={recovery}
          setRightOpen={setRightOpen}
          setRightTab={setRightTab}
          handleRegenerate={handleRegenerate}
          copyError={copyError}
          copyMessageRecord={copyMessageRecord}
          setPreviewSrc={setPreviewSrc}
        />

        {/* 底部输入工具条：仿 WorkBuddy 的大圆角输入框，工具按钮内嵌在框底 */}
        <ChatComposer
          pendingApproval={!!pendingApproval}
          recovery={recovery}
          pendingChoice={!!pendingChoice}
          planApproval={!!planApproval}
          setRightOpen={setRightOpen}
          setRightTab={setRightTab}
          dragOver={dragOver}
          setDragOver={setDragOver}
          dragDepth={dragDepth}
          setWindowDrag={setWindowDrag}
          addFiles={addFiles}
          startInputResize={startInputResize}
          textareaRef={textareaRef}
          input={input}
          inputHeight={inputHeight}
          handleInputChange={handleInputChange}
          onPaste={onPaste}
          handleCaretMove={handleCaretMove}
          handleInputKeyDown={handleInputKeyDown}
          agentBusy={agentBusy}
          mentionTags={mentionTags}
          setMentionTags={setMentionTags}
          suggest={suggest}
          setSuggest={setSuggest}
          applyMention={applyMention}
          runCommand={runCommand}
          pendingAttachments={pendingAttachments}
          setPendingAttachments={setPendingAttachments}
          setPreviewSrc={setPreviewSrc}
          isMultimodal={isMultimodal}
          fileInputRef={fileInputRef}
          fileAttachRef={fileAttachRef}
          projects={projects}
          pendingProjectId={pendingProjectId}
          changeWorkspaceDir={changeWorkspaceDir}
          clearWorkspaceBinding={clearWorkspaceBinding}
          agent={agent}
          boundSkills={boundSkills}
          removedSkillIds={removedSkillIds}
          toggleSkill={toggleSkill}
          boundMcps={boundMcps}
          removedMcpIds={removedMcpIds}
          toggleMcp={toggleMcp}
          disabledMcpToolIds={disabledMcpToolIds}
          toggleMcpTool={toggleMcpTool}
          boundPlugins={boundPlugins}
          removedPluginIds={removedPluginIds}
          togglePlugin={togglePlugin}
          liveTokenUsage={liveTokenUsage}
          lastLlmUsage={lastLlmUsage}
          activeSession={activeSession}
          contextLength={contextLength}
          hasStt={hasStt}
          recording={recording}
          toggleVoice={toggleVoice}
          isRunning={isRunning}
          cancel={cancel}
          send={send}
        />

      </section>

      {/* 右侧投影面板：图（本轮 DAG）/ 过程 / 产物 / 处置（S1 拆分 → chat/RightPanel） */}
      <RightPanel
        rightOpen={rightOpen}
        rightTab={rightTab}
        setRightTab={setRightTab}
        setRightOpen={setRightOpen}
        rightWidth={rightWidth}
        resizeElRef={resizeElRef}
        startResize={startResize}
        planSteps={session.planSteps}
        toolSteps={session.toolSteps}
        artifacts={session.artifacts}
        planning={session.planning}
        isRunning={session.isRunning}
        pendingApproval={session.pendingApproval}
        recovery={session.recovery}
        pendingChoice={session.pendingChoice}
        planApproval={session.planApproval}
        trace={session.trace}
        planBranch={session.planBranch}
        resolveRecovery={session.resolveRecovery}
        submitChoice={session.submitChoice}
        resolvePlanApproval={session.resolvePlanApproval}
        agentName={agent?.name ?? ''}
        isTauri={isTauri}
        activeSessionId={activeSessionId}
        onPreviewArtifact={handlePreviewArtifact}
        onBranchFromStep={handleBranchFromStep}
        onApplyBranch={handleApplyBranch}
        onDismissBranch={handleDismissBranch}
        onApproval={handleApproval}
      />

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
