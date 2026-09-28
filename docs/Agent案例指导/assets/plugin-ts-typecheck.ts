/**
 * name: ts-typecheck
 * description: 在工程内执行 typecheck（tsc/vue-tsc/自定义 npm script），解析 error TS 列表。
 * dependencies: []
 * parameters:
 *   type: object
 *   properties:
 *     workspace:
 *       type: string
 *       description: 前端工程根目录（含 package.json）
 *     script:
 *       type: string
 *       description: package.json script 名，默认 typecheck；无则回退 npx tsc -p tsconfig.json --noEmit
 *     timeoutSec:
 *       type: integer
 *       description: 超时秒，默认 120
 *   required:
 *     - workspace
 */
async function runNpmScript(workspace: string, script: string, timeoutSec: number) {
  const isWin = process.platform === 'win32'
  const cmd = isWin
    ? ['cmd', '/c', 'npm', 'run', script]
    : ['npm', 'run', script]
  const proc = Bun.spawnSync({
    cmd,
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

export async function run(params: Record<string, unknown>): Promise<unknown> {
  const workspace = (params.workspace as string) || ''
  if (!workspace) throw new Error('workspace is required')
  const script = (params.script as string) || 'typecheck'
  const timeoutSec = Number(params.timeoutSec || 120)

  const pkgPath = `${workspace}/package.json`
  const pkgFile = Bun.file(pkgPath)
  let hasScript = false
  if (await pkgFile.exists()) {
    const pkg = await pkgFile.json()
    hasScript = Boolean(pkg.scripts && pkg.scripts[script])
  }

  let out: { exitCode: number; stdout: string; stderr: string }
  if (hasScript) {
    out = await runNpmScript(workspace, script, timeoutSec)
  } else {
    const proc = Bun.spawnSync({
      cmd: ['npx', '--no-install', 'tsc', '-p', 'tsconfig.json', '--noEmit'],
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    out = {
      exitCode: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    }
  }

  const text = out.stdout + '\n' + out.stderr
  const errors: Array<{ file: string; message: string }> = []
  // TS2304: file(1,2): message  /  error TS2304: ...
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
  }
}
