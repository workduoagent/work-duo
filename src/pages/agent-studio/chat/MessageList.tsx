/**
 * 中间消息流（台账 S1 §2.2 拆分：自 chat.tsx 纯移动，行为等价）。
 * 含：滚动容器（跟随/回看判定）、全部气泡渲染（交错时间线/过程折叠/打字机正文）、
 * 附件展示、错误诊断面板、文件路径卡片、消息操作条、statusText。
 */
import { Coins, MessageSquare, Clock, FileText, TriangleAlert, RefreshCw, Bot } from 'lucide-react'
import type { RefObject } from 'react'
import { Button } from '@/components/ui'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { stripWinVerbatimInText } from '@/utils/pathDisplay'
import { estimateTokens, formatConversationDuration, formatDuration, formatSize, formatTime, textPreview } from './file-helpers'
import { fileExtIcon } from './message-ui'
import type { ChatMessage } from './types'
import type { AgentInfo } from '@/types/core'
import type { ToolStep, RecoveryRequest } from '../session/types'
import { ToolStepLine } from '../session/ToolStepLine'
import { KbSourceList } from '../session/KbSearchCitations'
import {
  CiteAwareMarkdown,
  TypewriterMarkdown,
  ProcessCollapse,
  ThoughtSegmentLine,
  ThoughtPanel,
  FilePathCards,
  MessageActions,
} from './message-ui'

interface MessageListProps {
  displayMessages: ChatMessage[]
  /** 最后一条 agent 气泡的打字机展示内容（chat.tsx 的 displayContent 派生）。 */
  displayedContent: string
  agent: AgentInfo
  scrollRef: RefObject<HTMLDivElement | null>
  lastScrollTopRef: RefObject<number>
  setFollowBottom: (v: boolean) => void
  scheduleFollowScroll: () => void
  isStreaming: boolean
  isRunning: boolean
  statusText: string
  recovery: RecoveryRequest | null
  setRightOpen: (v: boolean) => void
  setRightTab: (t: 'graph' | 'process' | 'artifacts' | 'actions') => void
  handleRegenerate: (msgId: string) => void
  copyError: (message: string) => void
  copyMessageRecord: (m: ChatMessage) => void
  setPreviewSrc: (v: string | null) => void
  /** 会话绑定的工作空间绝对路径（气泡内联图片按它解析相对路径）。 */
  workspace?: string | null
}

export function MessageList(props: MessageListProps) {
  const {
    displayMessages,
    displayedContent,
    agent,
    scrollRef,
    lastScrollTopRef,
    setFollowBottom,
    scheduleFollowScroll,
    isStreaming,
    isRunning,
    statusText,
    recovery,
    setRightOpen,
    setRightTab,
    handleRegenerate,
    copyError,
    copyMessageRecord,
    setPreviewSrc,
    workspace,
  } = props

  return (
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
                <FilePathCards content={isLastAgent ? displayedContent : m.content} workspace={workspace} />
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
  )
}
