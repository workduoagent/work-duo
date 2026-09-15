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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Pencil,
  Send,
  Bot,
  Loader2,
  Box,
  Trash2,
  Square,
  ChevronRight,
  ChevronLeft,
  Copy,
  Volume2,
  RefreshCw,
  Coins,
  Clock,
  Mic,
  ImagePlus,
  Search,
  Plus,
  MessageSquare,
  Star,
  X,
  RotateCcw,
  Folder,
  GitBranch,
  Workflow,
  MoreVertical,
  Archive,
  MessageSquarePlus,
  Pin,
  PinOff,
  ArchiveRestore,
  FilePen,
  FolderEdit,
  Unlink,
  File,
  FileText,
  FileSpreadsheet,
  FileCode,
  FileImage,
  FileArchive,
  Paperclip,
  TriangleAlert,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { appDataDir, resourceDir } from '@tauri-apps/api/path'
import { openPath } from '@tauri-apps/plugin-opener'
import { open } from '@tauri-apps/plugin-dialog'
import { Button, Switch, Modal, Input } from '@/components/ui'
import { Avatar } from '@/components/ui/AvatarGroup'
import { useNotify } from '@/components/ui/notify'

/** 产物画廊：把本次任务各子任务成功闭环登记的文件产物横向展示，支持打开/定位与复制路径（K3 §2.3）。 */
function ArtifactIcon({ type }: { type: string }) {
  switch (type) {
    case 'image':
      return <FileImage size={16} />
    case 'spreadsheet':
      return <FileSpreadsheet size={16} />
    case 'code':
      return <FileCode size={16} />
    case 'directory':
      return <Folder size={16} />
    case 'document':
    case 'json':
    case 'report':
      return <FileText size={16} />
    default:
      return <File size={16} />
  }
}

function ArtifactGallery({ artifacts, isTauri }: { artifacts: ArtifactRef[]; isTauri: boolean }) {
  const { message } = useNotify()
  if (!artifacts.length) return null
  const copyPath = (p: string) => {
    navigator.clipboard
      ?.writeText(p)
      .then(() => message.success('路径已复制'), () => message.error('复制失败'))
  }
  const open = (p: string) => {
    if (!isTauri) return
    openPath(p).catch(() => message.error('打开失败'))
  }
  return (
    <div className="agent-chat__gallery">
      <div className="agent-chat__gallery-title">📦 本次产物（{artifacts.length}）</div>
      <div className="agent-chat__gallery-list">
        {artifacts.map((a) => (
          <div key={a.artifactId} className="agent-chat__gallery-item" title={a.path}>
            <span className="agent-chat__gallery-icon">
              <ArtifactIcon type={a.artifactType} />
            </span>
            <div className="agent-chat__gallery-meta">
              <div className="agent-chat__gallery-name">{a.description || a.path}</div>
              <div className="agent-chat__gallery-sub">{formatSize(a.size)}</div>
            </div>
            <button
              type="button"
              className="agent-chat__gallery-open"
              title="在文件夹中打开"
              disabled={!isTauri}
              onClick={() => open(a.path)}
            >
              打开
            </button>
            <button
              type="button"
              className="agent-chat__gallery-copy"
              title="复制绝对路径"
              onClick={() => copyPath(a.path)}
            >
              <Copy size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
import { getAgent, listAgentMcpTools, listAgentSkills } from '@/core/mapper/agent-mapper'
import { listSkills } from '@/core/mapper/skill-mapper'
import { readSkillLogoBase64 } from '@/core/file/skillFs'
import { listMcps, listMcpTools } from '@/core/mapper/mcp-mapper'
import { getModel } from '@/core/mapper/model-mapper'
import { getRawConfig } from '@/core/mapper/config-mapper'
import {
  createSession,
  listSessions,
  updateSession,
  getSession,
  deleteSession,
  appendRound,
  listRounds,
  updateRound,
  addSessionTokens,
  renameSession,
  setSessionArchived,
  clearSessionProject,
  toggleSessionTop,
  type SessionTreeGroup,
} from '@/core/mapper/agent-session-mapper'
import {
  listProjects,
  getProject,
  ensureProjectByPath,
  updateProject,
  deleteProject,
  leafDirName,
} from '@/core/mapper/agent-project-mapper'
import { readProjectMemory, writeProjectMemory } from '@/core/mapper/wd-mem-mapper'
import { agentEditPath } from '@/core/router/paths'
import { isTauri } from '@/core/config'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { useAgentSession } from './session/useAgentSession'
import { TracePanel } from './session/TracePanel'
import { RunDagCanvas } from './session/RunDagCanvas'
import { ToolStepLine } from './session/ToolStepLine'
import { UserPromptPanel } from './session/UserPromptPanel'
import { TakeoverPanel } from './session/TakeoverPanel'
import type { ToolStep, PlanStep, ChatAttachmentInput, ArtifactRef, ReadArtifactResult, BranchFromStepInput, BranchStep, PlanDAG, ContextCompactedPayload } from './session/types'
import type {
  AgentInfo,
  AgentConversationSession,
  AgentConversationRound,
  AgentProject,
} from '@/types/core'
import type { SkillInfo } from '@/core/file/skill-file'
import type { McpToolDefinition } from '@/core/file/mcp-file'
import './chat.scss'

/** 输入框底部工具条里展示的「单个 MCP 服务」及其绑定工具（用于临时移除 / 工具开关）。 */
interface BoundMcpTool {
  /** mcp_tool_definition.id（Rust 过滤键）。 */
  toolId: string
  /** 工具代码 / 展示名。 */
  toolCode: string
  displayName?: string
  description?: string
}
interface BoundMcpServer {
  mcpId: string
  name: string
  tools: BoundMcpTool[]
}

/** 输入框 @提及 / /指令 浮层的候选条目。 */
interface SuggestItem {
  /** 唯一键（用于 React 列表与选中判定）。 */
  key: string
  /** 插入文本框的 token（@ 或 / 之后的实际文本，通常无空格）。 */
  token: string
  /** 展示名。 */
  label: string
  /** 补充说明（技能描述 / 服务类型 / 指令说明）。 */
  sub?: string
  /** 分组标题（决定浮层渲染时的分组头）。 */
  group: '技能' | 'MCP 服务' | '指令'
}

/** 输入框建议浮层状态（@提及 与 /指令 共用同一套触发/渲染逻辑）。 */
interface SuggestState {
  mode: 'mention' | 'command'
  /** 触发符（@ 或 /）之后的查询串。 */
  query: string
  /** 触发符在 input 中的起始下标（含 @ 或 /）。 */
  start: number
  /** 当前光标位置（触发词尾部）。 */
  end: number
  /** 按查询过滤后的候选列表（渲染与键盘导航共用）。 */
  items: SuggestItem[]
  /** 当前高亮项下标（仅在触发词签名变化时归零，避免方向键被光标微调重置）。 */
  index: number
}

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  createdAt: number
  /** 该轮的深度思考/状态文本（绑定到消息，多轮互不串台）。 */
  thought?: string[]
  /** 该轮的工具调用步骤（绑定到消息，多轮互不串台）。 */
  toolSteps?: ToolStep[]
  /** 该轮的规划步骤结构（绑定到消息，历史回显时重建「步骤 → 工具」嵌套视图；live 轮用运行时 planSteps）。 */
  planSteps?: PlanStep[]
  /** 回复完成时间戳（用于计算对话时长与本条耗时）。 */
  completedAt?: number
  /** 本条回复耗时（ms）。 */
  durationMs?: number
  /** 预估消耗 token 数。 */
  tokenCount?: number
  /** 用户消息附带的图片（多模态）。 */
  images?: ChatAttachmentInput[]
  /** 用户消息附带的全部附件（image/text/file），用于气泡回显。 */
  attachments?: ChatAttachmentInput[]
  /** 该轮任务异常信息（由 `agent-task-error` 写入），用于渲染「错误诊断面板」。 */
  error?: { message: string; at: number }
}

/** 输入框暂存附件：在 ChatAttachmentInput 基础上加前端 id，用于列表 key 与移除。 */
interface PendingAttachment extends ChatAttachmentInput {
  id: string
}

/** 文本型扩展名白名单：这些文件直接提取文本内联（≤200KB），任意模型可用。 */
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'xml', 'html', 'htm', 'css',
  'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp',
  'sh', 'bat', 'ps1', 'yml', 'yaml', 'toml', 'ini', 'env', 'sql', 'kt', 'swift',
  'php', 'rb', 'gitignore', 'lock',   'tex', 'r', 'scala', 'dart',
])

/** 判断文件是否可作文本内联（按 MIME 或扩展名）。 */
function isTextType(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (['application/json', 'application/xml', 'application/javascript', 'application/typescript'].includes(file.type)) {
    return true
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXT.has(ext)
}

/** 生成附件前端 id。 */
function attId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/** 人类可读的文件大小。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** Promise 化的 FileReader 读取。 */
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

/** 按扩展名映射文件类型图标（lucide-react 组件）。 */
function fileExtIcon(name?: string, size = 16): ReactElement {
  const ext = (name?.split('.').pop() ?? '').toLowerCase()
  if (['pdf', 'doc', 'docx', 'rtf', 'ppt', 'pptx', 'odt'].includes(ext)) return <FileText size={size} />
  if (['xls', 'xlsx', 'csv', 'tsv', 'numbers'].includes(ext)) return <FileSpreadsheet size={size} />
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2'].includes(ext)) return <FileArchive size={size} />
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) return <FileImage size={size} />
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'sh', 'json', 'yml', 'yaml', 'toml'].includes(ext)) return <FileCode size={size} />
  return <File size={size} />
}

