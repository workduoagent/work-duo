/**
 * 消息流 UI 组件与打字机 hook（#20260915005 Step 4 自 chat.tsx 原样抽出）。
 *
 * 搬运原则（docs/chat-split-plan.md）：JSX、className、实现、注释一律原样，仅加 export；
 * 渲染层 DOM 结构零改动。useTypewriter / fileExtIcon 仍被 chat.tsx 直接使用，由主文件 import 回引。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import type { ReactElement } from 'react'
import { ChevronDown, ChevronRight, ClipboardList, Copy, File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, RefreshCw, Volume2 } from 'lucide-react'
import { openPath } from '@tauri-apps/plugin-opener'
import { readFile } from '@tauri-apps/plugin-fs'
import { useNotify } from '@/components/ui/notify'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { ToolStepLine } from '../session/ToolStepLine'
import { KbCiteMark } from '../session/KbSearchCitations'
import { makeRemarkKbCites } from '../session/remarkKbCites'
import { isTauri } from '@/core/config'
import { stripWinVerbatim, stripWinVerbatimInText } from '@/utils/pathDisplay'
import type { AgentInfo } from '@/types/core'
import { ImageLightbox } from './image-lightbox'
import type { LightboxImage } from './image-lightbox'
import type { ChatMessage, ChatSegment } from './types'
import type { ToolStep } from '../session/types'
import type { KbHit } from '../session/KbSearchCitations'
import {
  extractFilePaths,
  extractImageMentions,
  FILE_CODE_EXTS,
  FILE_IMAGE_EXTS,
  FILE_SPREADSHEET_EXTS,
  FILE_TEXT_EXTS,
  IMAGE_MIME_BY_EXT,
  isImageExt,
  resolveImagePath,
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
export function FilePathCard({ path }: { path: string }) {
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

/* ------------------------------------------------------------------ *
 * 气泡内联图片：识别回复中的图片路径 → 预载（fs readFile → data URL）→
 * 缩略图直出，点击进全屏预览器（下载/目录资源/旋转/缩放）。
 * ---------------------------------------------------------------- */

interface LoadedImage {
  dataUrl: string
  bytes: Uint8Array
}

/** 图片预载缓存（模块级，按绝对路径去重；同一图片在多气泡/重渲染间共享）。 */
const imageDataCache = new Map<string, Promise<LoadedImage | null>>()

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function loadImageFile(absPath: string, ext: string): Promise<LoadedImage | null> {
  let hit = imageDataCache.get(absPath)
  if (!hit) {
    hit = (async () => {
      try {
        if (!isTauri) return null
        const bytes = await readFile(absPath)
        const mime = IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream'
        return { dataUrl: `data:${mime};base64,${toBase64(bytes)}`, bytes }
      } catch {
        return null
      }
    })()
    imageDataCache.set(absPath, hit)
  }
  return hit
}

/** 气泡内联图片卡：预载成功渲染缩略图（点击进 Lightbox）；失败回退通用文件卡，加载中出占位。 */
function InlineImageCard({
  rawPath,
  workspace,
  onOpen,
}: {
  rawPath: string
  workspace?: string | null
  onOpen: (img: LightboxImage) => void
}) {
  const abs = useMemo(() => resolveImagePath(rawPath, workspace), [rawPath, workspace])
  const slashIdx = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
  const fileName = slashIdx >= 0 ? abs.slice(slashIdx + 1) : abs
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  const [loaded, setLoaded] = useState<LoadedImage | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setLoaded(null)
    setFailed(false)
    loadImageFile(abs, ext).then((r) => {
      if (alive) {
        if (r) setLoaded(r)
        else setFailed(true)
      }
    })
    return () => {
      alive = false
    }
  }, [abs, ext])

  if (failed) return <FilePathCard path={rawPath} />
  if (!loaded) {
    return (
      <div className="agent-chat__img-card is-loading" title={`加载图片：${rawPath}`}>
        <div className="agent-chat__img-loading" />
      </div>
    )
  }
  return (
    <button
      type="button"
      className="agent-chat__img-card"
      title={`预览：${rawPath}`}
      onClick={() => onOpen({ path: abs, name: fileName, dataUrl: loaded.dataUrl, bytes: loaded.bytes })}
    >
      <img className="agent-chat__img-thumb" src={loaded.dataUrl} alt={fileName} draggable={false} />
      <span className="agent-chat__img-name">{fileName}</span>
    </button>
  )
}

