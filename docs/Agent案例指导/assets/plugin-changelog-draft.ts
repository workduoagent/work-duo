/**
 * name: changelog-draft
 * description: 从任务要点/提交说明拼变更日志草稿（Keep a Changelog 风格）。
 * dependencies: []
 * parameters:
 *   type: object
 *   properties:
 *     version:
 *       type: string
 *       description: 版本号，如 1.2.0
 *     date:
 *       type: string
 *       description: 日期 YYYY-MM-DD，默认今天
 *     items:
 *       type: array
 *       description: 变更条目，每项可为字符串或 {type, text}
 *     repoPath:
 *       type: string
 *       description: 可选 git 仓库，用最近 N 条 commit message 作素材
 *     commitLimit:
 *       type: integer
 *       description: 读取 commit 条数，默认 20
 *   required:
 *     - version
 */
type Item = { type: string; text: string }

function classify(text: string): string {
  const t = text.toLowerCase()
  if (/fix|bug|缺陷|修复/.test(t)) return 'Fixed'
  if (/feat|feature|新增|添加/.test(t)) return 'Added'
  if (/break|破坏|不兼容/.test(t)) return 'Changed'
  if (/refactor|重构|优化/.test(t)) return 'Changed'
  if (/doc|文档/.test(t)) return 'Documented'
  return 'Changed'
}

export async function run(params: Record<string, unknown>): Promise<unknown> {
  const version = String(params.version || '')
  if (!version) throw new Error('version is required')
  const date =
    (params.date as string) ||
    new Date().toISOString().slice(0, 10)

  const items: Item[] = []
  const rawItems = (params.items as unknown[]) || []
  for (const it of rawItems) {
    if (typeof it === 'string') items.push({ type: classify(it), text: it })
    else if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>
      const text = String(o.text || o.summary || '')
      if (text) items.push({ type: String(o.type || classify(text)), text })
    }
  }

  if (params.repoPath) {
    const limit = Number(params.commitLimit || 20)
    const proc = Bun.spawnSync({
      cmd: ['git', 'log', `-${limit}`, '--pretty=format:%s'],
      cwd: params.repoPath as string,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const log = new TextDecoder().decode(proc.stdout)
    for (const line of log.split('\n')) {
      const s = line.trim()
      if (!s) continue
      if (items.some((i) => i.text === s)) continue
      items.push({ type: classify(s), text: s })
    }
  }

  const groups: Record<string, string[]> = {}
  for (const i of items) {
    const g = i.type || 'Changed'
    ;(groups[g] ||= []).push(i.text)
  }
  const order = ['Added', 'Changed', 'Fixed', 'Documented', 'Removed']
  const parts: string[] = [`## [${version}] - ${date}`, '']
  for (const key of order) {
    if (!groups[key]?.length) continue
    parts.push(`### ${key}`, '')
    for (const t of groups[key]) parts.push(`- ${t}`)
    parts.push('')
  }
  for (const [key, list] of Object.entries(groups)) {
    if (order.includes(key)) continue
    parts.push(`### ${key}`, '')
    for (const t of list) parts.push(`- ${t}`)
    parts.push('')
  }

  return {
    ok: true,
    version,
    date,
    itemCount: items.length,
    changelog: parts.join('\n'),
    groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
  }
}
