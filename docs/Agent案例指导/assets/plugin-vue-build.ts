/**
 * name: vue-build
 * description: Vue3 工程构建自检：优先 vue-tsc/vite build（或 package script），解析错误摘要。
 * dependencies: []
 * parameters:
 *   type: object
 *   properties:
 *     workspace:
 *       type: string
 *       description: Vue 工程根目录
 *     action:
 *       type: string
 *       description: "typecheck | build，默认 typecheck"
 *       enum: [typecheck, build]
 *     script:
 *       type: string
 *       description: 覆盖 npm script 名
 *     timeoutSec:
 *       type: integer
 *       description: 超时秒，默认 180
 *   required:
 *     - workspace
 */
export async function run(params: Record<string, unknown>): Promise<unknown> {
  const workspace = (params.workspace as string) || ''
  if (!workspace) throw new Error('workspace is required')
  const action = (params.action as string) || 'typecheck'
  if (!['typecheck', 'build'].includes(action)) {
    throw new Error("action must be 'typecheck' or 'build'")
  }
  const timeoutSec = Number(params.timeoutSec || 180)

  const pkgFile = Bun.file(`${workspace}/package.json`)
  if (!(await pkgFile.exists())) {
    throw new Error('package.json not found')
  }
  const pkg = await pkgFile.json()
  const scripts: Record<string, string> = pkg.scripts || {}
  const preferred =
    (params.script as string) ||
    (action === 'build'
      ? ['build', 'build:prod'].find((s) => scripts[s]) || ''
      : ['typecheck', 'vue-tsc', 'type-check'].find((s) => scripts[s]) || '')

  let cmd: string[]
  let used: string
  if (preferred && scripts[preferred]) {
    used = `npm run ${preferred}`
    cmd =
      process.platform === 'win32'
        ? ['cmd', '/c', 'npm', 'run', preferred]
        : ['npm', 'run', preferred]
  } else if (action === 'build') {
    used = 'npx vite build'
    cmd = ['npx', '--no-install', 'vite', 'build']
  } else {
    used = 'npx vue-tsc --noEmit'
    cmd = ['npx', '--no-install', 'vue-tsc', '--noEmit']
  }

  const proc = Bun.spawnSync({
    cmd,
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new TextDecoder().decode(proc.stdout)
  const stderr = new TextDecoder().decode(proc.stderr)
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
    ok: proc.exitCode === 0 && errors.length === 0,
    exitCode: proc.exitCode,
    action,
    used,
    timeoutSec,
    errorCount: errors.length,
    errors: [...new Set(errors)].slice(0, 25),
    stdoutTail: stdout.slice(-3000),
    stderrTail: stderr.slice(-1500),
  }
}
