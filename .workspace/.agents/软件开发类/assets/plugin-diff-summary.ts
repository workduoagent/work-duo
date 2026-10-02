/**
 * @name diff-summary
 * @description 扫描 git diff 或传入 diff 文本，输出变更文件摘要与风险提示
 * @dependencies
 * @parameters
 *   workspace:
 *     type: string
 *     description: git 工程根目录（使用 git diff 时填写）
 *     required: false
 *   diffText:
 *     type: string
 *     description: 直接传入 unified diff 文本（与 workspace 二选一）
 *     required: false
 *   staged:
 *     type: boolean
 *     description: 是否只看 staged 变更
 *     required: false
 */
import { spawnSync } from 'node:child_process'

export default async function run(params: {
  workspace?: string
  diffText?: string
  staged?: boolean
}) {
  const workspace = params.workspace || ''
  const staged = Boolean(params.staged)
  let diffText = params.diffText || ''

  if (!diffText && workspace) {
    const args = staged ? ['diff', '--cached'] : ['diff', 'HEAD']
    const proc = spawnSync('git', args, {
      cwd: workspace,
      encoding: 'utf-8',
      shell: false,
    })
    diffText = (proc.stdout || '') + (proc.stderr || '')
    if (proc.status !== 0 && !diffText.includes('diff --git')) {
      return {
        ok: false,
        errorType: 'git_failed',
        exitCode: proc.status,
        stderr: (proc.stderr || '').slice(0, 500),
      }
    }
  }

  if (!diffText) {
    return { ok: false, errorType: 'no_diff' }
  }

  const files: Array<{
    path: string
    added: number
    deleted: number
    binary?: boolean
    deletedFile?: boolean
    newFile?: boolean
  }> = []
  let cur: (typeof files)[number] | null = null

  for (const line of diffText.split('\n')) {
    const head = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (head) {
      cur = { path: head[2], added: 0, deleted: 0 }
      files.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('Binary files') || line.includes('GIT binary patch')) cur.binary = true
    if (line.startsWith('deleted file mode')) cur.deletedFile = true
    if (line.startsWith('new file mode')) cur.newFile = true
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+') && !line.startsWith('+++')) cur.added++
    if (line.startsWith('-') && !line.startsWith('---')) cur.deleted++
  }

  const risks: string[] = []
  for (const f of files) {
    if (f.deletedFile) risks.push(`删除文件: ${f.path}`)
    if (f.binary) risks.push(`二进制变更: ${f.path}`)
    if (f.added + f.deleted > 400) risks.push(`大改动 (${f.added + f.deleted} 行): ${f.path}`)
    if (/(migrations?|init\.sql|updater\.sql|\.env)/i.test(f.path)) {
      risks.push(`敏感路径: ${f.path}`)
    }
  }

  return {
    ok: true,
    fileCount: files.length,
    totalAdded: files.reduce((s, f) => s + f.added, 0),
    totalDeleted: files.reduce((s, f) => s + f.deleted, 0),
    files: files.slice(0, 50),
    risks: risks.slice(0, 20),
  }
}
