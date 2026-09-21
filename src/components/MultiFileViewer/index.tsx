/**
 * 知识库文件多格式查看器（按扩展名分发渲染）。
 *
 * 调度规则（组件置于 src/components 下，供知识库详情页统一调用），严格对齐用户推荐渲染库：
 *  - md / markdown        → MarkdownRenderer（react-markdown + remark-gfm + remark-math + rehype-katex + rehype-highlight + mermaid）
 *  - pdf                  → @react-pdf-viewer/core + default-layout（pdfjs-dist worker 本地化）
 *  - doc / docx           → 动态 import('docx-preview') 渲染；未安装该库时降级为「下载原文件」
 *  - xls / xlsx / csv     → xlsx(SheetJS) 解析 + ag-grid-react 表格；未安装时降级为「下载原文件」
 *  - pptx                 → jszip 解包 OOXML 渲染（文本框 + 图片；图表/SMARTART 降级下载）
 *  - 图片（png/jpg/...）   → react-zoom-pan-pinch 缩放/拖拽查看
 *  - 音频                  → wavesurfer.js 波形播放器
 *  - 视频                  → video.js 播放器
 *  - epub                 → react-reader 阅读器
 *  - 其余（文本/代码/json）→ MonacoJsonEditor（只读）
 *
 * docx-preview / xlsx / jszip 通过动态 import 按需加载并以 try/catch 兜底，故即便缺失也不阻断类型检查与运行。
 * 文件内容由 kbFs.readKbFileContent 读取（kb.path + relPath），本组件自行管理加载/错误态。
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Spin } from 'antd'
import { Save, X, Pencil } from 'lucide-react'
import type { KnowledgeBase } from '@/types/core'
import { readKbFileContent, writeKbFileContent, type KbFileContent } from '@/core/file/kbFs'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { MonacoJsonEditor } from '@/components/code-editor'
import { useNotify } from '@/components/ui/notify'
import { useResolvedTheme } from '@/hooks/useResolvedTheme'
import { pdfZhCn } from './pdfZhCn'

// 第三方渲染库样式（仅在对应库安装后生效；缺失也不影响类型检查）
import '@react-pdf-viewer/core/lib/styles/index.css'
import '@react-pdf-viewer/default-layout/lib/styles/index.css'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-quartz.css'
import 'video.js/dist/video-js.css'

/** 图片扩展名 -> MIME（用于直接展示图片）。 */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

/** 音频扩展名 -> MIME（用于原生 <audio> 兜底与 wavesurfer 加载）。 */
const AUDIO_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  webm: 'audio/webm',
}

/** 视频扩展名 -> MIME（用于 video.js 加载）。 */
const VIDEO_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
}

/** 扩展名 -> Monaco 语言 id。 */
const EXT_LANG: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  lua: 'lua',
  sql: 'sql',
  xml: 'xml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : ''
}
function isImageFile(name: string): boolean {
  return extOf(name) in IMAGE_MIME
}
function isAudioFile(name: string): boolean {
  return extOf(name) in AUDIO_EXT
}
function isVideoFile(name: string): boolean {
  return extOf(name) in VIDEO_EXT
}
function langOf(name: string): string {
  return EXT_LANG[extOf(name)] ?? 'plaintext'
}

export interface MultiFileViewerProps {
  kb: KnowledgeBase
  /** 相对知识库根目录的路径；为空表示未选中 */
  relPath: string | null
  /** 文件内容被编辑保存后回调（如触发知识库增量索引），可选。 */
  onFileChanged?: () => void
}

/** 可编辑扩展名集合：纯文本/标记/代码类（二进制与富格式仅预览）。 */
const EDITABLE_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'jsonc', 'yml', 'yaml', 'sh', 'bash', 'zsh',
  'ps1', 'py', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'less',
  'go', 'rs', 'java', 'kt', 'rb', 'php', 'c', 'h', 'cpp', 'cs', 'swift', 'lua', 'sql',
  'xml', 'toml', 'ini', 'env',
])

