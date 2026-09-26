/**
 * 底部输入工具条（台账 S1 §2.2 拆分：自 chat.tsx 纯移动，行为等价）。
 * 含：待处置提醒卡、输入框（拖拽高度/粘贴/拖放）、@提及 chips 与建议浮层、
 * 待发附件区、能力胶囊（工程/沙箱/技能/MCP/插件）、token 计数、语音与发送。
 */
import { TriangleAlert, FileText, ImagePlus, Paperclip, Mic, Square, Send } from 'lucide-react'
import type { RefObject } from 'react'
import { Button } from '@/components/ui'
import { formatSize, textPreview } from './file-helpers'
import { WorkspaceChip, SkillChip, McpPill, PluginPill } from './mention-ui'
import { fileExtIcon, LiveTokenCounter, TokenRing } from './message-ui'
import type { PendingAttachment, SuggestItem, SuggestState } from './types'

/** @提及 chip（chat.tsx 状态机管理，key/label/token）。 */
interface MentionTag {
  key: string
  label: string
  token: string
}
import type { RecoveryRequest } from '../session/types'
import type { AgentInfo, AgentConversationSession, AgentProject } from '@/types/core'
import type { BoundMcpServer } from './types'
import type { UserPluginTool } from '@/core/file/plugin-file'
import type { SkillInfo } from '@/core/file/skill-file'



interface ChatComposerProps {
  /* 待处置提醒卡 */
  pendingApproval: boolean
  recovery: RecoveryRequest | null
  pendingChoice: boolean
  planApproval: boolean
  setRightOpen: (v: boolean) => void
  setRightTab: (t: 'graph' | 'process' | 'artifacts' | 'actions') => void
  /* 输入框与拖放 */
  dragOver: boolean
  setDragOver: (v: boolean) => void
  dragDepth: RefObject<number>
  setWindowDrag: (v: boolean) => void
  addFiles: (files: File[]) => void
  startInputResize: (e: React.MouseEvent) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  input: string
  inputHeight: number
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  handleCaretMove: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void
  handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  agentBusy: boolean
  /* @提及 */
  mentionTags: MentionTag[]
  setMentionTags: React.Dispatch<React.SetStateAction<MentionTag[]>>
  suggest: SuggestState | null
  setSuggest: React.Dispatch<React.SetStateAction<SuggestState | null>>
  applyMention: (it: SuggestItem) => void
  runCommand: (it: SuggestItem) => void
  /* 附件 */
  pendingAttachments: PendingAttachment[]
  setPendingAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>
  setPreviewSrc: (v: string | null) => void
  isMultimodal: boolean
  fileInputRef: RefObject<HTMLInputElement | null>
  fileAttachRef: RefObject<HTMLInputElement | null>
  /* 能力胶囊 */
  projects: AgentProject[]
  pendingProjectId: string | null
  changeWorkspaceDir: () => void
  clearWorkspaceBinding: () => void
  agent: AgentInfo
  boundSkills: SkillInfo[]
  removedSkillIds: Set<string>
  toggleSkill: (id: string) => void
  boundMcps: BoundMcpServer[]
  removedMcpIds: Set<string>
  toggleMcp: (id: string) => void
  disabledMcpToolIds: Set<string>
  toggleMcpTool: (toolId: string) => void
  boundPlugins: UserPluginTool[]
  removedPluginIds: Set<string>
  togglePlugin: (id: string) => void
  /* 计数与发送 */
  liveTokenUsage: { promptTokens: number; completionTokens: number } | null
  lastLlmUsage: { promptTokens: number; completionTokens: number } | null
  activeSession: AgentConversationSession | undefined
  contextLength: number | undefined
  hasStt: boolean
  recording: boolean
  toggleVoice: () => void
  isRunning: boolean
  cancel: () => void
  send: () => void
}

export function ChatComposer(props: ChatComposerProps) {
  const {
    pendingApproval,
    recovery,
    pendingChoice,
    planApproval,
    setRightOpen,
    setRightTab,
    dragOver,
    setDragOver,
    dragDepth,
    setWindowDrag,
    addFiles,
    startInputResize,
    textareaRef,
    input,
    inputHeight,
    handleInputChange,
    onPaste,
    handleCaretMove,
    handleInputKeyDown,
    agentBusy,
    mentionTags,
    setMentionTags,
    suggest,
    setSuggest,
    applyMention,
    runCommand,
    pendingAttachments,
    setPendingAttachments,
    setPreviewSrc,
    isMultimodal,
    fileInputRef,
    fileAttachRef,
    projects,
    pendingProjectId,
    changeWorkspaceDir,
    clearWorkspaceBinding,
    agent,
    boundSkills,
    removedSkillIds,
    toggleSkill,
    boundMcps,
    removedMcpIds,
    toggleMcp,
    disabledMcpToolIds,
    toggleMcpTool,
    boundPlugins,
    removedPluginIds,
    togglePlugin,
    liveTokenUsage,
    lastLlmUsage,
    activeSession,
    contextLength,
    hasStt,
    recording,
    toggleVoice,
    isRunning,
    cancel,
    send,
  } = props

  return (
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
          // 仅当真正离开 input-box 整体时收起（台账 S1 拖拽回归修复）：
          // relatedTarget = 拖拽移入的相邻元素——为 null（离开窗口）或不属于本容器
          // 子树（移出到外层空白）才复位；容器内部子元素间移动（textarea ↔ 附件 chip）
          // 则保持高亮。旧判定 `e.currentTarget === e.target` 在「从子元素直接拖出」时
          // target 是子元素 ≠ 容器，高亮永不复位（虚线框残留）。
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
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
  )
}
