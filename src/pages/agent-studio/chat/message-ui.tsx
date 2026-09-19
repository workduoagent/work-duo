/**
 * 消息流 UI 组件与打字机 hook（#20260915005 Step 4 自 chat.tsx 原样抽出）。
 *
 * 搬运原则（docs/chat-split-plan.md）：JSX、className、实现、注释一律原样，仅加 export；
 * 渲染层 DOM 结构零改动。useTypewriter / fileExtIcon 仍被 chat.tsx 直接使用，由主文件 import 回引。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import type { ReactElement } from 'react'
import { ClipboardList, Copy, File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, RefreshCw, Volume2 } from 'lucide-react'
import { openPath } from '@tauri-apps/plugin-opener'
import { useNotify } from '@/components/ui/notify'
import { isTauri } from '@/core/config'
import type { AgentInfo } from '@/types/core'
import type { ChatMessage } from './types'
import {
  extractFilePaths,
  FILE_CODE_EXTS,
  FILE_IMAGE_EXTS,
  FILE_SPREADSHEET_EXTS,
  FILE_TEXT_EXTS,
  ringColor,
} from './file-helpers'

/** 按扩展名映射文件类型图标（lucide-react 组件）。 */
export function fileExtIcon(name?: string, size = 16): ReactElement {
  const ext = (name?.split('.').pop() ?? '').toLowerCase()
  if (['pdf', 'doc', 'docx', 'rtf', 'ppt', 'pptx', 'odt'].includes(ext)) return <FileText size={size} />
  if (['xls', 'xlsx', 'csv', 'tsv', 'numbers'].includes(ext)) return <FileSpreadsheet size={size} />
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'].includes(ext)) return <FileArchive size={size} />
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) return <FileImage size={size} />
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'json', 'yml', 'yaml', 'toml'].includes(ext)) return <FileCode size={size} />
  return <File size={size} />
}

/** 打字机效果：把完整目标文本逐步显示，避免一次性刷出整段内容。
 *  自适应追赶：落后目标文本较多时按比例加速吐字（终态一次性推送全文时约 0.5s 追平），
 *  流式小步追加时仍保持 10ms/字符的细腻节奏。 */
export function useTypewriter(text: string, active: boolean, speed = 10) {
  const [displayed, setDisplayed] = useState('')
  const idxRef = useRef(0)
  const textRef = useRef(text)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 始终持有最新目标文本，供自驱定时器读取，避免闭包捕获到旧文本
  textRef.current = text

  useEffect(() => {
    if (!active) {
      // 流式结束：直接展示完整文本
      setDisplayed(textRef.current)
      idxRef.current = textRef.current.length
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      return
    }
    // 流式进行中：自驱定时器持续吐字，text 高频更新不再打断它
    const tick = () => {
      const target = textRef.current
      if (idxRef.current > target.length) idxRef.current = target.length
      if (idxRef.current >= target.length) {
        timerRef.current = null
        return
      }
      const remaining = target.length - idxRef.current
      // 落后超过 200 字符时按比例追赶（约 50 步内追平），否则逐字符推进
      idxRef.current += remaining > 200 ? Math.ceil(remaining / 50) : 1
      setDisplayed(target.slice(0, idxRef.current))
      timerRef.current = setTimeout(tick, speed)
    }
    // 仅当没有正在运行的定时器时才启动，避免重复堆叠
    if (timerRef.current == null) {
      timerRef.current = setTimeout(tick, speed)
    }
    // 注意：此处不清理定时器，否则 text 高频更新会把打字机清停导致卡住
  }, [text, active, speed])

  // 组件卸载时清理定时器，避免向已卸载组件 setState。
  // 关键：清理后必须复位 null——React StrictMode 双挂载（cleanup → 重跑 effect）时若残留旧 id，
  // 启动 guard（timerRef.current == null）会误判「定时器仍在」而永不重启，打字机卡死在空串
  // （2026-09-19 真机实锤：思考段全部渲染成空行）。判空用 != null 而非真值（定时器 id 可能为 0）。
  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  return displayed
}

