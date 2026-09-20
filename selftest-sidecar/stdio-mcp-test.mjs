// 模拟最新 MCP 客户端完整握手，验证 server.mjs 健壮性
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const child = spawn(process.execPath, ['server.mjs'], { cwd: dir })

let outBuf = Buffer.alloc(0)
const frames = []
function tryParse() {
  while (true) {
    const h = outBuf.indexOf('\r\n\r\n')
    if (h === -1) break
    const m = outBuf.slice(0, h).toString().match(/Content-Length:\s*(\d+)/i)
    if (!m) { outBuf = outBuf.slice(h + 4); continue }
    const len = parseInt(m[1], 10)
    const start = h + 4
    if (outBuf.length < start + len) break
    const body = outBuf.slice(start, start + len).toString('utf8')
    outBuf = outBuf.slice(start + len)
    try { frames.push(JSON.parse(body)) } catch {}
  }
}
child.stdout.on('data', (c) => { outBuf = Buffer.concat([outBuf, c]); tryParse() })
child.stderr.on('data', (c) => process.stderr.write('[sidecar-stderr] ' + c))

function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8')
  child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`)
  child.stdin.write(payload)
}

const tests = [
  { pv: '2025-06-18' },
  { pv: '2024-11-05' },
]
let ti = 0
function runOne() {
  if (ti >= tests.length) { finish(); return }
  const t = tests[ti++]
  const idBase = ti * 10
  send({ jsonrpc: '2.0', id: idBase + 1, method: 'initialize', params: { protocolVersion: t.pv, capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'test', version: '9' } } })
  setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/initialized' }), 150)
  setTimeout(() => send({ jsonrpc: '2.0', id: idBase + 2, method: 'tools/list', params: {} }), 300)
  setTimeout(() => send({ jsonrpc: '2.0', id: idBase + 3, method: 'tools/call', params: { name: 'agent.ui_list', arguments: {} } }), 450)
  setTimeout(() => {
    for (const f of frames) {
      if (f.id === idBase + 1) console.error(`PV=${t.pv} INIT_OK protoEchoed=${f.result?.protocolVersion} toolsCap=${JSON.stringify(f.result?.capabilities?.tools)}`)
      if (f.id === idBase + 2) console.error(`PV=${t.pv} TOOLS_COUNT=${f.result?.tools?.length}`)
      if (f.id === idBase + 3) console.error(`PV=${t.pv} CALL_ROUTED=${f.result ? 'yes' : 'no'} isError=${f.result?.isError} text=${(f.result?.content?.[0]?.text || '').slice(0, 60)}`)
    }
    runOne()
  }, 750)
}

function finish() {
  console.error('ALL_DONE')
  child.kill()
  process.exit(0)
}
runOne()
setTimeout(() => { console.error('TIMEOUT'); child.kill(); process.exit(1) }, 6000)