/** 单条消息的文件卡片列表：图片路径渲染内联缩略图（点击全屏预览），其余渲染通用文件卡。 */
export function FilePathCards({
  content,
  workspace,
}: {
  content: string
  workspace?: string | null
}) {
  const [preview, setPreview] = useState<LightboxImage | null>(null)
  // 去掉 Windows 逐字前缀 `\\?\`（Rust canonicalize 产物），卡片名称/标题/打开都用干净路径
  const paths = useMemo(() => extractFilePaths(content).map(stripWinVerbatim), [content])
  const imagePaths = useMemo(
    () => extractImageMentions(content, paths).map(stripWinVerbatim),
    [content, paths],
  )
  const fileCards = useMemo(
    () => paths.filter((p) => !isImageExt(p.split('.').pop() ?? '')),
    [paths],
  )
  if (paths.length === 0 && imagePaths.length === 0) return null
  return (
    <>
      {imagePaths.length > 0 && (
        <div className="agent-chat__img-cards">
          {imagePaths.map((p) => (
            <InlineImageCard key={p} rawPath={p} workspace={workspace} onOpen={setPreview} />
          ))}
        </div>
      )}
      {fileCards.length > 0 && (
        <div className="agent-chat__file-cards">
          {fileCards.map((p) => (
            <FilePathCard key={p} path={p} />
          ))}
        </div>
      )}
      {preview && <ImageLightbox image={preview} onClose={() => setPreview(null)} />}
    </>
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

/* ---------------- 引用感知渲染 / 打字机正文 / 过程折叠（台账 S1 步骤A 自 chat.tsx 迁入） ---------------- */

/** K3-2 引用感知正文渲染：消息带 kbSources 时启用内联引标 remark 插件——正文中的 `[N]`
 *  渲染为可悬浮溯源的引标（hover 展示召回片段内容）；无引用数据时与普通 MarkdownRenderer 等价。 */
export function CiteAwareMarkdown({ text, kbSources }: { text?: string; kbSources?: KbHit[] }) {
  const remarkExt = useMemo(() => (kbSources?.length ? [makeRemarkKbCites(kbSources)] : undefined), [kbSources])
   
  const compsExt = useMemo(
    () =>
      kbSources?.length
        ? {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            'kb-cite': (p: any) => <KbCiteMark cite={p?.cite} hits={kbSources} />,
          }
        : undefined,
    [kbSources],
  )
  // 展示净化：去掉 Rust canonicalize 带来的 Windows 逐字前缀 `\\?\`
  // （模型会把工具返回的路径原样写进正文，不处理就显示成 `\\?\E:\xxx`）。
  return (
    <MarkdownRenderer
      content={stripWinVerbatimInText(text ?? '')}
      remarkPluginsExt={remarkExt}
      componentsExt={compsExt}
    />
  )
}

/** 运行中正文段打字机（用户反馈：流式 chunk 整段刷出=「一句句往外刷」）：
 *  复用 useTypewriter 常速逐字（30ms/字≈33 字/秒，肉眼单字节奏；积压 >200 字按比例
 *  加速追赶防永久滞后）。仅最后一段 active 参与打字；非激活段直接全文渲染
 *  （绕过 hook 首帧空闪）。任务结束切非激活 → 终态一次性全文（既有约定）。 */
export function TypewriterMarkdownInner({ text, kbSources }: { text?: string; kbSources?: KbHit[] }) {
  const shown = useTypewriter(text ?? '', true, 30)
  return <CiteAwareMarkdown text={shown} kbSources={kbSources} />
}

export function TypewriterMarkdown({
  text,
  active,
  kbSources,
}: {
  text?: string
  active?: boolean
  kbSources?: KbHit[]
}) {
  if (!active) return <CiteAwareMarkdown text={text} kbSources={kbSources} />
  return <TypewriterMarkdownInner text={text} kbSources={kbSources} />
}

/* ------------------------------------------------------------------ *
 * 对话中的文件路径卡片：自动识别 Agent 回复里的文件路径，以内联卡片展示。
 * ---------------------------------------------------------------- */

/** 折叠的「思考与执行过程」块（2026-09-18 体验重构）：
 * 任务结束后，思考旁白、中间叙述文本与全部工具行**按真实时序**收进此处（默认收起），
 * 气泡正文只保留最终交付内容（最后一段模型文本），对话流恢复「一句问答一段回复」的干净形态。
 * thought 段渲染为「- 文本」小行，与工具块穿插（用户期望形式）。 */
export function ProcessCollapse({
  items,
  toolById,
  psOf,
}: {
  items: ChatSegment[]
  toolById: Map<string, ToolStep>
  psOf: (t?: ToolStep) => { verified?: boolean; evidence?: string } | undefined
}) {
  const [open, setOpen] = useState(false)
  const toolCount = items.filter((s) => s.kind === 'tool').length
  return (
    <div className="agent-chat__proc">
      <button type="button" className="agent-chat__proc-head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>思考与执行过程</span>
        {toolCount > 0 && <span className="agent-chat__proc-n">{toolCount} 次工具调用</span>}
      </button>
      {open && (
        <div className="agent-chat__proc-body">
          {items.map((s, i) =>
            s.kind === 'text' ? (
              <div key={i} className="agent-chat__seg-text">
                <MarkdownRenderer content={stripWinVerbatimInText(s.text ?? '')} />
              </div>
            ) : s.kind === 'thought' ? (
              <div key={i} className="agent-chat__seg-thought">
                - {s.text}
              </div>
            ) : (
              (() => {
                const t = toolById.get(s.callId ?? '')
                if (!t) return null
                const ps = psOf(t)
                return (
                  <ToolStepLine
                    key={`${s.callId}-${i}`}
                    step={t}
                    verified={ps?.verified}
                    evidence={ps?.evidence}
                  />
                )
              })()
            ),
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 运行中的思考段（#20260918011 工作空间模式打字机）：
 * 时间线此前把 thought 段当静态文本渲染（旁白/推理整段蹦出）。这里复用现成 useTypewriter
 * 逐字流出——段内文本增量续写时打字机继续推进，已打完的段自然静止（不回退、不重打）。
 */
export function ThoughtSegmentLine({ text, active = false }: { text?: string; active?: boolean }) {
  const full = text ?? ''
  // 30ms/字（≈33 字/秒）：8ms 对十几字旁白仅 ~150ms 一闪而过，肉眼感知不到打字机（真机反馈）；
  // 30ms 时一行旁白约 0.6s、一段推理 1.5~3s，节奏清晰可读。
  const shown = useTypewriter(full, active, 30)
  return (
    <div className="agent-chat__seg-thought">
      - {active ? shown : full}
      {active && shown.length < full.length && <span className="agent-chat__type-caret" />}
    </div>
  )
}
