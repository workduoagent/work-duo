/**
 * 会话 / 工作空间域（台账 S1：自 chat.tsx 原样迁出 hook 化，行为零改动）。
 *
 * 覆盖：sessions / projects 状态与树 memo（buildSessionTree / 搜索过滤 / 分组折叠）、
 * 会话行操作（打开 / 新建 / 删除 / 重命名 / 置顶 / 归档）、工程操作（新增子对话 /
 * 重命名 / 置顶 / 归档 / 级联删除）、工程记忆编辑器（.wd_mem/MEMORY.md）、
 * 工作空间绑定胶囊（绑定 / 解绑，#20260915004 B1）、chatMod 模块级注入
 * （refreshSessionsRef / chatViewSessionRef / openSessionRef / sessionsSnapshot）、
 * 切页恢复（lastSessionByAgent，含 2026-09-26 二修/三修竞态守卫）、切智能体清空、
 * 卸载守卫与空会话清理。
 * 运行链路在 useChatRun，终态落库在 terminal-bridge。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { isTauri } from '@/core/config'
import { getNotifyApi } from '@/components/ui/notifyBridge'
import { useNotify } from '@/components/ui/notify'
import {
  createSession,
  deleteSession,
  getSession,
  listRounds,
  listSessions,
  renameSession,
  setSessionArchived,
  clearSessionProject,
  toggleSessionTop,
  updateSession,
  type SessionTreeGroup,
} from '@/core/mapper/agent-session-mapper'
import {
  deleteProject,
  ensureProjectByPath,
  getProject,
  listProjects,
  updateProject,
} from '@/core/mapper/agent-project-mapper'
import { readProjectMemory, writeProjectMemory } from '@/core/mapper/wd-mem-mapper'
import { isSessionRunning } from '../session/runtimeStore'
import type { AgentInfo, AgentConversationSession, AgentProject } from '@/types/core'
import { chatMod, lastSessionByAgent } from './terminal-bridge'
import { buildSessionTree, roundsToMessages } from './session-helpers'
import { useAttachments } from './useAttachments'
import type { ChatMessage } from './types'

type MentionTag = { key: string; label: string; token: string }
type Notify = ReturnType<typeof useNotify>

export function useSessionWorkspace(opts: {
  agent: AgentInfo | undefined
  /** 路由参数 id：切智能体 effect 的依赖（与 agent 对象解耦，agent 尚未加载完成时也能清场）。 */
  agentId: string
  activeSessionId: string | null
  setActiveSessionId: Dispatch<SetStateAction<string | null>>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  reset: () => void
  /** 运行域轮次序号（useChatRun 返回）：切智能体 / 新建会话 / 打开历史时复位。 */
  roundIndexRef: { current: number }
  /** 「新增子对话」空会话标记（组件持有，useChatRun 同用）：发送即清，离开页面按需清理。 */
  pendingEmptySessionIdRef: { current: string | null }
  /** projects / sessions 留在组件（load effect 在本 hook 之前定义，TDZ），只传值与 setter。 */
  projects: AgentProject[]
  setProjects: Dispatch<SetStateAction<AgentProject[]>>
  sessions: AgentConversationSession[]
  setSessions: Dispatch<SetStateAction<AgentConversationSession[]>>
  pendingProjectId: string | null
  setPendingProjectId: Dispatch<SetStateAction<string | null>>
  setInput: Dispatch<SetStateAction<string>>
  setMentionTags: Dispatch<SetStateAction<MentionTag[]>>
  setPendingAttachments: ReturnType<typeof useAttachments>['setPendingAttachments']
  setDragOver: ReturnType<typeof useAttachments>['setDragOver']
  setRemovedSkillIds: Dispatch<SetStateAction<Set<string>>>
  setRemovedMcpIds: Dispatch<SetStateAction<Set<string>>>
  setDisabledMcpToolIds: Dispatch<SetStateAction<Set<string>>>
  message: Notify['message']
  modal: Notify['modal']
}) {
  const {
    agent,
    agentId,
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
  } = opts

  // 搜索 / 归档过滤 / 分组折叠（projects / sessions 留在组件，见 opts 注释）
  const [sessionSearch, setSessionSearch] = useState('')
  // 归档项默认收起；开启后已归档会话 / 工程重新出现在列表（#20260915004 B2）。
  const [showArchived, setShowArchived] = useState(false)
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

  // 工程记忆编辑器（.wd_mem/MEMORY.md）
  const [memoEditor, setMemoEditor] = useState<{ open: boolean; rootPath: string; name: string } | null>(null)
  const [memoContent, setMemoContent] = useState('')
  const [memoSaving, setMemoSaving] = useState(false)

  // 重命名弹窗（替代 window.prompt，避免 Tauri 拦截 dialog 插件）
  const [renameTarget, setRenameTarget] = useState<{ kind: 'session' | 'project'; id: string; current: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 会话加载代次：openSession 的异步加载（getSession/listRounds）resolve 后核对，
  // 代次已变（newChat / 切智能体）则丢弃结果——防「历史会话消息盖回新建对话」竞态。
  const sessionLoadEpochRef = useRef(0)
  // 卸载守卫：避免卸载后调用 setState 触发警告
  const mountedRef = useRef(true)

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

  // 切页回来（对话页重挂）：恢复上次查看的会话。
  // **刻意不走 openSession**——它会 resetRuntime 清掉该会话的运行态，把正在跑的任务
  // 的进度抹掉；这里只加载历史轮次并绑定会话 id，运行态由模块级 store 原样带出。
  // 竞态守卫（2026-09-26 二修）：恢复期间用户点历史会话 / 点「新建对话」都会改变
  // activeSessionId → effect cleanup 置 cancelled，在途恢复 resolve 后丢弃——
  // 否则历史消息会在 newChat 渲染完欢迎语后被盖回（仅首次进入页面快速连点可见）。
  // 资格守卫（2026-09-26 三修，真正主因）：恢复资格的消耗必须先于 prev 检查——
  // 否则「进入页面时无 lastSession → 资格保留；点开历史 A 时把 A 写入
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
      const selected = await open({ directory: true, multiple: false, recursive: true, title: '选择工作空间目录' })
      if (!selected || typeof selected !== 'string') return
      const proj = await ensureProjectByPath(selected)
      // F003 follow-up：为工程根签发跨重启授权凭据（手选目录已由 dialog 自动授权本次会话）。
      // 失败不阻断绑定：重启后重新选择目录即可补签。
      try {
        await invoke('record_fs_scope_grant', { scopeKey: `project:${proj.id}`, path: proj.rootPath })
      } catch (scopeError) {
        message.warning(`工作空间已绑定，但持久授权签发失败（重启后需重新选择目录）：${String(scopeError)}`)
      }
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
  }, [agentId])

  // 卸载守卫 + 离开会话页时清理未发消息的空会话（刷新 / 路由回列表均走此处）
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void cleanupPendingEmptySession()
    }
  }, [])

  // 左侧树状分组（GLOBAL + 各 PROJECT），随搜索过滤
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

  return {
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
  }
}
