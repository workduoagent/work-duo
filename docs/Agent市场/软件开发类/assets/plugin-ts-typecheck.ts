/**
 * @name ts-typecheck
 * @description 执行项目 typecheck（npm script 或 tsc）并解析 TS 错误列表
 * @dependencies
 * @parameters
 *   workspace:
 *     type: string
 *     description: 前端工程根目录（含 package.json）
 *     required: true
 *   script:
 *     type: string
 *     description: package.json script 名，默认 typecheck
 *     required: false
 *   timeoutSec:
 *     type: integer
 *     description: 超时秒，默认 120
 *     required: false
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export default async function run(params: {
  workspace?: string
  script?: string
  timeoutSec?: number
}) {
  const workspace = params.workspace || ''
  if (!workspace) throw new Error('workspace is required')
  const script = params.script || 'typecheck'
  const timeoutSec = Number(params.timeoutSec || 120)

  let hasScript = false
  const pkgPath = join(workspace, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      hasScript = Boolean(pkg.scripts && pkg.scripts[script])
    } catch {
      hasScript = false
    }
  }

  let out: { exitCode: number | null; stdout: string; stderr: string }
  if (hasScript) {
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'cmd' : 'npm'
    const args = isWin ? ['/c', 'npm', 'run', script] : ['run', script]
    const proc = spawnSync(cmd, args, {
      cwd: workspace,
      encoding: 'utf-8',
      shell: false,
      timeout: timeoutSec * 1000,
    })
    out = {
      exitCode: proc.status,
      stdout: proc.stdout || '',
      stderr: proc.stderr || '',
    }
  } else {
    const proc = spawnSync(
      'npx',
      ['--no-install', 'tsc', '-p', 'tsconfig.json', '--noEmit'],
      {
        cwd: workspace,
        encoding: 'utf-8',
        shell: false,
        timeout: timeoutSec * 1000,
      }
    )
    out = {
      exitCode: proc.status,
      stdout: proc.stdout || '',
      stderr: proc.stderr || '',
    }
  }

  const text = out.stdout + '\n' + out.stderr
  const errors: Array<{ file: string; message: string }> = []
  const re = /((?:[A-Za-z]:)?[^\s(]+)\((\d+),(\d+)\):\s*(?:error\s+)?(TS\d+):\s*(.+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    errors.push({ file: `${m[1]}:${m[2]}:${m[3]}`, message: `${m[4]}: ${m[5]}` })
  }
  const plain = text.match(/error TS\d+:\s*.+/g) || []
  for (const p of plain.slice(0, 30)) {
    if (!errors.some((e) => e.message.includes(p.slice(0, 40)))) {
      errors.push({ file: '', message: p })
    }
  }

  return {
    ok: out.exitCode === 0 && errors.length === 0,
    exitCode: out.exitCode,
    usedScript: hasScript ? script : 'tsc --noEmit',
    errorCount: errors.length,
    errors: errors.slice(0, 30),
    stdoutTail: out.stdout.slice(-3000),
    stderrTail: out.stderr.slice(-1000),
    timeoutSec,
  }
}
