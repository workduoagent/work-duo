/**
 * @name vue-build
 * @description Vue3 工程 typecheck 或 build 自检并解析错误摘要
 * @dependencies
 * @parameters
 *   workspace:
 *     type: string
 *     description: Vue 工程根目录
 *     required: true
 *   action:
 *     type: string
 *     description: typecheck 或 build，默认 typecheck
 *     required: false
 *   script:
 *     type: string
 *     description: 覆盖 npm script 名
 *     required: false
 *   timeoutSec:
 *     type: integer
 *     description: 超时秒，默认 180
 *     required: false
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export default async function run(params: {
  workspace?: string
  action?: string
  script?: string
  timeoutSec?: number
}) {
  const workspace = params.workspace || ''
  if (!workspace) throw new Error('workspace is required')
  const action = params.action || 'typecheck'
  if (!['typecheck', 'build'].includes(action)) {
    throw new Error("action must be 'typecheck' or 'build'")
  }
  const timeoutSec = Number(params.timeoutSec || 180)

  const pkgPath = join(workspace, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error('package.json not found')
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const scripts: Record<string, string> = pkg.scripts || {}
  const preferred =
    params.script ||
    (action === 'build'
      ? ['build', 'build:prod'].find((s) => scripts[s]) || ''
      : ['typecheck', 'vue-tsc', 'type-check'].find((s) => scripts[s]) || '')

  let cmd: string
  let args: string[]
  let used: string
  if (preferred && scripts[preferred]) {
    used = `npm run ${preferred}`
    if (process.platform === 'win32') {
      cmd = 'cmd'
      args = ['/c', 'npm', 'run', preferred]
    } else {
      cmd = 'npm'
      args = ['run', preferred]
    }
  } else if (action === 'build') {
    used = 'npx vite build'
    cmd = 'npx'
    args = ['--no-install', 'vite', 'build']
  } else {
    used = 'npx vue-tsc --noEmit'
    cmd = 'npx'
    args = ['--no-install', 'vue-tsc', '--noEmit']
  }

  const proc = spawnSync(cmd, args, {
    cwd: workspace,
    encoding: 'utf-8',
    shell: false,
    timeout: timeoutSec * 1000,
  })
  const stdout = proc.stdout || ''
  const stderr = proc.stderr || ''
  const text = stdout + '\n' + stderr

  const errors: string[] = []
  const patterns = [
    /error TS\d+:\s*.+/g,
    /(?:ERROR|Error)\s+in\s+.+/g,
    /\[vite\].*error.*/gi,
    /Module\s+"?"?[^"\n]+"?"?\s+has no exported member.+/g,
  ]
  for (const re of patterns) {
    for (const m of text.match(re) || []) errors.push(m.trim())
  }

  return {
    ok: proc.status === 0 && errors.length === 0,
    exitCode: proc.status,
    action,
    used,
    timeoutSec,
    errorCount: errors.length,
    errors: [...new Set(errors)].slice(0, 25),
    stdoutTail: stdout.slice(-3000),
    stderrTail: stderr.slice(-1500),
  }
}