export function MultiFileViewer({ kb, relPath, onFileChanged }: MultiFileViewerProps) {
  const { message } = useNotify()
  const [content, setContent] = useState<KbFileContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 编辑态（K 系列补充：详情页此前只能创建不能编辑，属功能缺口）
  const [reloadNonce, setReloadNonce] = useState(0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    setContent(null)
    setError(null)
    setEditing(false)
    if (!relPath || !kb.path) return
    setLoading(true)
    void (async () => {
      const c = await readKbFileContent(kb.path as string, relPath)
      if (!active) return
      if (!c) setError('无法读取该文件（可能已被删除或无权限）')
      setContent(c)
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [kb.path, relPath, reloadNonce])

  if (!relPath) return <div className="kb-viewer__muted">请从左侧选择一个文件</div>
  if (loading) return <div className="kb-viewer__loading"><Spin tip="正在读取文件..." /></div>
  if (error) return <div className="kb-viewer__muted">{error}</div>
  if (!content) return <div className="kb-viewer__muted">请选择一个文件</div>

  const ext = extOf(content.name)
  const canEdit = EDITABLE_EXTS.has(ext)

  if (editing) {
    return (
      <div className="kb-viewer__editwrap">
        <div className="kb-viewer__editbar">
          <span className="kb-viewer__editbar-hint">{relPath}</span>
          <button
            type="button"
            className="kb-viewer__editbar-btn"
            disabled={saving}
            onClick={() => {
              void (async () => {
                setSaving(true)
                const r = await writeKbFileContent(kb.path as string, relPath, draft)
                setSaving(false)
                if (r.ok) {
                  message.success('已保存')
                  onFileChanged?.()
                  setEditing(false)
                  setReloadNonce((n) => n + 1)
                } else {
                  message.error(`保存失败：${r.error ?? '未知错误'}`)
                }
              })()
            }}
          >
            <Save size={13} /> {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="kb-viewer__editbar-btn"
            disabled={saving}
            onClick={() => setEditing(false)}
          >
            <X size={13} /> 取消
          </button>
        </div>
        <div className="kb-viewer__editarea">
          <MonacoJsonEditor
            mode="code"
            value={draft}
            onChange={(v) => setDraft(typeof v === 'string' ? v : draft)}
            language={langOf(content.name)}
            height="100%"
          />
        </div>
      </div>
    )
  }

  const body =
    ext === 'md' || ext === 'markdown' ? (
      <MarkdownViewer bytes={content.data} kbPath={kb.path as string} mdRelPath={relPath} />
    ) : ext === 'pdf' ? (
      <PdfViewer bytes={content.data} name={content.name} />
    ) : ext === 'doc' || ext === 'docx' ? (
      <DocxViewer bytes={content.data} name={content.name} />
    ) : ext === 'xls' || ext === 'xlsx' || ext === 'csv' ? (
      <XlsxViewer bytes={content.data} name={content.name} />
    ) : ext === 'pptx' ? (
      <PptxViewer bytes={content.data} name={content.name} />
    ) : isImageFile(content.name) ? (
      <ImageViewer bytes={content.data} name={content.name} ext={ext} />
    ) : isVideoFile(content.name) ? (
      <VideoViewer bytes={content.data} name={content.name} ext={ext} />
    ) : isAudioFile(content.name) ? (
      <AudioViewer bytes={content.data} name={content.name} ext={ext} />
    ) : ext === 'epub' ? (
      <EpubViewer bytes={content.data} name={content.name} />
    ) : (
      <TextViewer bytes={content.data} name={content.name} />
    )

  return canEdit ? (
    <div className="kb-viewer__editwrap">
      <div className="kb-viewer__editbar">
        <span className="kb-viewer__editbar-hint" />
        <button
          type="button"
          className="kb-viewer__editbar-btn"
          onClick={() => {
            setDraft(new TextDecoder('utf-8').decode(content.data))
            setEditing(true)
          }}
        >
          <Pencil size={13} /> 编辑
        </button>
      </div>
      {body}
    </div>
  ) : (
    body
  )
}

/* ----------------------------- 各类型渲染子组件 ----------------------------- */

function MarkdownViewer({
  bytes,
  kbPath,
  mdRelPath,
}: {
  bytes: Uint8Array
  kbPath: string
  mdRelPath: string | null
}) {
  const text = useMemo(() => new TextDecoder('utf-8').decode(bytes), [bytes])

  // 解析 markdown 内引用的本地图片（相对路径 / file:// 绝对路径）→ blob URL；
  // 浏览器原生无法加载这些路径，会报 net::ERR_FILE_NOT_FOUND，故在此按知识库实际文件解析。
  const resolveImageUrl = useCallback(
    async (src: string): Promise<string | null> => {
      try {
        let rel = src.replace(/^[a-zA-Z]+:\/\//, '') // 去掉 file:// 等协议前缀
        rel = rel.replace(/^[A-Za-z]:[\\/]/, '') // 去掉 C:\ / C:/ 盘符前缀
        if (!rel || /^(https?:|data:|blob:)/i.test(src)) return null
        const baseDir = mdRelPath && mdRelPath.includes('/') ? mdRelPath.slice(0, mdRelPath.lastIndexOf('/')) : ''
        const candidate = baseDir ? `${baseDir}/${rel}` : rel
        const c = await readKbFileContent(kbPath, candidate)
        if (!c) return null
        const mime = IMAGE_MIME[extOf(c.name)] ?? 'application/octet-stream'
        return URL.createObjectURL(new Blob([c.data as BlobPart], { type: mime }))
      } catch {
        return null
      }
    },
    [kbPath, mdRelPath],
  )

  return <MarkdownRenderer content={text} resolveImageUrl={resolveImageUrl} />
}

/* ----------------------------- PDF：@react-pdf-viewer ----------------------------- */

/** PDF 渲染失败时兜底（捕获 react-pdf-viewer 渲染异常，提供下载原文件入口）。 */
class PdfErrorBoundary extends Component<{ fallback: React.ReactNode; children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

/** PDF 预览按需加载的模块集合。 */
interface PdfMods {
  Worker: unknown
  Viewer: unknown
  defaultLayoutPlugin: unknown
  workerUrl: string
}

function PdfViewer({ bytes, name }: { bytes: Uint8Array; name: string }) {
  // 注意：blob URL 必须在 effect 内创建，而非 useMemo。原因：React 18 StrictMode 下组件会
  // 经历 mount→unmount(模拟)→mount，若用 useMemo 创建、单独 effect 仅 revoke，模拟卸载时 blob
  // 已被 revoke 而 useMemo 不会重建，导致 pdf 拿到失效 blob URL（net::ERR_FILE_NOT_FOUND）。
  // 改为 effect 内创建 + 同 effect 内 revoke：每次挂载（含 StrictMode 重挂）都重建有效 URL。
  const [url, setUrl] = useState('')
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [bytes])

  const fallback = (
    <DownloadFallback bytes={bytes} name={name} hint="PDF 预览组件加载失败，可下载原文件查看。" />
  )

  // 动态加载，避免未安装时阻断首屏；安装后自动启用富预览
  const [mods, setMods] = useState<PdfMods | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([
      import('@react-pdf-viewer/core'),
      import('@react-pdf-viewer/default-layout'),
      import('pdfjs-dist/build/pdf.worker.min.js?url'),
    ])
      .then(([core, layout, workerUrl]) => {
        if (!active) return
        setMods({
          Worker: (core as { Worker: unknown }).Worker,
          Viewer: (core as { Viewer: unknown }).Viewer,
          defaultLayoutPlugin: (layout as { defaultLayoutPlugin: unknown }).defaultLayoutPlugin,
          workerUrl: (workerUrl as { default: string }).default,
        })
      })
      .catch((e: unknown) => {
        if (active) setErr(e instanceof Error ? e.message : String(e))
      })
    return () => {
      active = false
    }
  }, [])

  if (err) return fallback
  if (!mods || !url) return <div className="kb-viewer__loading"><Spin tip="正在加载 PDF 预览..." /></div>

  // 模块就绪后再渲染内部组件：defaultLayoutPlugin 内部使用 useMemo（属于 hook），
  // 必须在组件顶层「无条件」调用，不能放在本组件 early-return 之后的 JSX 里，
  // 否则会在 mods 加载前后出现 hook 数量不一致而崩溃。
  return <PdfViewerInner mods={mods} url={url} fallback={fallback} />
}

/** PDF 真正渲染层：defaultLayoutPlugin() 作为 hook 在顶层无条件调用。 */
function PdfViewerInner({ mods, url, fallback }: { mods: PdfMods; url: string; fallback: React.ReactNode }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Worker = mods.Worker as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Viewer = mods.Viewer as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defaultLayoutPlugin = mods.defaultLayoutPlugin as any
  // defaultLayoutPlugin 内部使用 useMemo，必须作为 hook 在组件顶层无条件调用
  const layoutPlugin = defaultLayoutPlugin()

  // 跟随应用主题：useResolvedTheme 已处理 light / dark / system 跟随系统，
  // 直接传给 Viewer.theme（'light' | 'dark'），随应用主题切换实时变化，无需重载 PDF。
  const pdfTheme = useResolvedTheme()

  return (
    <PdfErrorBoundary fallback={fallback}>
      <div className="kb-viewer__pdf">
        <Worker workerUrl={mods.workerUrl}>
          <Viewer fileUrl={url} theme={pdfTheme} localization={pdfZhCn} plugins={[layoutPlugin]} />
        </Worker>
      </div>
    </PdfErrorBoundary>
  )
}

/* ----------------------------- docx：docx-preview ----------------------------- */

/** docx：按需加载 docx-preview；加载/渲染失败则降级为下载原文件。 */
function DocxViewer({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setErr(null)
    const el = ref.current
    if (!el) return
    el.innerHTML = ''
    import('docx-preview')
      .then(({ renderAsync }) =>
        renderAsync(new Blob([bytes as BlobPart]), el, undefined, {
          className: 'kb-docx',
          inWrapper: true,
        }),
      )
      .then(() => active && setLoading(false))
      .catch((e: unknown) => {
        if (active) {
          setErr(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [bytes])

  if (loading) return <div className="kb-viewer__loading"><Spin tip="正在渲染文档..." /></div>
  if (err)
    return (
      <DownloadFallback
        bytes={bytes}
        name={name}
        hint={`文档渲染失败：${err}。可安装 docx-preview 后启用富渲染，或下载原文件查看。`}
      />
    )
  return <div className="kb-viewer__docx" ref={ref} />
}

/* ----------------------------- xlsx：xlsx + ag-grid ----------------------------- */

/** xlsx：SheetJS 解析 + ag-grid-react 表格；多工作表提供切换标签；加载/解析失败则降级为下载原文件。 */
function XlsxViewer({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const [sheets, setSheets] = useState<{ name: string; rows: unknown[][] }[] | null>(null)
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [agMods, setAgMods] = useState<{ AgGridReact: unknown } | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setErr(null)
    setSheets(null)
    setActive(0)
    Promise.all([import('xlsx'), import('ag-grid-react')])
      .then(([XLSX, ag]) => {
        const wb = XLSX.read(bytes, { type: 'array' })
        const list = wb.SheetNames.map((sheetName: string) => {
          const ws = wb.Sheets[sheetName]
          const rows = XLSX.utils.sheet_to_json(ws ?? {}, { header: 1, defval: '' }) as unknown[][]
          return { name: sheetName, rows }
        })
        if (active) {
          setSheets(list)
          setAgMods({ AgGridReact: (ag as { AgGridReact: unknown }).AgGridReact })
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (active) {
          setErr(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [bytes])

  if (loading) return <div className="kb-viewer__loading"><Spin tip="正在解析表格..." /></div>
  if (err)
    return (
      <DownloadFallback
        bytes={bytes}
        name={name}
        hint={`表格解析失败：${err}。可安装 xlsx / ag-grid 后启用表格预览，或下载原文件查看。`}
      />
    )

  const current = sheets?.[active]
  return (
    <div className="kb-viewer__xlsx">
      {sheets && sheets.length > 1 && (
        <div className="kb-xlsx__tabs" role="tablist">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={`kb-xlsx__tab${i === active ? ' is-active' : ''}`}
              onClick={() => setActive(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="kb-viewer__grid">
        {current && agMods && (
          <AgGridRoot
            AgGridReact={agMods.AgGridReact as React.ComponentType<Record<string, unknown>>}
            rows={current.rows}
          />
        )}
      </div>
    </div>
  )
}

/** 将工作表二维数组转为 ag-grid 的 rowData / columnDefs 并渲染。 */
function AgGridRoot({
  AgGridReact,
  rows,
}: {
  AgGridReact: React.ComponentType<Record<string, unknown>>
  rows: unknown[][]
}) {
  const header = rows[0] ?? []
  const columnDefs = header.map((h, i) => ({
    field: String(i),
    headerName: String(h ?? `列${i + 1}`),
  }))
  const rowData = rows.slice(1).map((r) =>
    Object.fromEntries(r.map((v, i) => [String(i), v])),
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Grid = AgGridReact as any
  return (
    <Grid
      rowData={rowData}
      columnDefs={columnDefs}
      className="ag-theme-quartz"
      defaultColDef={{ resizable: true, sortable: true, filter: true }}
    />
  )
}

/* ----------------------------- pptx：jszip 解包渲染 ----------------------------- */
// 说明：推荐库 pptx2html 依赖 exotic 子依赖 dimple（github git 源），被本项目 supply-chain 策略
// blockExoticSubdeps 拦截且当前环境无法访问 github，故改用已安装的 jszip 直接解包 OOXML，
// 提取文本框与图片绝对定位渲染；图表/SMARTART 等由 dimple 负责的部分降级为「下载原文件」。

const PPTX_EMU_PER_PX = 914400 / 96

/** 转义 pptx 文本中的 HTML 特殊字符，避免注入并正确显示。 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/** 读取 a:rPr 内的字体颜色（srgbClr），无则返回 null。 */
function pptxRunColor(rPr: Element | undefined): string | null {
  if (!rPr) return null
  const srgb = rPr.getElementsByTagName('a:srgbClr')[0]
  return srgb ? '#' + (srgb.getAttribute('val') || '') : null
}

/** 解引用 pptx 内部相对路径（slides/slideN.xml + ../media/img.png → ppt/media/img.png）。 */
function resolvePart(basePath: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\//, '')
  const baseDir = basePath.replace(/[^/]+$/, '')
  const stack: string[] = []
  for (const p of (baseDir + target).split('/')) {
    if (p === '..') stack.pop()
    else if (p && p !== '.') stack.push(p)
  }
  return stack.join('/')
}

/** 最小化的 jszip 实例形态（仅取所需方法），避免静态依赖其类型。 */
interface JSZipLike {
  file: (p: string) => { async: (t: 'string' | 'base64') => Promise<unknown> } | null
  loadAsync: (data: Uint8Array | ArrayBuffer) => Promise<JSZipLike>
}

/** 读取媒体文件为内联 data URL（用于 <img>）。 */
async function readMediaDataUrl(zip: JSZipLike, mediaPath: string): Promise<string | null> {
  const file = zip.file(mediaPath)
  if (!file) return null
  const buf = (await file.async('base64')) as string
  const ext = mediaPath.split('.').pop()?.toLowerCase() ?? 'png'
  const mime: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  }
  return `data:${mime[ext] ?? 'application/octet-stream'};base64,${buf}`
}

/** 解析单个 slide 的 XML 为绝对定位的 HTML 字符串，并返回引用的媒体路径列表。 */
function buildSlideHtml(
  slideDoc: Document,
  relsDoc: Document | null,
  slidePath: string,
): { html: string; mediaPaths: string[] } {
  const sRelMap = new Map<string, string>()
  if (relsDoc) {
    for (const r of Array.from(relsDoc.getElementsByTagName('Relationship'))) {
      const id = r.getAttribute('Id')
      const tg = r.getAttribute('Target')
      if (id && tg) sRelMap.set(id, tg)
    }
  }
  const parts: string[] = []
  const mediaPaths: string[] = []

  // 文本框
  for (const sp of Array.from(slideDoc.getElementsByTagName('p:sp'))) {
    const spPr = sp.getElementsByTagName('p:spPr')[0]
    const xfrm = spPr?.getElementsByTagName('a:xfrm')[0]
    const off = xfrm?.getElementsByTagName('a:off')[0]
    const ext = xfrm?.getElementsByTagName('a:ext')[0]
    if (!off || !ext) continue
    const L = Math.round((Number(off.getAttribute('x')) || 0) / PPTX_EMU_PER_PX)
    const T = Math.round((Number(off.getAttribute('y')) || 0) / PPTX_EMU_PER_PX)
    const W = Math.round((Number(ext.getAttribute('cx')) || 0) / PPTX_EMU_PER_PX)
    const H = Math.round((Number(ext.getAttribute('cy')) || 0) / PPTX_EMU_PER_PX)
    const txBody = sp.getElementsByTagName('p:txBody')[0]
    if (!txBody) continue
    let paraHtml = ''
    for (const p of Array.from(txBody.getElementsByTagName('a:p'))) {
      let runs = ''
      for (const r of Array.from(p.getElementsByTagName('a:r'))) {
        const t = r.getElementsByTagName('a:t')[0]?.textContent ?? ''
        const rPr = r.getElementsByTagName('a:rPr')[0]
        const sz = (Number(rPr?.getAttribute('sz')) || 1800) / 100
        const style = [
          `font-size:${sz}pt`,
          rPr?.getAttribute('b') === '1' ? 'font-weight:bold' : '',
          rPr?.getAttribute('i') === '1' ? 'font-style:italic' : '',
          pptxRunColor(rPr) ? `color:${pptxRunColor(rPr)}` : '',
        ].filter(Boolean).join(';')
        runs += `<span style="${style}">${escapeHtml(t)}</span>`
      }
      paraHtml += `<div style="margin:2px 0;line-height:1.2">${runs || '&nbsp;'}</div>`
    }
    parts.push(
      `<div style="position:absolute;left:${L}px;top:${T}px;width:${W}px;height:${H}px;overflow:hidden;box-sizing:border-box">${paraHtml}</div>`,
    )
  }

  // 图片
  for (const pic of Array.from(slideDoc.getElementsByTagName('p:pic'))) {
    const xfrm = pic.getElementsByTagName('a:xfrm')[0]
    const off = xfrm?.getElementsByTagName('a:off')[0]
    const ext = xfrm?.getElementsByTagName('a:ext')[0]
    const blip = pic.getElementsByTagName('a:blip')[0]
    const rid = blip?.getAttribute('r:embed')
    if (!off || !ext || !rid) continue
    const target = sRelMap.get(rid)
    if (!target) continue
    const mediaPath = resolvePart(slidePath, target)
    mediaPaths.push(mediaPath)
    parts.push(
      `<img data-media="${mediaPath}" style="position:absolute;left:${Math.round((Number(off.getAttribute('x')) || 0) / PPTX_EMU_PER_PX)}px;top:${Math.round((Number(off.getAttribute('y')) || 0) / PPTX_EMU_PER_PX)}px;width:${Math.round((Number(ext.getAttribute('cx')) || 0) / PPTX_EMU_PER_PX)}px;height:${Math.round((Number(ext.getAttribute('cy')) || 0) / PPTX_EMU_PER_PX)}px;object-fit:contain" alt="" />`,
    )
  }

  return { html: parts.join(''), mediaPaths }
}

/** 解析整个 pptx：解包 presentation.xml 取幻灯片顺序，逐页提取文本与图片。 */
async function parsePptx(zip: JSZipLike): Promise<{ width: number; height: number; slides: string[] }> {
  const presFile = zip.file('ppt/presentation.xml')
  const presXml = (await presFile?.async('string')) as string | undefined
  const presDoc = new DOMParser().parseFromString(
    presXml ?? '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    'application/xml',
  )
  const sldSz = presDoc.getElementsByTagName('p:sldSz')[0]
  const cx = Number(sldSz?.getAttribute('cx')) || 12192000
  const cy = Number(sldSz?.getAttribute('cy')) || 6858000
  const width = Math.round(cx / PPTX_EMU_PER_PX)
  const height = Math.round(cy / PPTX_EMU_PER_PX)

  const presRelsFile = zip.file('ppt/_rels/presentation.xml.rels')
  const presRelsDoc = presRelsFile
    ? new DOMParser().parseFromString((await presRelsFile.async('string')) as string, 'application/xml')
    : null
  const relMap = new Map<string, string>()
  if (presRelsDoc) {
    for (const r of Array.from(presRelsDoc.getElementsByTagName('Relationship'))) {
      const id = r.getAttribute('Id')
      const tg = r.getAttribute('Target')
      if (id && tg) relMap.set(id, tg)
    }
  }

  const slidePaths: string[] = []
  for (const sldId of Array.from(presDoc.getElementsByTagName('p:sldId'))) {
    const rid = sldId.getAttribute('r:id')
    const target = rid ? relMap.get(rid) : undefined
    if (target) slidePaths.push(resolvePart('ppt/presentation.xml', target))
  }

  const slides: string[] = []
  for (const path of slidePaths) {
    const f = zip.file(path)
    if (!f) continue
    const xml = (await f.async('string')) as string
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const relsPath = path.replace(/slides\/([^/]+)$/, 'slides/_rels/$1.rels')
    const rf = zip.file(relsPath)
    const relsDoc = rf
      ? new DOMParser().parseFromString((await rf.async('string')) as string, 'application/xml')
      : null
    const { html, mediaPaths } = buildSlideHtml(doc, relsDoc, path)
    const urlMap = new Map<string, string>()
    for (const mp of mediaPaths) {
      const u = await readMediaDataUrl(zip, mp)
      if (u) urlMap.set(mp, u)
    }
    const finalHtml = html.replace(/data-media="([^"]+)"/g, (_m, p: string) => `src="${urlMap.get(p) ?? ''}"`)
    slides.push(finalHtml)
  }
  return { width, height, slides }
}

/** pptx：jszip 解包渲染（文本框 + 图片）；解析失败降级下载原文件。 */
function PptxViewer({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [model, setModel] = useState<{ width: number; height: number; slides: string[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    let active = true
    setLoading(true)
    setErr(null)
    setModel(null)
    import('jszip')
      .then((mod) => {
        const JSZip = (mod as { default: new () => JSZipLike }).default
        if (!JSZip) throw new Error('jszip 未默认导出')
        return new JSZip().loadAsync(bytes as unknown as ArrayBuffer)
      })
      .then((zip) => parsePptx(zip as unknown as JSZipLike))
      .then((res) => {
        if (active) {
          setModel(res)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (active) {
          setErr(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [bytes])

  // 自适应宽度缩放（EMU→px 按 96DPI，容器宽度不足时整体等比缩放）
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !model) return
    const fit = () => {
      const w = stage.clientWidth
      if (w > 0) setZoom(Math.min(1, w / model.width))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [model])

  if (loading) return <div className="kb-viewer__loading"><Spin tip="正在解析演示文稿..." /></div>
  if (err || !model)
    return (
      <DownloadFallback
        bytes={bytes}
        name={name}
        hint={`演示文稿解析失败：${err ?? '未知错误'}。可下载原文件查看。`}
      />
    )
  return (
    <div className="kb-viewer__pptx-stage" ref={stageRef}>
      <div style={{ width: model.width * zoom, height: model.height * zoom }}>
        <div
          style={{
            width: model.width,
            height: model.height,
            transform: `scale(${zoom})`,
            transformOrigin: 'top left',
          }}
        >
          {model.slides.map((html, i) => (
            <div
              key={i}
              className="pptx-slide"
              style={{ width: model.width, height: model.height, background: '#fff', position: 'relative', marginBottom: 16 }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/* ----------------------------- 图片：react-zoom-pan-pinch ----------------------------- */

function ImageViewer({ bytes, name, ext }: { bytes: Uint8Array; name: string; ext: string }) {
  // 直接用 base64 data URL 渲染，规避 blob URL 的生命周期 / 协议拦截问题，
  // 彻底避免「图片显示不了 / net::ERR_FILE_NOT_FOUND」这类加载失败。
  const dataUrl = useMemo(() => {
    const mime = IMAGE_MIME[ext] ?? 'application/octet-stream'
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])
    }
    return `data:${mime};base64,${btoa(binary)}`
  }, [bytes, ext])

  const [T, setT] = useState<{ TransformWrapper: React.ComponentType<Record<string, unknown>>; TransformComponent: React.ComponentType<Record<string, unknown>> } | null>(null)
  useEffect(() => {
    let active = true
    import('react-zoom-pan-pinch').then((m) => {
      if (active)
        setT({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          TransformWrapper: (m as any).TransformWrapper,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          TransformComponent: (m as any).TransformComponent,
        })
    })
    return () => {
      active = false
    }
  }, [])

  if (!T) return <img src={dataUrl} alt={name} className="kb-viewer__image" />

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Wrapper = T.TransformWrapper as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Inner = T.TransformComponent as any
  return (
    <div className="kb-viewer__image-wrap">
      <Wrapper
        minScale={0.5}
        maxScale={8}
        initialScale={1}
        centerOnInit
        wheel={{ step: 0.2 }}
        doubleClick={{ mode: 'zoomIn', step: 0.6 }}
        pinch={{ step: 5 }}
        panning={{ velocityDisabled: false }}
      >
        <Inner>
          <img src={dataUrl} alt={name} className="kb-viewer__image" />
        </Inner>
      </Wrapper>
    </div>
  )
}

/* ----------------------------- 视频：video.js ----------------------------- */

/** 视频：video.js 播放器（blob URL 直出）。 */
function VideoViewer({ bytes, name, ext }: { bytes: Uint8Array; name: string; ext: string }) {
  const url = useMemo(() => {
    const mime = VIDEO_EXT[ext] ?? 'video/mp4'
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  }, [bytes, ext])
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  const videoRef = useRef<HTMLVideoElement>(null)
  const playerRef = useRef<{ dispose: () => void } | null>(null)

  useEffect(() => {
    let active = true
    import('video.js').then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const videojs = (mod as any).default ?? mod
      if (!active || !videoRef.current) return
      playerRef.current = videojs(videoRef.current, {
        controls: true,
        preload: 'auto',
        fluid: true,
        sources: [{ src: url, type: VIDEO_EXT[ext] ?? 'video/mp4' }],
      })
    })
    return () => {
      active = false
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [url, ext])

  return (
    <div className="kb-viewer__media-wrap" data-vjs-player>
      <video ref={videoRef} className="video-js vjs-big-play-centered" title={name} />
    </div>
  )
}

/* ----------------------------- 音频：wavesurfer.js ----------------------------- */

/** 音频：wavesurfer.js 波形播放器（blob URL 直出）。 */
function AudioViewer({ bytes, name, ext }: { bytes: Uint8Array; name: string; ext: string }) {
  const url = useMemo(() => {
    const mime = AUDIO_EXT[ext] ?? 'audio/mpeg'
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  }, [bytes, ext])
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  const containerRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const wsRef = useRef<{ play: () => void; pause: () => void; destroy: () => void; on: (e: string, cb: () => void) => void } | null>(null)

  useEffect(() => {
    let active = true
    import('wavesurfer.js').then((mod) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const WaveSurfer = (mod as any).default ?? mod
      if (!active || !containerRef.current) return
      const ws = WaveSurfer.create({
        container: containerRef.current,
        url,
        height: 96,
        waveColor: '#9ca3af',
        progressColor: '#6366f1',
      })
      ws.on('play', () => setPlaying(true))
      ws.on('pause', () => setPlaying(false))
      wsRef.current = ws
    })
    return () => {
      active = false
      wsRef.current?.destroy()
      wsRef.current = null
    }
  }, [url])

  return (
    <div className="kb-viewer__audio">
      <div ref={containerRef} className="kb-viewer__wave" />
      <button
        type="button"
        className="kb-viewer__audio-btn"
        aria-label={`播放/暂停：${name}`}
        onClick={() => {
          const ws = wsRef.current
          if (!ws) return
          if (playing) ws.pause()
          else ws.play()
        }}
      >
        {playing ? '暂停' : '播放'}
      </button>
    </div>
  )
}

/* ----------------------------- epub：react-reader ----------------------------- */

/** epub：react-reader 阅读器（blob URL 直出）。 */
function EpubViewer({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/epub+zip' })),
    [bytes],
  )
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  const [Reader, setReader] = useState<React.ComponentType<Record<string, unknown>> | null>(null)
  useEffect(() => {
    let active = true
    import('react-reader').then((m) => {
      if (active) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setReader(((m as any).ReactReader as React.ComponentType<Record<string, unknown>>) ?? null)
      }
    })
    return () => {
      active = false
    }
  }, [])

  if (!Reader) return <div className="kb-viewer__loading"><Spin tip="正在加载电子书..." /></div>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const R = Reader as any
  return (
    <div className="kb-viewer__epub">
      <R url={url} title={name} />
    </div>
  )
}

/* ----------------------------- 文本/代码：Monaco ----------------------------- */

function TextViewer({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const text = useMemo(() => new TextDecoder('utf-8').decode(bytes), [bytes])
  // 父容器 .kb-detail__explorer-view 已改为 flex 列且具确定高度（参考 skill 模块详情页），
  // 故这里传 "100%" 即可让 Monaco 撑满内容区；不再用固定像素高度（避免页面挤出 Y 轴滚动条）。
  return <MonacoJsonEditor mode="code" readOnly value={text} language={langOf(name)} height="100%" />
}

/** 未安装渲染库 / 渲染失败时的兜底：提供原文件下载入口。 */
function DownloadFallback({ bytes, name, hint }: { bytes: Uint8Array; name: string; hint: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes as BlobPart])), [bytes])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return (
    <div className="kb-viewer__muted">
      <p>{hint}</p>
      <a className="kb-viewer__download" href={url} download={name}>
        下载原文件：{name}
      </a>
    </div>
  )
}
