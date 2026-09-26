/**
 * 左侧会话树（台账 S1 §2.2 拆分：自 chat.tsx 纯移动，行为等价）。
 * 含：顶部导航（返回/编辑/新建）+ 记忆编辑/重命名/帮助三个 Modal + 搜索/归档开关 +
 * 工程分组树（折叠/置顶/归档/删除等操作菜单）+ 会话项（活动态/运行态/挂起徽标）。
 */
import { ArrowLeft, Pencil, Plus, Search, ChevronRight, ChevronDown, Folder, MessageSquarePlus, FilePen, PinOff, Pin, ArchiveRestore, Archive, MessageSquare, Star, Trash2, MoreVertical, Loader2 } from 'lucide-react'
import { Button, Input, Modal } from '@/components/ui'
import { DropdownMenu } from './mention-ui'
import { agentEditPath } from '@/core/router/paths'
import { stripWinVerbatim } from '@/utils/pathDisplay'
import type { SessionTreeGroup } from '@/core/mapper/agent-session-mapper'
import { isSessionRunning } from '../session/runtimeStore'
import type { AgentConversationSession, AgentProject, AgentInfo } from '@/types/core'
import { formatTime } from './file-helpers'

/** 项目记忆编辑器状态（memoEditor）。 */
export interface MemoEditorState {
  open: boolean
  rootPath: string
  name: string
}

/** 重命名目标（会话 / 工程）。 */
export interface RenameTarget {
  kind: 'session' | 'project'
  id: string
  /** 当前名称（重命名 Modal 的初值，由 chat.tsx 状态机管理）。 */
  current: string
}

interface SessionSidebarProps {
  agent: AgentInfo
  navigate: (path: string) => void
  newChat: () => void
  /* 记忆编辑 Modal */
  memoEditor: MemoEditorState | null
  setMemoEditor: (v: MemoEditorState | null) => void
  memoSaving: boolean
  saveMemoEditor: () => void
  memoContent: string
  setMemoContent: (v: string) => void
  /* 重命名 Modal */
  renameTarget: RenameTarget | null
  setRenameTarget: (v: RenameTarget | null) => void
  renameValue: string
  setRenameValue: (v: string) => void
  confirmRename: () => void
  /* 帮助 Modal */
  helpOpen: boolean
  setHelpOpen: (v: boolean) => void
  /* 搜索 / 归档开关 */
  sessionSearch: string
  setSessionSearch: (v: string) => void
  showArchived: boolean
  setShowArchived: (v: boolean) => void
  /* 会话树 */
  filteredTree: SessionTreeGroup[]
  collapsedGroups: Set<string>
  toggleGroupFold: (groupId: string) => void
  activeSessionId: string | null
  openSession: (sessionId: string) => void
  pendingApproval: boolean
  pendingChoice: boolean
  planApproval: boolean
  /* 操作回调 */
  startProjectSession: (groupId: string) => void
  openMemoEditor: (group: SessionTreeGroup) => void
  pinProjectHandler: (p: AgentProject) => void
  renameProjectHandler: (p: AgentProject) => void
  archiveProjectHandler: (p: AgentProject) => void
  deleteProjectHandler: (p: AgentProject) => void
  removeSession: (sessionId: string) => void
  renameSessionHandler: (s: AgentConversationSession) => void
  toggleSessionTopHandler: (s: AgentConversationSession) => void
  archiveSessionHandler: (s: AgentConversationSession) => void
}

export function SessionSidebar(props: SessionSidebarProps) {
  const {
    agent,
    navigate,
    newChat,
    memoEditor,
    setMemoEditor,
    memoSaving,
    saveMemoEditor,
    memoContent,
    setMemoContent,
    renameTarget,
    setRenameTarget,
    renameValue,
    setRenameValue,
    confirmRename,
    helpOpen,
    setHelpOpen,
    sessionSearch,
    setSessionSearch,
    showArchived,
    setShowArchived,
    filteredTree,
    collapsedGroups,
    toggleGroupFold,
    activeSessionId,
    openSession,
    pendingApproval,
    pendingChoice,
    planApproval,
    startProjectSession,
    openMemoEditor,
    pinProjectHandler,
    renameProjectHandler,
    archiveProjectHandler,
    deleteProjectHandler,
    removeSession,
    renameSessionHandler,
    toggleSessionTopHandler,
    archiveSessionHandler,
  } = props

  return (
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
                      { label: '重命名', icon: <Pencil size={13} />, onClick: () => void renameSessionHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: false, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' } as AgentConversationSession) },
                      { label: s.isTop ? '取消置顶' : '置顶', icon: s.isTop ? <PinOff size={13} /> : <Pin size={13} />, onClick: () => void toggleSessionTopHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: false, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' } as AgentConversationSession) },
                      { label: s.isArchived ? '取消归档' : '归档', icon: s.isArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />, onClick: () => void archiveSessionHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: s.isArchived, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' } as AgentConversationSession) },
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
  )
}
