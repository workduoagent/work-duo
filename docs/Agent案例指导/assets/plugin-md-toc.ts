/**
 * @name md-toc
 * @description 生成或校验 Markdown 标题目录（TOC）
 * @dependencies
 * @parameters
 *   markdown:
 *     type: string
 *     description: Markdown 全文
 *     required: true
 *   maxLevel:
 *     type: integer
 *     description: 收录标题级别，默认 3
 *     required: false
 *   checkOnly:
 *     type: boolean
 *     description: 仅校验是否已有 TOC
 *     required: false
 */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥\s-]/g, '')
    .replace(/\s+/g, '-')
}

export default async function run(params: {
  markdown?: string
  maxLevel?: number
  checkOnly?: boolean
}) {
  const markdown = params.markdown || ''
  if (!markdown) throw new Error('markdown is required')
  const maxLevel = Number(params.maxLevel || 3)
  const checkOnly = Boolean(params.checkOnly)

  const lines = markdown.split(/\r?\n/)
  const headings: Array<{ level: number; text: string; slug: string }> = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = line.match(/^(#{1,6})\s+(.+)$/)
    if (!m) continue
    const level = m[1].length
    if (level > maxLevel) continue
    const text = m[2].replace(/[#*`]/g, '').trim()
    headings.push({ level, text, slug: slugify(text) })
  }

  const existingToc = /(^|\n)(<!--\s*toc\s*-->|##\s*目录)/i.test(markdown)
  if (checkOnly) {
    return { ok: true, hasToc: existingToc, headingCount: headings.length }
  }

  const toc = headings
    .map((h) => `${'  '.repeat(h.level - 1)}- [${h.text}](#${h.slug})`)
    .join('\n')

  return {
    ok: true,
    headingCount: headings.length,
    hasToc: existingToc,
    toc,
    headings,
  }
}