/** 文本附件首行预览（去掉多余空白，限长）。 */
function textPreview(content?: string): string {
  if (!content) return ''
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? ''
  return firstLine.length > 48 ? firstLine.slice(0, 48) + '…' : firstLine
}

/** 附件尺寸上限（分片上传，远高于旧版 20MB 内联上限）。 */
const MAX_INLINE_IMAGE = 20 * 1024 * 1024
const TEXT_INLINE_LIMIT = 200 * 1024
const MAX_FILE = 500 * 1024 * 1024

/** 解析 app_config.workspace_path（$APPDATA/$RESOURCE 占位）为真实目录，并追加智能体子目录。 */
async function resolveWorkspaceDir(agent: AgentInfo): Promise<string | null> {
  if (!isTauri) return null
  const raw = (await getRawConfig('workspace_path')) ?? '$APPDATA/.workspace'
  // 去引号兜底：历史库可能把 value 存成了带双引号的形式。
  const cleaned = raw.replace(/^"+/, '').replace(/"+$/, '').trim()
  let base = cleaned
  if (base.includes('$APPDATA')) base = base.replace('$APPDATA', await appDataDir())
  if (base.includes('$RESOURCE')) base = base.replace('$RESOURCE', await resourceDir())
  return `${base}/${agent.identifier}`
}

/** 打字机效果：把完整目标文本逐步显示，避免一次性刷出整段内容。
 *  自适应追赶：落后目标文本较多时按比例加速吐字（终态一次性推送全文时约 0.5s 追平），
 *  流式小步追加时仍保持 10ms/字符的细腻节奏。 */
function useTypewriter(text: string, active: boolean, speed = 10) {
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

  // 组件卸载时清理定时器，避免向已卸载组件 setState
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return displayed
}

function ThoughtPanel({ thoughts, active = false }: { thoughts: string[]; active?: boolean }) {
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

/** 匹配 Windows / Unix / 相对路径（要求带扩展名，避免把 URL 当路径）。
 * 字符类显式排除 `'`, `"`, `` ` ``, `+`：这些在真实文件名里几乎不会出现，
 * 但 Agent 输出常把它们作为代码引用 / 模板字面量的边界字符；不排除则正则
 * 会贪婪地把多段路径/文件名穿成一个串（如 `a.md' + 'b.docx`）。 */
const FILE_PATH_RE =
  /(?<!:\/\/)(?<![a-zA-Z]:\/\/)\b(?:[A-Za-z]:[\\/](?:[^<>:"|?*'`+\n\r]+[\\/])*[^<>:"|?*'`+\n\r]+\.\w{2,10}|(?:\/|\.{0,2}\/)(?:[^<>:"|?*'`+\n\r]+\/)*[^<>:"|?*'`+\n\r]+\.\w{2,10})/g

const FILE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const FILE_SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'tsv'])
const FILE_TEXT_EXTS = new Set(['md', 'txt', 'doc', 'docx', 'pdf', 'rtf'])
const FILE_CODE_EXTS = new Set([
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'py',
  'js',
  'ts',
  'tsx',
  'jsx',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'cs',
  'php',
  'rb',
])

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

