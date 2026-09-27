import { spawnSync } from 'node:child_process'
const dir = process.argv[2], cmd = process.argv[3], rest = process.argv.slice(4)
process.chdir(dir)
console.log('[runner] cwd =', process.cwd(), '| args =', [cmd, ...rest].join(' '))
const r = spawnSync('node', [cmd, ...rest], { stdio: 'inherit' })
process.exit(r.status ?? 1)
