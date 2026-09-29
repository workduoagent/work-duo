/**
 * @name changelog-draft
 * @description 从任务要点或 git commit 生成 Keep a Changelog 风格变更日志草稿
 * @dependencies
 * @parameters
 *   version:
 *     type: string
 *     description: 版本号，如 1.2.0
 *     required: true
 *   date:
 *     type: string
 *     description: 日期 YYYY-MM-DD，默认今天
 *     required: false
 *   items:
 *     type: array
 *     description: 变更条目，字符串或 {type,text}
 *     required: false
 *   repoPath:
 *     type: string
 *     description: 可选 git 仓库路径，用于读取最近提交
 *     required: false
 *   commitLimit:
 *     type: integer
 *     description: 读取 commit 条数，默认 20
 *     required: false
 */
import { spawnSync } from 'node:child_process'

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

export default async function run(params: {
  version?: string
  date?: string
  items?: Array<string | { type?: string; text?: string; summary?: string }>
  repoPath?: string
  commitLimit?: number
}) {
  const version = String(params.version || '')
  if (!version) throw new Error('version is required')
  const date = params.date || new Date().toISOString().slice(0, 10)

  const items: Item[] = []
  for (const it of params.items || []) {
    if (typeof it === 'string') items.push({ type: classify(it), text: it })
    else if (it && typeof it === 'object') {
      const text = String(it.text || it.summary || '')
      if (text) items.push({ type: String(it.type || classify(text)), text })
    }
  }

  if (params.repoPath) {
    const limit = Number(params.commitLimit || 20)
    const proc = spawnSync('git', ['log', `-${limit}`, '--pretty=format:%s'], {
      cwd: params.repoPath,
      encoding: 'utf-8',
      shell: false,
    })
    const log = proc.stdout || ''
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