function extractFilePaths(content: string): string[] {
  const matches = Array.from(content.matchAll(FILE_PATH_RE))
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of matches) {
    // 去除末尾标点，避免把 markdown 句尾标点纳入路径
    let raw = m[0].replace(/[.,;:)\}\]>`]+$/, '')
    if (!raw) continue
    // 排除 URL 片段：若匹配前紧邻 http(s):// 则跳过
    const prefix = content.slice(Math.max(0, m.index - 10), m.index)
    if (/https?:\/\/$/i.test(prefix)) continue
    // 统一处理 Windows 反斜杠为展示用原始值；仅当确实像路径才保留
    if (!/[\\/]/.test(raw) && !/^[A-Za-z]:/.test(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
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
function FilePathCards({ content }: { content: string }) {
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

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0.0s'
  return `${(ms / 1000).toFixed(1)}s`
}

function formatConversationDuration(ms: number): string {
  if (!ms || ms < 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 简易 token 估算：CJK 字符 ≈ 1 token；其余按空格分词 ≈ 1.3 token/词。 */
function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[一-鿿　-〿぀-ゟ゠-ヿ가-힯]/g) ?? []).length
  const nonCjk = text.replace(/[一-鿿　-〿぀-ゟ゠-ヿ가-힯]/g, ' ')
  const words = nonCjk.trim().split(/\s+/).filter(Boolean).length
  return Math.ceil(cjk + words * 1.3)
}

/** 单个工具 / 技能定义占用的上下文 token 估算值（工具定义理论上固定，移除 Skill / 停用 MCP 时下调）。 */
const AVG_TOOL_TOKENS = 300

/** 根据占比（0~1）返回绿色→黄色→红色的渐变色（越接近上限越红）。 */
function ringColor(ratio: number): string {
  const p = Math.max(0, Math.min(1, ratio))
  const green: [number, number, number] = [82, 196, 26] // --color-success
  const yellow: [number, number, number] = [250, 173, 20] // --color-warning
  const red: [number, number, number] = [255, 77, 79] // --color-danger
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)
  let from: [number, number, number]
  let to: [number, number, number]
  let t: number
  if (p < 0.5) {
    from = green
    to = yellow
    t = p / 0.5
  } else {
    from = yellow
    to = red
    t = (p - 0.5) / 0.5
  }
  return `rgb(${lerp(from[0], to[0], t)}, ${lerp(from[1], to[1], t)}, ${lerp(from[2], to[2], t)})`
}

/** token 环形图 + 悬浮明细：已消耗上下文（提示词 + 对话 + 工具）占上下文限制的比例。
 * 单一环，无中心数字，越接近 100% 颜色由绿→黄→红；悬浮显示上下文总数 / 输入占比 / 对话占比 / 工具占比。 */
function TokenRing({
  promptTokens,
  completionTokens,
  toolsTokens,
  limit,
}: {
  promptTokens: number
  completionTokens: number
  toolsTokens: number
  limit?: number
}) {
  const size = 22
  const stroke = 3
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const used = promptTokens + completionTokens + toolsTokens
  const ratio = limit && limit > 0 ? used / limit : 0
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = c * clamped
  const color = used > 0 ? ringColor(ratio) : 'var(--color-border)'
  const pct = limit && limit > 0 ? Math.round(ratio * 100) : null
  const total = Math.max(1, used)
  const inputPct = Math.round((promptTokens / total) * 100)
  const completionPct = Math.round((completionTokens / total) * 100)
  const toolPct = Math.round((toolsTokens / total) * 100)
  return (
    <span
      className="agent-chat__token-ring"
      tabIndex={0}
      title={
        pct !== null
          ? `已消耗 ${used} / ${limit} tokens（${pct}%）`
          : `已消耗 ${used} tokens`
      }
    >
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-border)" strokeWidth={stroke} fill="none" />
        {used > 0 && (
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
          上下文总数：{used} tokens{pct !== null ? `（${pct}% 窗口）` : ''}
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
function LiveTokenCounter({
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
function MessageActions({
  msg,
  agent,
  onRegenerate,
}: {
  msg: ChatMessage
  agent: AgentInfo
  onRegenerate: () => void
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
        <button type="button" title="重新生成" onClick={onRegenerate}>
          <RefreshCw size={14} />
        </button>
      </div>
    </div>
  )
}

/** 把历史轮次转为消息流（用于点击左侧会话加载）。 */
/** 从历史落库的 raw_messages_json 提取用户消息的多模态图片，重建气泡附件卡片（跨会话恢复）。
 * 仅取最后一条 user 消息的 image_url parts（dataUrl）；JSON 损坏 / 非多模态安全返回 undefined。 */
function extractHistoryAttachments(raw: string | undefined): ChatAttachmentInput[] | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const userMsg = [...parsed]
    .reverse()
    .find((m) => !!m && typeof m === 'object' && (m as Record<string, unknown>).role === 'user') as
    | Record<string, unknown>
    | undefined
  if (!userMsg) return undefined
  const content = userMsg.content
  let parts: unknown[] = []
  if (Array.isArray(content)) {
    parts = content
  } else if (content && typeof content === 'object' && Array.isArray((content as Record<string, unknown>).content)) {
    parts = (content as Record<string, unknown>).content as unknown[]
  } else {
    return undefined
  }
  const imgs: ChatAttachmentInput[] = []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    const imgUrl = (p as Record<string, unknown>).image_url
    const dataUrl = imgUrl && typeof imgUrl === 'object' ? (imgUrl as Record<string, unknown>).url : undefined
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image')) {
      imgs.push({ type: 'image', dataUrl })
    }
  }
  return imgs.length ? imgs : undefined
}

function roundsToMessages(rounds: AgentConversationRound[]): ChatMessage[] {
  const msgs: ChatMessage[] = []
  for (const r of rounds) {
    if (r.userQuestion) {
      msgs.push({
        id: `u-${r.id}`,
        role: 'user',
        content: r.userQuestion,
        createdAt: r.startTime ?? Date.now(),
        attachments: extractHistoryAttachments(r.rawMessagesJson),
      })
    }
    // 工具调用汇总 → ToolStep 卡片（历史回显时思考面板可完整还原工具调用过程）。
    // 存储格式来自任务结束时的 updateRound：[{ name, status, args, result, step? }]。
    const toolSteps: ToolStep[] | undefined = Array.isArray(r.toolCallsSummary)
      ? r.toolCallsSummary.map((t, i) => {
          const name = typeof t.name === 'string' ? t.name : ''
          const status = t.status === 'failed' ? 'failed' : 'success'
          return {
            callId: `hist-${r.id}-${i}`,
            toolName: name,
            toolLabel: name.split('__').pop() || name,
            status,
            args: typeof t.args === 'string' ? t.args : undefined,
            result: typeof t.result === 'string' ? t.result : undefined,
            sensitive: false,
            createdAt: r.startTime ?? Date.now(),
            step: typeof t.step === 'number' ? t.step : undefined,
          }
        })
      : undefined
    // 规划步骤结构 → PlanStep[]（与 toolCallsSummary 对称落库；历史回显时重建「步骤 → 工具」嵌套视图）。
    // 存储格式来自任务结束时的 updateRound：[{ step, title, status, summary? }]。
    const planSteps: PlanStep[] | undefined = Array.isArray(r.planStepsSummary)
      ? r.planStepsSummary.reduce<PlanStep[]>((acc, p) => {
          const step = typeof p.step === 'number' ? p.step : Number(p.step)
          if (!Number.isFinite(step)) return acc
          const status = p.status as PlanStep['status'] | undefined
          acc.push({
            step,
            title: typeof p.title === 'string' ? p.title : `步骤 ${step}`,
            status: status ?? 'success',
            summary: typeof p.summary === 'string' ? p.summary : undefined,
          })
          return acc
        }, [])
      : undefined
    msgs.push({
      id: `a-${r.id}`,
      role: 'agent',
      content: r.assistantAnswer ?? '',
      createdAt: r.endTime ?? Date.now(),
      thought: r.thinkingContent ? r.thinkingContent.split('\n') : undefined,
      toolSteps: toolSteps?.length ? toolSteps : undefined,
      planSteps: planSteps?.length ? planSteps : undefined,
      completedAt: r.endTime,
      durationMs: r.startTime && r.endTime ? r.endTime - r.startTime : undefined,
      tokenCount: (r.inputTokens ?? 0) + (r.outputTokens ?? 0) || estimateTokens(r.assistantAnswer ?? ''),
    })
  }
  return msgs
}

/** 技能头像 + 临时移除/恢复按钮。
 *  - Logo 优先读技能根目录 logo.<ext>（readSkillLogoBase64），读不到回退首字，与 Skill Hub 一致；
 *  - 悬停（未移除态）显示 × 可临时移除；已移除态显示 ↺ 可恢复；均为纯前端内存态，不写库。 */
function SkillChip({
  skill,
  removed,
  onToggle,
}: {
  skill: SkillInfo
  removed: boolean
  onToggle: (id: string) => void
}) {
  const [logo, setLogo] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void readSkillLogoBase64(skill.identifier)
      .then((url) => {
        if (active) setLogo(url)
      })
      .catch(() => {
        if (active) setLogo(null)
      })
    return () => {
      active = false
    }
  }, [skill.identifier])

  return (
    <span
      className={`agent-chat__skill-chip${removed ? ' is-removed' : ''}`}
      title={removed ? `已临时移除：${skill.name}（点击恢复）` : `${skill.name}（点击临时移除）`}
    >
      <Avatar
        size={24}
        src={logo ?? undefined}
        style={{ background: 'var(--color-background, #ffffff)', color: 'var(--color-foreground, #0b2030)' }}
      >
        {logo ? '' : (skill.name || skill.identifier || '').slice(0, 1)}
      </Avatar>
      <button
        type="button"
        className="agent-chat__skill-toggle"
        // 阻止点击时焦点从输入框转移，避免切换后焦点回弹导致输入框蓝色光晕闪动
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onToggle(skill.id)}
        title={removed ? '恢复此技能' : '临时移除此技能（仅当前会话）'}
        aria-label={removed ? '恢复技能' : '临时移除技能'}
      >
        {removed ? <RotateCcw size={10} /> : <X size={10} />}
      </button>
    </span>
  )
}

/** MCP 服务的文字胶囊 + 悬浮 Pop（移除整个服务 / 单个工具开关）。
 *  - 无头像，纯文字胶囊；多个 MCP 排列在 Skill 之后；
 *  - 悬浮弹出层显示该服务下全部绑定工具，可逐个开/关；
 *  - 移除整个服务或关闭工具均为会话内内存态，不写库；切换/重开会话即恢复。 */
function McpPill({
  mcp,
  removed,
  disabledToolIds,
  onToggleRemove,
  onToggleTool,
}: {
  mcp: BoundMcpServer
  removed: boolean
  disabledToolIds: Set<string>
  onToggleRemove: (mcpId: string) => void
  onToggleTool: (toolId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 工具条在页面底部，弹层向上展开（锚定 bottom，避免溢出视口下沿）
  const [pos, setPos] = useState<{ bottom: number; left: number }>({ bottom: 0, left: 0 })

  const show = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      // 弹层底部贴合胶囊顶部上方 6px；靠近右边界时左移避免溢出视口
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 260))
      setPos({ bottom: window.innerHeight - r.top + 6, left })
    }
    setOpen(true)
  }, [])

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setOpen(false), 140)
  }, [])

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
  }, [])

  return (
    <span
      ref={ref}
      className={`agent-chat__mcp-pill${removed ? ' is-removed' : ''}`}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <span className="agent-chat__mcp-label">{mcp.name}</span>
      {removed ? (
        <button
          type="button"
          className="agent-chat__mcp-toggle"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleRemove(mcp.mcpId)}
          title="恢复此 MCP 服务"
          aria-label="恢复 MCP 服务"
        >
          <RotateCcw size={10} />
        </button>
      ) : (
        <button
          type="button"
          className="agent-chat__mcp-toggle agent-chat__mcp-toggle--remove"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggleRemove(mcp.mcpId)}
          title="临时移除整个 MCP 服务（仅当前会话）"
          aria-label="临时移除 MCP 服务"
        >
          <X size={10} />
        </button>
      )}

      {open && !removed && (
        <div
          className="agent-chat__mcp-pop"
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left }}
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
        >
          <div className="agent-chat__mcp-pop-card">
            <div className="agent-chat__mcp-pop-head">
              <span className="agent-chat__mcp-pop-title">{mcp.name}</span>
              <button
                type="button"
                className="agent-chat__mcp-pop-remove"
                onClick={() => onToggleRemove(mcp.mcpId)}
              >
                移除服务
              </button>
            </div>
            <div className="agent-chat__mcp-pop-tools">
              {mcp.tools.map((t) => (
                <label key={t.toolId} className="agent-chat__mcp-tool">
                  <Switch
                    size="small"
                    checked={!disabledToolIds.has(t.toolId)}
                    onChange={() => onToggleTool(t.toolId)}
                  />
                  <span className="agent-chat__mcp-tool-name" title={t.description}>
                    {t.displayName || t.toolCode}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * 通用点击外部关闭的下拉菜单
 * ---------------------------------------------------------------- */
interface MenuItem {
  label: string
  onClick: () => void
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
}
function DropdownMenu({
  trigger,
  items,
  align = 'right',
  title,
}: {
  trigger: React.ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [placement, setPlacement] = useState<'bottom' | 'top'>('bottom')
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setReady(false)
      return
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      // 触发器与浮层（已 portal 到 body）都算内部，点击外部才关闭
      if (wrapRef.current && !wrapRef.current.contains(t) && menuRef.current && !menuRef.current.contains(t)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 自适应定位：打开后测量菜单真实尺寸与视口，若向下会超出视口底部（被任务栏/窗口底边挡住），
  // 则向上翻转；同时保证左右不超出视口。首次定位完成前隐藏浮层，避免一闪而过的错误位置。
  useLayoutEffect(() => {
    if (!open) return
    const menu = menuRef.current
    const trigger = triggerRef.current
    if (!menu || !trigger) return
    const rect = trigger.getBoundingClientRect()
    const menuH = menu.offsetHeight
    const menuW = menu.offsetWidth
    const margin = 8
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth

    let nextTop = rect.bottom + 4
    let nextPlacement: 'bottom' | 'top' = 'bottom'
    if (nextTop + menuH > viewportH - margin) {
      nextTop = Math.max(margin, rect.top - menuH - 4)
      nextPlacement = 'top'
    }

    const rawLeft = align === 'right' ? rect.right - menuW : rect.left
    let nextLeft = Math.max(margin, rawLeft)
    if (nextLeft + menuW > viewportW - margin) {
      nextLeft = Math.max(margin, viewportW - menuW - margin)
    }

    setPos({ top: nextTop, left: nextLeft })
    setPlacement(nextPlacement)
    setReady(true)
  }, [open, align])

  // 点击触发器：用触发器实际位置 + fixed 定位。浮层 portal 到 body，
  // 彻底逃逸任何祖先 transform / overflow 裁剪，避免定位大幅偏移。
  const handleClick = () => {
    const el = triggerRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: Math.max(8, align === 'right' ? r.right - 168 : r.left) })
    }
    setOpen((o) => !o)
  }

  return (
    <div className="agent-chat__menu-wrap" ref={wrapRef}>
      <span className="agent-chat__menu-trigger" ref={triggerRef} onClick={handleClick}>
        {trigger}
      </span>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={`agent-chat__menu${align === 'right' ? ' is-right' : ''}${placement === 'top' ? ' is-top' : ''}`}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              minWidth: 168,
              visibility: ready ? 'visible' : 'hidden',
            }}
          >
            {title && <div className="agent-chat__menu-title">{title}</div>}
            {items.map((it, i) => (
              <button
                key={i}
                type="button"
                className={`agent-chat__menu-item${it.danger ? ' is-danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false)
                  it.onClick()
                }}
              >
                {it.icon && <span className="agent-chat__menu-icon">{it.icon}</span>}
                <span className="agent-chat__menu-label">{it.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 输入框左侧的工作空间胶囊：
 *  - 未绑定目录 → 显示「选择目录」入口（任务态，可选为工程）
 *  - 已绑定目录 → 显示目录名（工程态，可更改 / 清除）
 * ---------------------------------------------------------------- */
function WorkspaceChip({
  project,
  onPickDir,
  onChangeDir,
  onClear,
}: {
  project?: AgentProject
  onPickDir: () => void
  onChangeDir: () => void
  onClear: () => void
}) {
  // 未绑定：任务态，点击选择目录即可升级为工程
  if (!project) {
    return (
      <span
        className="agent-chat__chip agent-chat__chip--pick"
        title="选择工作目录（选中后本会话绑定为工程）"
        onClick={onPickDir}
      >
        <Folder size={12} />
        选择目录
      </span>
    )
  }
  // 已绑定：工程态，显示目录名，可更改 / 清除
  return (
    <DropdownMenu
      align="left"
      trigger={
        <span className="agent-chat__chip agent-chat__chip--workspace" title={project.rootPath}>
          <Folder size={12} />
          {leafDirName(project.rootPath)}
        </span>
      }
      items={[
        { label: '更改工作目录', icon: <FolderEdit size={13} />, onClick: onChangeDir },
        { label: '清除绑定（自由对话）', icon: <Unlink size={13} />, onClick: onClear, danger: true },
      ]}
    />
  )
}

/** 从扁平会话列表 + 工程列表构建树状分组（GLOBAL + 各 PROJECT）。 */
function buildSessionTree(
  list: AgentConversationSession[],
  projects: AgentProject[],
): SessionTreeGroup[] {
  const toItem = (s: AgentConversationSession) => ({
    id: s.id,
    sessionName: s.sessionName,
    totalTurns: s.totalTurns ?? 0,
    updatedAt: Date.parse(s.updatedAt) || 0,
    isTop: s.isTop,
    isArchived: s.isArchive,
    projectId: s.projectId,
  })
  const global = list
    .filter((s) => !s.projectId)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .map(toItem)
  const groups: SessionTreeGroup[] = [
    {
      groupType: 'GLOBAL',
      groupId: 'GLOBAL',
      projectName: '自由会话',
      rootPath: null,
      sessions: global,
    },
  ]
  const byProject = new Map<string, AgentConversationSession[]>()
  for (const s of list) {
    if (!s.projectId) continue
    const arr = byProject.get(s.projectId) ?? []
    arr.push(s)
    byProject.set(s.projectId, arr)
  }
  for (const [pid, arr] of byProject) {
    arr.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    const p = projects.find((x) => x.id === pid)
    groups.push({
      groupType: 'PROJECT',
      groupId: pid,
      projectName: p?.name ?? '未命名工程',
      rootPath: p?.rootPath ?? null,
      isPinned: p?.isPinned,
      isArchived: p?.isArchived,
      sessions: arr.map(toItem),
    })
  }
  return groups
}

export default function AgentChatPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { message, modal } = useNotify()

  // 会话状态机（必须早于任何引用 session.* 的回调/依赖数组，否则 TDZ）。
  const session = useAgentSession()
  const { toolSteps, streamingText, isStreaming, statusText, thoughts, planSteps, isRunning, pendingApproval, run, submitDecision, reset, cancel, lastTaskUsage, liveTokenUsage, taskError, artifacts, recovery, resolveRecovery, pendingChoice, submitChoice, planApproval, resolvePlanApproval } =
    session

  const [agent, setAgent] = useState<AgentInfo | undefined>()
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
  // @提及 候选全集（全量技能 / MCP 服务，不限于本智能体绑定），供输入框随时引用
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])
  const [allMcps, setAllMcps] = useState<Awaited<ReturnType<typeof listMcps>>>([])
  // 输入框 @提及 / /指令 浮层状态
  const [suggest, setSuggest] = useState<SuggestState | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  // @提及 选中的标签（chip）：独立维护，发送时序列化为「@标签」前缀，从文本框剥离避免歧义
  // token = 序列化进 prompt 的稳定标识（优先 skill.identifier，绝不依赖 name 判断）；label = 展示用人类可读名
  const [mentionTags, setMentionTags] = useState<{ key: string; label: string; token: string }[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 当前会话内临时移除的技能 id（内存态，不写库；页面重进/切换智能体即复位）
  const [removedSkillIds, setRemovedSkillIds] = useState<Set<string>>(new Set())
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
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

  // 多模态图片附件
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  // 整窗拖拽吸附：dragDepth 计数嵌套 enter/leave，windowDrag 控制全窗遮罩。
  const [windowDrag, setWindowDrag] = useState(false)
  const dragDepth = useRef(0)
  // 右侧投影面板（图 / 过程 / 产物）：二期方案 C Graph-first，默认关闭、发消息自动展开「图」。
  // 接管不再常驻 Tab，改为 recovery 非空时右栏底部情境升起。
  const [rightOpen, setRightOpen] = useState(false)
  const [rightTab, setRightTab] = useState<'graph' | 'process' | 'artifacts'>('graph')
  // 右栏宽度（可鼠标拖拽调节），默认 340px
  const [rightWidth, setRightWidth] = useState(340)
  const resizingRef = useRef(false)
  const resizeElRef = useRef<HTMLDivElement>(null)
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    resizeElRef.current?.classList.add('is-dragging')
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      // 右栏右侧留 14px margin；按指针位置反推右栏宽度
      const w = window.innerWidth - ev.clientX - 14
      setRightWidth(Math.min(680, Math.max(300, w)))
    }
    const onUp = () => {
      resizingRef.current = false
      resizeElRef.current?.classList.remove('is-dragging')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }
  // 图片放大预览：点击气泡/待发区缩略图打开
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  // §3.2 产物预览：点击画布节点产物调 read_artifact 命令获取内容，在 Modal 里展示
  const [artifactPreview, setArtifactPreview] = useState<ReadArtifactResult | null>(null)
  const [artifactLoading, setArtifactLoading] = useState(false)

  // §3.2 画布交互回调
  // 点击产物文件 → 调 read_artifact 命令获取内容（文本/图片/目录列表），在 Modal 展示
  const handlePreviewArtifact = useCallback(async (path: string) => {
    if (!isTauri) return
    setArtifactLoading(true)
    setArtifactPreview(null)
    try {
      const result = await invoke<ReadArtifactResult>('read_artifact', {
        path,
        workspace: workspaceDir ?? null,
      })
      setArtifactPreview(result)
    } catch (e) {
      setArtifactPreview({
        path,
        name: path,
        kind: 'error',
        size: 0,
        content: `读取产物失败：${e}`,
        truncated: false,
      })
    } finally {
      setArtifactLoading(false)
    }
  }, [isTauri, workspaceDir])

  // 接管上下文化（二期方案 C）：步骤受阻（recovery 非空）时自动展开右栏，
  // 失败详情随右栏底部「接管」情境条升起（不再依赖常驻「接管」Tab），默认切到「图」便于看失败节点。
  useEffect(() => {
    if (recovery) {
      setRightOpen(true)
      setRightTab('graph')
    }
  }, [recovery])

  // 右键「从此步骤分支」→ 调 branch_from_step 命令，后端生成新分支并推 plan_branch 事件
  const handleBranchFromStep = useCallback(async (fromStep: number) => {
    if (!isTauri || !agent?.id) return
    // 构造原方案尾段（step > fromStep 的步骤），供后端对比展示
    const originalTail: BranchStep[] = session.planSteps
      .filter((s) => s.step > fromStep)
      .map((s) => ({
        step: s.step,
        taskId: s.taskId ?? '',
        title: s.title,
        description: s.description ?? '',
        dependsOn: s.dependsOn ?? [],
      }))
    const input: BranchFromStepInput = {
      agentId: agent.id,
      workspace: workspaceDir ?? null,
      fromStep,
      goalSummary: `从步骤 ${fromStep} 起重新规划后续步骤`,
      originalTail,
    }
    try {
      await invoke('branch_from_step', { input })
    } catch (e) {
      console.error('[agent] branch_from_step 失败：', e)
    }
  }, [isTauri, agent?.id, workspaceDir, session.planSteps])

  // 放弃分支对比
  const handleDismissBranch = useCallback(() => {
    // planBranch 由 session 状态机管理，前端无法直接清空；
    // 这里切回「图」Tab 视觉上隐藏对比横幅。后续可在 useAgentSession 加 dismissPlanBranch 方法。
    setRightTab('graph')
  }, [])

  // 历史会话加载时瞬时跳到底部，避免 smooth 滚动造成的长列表滑动抖动
  const restoringRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileAttachRef = useRef<HTMLInputElement>(null)

  // 兜底：任何拖拽真正结束时（dragend）复位整窗吸附状态。
  // 落在输入框内已在 onDrop 就地复位；此处再防其他边角（如 drop 命中未知落点 / 逻辑遗漏）导致遮罩卡死。
  useEffect(() => {
    const resetWindowDrag = () => {
      dragDepth.current = 0
      setWindowDrag(false)
    }
    window.addEventListener('dragend', resetWindowDrag)
    return () => window.removeEventListener('dragend', resetWindowDrag)
  }, [])

  // 语音输入
  const [recording, setRecording] = useState(false)
  const recognitionRef = useRef<unknown>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const replyStartRef = useRef<number | null>(null)
  const prevIsRunningRef = useRef(false)
  const roundIdRef = useRef<string | null>(null)
  const roundIndexRef = useRef(0)
  // 标记「本次由『新增子对话』创建的、尚未发过任何消息的空会话」——离开时若仍为 0 轮则清理
  const pendingEmptySessionIdRef = useRef<string | null>(null)
  // 卸载守卫：避免卸载后调用 setState 触发警告
  const mountedRef = useRef(true)
  const lastPromptRef = useRef('')
  const lastTokensRef = useRef<{ input: number; output: number }>({ input: 0, output: 0 })

  // 收到 agent-task-error 时，把错误挂到最后一条 agent 消息，渲染「错误诊断面板」（展示+复制；重试/跳过留 Phase 2）。
  useEffect(() => {
    if (!taskError) return
    setMessages((prev) => {
      let realIdx = -1
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'agent') {
          realIdx = i
          break
        }
      }
      if (realIdx === -1) return prev
      return prev.map((m, i) => (i === realIdx ? { ...m, error: taskError } : m))
    })
  }, [taskError])

  const lastAgentContent =
    messages.length > 0 && messages[messages.length - 1].role === 'agent'
      ? messages[messages.length - 1].content
      : ''
  const displayedContent = useTypewriter(lastAgentContent, isStreaming)

  // 加载智能体 + 工具/技能计数 + 能力判定 + 工作空间 + 会话列表
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
        const [allMcps, allSkills] = await Promise.all([listMcps(), listSkills()])
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
          // 全量技能 / MCP 服务缓存，供输入框 @提及 候选（不局限于本智能体绑定项）
          setAllSkills(allSkills)
          setAllMcps(allMcps)
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
    void cleanupPendingEmptySession()
    reset()
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

  // 新消息 / 工具步骤 / 流式文本变化时滚动到底
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (restoringRef.current) {
      // 历史会话回显：瞬时定位到底部，避免整列平滑滑动的视觉抖动
      restoringRef.current = false
      el.scrollTop = el.scrollHeight
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, toolSteps, streamingText])

  /** 持久化一轮：确保有会话 → 追加 round → 记录 roundId / 序号。 */
  const ensureRound = useCallback(
    async (prompt: string): Promise<string | null> => {
      // 一旦发起发送，立即取消「空会话待清理」标记，避免异步过程中离开误删
      pendingEmptySessionIdRef.current = null
      if (!agent) return null
      let sessionId = activeSessionId
      if (!sessionId) {
        const sess = await createSession(agent.identifier, prompt.slice(0, 40), {
          projectId: pendingProjectId,
        })
        sessionId = sess.id
        setActiveSessionId(sess.id)
        // 估算工具 / Skill 定义占用的上下文 token（理论固定，移除 Skill / 停用 MCP 时下调）
        // 已临时移除的 Skill / MCP 服务 / 单个 MCP 工具不再计入工具集，分别扣减。
        const removedMcpToolCount = boundMcps
          .filter((m) => removedMcpIds.has(m.mcpId))
          .reduce((sum, m) => sum + m.tools.length, 0)
        const effToolCount = toolCount - removedMcpToolCount - disabledMcpToolIds.size
        const effSkillCount = skillCount - removedSkillIds.size
        const toolsTokens = Math.round((effToolCount + effSkillCount) * AVG_TOOL_TOKENS)
        await updateSession(sess.id, { toolsTokens })
        const list = await listSessions(agent.identifier)
        setSessions(list.map((s) => (s.id === sess.id ? { ...s, toolsTokens } : s)))
      }
      const round = await appendRound({
        sessionId: sessionId!,
        llmCode: agent.llmId,
        roundIndex: roundIndexRef.current,
        userQuestion: prompt,
        startTime: Date.now(),
      })
      roundIdRef.current = round.id
      roundIndexRef.current += 1
      return sessionId
    },
    [agent, activeSessionId, toolCount, skillCount, removedSkillIds, removedMcpIds, disabledMcpToolIds, boundMcps, pendingProjectId],
  )

  // 应用分支：把「原方案 head（from_step 之前）+ 新分支 tail」合并成完整计划，
  // head 标记为预完成（后端跳过执行、沿用其结果），调用 run_agent_task 用新分支实际重跑任务。
  const handleApplyBranch = useCallback(async () => {
    const branch = session.planBranch
    if (!branch || !agent?.id) return
    const head = session.planSteps.filter((s) => s.step <= branch.fromStep)
    const tasks = [
      ...head.map((s) => ({
        step: s.step,
        task_id: s.taskId ?? `head-${s.step}`,
        title: s.title,
        description: s.description ?? '',
        depends_on: s.dependsOn ?? [],
      })),
      ...branch.branchTasks.map((t) => ({
        step: t.step,
        task_id: t.taskId,
        title: t.title,
        description: t.description,
        depends_on: t.dependsOn,
      })),
    ]
    const planOverride: PlanDAG = {
      goal_summary: branch.goalSummary || '应用分支重规划',
      tasks,
    }
    const preCompleted = head.map((s) => s.taskId ?? `head-${s.step}`)
    const initialContext = head
      .map((s) => `步骤 ${s.step}「${s.title}」已完成（分支重跑沿用其结果）`)
      .join('\n')
    const prompt = branch.goalSummary || '应用分支重规划'
    // 起新一轮（沿用当前会话，新建 round 以便记忆召回与 token 持久化），再带 plan_override 重跑。
    const sid = await ensureRound(prompt)
    if (!sid) return
    try {
      await run({
        agentId: agent.id,
        prompt,
        workspace: workspaceDir ?? null,
        sessionId: sid,
        roundId: roundIdRef.current ?? undefined,
        planOverride,
        preCompleted,
        initialContext,
      })
    } catch (e) {
      console.error('[agent] apply branch 失败：', e)
    }
  }, [session.planBranch, agent?.id, workspaceDir, session.planSteps, ensureRound, run])

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

  const send = useCallback(() => {
    // 序列化：@标签 作为前缀，再拼接自由文本；token 用 skill.identifier（稳定、无空格），label 仅用于展示
    const mentionPrefix = mentionTags.map((t) => `@${t.token}`).join(' ')
    const text = [mentionPrefix, input.trim()].filter(Boolean).join(' ').trim()
    if (!text || isRunning || !agent) return

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: Date.now(),
      images: pendingAttachments.some((a) => a.type === 'image')
        ? pendingAttachments.filter((a) => a.type === 'image')
        : undefined,
      attachments: pendingAttachments.length ? pendingAttachments : undefined,
    }
    const agentMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      role: 'agent',
      content: '',
      createdAt: Date.now(),
    }
    setMessages((prev) => [...prev, userMsg, agentMsg])
    setInput('')
    setMentionTags([])
    setInputHeight(48)
    setPendingAttachments([])
    lastPromptRef.current = text

    replyStartRef.current = Date.now()
    // 方案 C：发消息即自动展开右栏并切到「图」（本轮 DAG 主视图），符合 Graph-first 作用域。
    setRightOpen(true)
    setRightTab('graph')
    const attachments = pendingAttachments
    const disabledSkillIds = [...removedSkillIds]
    const disabledMcpIds = [...removedMcpIds]
    const disabledMcpToolIdsArr = [...disabledMcpToolIds]
    // `@` 提及 → 本轮临时启用：从 mentionTags 解析出技能 / MCP 服务 id（key 形如 skill:<id> / mcp:<id>）
    const enabledSkillIds = mentionTags
      .filter((t) => t.key.startsWith('skill:'))
      .map((t) => t.key.slice('skill:'.length))
    const enabledMcpIds = mentionTags
      .filter((t) => t.key.startsWith('mcp:'))
      .map((t) => t.key.slice('mcp:'.length))
    void ensureRound(text).then((sid) => {
      void run({
        agentId: agent.id,
        prompt: text,
        workspace: workspaceDir,
        attachments,
        // 修复：使用 ensureRound 返回的真实会话 id，避免闭包捕获到尚未更新的 stale activeSessionId（首条消息时为 null）
        sessionId: sid ?? undefined,
        roundId: roundIdRef.current ?? undefined,
        // 临时移除的技能 / MCP 服务 / MCP 工具：随本轮请求传给 Rust，从智能体工具集中剔除
        disabledSkillIds,
        disabledMcpIds,
        disabledMcpToolIds: disabledMcpToolIdsArr,
        // `@` 提及触发：本轮临时启用未绑定（或重新启用已移除）的技能 / MCP 服务
        enabledSkillIds,
        enabledMcpIds,
      })
    })
  }, [input, isRunning, agent, run, workspaceDir, pendingAttachments, ensureRound, removedSkillIds, removedMcpIds, disabledMcpToolIds, mentionTags])

  // 将 session 的流式文本/思考/工具步骤同步进「最后一条助手气泡」
  useEffect(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      // 欢迎语是静态提示，不参与流式回填：避免 reset() 清空 streamingText 后
      // 把欢迎语覆盖成空内容，导致界面误显示「思考中…」
      if (!last || last.role !== 'agent' || last.id === 'welcome') return prev
      return [...prev.slice(0, -1), { ...last, content: streamingText, thought: thoughts, toolSteps }]
    })
  }, [streamingText, thoughts, toolSteps])

  // 任务结束（完成/异常/取消）时，补全耗时、token 与历史持久化
  useEffect(() => {
    if (prevIsRunningRef.current && !isRunning) {
      const completedAt = Date.now()
      const durationMs = replyStartRef.current ? completedAt - replyStartRef.current : undefined
      replyStartRef.current = null
      const answer = streamingText || lastAgentContent
      // 真实 token 用量：Tauri 路径下后端已在 run_task 中把本轮 LLM 真实 usage
      // （跨所有 ReAct 轮累计的 prompt+completion）写回会话表，并经 agent-task-done 事件带出；
      // 此处优先采用，避免前端「仅首尾文本」估算严重低估。dev/mock 无后端时回退估算。
      // 但若网关未在流中返回 usage（后端带回 0/0），则视为无效、回退估算，避免出现「消耗 0 tokens」。
      const rawUsage = isTauri ? lastTaskUsage.current : null
      const realUsage =
        rawUsage && (rawUsage.promptTokens > 0 || rawUsage.completionTokens > 0) ? rawUsage : null
      const inputTokens = realUsage ? realUsage.promptTokens : estimateTokens(lastPromptRef.current)
      const outputTokens = realUsage ? realUsage.completionTokens : estimateTokens(answer)
      lastTokensRef.current = { input: inputTokens, output: outputTokens }

      // 回填历史轮次
      if (roundIdRef.current && activeSessionId) {
        void updateRound(roundIdRef.current, {
          assistantAnswer: answer,
          thinkingContent: thoughts.join('\n'),
          toolCallsSummary: toolSteps.map((s) => ({
            name: s.toolName,
            status: s.status,
            args: s.args,
            result: s.result,
            step: s.step,
          })),
          planStepsSummary: planSteps.map((s) => ({
            step: s.step,
            title: s.title,
            status: s.status,
            summary: s.summary,
          })),
          inputTokens,
          outputTokens,
          endTime: completedAt,
        })
        roundIdRef.current = null
      }

      // 累计 token（提示词 + 对话）并回填会话状态
      if (activeSessionId) {
        const sid = activeSessionId
        void (async () => {
          await updateSession(sid, {
            status: statusText ? 'ERROR' : 'COMPLETED',
            endTime: completedAt,
          })
          // 累计 token 并回填会话表：
          // - dev/mock 始终按本地估算累加；
          // - Tauri 路径：后端已在 run_task 累计真实 prompt/completion 到会话表，直接读回（realUsage 有效时）；
          //   若网关未在流中返回 usage（realUsage 为 null，后端带回 0/0），则本地用估算兜底补写，
          //   避免出现「消耗 0 tokens」导致环形图（上下文总数）恒为 0。
          const needLocalEstimate = !isTauri || !realUsage
          if (needLocalEstimate) {
            await addSessionTokens(sid, inputTokens, outputTokens)
          }
          let fresh = await getSession(sid)
          let toolsTokens: number | undefined
          if (!isTauri) {
            toolsTokens = Math.round(
              (toolCount -
                boundMcps
                  .filter((m) => removedMcpIds.has(m.mcpId))
                  .reduce((sum, m) => sum + m.tools.length, 0) -
                disabledMcpToolIds.size +
                (skillCount - removedSkillIds.size)) *
                AVG_TOOL_TOKENS,
            )
          }
          // 未命名会话（多为「工程 / 项目目录」下新建的子对话）：首轮完成后用第一个问题命名
          const wasUnnamed = !fresh?.sessionName || fresh.sessionName.trim() === ''
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sid) return s
              const b = fresh ?? s
              let name = b.sessionName
              if (wasUnnamed && lastPromptRef.current) {
                name = lastPromptRef.current.trim().slice(0, 40)
              }
              return {
                ...b,
                sessionName: name || b.sessionName,
                // Tauri 路径 tools_tokens 由后端动态重算；dev 路径本地估算
                toolsTokens: isTauri ? b.toolsTokens : (toolsTokens ?? b.toolsTokens),
              }
            }),
          )
          // 把首轮命名回写库（仅当原本未命名）
          if (wasUnnamed && lastPromptRef.current) {
            await renameSession(sid, lastPromptRef.current.trim().slice(0, 40))
          }
        })()
      }

      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'agent') {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              content: answer,
              thought: thoughts,
              toolSteps,
              completedAt,
              durationMs,
              tokenCount: inputTokens + outputTokens,
            },
          ]
        }
        return prev
      })
    }
    prevIsRunningRef.current = isRunning
  }, [isRunning, streamingText, thoughts, toolSteps, planSteps, lastAgentContent, statusText, activeSessionId, removedSkillIds, removedMcpIds, disabledMcpToolIds, boundMcps, toolCount, skillCount, isTauri, lastTaskUsage])

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
    (decision: 'approve' | 'skip' | 'takeover', guidance?: string) => {
      if (!pendingApproval) return
      void submitDecision({ approvalId: pendingApproval.approvalId, decision, guidance })
    },
    [pendingApproval, submitDecision],
  )

  /** 重新生成：以上一轮 user 消息为 prompt 再跑一次，替换当前 agent 回复。 */
  /**
   * 从一段用户消息文本里反解出 @提及 标签（#20260915004 B3）。
   * 与 `getCandidates` 同源：只匹配已知技能 / MCP 服务名称，避免误伤自由文本里的 @。
   * 用于「重新生成」时把首轮临时启用的能力原样带回（send 走的是 mentionTags，regenerate 时它已清空）。
   */
  const resolveMentionTags = useCallback(
    (text: string): { key: string; label: string; token: string }[] => {
      const out: { key: string; label: string; token: string }[] = []
      const seen = new Set<string>()
      const add = (key: string, label: string, token: string) => {
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ key, label, token })
        }
      }
      const tokens = text.match(/@[\p{L}\p{N}_-]+/gu) ?? []
      for (const tk of tokens) {
        const name = tk.slice(1)
        if (!name) continue
        // 硬化：优先按 identifier 精确匹配，绝不依赖 name 判断（name 含空格会被截断、重名歧义、改名失链）
        const sk =
          allSkills.find((s) => (s.identifier || '') === name) ?? allSkills.find((s) => s.name === name)
        if (sk) {
          add(`skill:${sk.id}`, sk.name, sk.identifier || sk.name)
          continue
        }
        const mc = allMcps.find((m) => (m.aliasName || m.mcpName || m.id) === name)
        if (mc) {
          const mcName = mc.aliasName || mc.mcpName || mc.id
          add(`mcp:${mc.id}`, mcName, mcName)
        }
      }
      return out
    },
    [allSkills, allMcps],
  )

  const handleRegenerate = useCallback(
    (msgId: string) => {
      const idx = messages.findIndex((m) => m.id === msgId)
      if (idx <= 0 || !agent) return
      const userMsg = messages[idx - 1]
      if (userMsg.role !== 'user') return
      reset()
      setMessages((prev) => {
        const base = prev.slice(0, idx)
        return [
          ...base,
          {
            id: `a-${Date.now()}`,
            role: 'agent',
            content: '',
            createdAt: Date.now(),
          },
        ]
      })
      replyStartRef.current = Date.now()
      lastPromptRef.current = userMsg.content
      const disabledSkillIds = [...removedSkillIds]
      const disabledMcpIds = [...removedMcpIds]
      const disabledMcpToolIdsArr = [...disabledMcpToolIds]
      // 修复（#20260915004 B3）：重新生成时 @@提及 文本已序列化进 userMsg.content，但 mentionTags 已清空。
      // 从内容反解出本轮临时启用的技能 / MCP，与 send 对齐，避免「重生成丢失 @提及」。
      const tags = resolveMentionTags(userMsg.content)
      const enabledSkillIds = tags.filter((t) => t.key.startsWith('skill:')).map((t) => t.key.slice('skill:'.length))
      const enabledMcpIds = tags.filter((t) => t.key.startsWith('mcp:')).map((t) => t.key.slice('mcp:'.length))
      setMentionTags(tags) // 回填 chips，UI 重显本次启用的 @提及
      void ensureRound(userMsg.content).then((sid) => {
        void run({
          agentId: agent.id,
          prompt: userMsg.content,
          workspace: workspaceDir,
          // 修复：使用 ensureRound 返回的真实会话 id
          sessionId: sid ?? undefined,
          roundId: roundIdRef.current ?? undefined,
          // 临时移除的技能 / MCP 服务 / MCP 工具在本轮同样生效
          disabledSkillIds,
          disabledMcpIds,
          disabledMcpToolIds: disabledMcpToolIdsArr,
          // 临时启用的技能 / MCP 服务（@提及 触发），与 send 完全对齐
          enabledSkillIds,
          enabledMcpIds,
        })
      })
    },
    [messages, agent, reset, run, workspaceDir, ensureRound, removedSkillIds, removedMcpIds, disabledMcpToolIds, resolveMentionTags],
  )

  /** 点击左侧历史会话，加载其全部轮次。 */
  const openSession = useCallback(
    async (sessionId: string) => {
      if (sessionId === activeSessionId) return
      reset()
      setActiveSessionId(sessionId)
      setRemovedSkillIds(new Set()) // 切换会话即复位临时移除（重新打开会话恢复全部技能）
      setRemovedMcpIds(new Set()) // 临时移除的 MCP 服务复位
      setDisabledMcpToolIds(new Set()) // 临时关闭的 MCP 工具复位
      try {
        // 回显该会话绑定的工程（工作空间），无则自由对话
        const sess = await getSession(sessionId)
        setPendingProjectId(sess?.projectId ?? null)
        const rounds = await listRounds(sessionId)
        setMessages(roundsToMessages(rounds))
        setMentionTags([]) // 切换会话清空 @提及 标签
        roundIndexRef.current = rounds.length
      } catch (e) {
        message.error(`加载会话失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [activeSessionId, reset, message],
  )

  /** 新建对话：清空当前会话，回到欢迎语。 */
  const newChat = useCallback(() => {
    void cleanupPendingEmptySession()
    reset()
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

  /* ---------------- 输入框 @提及 / /指令 ---------------- */

  /** 快捷指令定义（/ 触发）。 */
  const COMMANDS: SuggestItem[] = [
    { key: 'cmd:new', token: '/new', label: '新建会话', sub: '开启一个全新对话', group: '指令' },
    { key: 'cmd:clear', token: '/clear', label: '清空对话', sub: '清除当前全部消息', group: '指令' },
    { key: 'cmd:reset', token: '/reset', label: '重置运行态', sub: '中断并复位智能体运行态', group: '指令' },
    { key: 'cmd:help', token: '/help', label: '使用帮助', sub: '查看 @提及 与 /指令 说明', group: '指令' },
  ]

  /** 解析输入框中位于光标前的激活触发词（@ 或 / 开头、且前导为行首或空白）。 */
  const computeTrigger = (
    text: string,
    caret: number,
  ): { mode: 'mention' | 'command'; start: number; end: number; query: string } | null => {
    let i = caret - 1
    while (i >= 0) {
      const ch = text[i]
      if (ch === ' ' || ch === '\n' || ch === '\t') break
      if (ch === '@' || ch === '/') {
        const prevCh = i > 0 ? text[i - 1] : ''
        const boundary = i === 0 || /\s/.test(prevCh)
        if (!boundary) break // 形如邮箱 foo@bar 不视为触发
        return { mode: ch === '@' ? 'mention' : 'command', start: i, end: caret, query: text.slice(i + 1, caret) }
      }
      i--
    }
    return null
  }

  /** 按模式 + 查询串过滤候选（@ 取技能 + MCP 服务；/ 取快捷指令）。 */
  const getCandidates = (mode: 'mention' | 'command', query: string): SuggestItem[] => {
    const q = query.trim().toLowerCase()
    if (mode === 'command') {
      return COMMANDS.filter((c) => !q || c.token.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
    }
    const skills = allSkills
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          (s.identifier || '').toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q),
      )
      // token 用 skill.identifier（稳定、无空格），label 用 s.name 仅展示；硬化后不再依赖 name 做判断
      .map<SuggestItem>((s) => ({ key: `skill:${s.id}`, token: s.identifier || s.name, label: s.name, sub: s.description || '技能', group: '技能' }))
    const mcps = allMcps
      .filter((m) => !q || (m.aliasName || m.mcpName || '').toLowerCase().includes(q))
      .map<SuggestItem>((m) => {
        const name = m.aliasName || m.mcpName || m.id
        return { key: `mcp:${m.id}`, token: name, label: name, sub: 'MCP 服务', group: 'MCP 服务' }
      })
    return [...skills, ...mcps]
  }

  /** 依据当前文本与光标位置刷新浮层；命中候选则展开，否则收起。 */
  const syncSuggest = (text: string, caret: number) => {
    const trig = computeTrigger(text, caret)
    if (!trig) {
      setSuggest(null)
      return
    }
    const items = getCandidates(trig.mode, trig.query)
    if (items.length === 0) {
      setSuggest(null)
      return
    }
    setSuggest((prev) => {
      const p = prev
      // 触发词签名未变（仅光标微调）时保留当前高亮，避免方向键被 keyup 重置
      const keepIndex = p && p.mode === trig.mode && p.query === trig.query && p.index < items.length ? p.index : 0
      return { ...trig, items, index: keepIndex }
    })
  }

  /** 选中 @提及 候选：把触发词从文本框剥离，改为生成一个可移除的 Tag（chip）。 */
  const applyMention = (item: SuggestItem) => {
    if (!suggest) return
    // 从文本框删除「@query」片段（标签已独立承载，避免空格歧义）
    const next = input.slice(0, suggest.start) + input.slice(suggest.end)
    setInput(next)
    setMentionTags((prev) => {
      if (prev.some((t) => t.key === item.key)) return prev // 去重：同一技能/MCP 不重复添加
      // 写入 chip：label 展示人类名，token 携带 identifier（send 序列化与 regenerate 反解都按 token 匹配）
      return [...prev, { key: item.key, label: item.label, token: item.token }]
    })
    setSuggest(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        const caret = suggest.start
        el.setSelectionRange(caret, caret)
      }
    })
  }

  /** 选中 / 指令：立即执行对应动作。 */
  const runCommand = (item: SuggestItem) => {
    setSuggest(null)
    setInput('')
    setMentionTags([])
    switch (item.key) {
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

  /** 输入框内容变化：写回 state 并刷新浮层。 */
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    syncSuggest(val, e.target.selectionStart ?? val.length)
  }

  /** 光标移动（点击 / 方向键）：重新判定触发词，离开触发词则收起浮层。 */
  const handleCaretMove = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    syncSuggest(el.value, el.selectionStart ?? el.value.length)
  }

  /** 键盘事件：浮层展开时方向键导航、Enter/Tab 选中、Esc 收起；否则保持原 Enter 发送逻辑。 */
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest && suggest.items.length > 0) {
      const n = suggest.items.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSuggest((s) => (s ? { ...s, index: (s.index + 1) % n } : s))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSuggest((s) => (s ? { ...s, index: (s.index - 1 + n) % n } : s))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const item = suggest.items[suggest.index]
        if (item) {
          if (suggest.mode === 'mention') applyMention(item)
          else runCommand(item)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSuggest(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

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
      reset()
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

  // ---- 附件（图片 / 文本 / 文件）----
  /** 把文件分片上传到后端 `workspace/.attachments/`，返回落地路径（Tauri 环境）。
   *  非 Tauri（dev/mock）环境无原生落盘能力，回退为 base64 内联（仅小文件）。 */
  const stageFile = useCallback(
    async (file: File): Promise<string> => {
      if (!isTauri) {
        if (file.size > MAX_INLINE_IMAGE) throw new Error('非 Tauri 环境不支持超大文件')
        const dataUrl = await readFileAsDataURL(file)
        const comma = dataUrl.indexOf(',')
        return dataUrl.slice(comma + 1)
      }
      const CHUNK = 4 * 1024 * 1024
      const stageId = await invoke<string>('begin_stage_attachment', {
        name: file.name,
        mime: file.type || 'application/octet-stream',
      })
      try {
        for (let off = 0; off < file.size; off += CHUNK) {
          const slice = file.slice(off, Math.min(off + CHUNK, file.size))
          const buf = await slice.arrayBuffer()
          await invoke('append_stage_chunk', { stageId, data: new Uint8Array(buf) })
        }
        return await invoke<string>('commit_stage_attachment', {
          stageId,
          workspace: workspaceDir ?? null,
        })
      } catch (e) {
        await invoke('abort_stage_attachment', { stageId }).catch(() => {})
        throw e
      }
    },
    [isTauri, workspaceDir, message],
  )

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      for (const file of list) {
        const size = file.size
        try {
          // 图片：≤20MB 多模态 dataUrl 内联；超大图片走分片落盘（file 类型，agent 用 native__read_file 看）。
          if (file.type.startsWith('image/') && size <= MAX_INLINE_IMAGE) {
            const dataUrl = await readFileAsDataURL(file)
            setPendingAttachments((prev) => [
              ...prev,
              { id: attId(), type: 'image', dataUrl, name: file.name, size },
            ])
            continue
          }
          if (size > MAX_FILE) {
            message.error(`「${file.name}」超过 500MB，已忽略`)
            continue
          }
          // 文本（≤200KB）直接内联；其余（二进制 / 超大文本 / 超大图片）分片落盘。
          if (isTextType(file) && size <= TEXT_INLINE_LIMIT && !file.type.startsWith('image/')) {
            const text = await readFileAsText(file)
            setPendingAttachments((prev) => [
              ...prev,
              { id: attId(), type: 'text', content: text, name: file.name, mime: file.type || 'text/plain', size },
            ])
            continue
          }
          const path = await stageFile(file)
          setPendingAttachments((prev) => [
            ...prev,
            {
              id: attId(),
              type: 'file',
              name: file.name,
              mime: file.type || 'application/octet-stream',
              size,
              path,
            },
          ])
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          message.error(`「${file.name}」处理失败：${msg}`)
        }
      }
    },
    [message, stageFile],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const it of Array.from(items)) {
        // 任意文件（不再仅限图片，也不再要求多模态模型）——文本/文件附件任意模型可用
        const file = it.getAsFile()
        if (file) files.push(file)
      }
      if (files.length) {
        e.preventDefault()
        addFiles(files)
      }
    },
    [addFiles],
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
      style={{ '--input-h': `${inputHeight}px` } as React.CSSProperties}
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
      {/* 审批授权：右下角通知形式，不再嵌入对话流 */}
      <UserPromptPanel
        approval={pendingApproval}
        recovery={recovery}
        choice={pendingChoice}
        planApproval={planApproval}
        agentName={agent?.name ?? ''}
        onApproval={handleApproval}
        onResolve={resolveRecovery}
        onSubmitChoice={submitChoice}
        onResolvePlanApproval={resolvePlanApproval}
        compact={false}
      />

      {/* 左侧会话列表 */}
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
                  <Folder size={13} className="agent-chat__group-icon" />
                  <div className="agent-chat__group-info">
                    <span className="agent-chat__group-name" title={group.rootPath ?? ''}>
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
                  <MessageSquare size={13} className="agent-chat__group-icon" />
                  <span className="agent-chat__group-name">{group.projectName}</span>
                </div>
              )}
              {group.sessions.map((s) => (
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
                    {s.id === activeSessionId && isRunning && !(pendingApproval || pendingChoice || planApproval) && (
                      <Loader2 size={13} className="agent-chat__session-spin" />
                    )}
                  </div>
                  <div className="agent-chat__session-ops" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu
                      align="right"
                      items={[
                        { label: '重命名', icon: <Pencil size={13} />, onClick: () => void renameSessionHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: false, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' }) },
                        { label: s.isTop ? '取消置顶' : '置顶', icon: s.isTop ? <PinOff size={13} /> : <Pin size={13} />, onClick: () => void toggleSessionTopHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: false, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' }) },
                        { label: s.isArchived ? '取消归档' : '归档', icon: s.isArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />, onClick: () => void archiveSessionHandler({ id: s.id, sessionName: s.sessionName, agentCode: '', status: 'RUNNING', isCollection: false, isTop: false, isArchive: s.isArchived, fromSite: 'DEBUG_CHAT', createdAt: '', updatedAt: '' }) },
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

      {/* 中间会话区 */}
      <section className="agent-chat__main">
        <div className="agent-chat__scroll" ref={scrollRef}>
          {messages.map((m, idx) => {
            const isLastAgent = idx === messages.length - 1 && m.role === 'agent'
            const content = isLastAgent ? displayedContent : m.content
            const conversationMs =
              m.completedAt && messages[0]?.createdAt
                ? m.completedAt - messages[0].createdAt
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
                        <MarkdownRenderer content={content} />
                      ) : isStreaming || isRunning ? (
                        <span className="agent-chat__thinking">思考中…</span>
                      ) : (
                        <span className="agent-chat__thinking">（智能体未返回文本内容）</span>
                      )
                    ) : (
                      <span className="agent-chat__plain">{m.content}</span>
                    )}
                  </div>
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
                      </div>
                    </div>
                  )}
                  {m.role === 'agent' && <FilePathCards content={m.content} />}
                  {m.role === 'agent' && m.completedAt && (
                    <MessageActions
                      msg={m}
                      agent={agent}
                      onRegenerate={() => handleRegenerate(m.id)}
                    />
                  )}
                </div>
              </div>
            )
          })}
          {statusText && <div className="agent-chat__status">{statusText}</div>}
        </div>

        {/* 底部输入工具条：仿 WorkBuddy 的大圆角输入框，工具按钮内嵌在框底 */}
        <footer className="agent-chat__input">
          <div
            className={`agent-chat__input-box${dragOver ? ' agent-chat__input-box--drag' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              if (!dragOver) setDragOver(true)
            }}
            onDragLeave={(e) => {
              // 仅当真正离开 input-box 整体时收起（避免子元素冒泡误触发）
              if (e.currentTarget === e.target) setDragOver(false)
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
              disabled={isRunning}
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
              </div>

              <div className="agent-chat__toolbar-right">
                <LiveTokenCounter usage={liveTokenUsage} running={isRunning} />
                <TokenRing
                  promptTokens={activeSession?.totalPromptTokens ?? 0}
                  completionTokens={activeSession?.totalCompletionTokens ?? 0}
                  toolsTokens={activeSession?.toolsTokens ?? 0}
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
                    title="发送"
                    disabled={!input.trim()}
                    onClick={send}
                  >
                    <Send size={16} />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </footer>

      </section>

      {/* 右侧投影面板：图（本轮 DAG）/ 过程 / 产物（方案 C Graph-first） */}
      {rightOpen ? (
        <>
          <div className="agent-chat__resize" ref={resizeElRef} onMouseDown={startResize} title="拖拽调节宽度" />
          <aside className="agent-chat__right" style={{ width: rightWidth }}>
          <div className="agent-chat__right-tabs">
            <button
              type="button"
              className={`agent-chat__right-tab ${rightTab === 'graph' ? 'is-active' : ''}`}
              onClick={() => setRightTab('graph')}
            >
              <Workflow size={13} />
              图
            </button>
            <button
              type="button"
              className={`agent-chat__right-tab ${rightTab === 'process' ? 'is-active' : ''}`}
              onClick={() => setRightTab('process')}
            >
              <GitBranch size={13} />
              过程
            </button>
            <button
              type="button"
              className={`agent-chat__right-tab ${rightTab === 'artifacts' ? 'is-active' : ''}`}
              onClick={() => setRightTab('artifacts')}
            >
              <Box size={13} />
              产物（{artifacts.length}）
            </button>
            {recovery && (
              <span className="agent-chat__right-flag" title="步骤受阻，请在底部处置">
                <TriangleAlert size={12} />
                待处置
              </span>
            )}
            <button
              type="button"
              className="agent-chat__right-collapse"
              title="收起面板"
              onClick={() => setRightOpen(false)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="agent-chat__right-body">
            {rightTab === 'graph' ? (
              <RunDagCanvas
                planSteps={planSteps}
                toolSteps={toolSteps}
                artifacts={artifacts}
                planBranch={session.planBranch}
                onPreviewArtifact={handlePreviewArtifact}
                onBranchFromStep={handleBranchFromStep}
                onApplyBranch={handleApplyBranch}
                onDismissBranch={handleDismissBranch}
              />
            ) : rightTab === 'process' ? (
              <TracePanel
                intent={session.trace.intent}
                thinking={[]}
                planSteps={planSteps}
                toolSteps={toolSteps}
              />
            ) : (
              <ArtifactGallery artifacts={artifacts} isTauri={isTauri} />
            )}
          </div>
          {/* 接管情境升起：recovery 非空时不再依赖常驻「接管」Tab，于右栏底部浮出详情（行动键在底部 UserPromptPanel） */}
          {recovery && (
            <div className="agent-chat__right-recovery">
              <TakeoverPanel recovery={recovery} onPreviewArtifact={handlePreviewArtifact} />
            </div>
          )}
        </aside>
        </>
      ) : (
        <button
          type="button"
          className="agent-chat__right-reopen"
          title="展开执行图"
          onClick={() => setRightOpen(true)}
        >
          <ChevronLeft size={14} />
          <span>执行图</span>
        </button>
      )}

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

/** Web Speech API 的最小类型（浏览器原生，未包含在 DOM lib 的完整定义时兜底）。 */
interface SpeechLike {
  lang: string
  interimResults: boolean
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}
