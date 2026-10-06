/**
 * 知识库 Markdown 渲染器（富渲染分支）——对话气泡的多模态输出面。
 *
 * 插件栈（对齐用户推荐表）：
 *  - remark-gfm         表格 / 删除线 / 任务列表等 GFM 语法
 *  - remark-math        识别 $...$ 与 $$...$$ 数学公式块
 *  - rehype-katex       将公式渲染为 KaTeX HTML（需引入 katex CSS）
 *  - rehype-highlight   代码块语法高亮（需引入 highlight.js 主题 CSS）
 *  - mermaid             ```mermaid 围栏代码块渲染为流程图 / 时序图（SVG）
 *  - echarts             ```echarts / ```echarts-json 围栏渲染为 ECharts 图表（option JSON）
 *
 * mermaid / echarts 由 rich-blocks.tsx 提供（动态 import 按需分包 + 流式防抖 + 主题跟随）。
 * 样式：katex.min.css 与 highlight.js 主题在组件内引入；.md-mermaid / .md-echarts 样式在 root.scss。
 */
import { memo, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { EChartsBlock, MermaidBlock } from './rich-blocks'
import 'katex/dist/katex.min.css'
// 注意：不在此引入 highlight.js 的预置主题 CSS（如 styles/github.css）。
// 那些主题把 .hljs 背景硬编码为浅色、token 颜色按白底调校，暗色下会整块刷白、语法色崩坏。
// 语法高亮配色改由 src/styles/root.scss 的 .md-body .hljs* 规则提供，跟随 .light/.dark 令牌切换。

export interface MarkdownRendererProps {
  content: string
  className?: string
  /**
   * 本地图片解析器：当 markdown 内 <img> 的 src 为相对路径或 file:// 绝对路径（非 http(s)/data/blob）
   * 时调用，返回可渲染的 blob/data URL；返回 null 则回退为原始 src。
   * 由调用方（如知识库查看器）按知识库实际文件解析。
   */
  resolveImageUrl?: (src: string) => Promise<string | null>
  /**
   * 追加的 remark 插件（可选，K3-2 内联引标等域内扩展）。
   * 传 undefined 时行为与原渲染器完全一致；不改变基础插件栈（gfm/math）。
   */
  remarkPluginsExt?: unknown[]
  /**
   * 追加的 react-markdown components 覆盖（可选，如自定义 `kb-cite` 元素渲染）。
   * 与内置 pre/img 覆盖合并，调用方同名字段优先生效。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  componentsExt?: Record<string, React.FC<any>>
}

// mermaid / echarts 渲染组件见 rich-blocks.tsx（防抖 + 动态分包 + 主题跟随）。

/** 递归抽取 React 节点中的纯文本（用于提取围栏代码块源码）。 */
function extractText(node: unknown): string {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    return extractText((node as { props: { children?: unknown } }).props.children)
  }
  return ''
}

/**
 * 把模型常见的 LaTeX 定界符归一化为 remark-math 认识的美元定界：
 * `\[...\]` → `$$...$$`（显示公式）、`\(...\)` → `$...$`（行内公式）。
 * 只处理普通文本段——fenced code / 行内 code span 内的 `\[`（如数组转义示意）不误伤。
 * 流式安全：未闭合 fence 原样保留（按 fence 段跳过），闭合后自然参与转换。
 */
export function normalizeMathDelimiters(src: string): string {
  const parts: string[] = []
  const re = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g
  let last = 0
  for (const m of src.matchAll(re)) {
    parts.push(plain(src.slice(last, m.index)), m[0])
    last = m.index + m[0].length
  }
  parts.push(plain(src.slice(last)))
  return parts.join('')

  function plain(s: string): string {
    // 先显示后行内：\[\] 整块先吃掉；块内的 \(\)/\[\] 剥壳为纯内容（已处于数学态，留壳会污染 KaTeX）
    return s
      .replace(/\\\[([\s\S]*?)\\\]/g, (_m, p1: string) => `$$${p1.replace(/\\([()[\]])/g, '$1')}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_m, p1: string) => `$${p1}$`)
  }
}

/** 廉价预筛 + 结构确认：该 JSON 块是否为 ECharts option（模型常把图表写成 ```json）。 */
export function looksLikeEchartsOption(code: string): boolean {
  if (!/"series"/.test(code)) return false
  try {
    const parsed: unknown = JSON.parse(code)
    const o = parsed as Record<string, unknown>
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false
    if (!('series' in o)) return false
    // series 存在即基本确认；再校验任一常见坐标系/组件键，进一步压低误判
    return ['xAxis', 'yAxis', 'radar', 'geo', 'polar', 'calendar', 'dataset', 'parallel', 'legend', 'tooltip'].some(
      (k) => k in o,
    )
  } catch {
    return false
  }
}

// 自定义组件：拦截富渲染围栏（其 <code> 带 language-xxx 类）：
//   ```mermaid → MermaidBlock；```echarts / ```echarts-json → EChartsBlock；
//   ```json（长得像 ECharts option）→ EChartsBlock（模型不按 echarts 语言出牌的兜底）；
// 其余代码块交给默认 <pre><code>（rehype-highlight 已加 hljs 类）。
const mdComponentsBase = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pre(props: any) {
    const child = props.children as { props?: { className?: string; children?: unknown } } | undefined
    const cn = child?.props?.className
    const lang = /language-([\w-]+)/.exec(cn ?? '')?.[1] ?? ''
    const code = extractText(child?.props?.children).trim()
    if (lang === 'mermaid') return <MermaidBlock code={code} />
    if (lang === 'echarts' || lang === 'echarts-json') return <EChartsBlock code={code} />
    if ((lang === 'json' || lang === 'json5') && looksLikeEchartsOption(code)) {
      return <EChartsBlock code={code} />
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

function MarkdownRendererInner({
  content,
  className,
  resolveImageUrl,
  remarkPluginsExt,
  componentsExt,
}: MarkdownRendererProps) {
  // 组件表随 resolveImageUrl / componentsExt 变化重建（img 拦截依赖前者，域内引标依赖后者）
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
      ...(componentsExt ?? {}),
    } as Record<string, React.FC<Record<string, unknown>>>
     
  }, [resolveImageUrl, componentsExt])

  const remarkPlugins = useMemo(
    () => [...(remarkPluginsExt ?? [])] as never[],
    [remarkPluginsExt],
  )

  return (
    <div className={`md-body ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, ...remarkPlugins]}
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
        {normalizeMathDelimiters(content)}
      </ReactMarkdown>
    </div>
  )
}

/**
 * 记忆化导出：父级无关重渲染（切 Tab / 计时 / 输入框打字等）时，content 未变即跳过整条
 * remark/rehype 解析管线（katex + highlight + mermaid），避免重复解析造成的交互卡顿。
 */
export const MarkdownRenderer = memo(MarkdownRendererInner)
