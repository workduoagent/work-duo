/**
 * name: md-toc
 * description: 生成或校验 Markdown 文件目录（TOC），按标题层级输出锚点列表。
 * dependencies: []
 * parameters:
 *   type: object
 *   properties:
 *     markdown:
 *       type: string
 *       description: Markdown 全文
 *     maxLevel:
 *       type: integer
 *       description: 收录到的标题级别，默认 3
 *     checkOnly:
 *       type: boolean
 *       description: 仅校验是否已有 TOC，不返回生成结果
 *   required:
 *     - markdown
 */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥\s-]/g, '')
    .replace(/\s+/g, '-')
}

export async function run(params: Record<string, unknown>): Promise<unknown> {
  const markdown = (params.markdown as string) || ''
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
