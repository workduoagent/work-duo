/**
 * 知识库 Markdown 渲染器（富渲染分支）。
 *
 * 插件栈（对齐用户推荐表）：
 *  - remark-gfm         表格 / 删除线 / 任务列表等 GFM 语法
 *  - remark-math        识别 $...$ 与 $$...$$ 数学公式块
 *  - rehype-katex       将公式渲染为 KaTeX HTML（需引入 katex CSS）
 *  - rehype-highlight   代码块语法高亮（需引入 highlight.js 主题 CSS）
 *  - mermaid             ```mermaid 围栏代码块渲染为流程图 / 时序图（SVG）
 *
 * 样式：katex.min.css 与 highlight.js 主题在组件内引入；mermaid 直接产出内联 SVG，无需额外 CSS。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import mermaid from 'mermaid'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'

export interface MarkdownRendererProps {
  content: string
  className?: string
  /**
   * 本地图片解析器：当 markdown 内 <img> 的 src 为相对路径或 file:// 绝对路径（非 http(s)/data/blob）
   * 时调用，返回可渲染的 blob/data URL；返回 null 则回退为原始 src。
   * 由调用方（如知识库查看器）按知识库实际文件解析。
   */
  resolveImageUrl?: (src: string) => Promise<string | null>
}

// mermaid 仅初始化一次；render 在每次代码块挂载时调用
mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' })

/** 递归抽取 React 节点中的纯文本（用于 mermaid 源码）。 */
function extractText(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    return extractText((node as { props: { children?: unknown } }).props.children)
  }
  return ''
}

/** 单个 mermaid 代码块：挂载后调用 mermaid.render 产出 SVG。 */
function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    const id = `mermaid-${Math.random().toString(36).slice(2)}`
    mermaid
      .render(id, code)
      .then((r: { svg: string }) => {
        if (active && ref.current) ref.current.innerHTML = r.svg
      })
      .catch((e: unknown) => {
        if (active && ref.current) {
          ref.current.innerHTML = `<pre class="md-mermaid__error">Mermaid 渲染失败：${
            e instanceof Error ? e.message : String(e)
          }</pre>`
        }
      })
    return () => {
      active = false
    }
  }, [code])
  return <div className="md-mermaid" ref={ref} />
}

// 自定义组件：拦截 ```mermaid 围栏（其 <code> 带 language-mermaid 类），改为渲染 MermaidBlock；
// 其余代码块交给默认 <pre><code>（rehype-highlight 已加 hljs 类）。
const mdComponentsBase = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pre(props: any) {
    const child = props.children as { props?: { className?: string; children?: unknown } } | undefined
    const cn = child?.props?.className
    if (cn && /language-mermaid/.test(cn)) {
      return <MermaidBlock code={extractText(child?.props?.children).trim()} />
    }
    return <pre>{props.children as React.ReactNode}</pre>
  },
} as Record<string, React.FC<Record<string, unknown>>>

/** markdown 内 <img>：本地相对 / file:// 路径经 resolveImageUrl 解析为可渲染 URL，避免 net::ERR_FILE_NOT_FOUND。 */
function MdImage({
  src,
  alt,
  resolveImageUrl,
}: {
  src?: string
  alt?: string
  resolveImageUrl?: (s: string) => Promise<string | null>
}) {
  const [resolved, setResolved] = useState<string | undefined>(src)
  useEffect(() => {
    let active = true
    if (!src) {
      setResolved(undefined)
      return
    }
    // 已是网络 / 内联资源，直接使用
    if (/^(https?:|data:|blob:)/i.test(src) || !resolveImageUrl) {
      setResolved(src)
      return
    }
    // 本地相对 / file:// 路径：交给调用方解析
    resolveImageUrl(src)
      .then((u) => {
        if (active) setResolved(u ?? src)
      })
      .catch(() => {
        if (active) setResolved(src)
      })
    return () => {
      active = false
    }
  }, [src, resolveImageUrl])
  if (!resolved) return null
  return <img src={resolved} alt={alt} />
}

export function MarkdownRenderer({ content, className, resolveImageUrl }: MarkdownRendererProps) {
  // 组件表随 resolveImageUrl 变化重建（img 拦截依赖它）
  const mdComponents = useMemo(() => {
    return {
      ...mdComponentsBase,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      img: (props: any) => (
        <MdImage
          src={typeof props.src === 'string' ? props.src : undefined}
          alt={typeof props.alt === 'string' ? props.alt : undefined}
          resolveImageUrl={resolveImageUrl}
        />
      ),
    } as Record<string, React.FC<Record<string, unknown>>>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveImageUrl])

  return (
    <div className={`md-body ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        // 放宽 KaTeX 严格模式：模型输出常在 $...$ 数学块里夹带中文 / en-dash 等「非严格 LaTeX」字符，
        // 默认 strict:'warn' 会刷大量 console.warn；strict:false 让其按文本静默回退渲染、不再告警。
        // throwOnError:false 保证即便有真语法错也只渲染成红色，而不会让整段 Markdown 渲染抛错崩掉。
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, katexOptions: { strict: false } }],
          rehypeHighlight,
        ]}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        components={mdComponents as any}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
