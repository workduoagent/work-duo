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
import { open } from '@tauri-apps/plugin-dialog'
import { Modal } from '@/components/ui'
import { getNotifyApi } from '@/components/ui/notifyBridge'
import { useNotify } from '@/components/ui/notify'

import { getAgent, listAgentMcpTools, listAgentSkills } from '@/core/mapper/agent-mapper'
import { listSkills } from '@/core/mapper/skill-mapper'
import { listPlugins } from '@/core/mapper/plugin-mapper'
import { listAgentPlugins } from '@/core/mapper/plugin-mapper'
import type { UserPluginTool } from '@/core/file/plugin-file'
import { listMcps, listMcpTools } from '@/core/mapper/mcp-mapper'
import { getModel } from '@/core/mapper/model-mapper'
import {
  createSession,
  listSessions,
  updateSession,
  getSession,
  deleteSession,
  listRounds,
  renameSession,
  setSessionArchived,
  clearSessionProject,
  toggleSessionTop,
  type SessionTreeGroup,
} from '@/core/mapper/agent-session-mapper'
import { isSessionRunning, isAgentRunning } from './session/runtimeStore'
import {
  listProjects,
  getProject,
  ensureProjectByPath,
  updateProject,
  deleteProject,
} from '@/core/mapper/agent-project-mapper'
import { readProjectMemory, writeProjectMemory } from '@/core/mapper/wd-mem-mapper'
import { isTauri } from '@/core/config'
import { useAgentSession } from './session/useAgentSession'
import { useMentionSuggest } from './chat/useMentionSuggest'
import { useAttachments } from './chat/useAttachments'
import { chatMod, lastSessionByAgent, SLASH_COMMANDS, resolveWorkspaceDir } from './chat/terminal-bridge'
import { useFollowScroll } from './chat/useFollowScroll'
import { useRightPanel } from './chat/useRightPanel'
import { useChatRun } from './chat/useChatRun'
import { SessionSidebar } from './chat/SessionSidebar'
import { MessageList } from './chat/MessageList'
import { ChatComposer } from './chat/ChatComposer'
import type { ContextCompactedPayload, ToolStep } from './session/types'
import type {
  AgentInfo,
  AgentConversationSession,
  AgentProject,
} from '@/types/core'
import type { SkillInfo } from '@/core/file/skill-file'
import type { McpToolDefinition } from '@/core/file/mcp-file'
import type { BoundMcpServer, ChatMessage, SpeechLike } from './chat/types'
import { RightPanel } from './chat/RightPanel'
import {
  useTypewriter,
} from './chat/message-ui'
import { buildSessionTree, roundsToMessages } from './chat/session-helpers'
import './chat.scss'

export default function AgentChatPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message, modal } = useNotify()

  // 当前会话 id 必须先于状态机声明：状态机按会话 id 绑定该会话自己的运行态（TDZ）。
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  // 会话状态机（必须早于任何引用 session.* 的回调/依赖数组，否则 TDZ）。
  const session = useAgentSession(activeSessionId)
  const { toolSteps, segments, lastLlmUsage, streamingText, isStreaming, statusText, thoughts, isRunning, pendingApproval, run, submitDecision, reset, cancel, lastTaskUsage, liveTokenUsage, taskError, recovery, pendingChoice, planApproval, kbSources } =
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
  // 图片放大预览：点击气泡/待发区缩略图打开（状态在 useRightPanel）

  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileAttachRef = useRef<HTMLInputElement>(null)


  // 语音输入
  const [recording, setRecording] = useState(false)
  const recognitionRef = useRef<unknown>(null)

  // ---- 会话流跟随滚动（台账 S1：hook 化 → chat/useFollowScroll）----
  const { scrollRef, setFollowBottom, lastScrollTopRef, scheduleFollowScroll } =
    useFollowScroll({ isStreaming, isRunning, messages, toolSteps, streamingText })
  // 会话加载代次：openSession 的异步加载（getSession/listRounds）resolve 后核对，
  // 代次已变（newChat / 切智能体）则丢弃结果——防「历史会话消息盖回新建对话」竞态。
  const sessionLoadEpochRef = useRef(0)
  // 标记「本次由『新增子对话』创建的、尚未发过任何消息的空会话」——离开时若仍为 0 轮则清理
  const pendingEmptySessionIdRef = useRef<string | null>(null)
  // 卸载守卫：避免卸载后调用 setState 触发警告
  const mountedRef = useRef(true)

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
    sessionLoadEpochRef.current += 1 // 使 openSession 在途加载作废
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
      // 会话加载代次守卫：快速连点「历史会话 → 新建对话」时，listRounds 在途结果
      // 会在 newChat 渲染完欢迎语之后 resolve 并把历史消息盖回去（表现为「新建对话
      // 要点两次才生效」）。newChat / 切智能体都会自增代次，此处 resolve 后代次已变
      // 即丢弃本次加载。
      const loadEpoch = sessionLoadEpochRef.current
      try {
        // 回显该会话绑定的工程（工作空间），无则自由对话
        const sess = await getSession(sessionId)
        const rounds = await listRounds(sessionId)
        if (sessionLoadEpochRef.current !== loadEpoch) return
        setPendingProjectId(sess?.projectId ?? null)
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
    sessionLoadEpochRef.current += 1 // 使 openSession 在途加载作废（防快速连点竞态覆盖欢迎语）
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
  // 竞态守卫（2026-09-26 二修）：恢复期间用户点历史会话 / 点「新建对话」都会改变
  // activeSessionId → effect cleanup 置 cancelled，在途恢复 resolve 后丢弃——
  // 否则历史消息会在 newChat 渲染完欢迎语后被盖回（仅首次进入页面快速连点可见）。
  // 资格守卫（2026-09-26 三修，真正主因）：恢复资格的消耗必须先于 prev 检查——
  // 否则「进入页面时无 lastSession → 资格保留；点开历史 A 时 :1539 把 A 写入
  // lastSessionByAgent；点新建对话使 activeSessionId=null 触发本 effect 重跑 →
  // prev=A 出现 → 把刚离开的会话当「上次会话」恢复回来盖掉欢迎语」——即重启软件
  // 后首次进入页面、点历史会话再点新建对话要点两次的完整引爆链。
  const restoredSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!agent?.id || activeSessionId) return
    if (restoredSessionRef.current === agent.id) return
    restoredSessionRef.current = agent.id // 无论有无 lastSession，本 agent 的自动恢复只判断这一次
    const prev = lastSessionByAgent.get(agent.id)
    if (!prev) return
    let cancelled = false
    void (async () => {
      try {
        const sess = await getSession(prev)
        const rounds = await listRounds(prev)
        if (cancelled) return
        setPendingProjectId(sess?.projectId ?? null)
        setMessages(roundsToMessages(rounds))
        roundIndexRef.current = rounds.length
        setActiveSessionId(prev)
      } catch {
        // 会话可能已被删除：忽略，停留在「新建对话」
      }
    })()
    return () => {
      cancelled = true
    }
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