export function ThoughtPanel({ thoughts, active = false }: { thoughts: string[]; active?: boolean }) {
  // 思考内容不再用「胶囊」包裹，也不折叠：直接平铺到对话流，按打字机节奏逐字输出
  // （与作答同款 useTypewriter；思考进行中带光标，结束后光标消失、内容保留）。
  const joined = thoughts.join('\n')
  const shown = useTypewriter(joined, active, 8)
  if (!joined) return null
  return (
    <div className="agent-chat__thinking-inline">
      {shown}
      {active && <span className="agent-chat__type-caret" />}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 对话中的文件路径卡片：自动识别 Agent 回复里的文件路径，以内联卡片展示。
 * ---------------------------------------------------------------- */

function fileIconAndColor(ext: string): { icon: React.ElementType; color: string } {
  const e = ext.toLowerCase()
  if (FILE_SPREADSHEET_EXTS.has(e)) {
    return { icon: FileSpreadsheet, color: 'var(--color-success)' }
  }
  if (FILE_IMAGE_EXTS.has(e)) {
    return { icon: FileImage, color: 'var(--color-primary)' }
  }
  if (FILE_TEXT_EXTS.has(e)) {
    return { icon: FileText, color: 'var(--color-foreground-muted)' }
  }
  if (FILE_CODE_EXTS.has(e)) {
    return { icon: FileCode, color: 'var(--color-brand-600)' }
  }
  return { icon: File, color: 'var(--color-foreground-muted)' }
}

/** 文件路径卡片：显示文件名、扩展名、类型图标，点击用系统默认应用打开。 */
function FilePathCard({ path }: { path: string }) {
  const { message } = useNotify()
  const slashIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const fileName = slashIdx >= 0 ? path.slice(slashIdx + 1) : path
  const extDot = fileName.lastIndexOf('.')
  const ext = extDot > 0 ? fileName.slice(extDot + 1) : ''
  const displayName = extDot > 0 ? fileName.slice(0, extDot) : fileName
  const { icon: Icon, color } = fileIconAndColor(ext)

  const handleOpen = useCallback(async () => {
    if (!isTauri) {
      message.info('浏览器环境无法打开本地文件')
      return
    }
    try {
      await openPath(path)
    } catch (e) {
      message.error(`打开文件失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [path, message])

  return (
    <button
      type="button"
      className="agent-chat__file-card"
      title={`打开：${path}`}
      onClick={handleOpen}
    >
      <span className="agent-chat__file-icon" style={{ color }}>
        <Icon size={22} />
      </span>
      <span className="agent-chat__file-info">
        <span className="agent-chat__file-name">{displayName}</span>
        {ext && <span className="agent-chat__file-ext">.{ext}</span>}
      </span>
    </button>
  )
}

/** 单条消息的文件卡片列表（仅在存在可识别路径时渲染）。 */
export function FilePathCards({ content }: { content: string }) {
  const paths = useMemo(() => extractFilePaths(content), [content])
  if (paths.length === 0) return null
  return (
    <div className="agent-chat__file-cards">
      {paths.map((p) => (
        <FilePathCard key={p} path={p} />
      ))}
    </div>
  )
}

/** token 环形图 + 悬浮明细。
 *  - 环：**最近一轮任务的输入 tokens / 上下文窗口**（真实的上下文压力指标）；
 *    2026-09-18 修正：此前误用「会话累计消耗 ÷ 窗口」当占比，多轮会话动辄 1100% 造成误导——
 *    累计是成本口径，不是窗口占用口径。
 *  - 悬浮明细：窗口占用（最近一轮输入）+ 会话累计消耗 + 输入/对话/工具成本占比。 */
export function TokenRing({
  windowTokens,
  sessionPrompt,
  sessionCompletion,
  sessionTools,
  limit,
}: {
  windowTokens: number
  sessionPrompt: number
  sessionCompletion: number
  sessionTools: number
  limit?: number
}) {
  const size = 22
  const stroke = 3
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const ratio = limit && limit > 0 ? windowTokens / limit : 0
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = c * clamped
  const color = windowTokens > 0 ? ringColor(ratio) : 'var(--color-border)'
  const pct = limit && limit > 0 ? Math.round(ratio * 100) : null
  const sessionTotal = Math.max(1, sessionPrompt + sessionCompletion + sessionTools)
  const inputPct = Math.round((sessionPrompt / sessionTotal) * 100)
  const completionPct = Math.round((sessionCompletion / sessionTotal) * 100)
  const toolPct = Math.round((sessionTools / sessionTotal) * 100)
  return (
    <span
      className="agent-chat__token-ring"
      tabIndex={0}
      title={
        pct !== null && limit
          ? `最近一轮输入 ${windowTokens.toLocaleString()} / ${limit.toLocaleString()} tokens（${pct}% 窗口）`
          : `最近一轮输入 ${windowTokens.toLocaleString()} tokens`
      }
    >
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-border)" strokeWidth={stroke} fill="none" />
        {windowTokens > 0 && (
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
          窗口占用（最近一轮输入）：{windowTokens.toLocaleString()} tokens
          {pct !== null ? `（${pct}%）` : ''}
        </div>
        <div className="agent-chat__token-pop-row">
          <span>会话累计消耗</span>
          <span>
            {(sessionPrompt + sessionCompletion + sessionTools).toLocaleString()} tokens
          </span>
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

/** 顶栏「本次任务」实时 token 计数卡：随 `agent-token-update` 事件实时跳数。
 *  - 运行中：脉冲圆点 + 累计总数（提示↑ / 补全↓）；
 *  - 运行结束：冻结为终值，直到下一轮 run / reset 清空；
 *  - 空闲且无用量：不渲染（不抢占顶栏空间）。 */
export function LiveTokenCounter({
  usage,
  running,
}: {
  usage: { promptTokens: number; completionTokens: number } | null
  running: boolean
}) {
  if (!usage && !running) return null
  const total = usage ? usage.promptTokens + usage.completionTokens : 0
  return (
    <span
      className={`agent-chat__token-live${running ? ' is-live' : ''}`}
      title="本次任务的实时 token 消耗（提示词 + 补全）"
    >
      <span className="agent-chat__token-live-dot" />
      <span className="agent-chat__token-live-label">本次</span>
      <span className="agent-chat__token-live-num">{total.toLocaleString()}</span>
      {usage ? (
        <span className="agent-chat__token-live-sub">
          {usage.promptTokens.toLocaleString()}↑ / {usage.completionTokens.toLocaleString()}↓
        </span>
      ) : (
        <span className="agent-chat__token-live-sub">统计中…</span>
      )}
    </span>
  )
}

/** 单条助手消息底部的操作按钮 + 元数据。 */
export function MessageActions({
  msg,
  agent,
  onRegenerate,
  onCopyFull,
}: {
  msg: ChatMessage
  agent: AgentInfo
  onRegenerate: () => void
  /** 复制该条完整记录（正文 + 思考旁白与工具调用穿插），放在「重新生成」左侧。 */
  onCopyFull?: () => void
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

  return (
    <div className="agent-chat__msg-footer">
      <div className="agent-chat__msg-actions">
        <button type="button" title="复制正文" onClick={handleCopy}>
          <Copy size={14} />
        </button>
        {agent.ttsId && (
          <button type="button" title="朗读" onClick={handleSpeak}>
            <Volume2 size={14} />
          </button>
        )}
        {onCopyFull && (
          <button
            type="button"
            title="复制完整记录（含思考与工具调用）"
            onClick={onCopyFull}
          >
            <ClipboardList size={14} />
          </button>
        )}
        <button type="button" title="重新生成" onClick={onRegenerate}>
          <RefreshCw size={14} />
        </button>
      </div>
    </div>
  )
}
