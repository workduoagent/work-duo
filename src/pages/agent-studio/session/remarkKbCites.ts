/**
 * K3-2 内联引用引标 remark 插件（会话域专用，不影响其它 MarkdownRenderer 消费方）。
 *
 * 识别正文文本节点中的 `[N]`（N = 本任务 kb_search 命中的引用编号），替换为自定义
 * `kbCite` 节点（经 data.hName 映射为 hast 元素 `<kb-cite cite="N">`），由 react-markdown
 * components 表注册 `kb-cite` 渲染为可悬浮溯源的引标。
 *
 * 安全边界：仅处理 `text` 类型节点——代码块（code/inlineCode）、链接 URL 不会命中；
 * 编号不在本任务命中集合内的 `[N]` 保留原文（模型幻觉编号不渲染为引标）。
 */
import type { KbHit } from './KbSearchCitations'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  [key: string]: unknown
}

/** 把一段文本按有效引标拆分为 [text, kbCite, text, ...] 序列。无命中时原样返回。 */
function splitText(value: string, cites: Set<number>): MdNode[] {
  const out: MdNode[] = []
  const re = /\[(\d{1,3})\]/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    const n = Number(m[1])
    if (!cites.has(n)) continue
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({
      type: 'kbCite',
      cite: n,
      data: { hName: 'kb-cite', hProperties: { cite: n } },
    })
    last = m.index + m[0].length
  }
  if (out.length === 0) return [{ type: 'text', value }]
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

/** 递归变换：text 叶子按引标拆分，其余节点原样保留并递归 children。 */
function transform(node: MdNode, cites: Set<number>): MdNode {
  if (!node.children || !Array.isArray(node.children)) return node
  const kids: MdNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      kids.push(...splitText(child.value, cites))
    } else {
      kids.push(transform(child, cites))
    }
  }
  return { ...node, children: kids }
}

/** 插件工厂：传入本任务的有效引用编号集合（来自去重后的命中列表）。 */
export function makeRemarkKbCites(hits: KbHit[] | undefined) {
  const cites = new Set<number>(
    (hits ?? []).map((h) => h.cite).filter((n): n is number => typeof n === 'number'),
  )
  return function remarkKbCites() {
    return (tree: MdNode) => transform(tree, cites)
  }
}
