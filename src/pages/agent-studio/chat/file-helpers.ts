/**
 * chat 页模块级纯常量与纯函数（#20260915005 Step 2 自 chat.tsx 原样抽出）。
 *
 * 搬运原则（docs/chat-split-plan.md）：声明、实现、注释一律原样，仅加 export；
 * 本文件零 React / 零 hook 依赖（纯 TS 逻辑），渲染层 JSX 零改动。
 */

/** 文本型扩展名白名单：这些文件直接提取文本内联（≤200KB），任意模型可用。 */
export const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'xml', 'html', 'htm', 'css',
  'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp',
  'sh', 'bat', 'ps1', 'yml', 'yaml', 'toml', 'ini', 'env', 'sql', 'kt', 'swift',
  'php', 'rb', 'gitignore', 'lock',   'tex', 'r', 'scala', 'dart',
])

/** 判断文件是否可作文本内联（按 MIME 或扩展名）。 */
export function isTextType(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (['application/json', 'application/xml', 'application/javascript', 'application/typescript'].includes(file.type)) {
    return true
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXT.has(ext)
}

/** 生成附件前端 id。 */
export function attId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

/** 人类可读的文件大小。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** Promise 化的 FileReader 读取。 */
export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

/** 文本附件首行预览（去掉多余空白，限长）。 */
export function textPreview(content?: string): string {
  if (!content) return ''
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? ''
  return firstLine.length > 48 ? firstLine.slice(0, 48) + '…' : firstLine
}

/** 附件尺寸上限（分片上传，远高于旧版 20MB 内联上限）。 */
export const MAX_INLINE_IMAGE = 20 * 1024 * 1024
export const TEXT_INLINE_LIMIT = 200 * 1024
export const MAX_FILE = 500 * 1024 * 1024

/** 匹配 Windows / Unix / 相对路径（要求带扩展名，避免把 URL 当路径）。
 * 字符类显式排除 `'`, `"`, `` ` ``, `+`：这些在真实文件名里几乎不会出现，
 * 但 Agent 输出常把它们作为代码引用 / 模板字面量的边界字符；不排除则正则
 * 会贪婪地把多段路径/文件名穿成一个串（如 `a.md' + 'b.docx`）。 */
export const FILE_PATH_RE =
  /(?<!:\/\/)(?<![a-zA-Z]:\/\/)\b(?:[A-Za-z]:[\\/](?:[^<>:"|?*'`+\n\r]+[\\/])*[^<>:"|?*'`+\n\r]+\.\w{2,10}|(?:\/|\.{0,2}\/)(?:[^<>:"|?*'`+\n\r]+\/)*[^<>:"|?*'`+\n\r]+\.\w{2,10})/g

export const FILE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
export const FILE_SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'tsv'])
export const FILE_TEXT_EXTS = new Set(['md', 'txt', 'doc', 'docx', 'pdf', 'rtf'])
export const FILE_CODE_EXTS = new Set([
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

export function extractFilePaths(content: string): string[] {
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

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0.0s'
  return `${(ms / 1000).toFixed(1)}s`
}

export function formatConversationDuration(ms: number): string {
  if (!ms || ms < 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

export function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 简易 token 估算：CJK 字符 ≈ 1 token；其余按空格分词 ≈ 1.3 token/词。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[一-鿿　-〿぀-ゟ゠-ヿ가-힯]/g) ?? []).length
  const nonCjk = text.replace(/[一-鿿　-〿぀-ゟ゠-ヿ가-힯]/g, ' ')
  const words = nonCjk.trim().split(/\s+/).filter(Boolean).length
  return Math.ceil(cjk + words * 1.3)
}

/** 单个工具 / 技能定义占用的上下文 token 估算值（工具定义理论上固定，移除 Skill / 停用 MCP 时下调）。 */
export const AVG_TOOL_TOKENS = 300

/** 根据占比（0~1）返回绿色→黄色→红色的渐变色（越接近上限越红）。 */
export function ringColor(ratio: number): string {
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
