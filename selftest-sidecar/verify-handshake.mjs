// 模拟 WorkBuddy MCP 客户端：stdin→server，捕获 stdout 帧
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const proc = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
  stdio: ['pipe', 'pipe', 'inherit'],
})

let buf = Buffer.alloc(0)
const frames = []
proc.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= 2) {
    const h = buf.indexOf('\r\n\r\n')
    if (h === -1) break
    const m = buf.slice(0, h).toString().match(/Content-Length:\s*(\d+)/i)
    if (!m) { buf = buf.slice(h + 4); continue }
    const len = parseInt(m[1], 10)
    const start = h + 4
    if (buf.length < start + len) break
    const body = buf.slice(start, start + len).toString('utf8')
    buf = buf.slice(start + len)
    frames.push(JSON.parse(body))
  }
})

function send(obj) {
  const json = JSON.stringify(obj)
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
}
const sendAndWait = (obj, timeoutMs = 1500) => new Promise((res) => {
  const id = obj.id
  const timer = setInterval(() => {
    const f = frames.find((x) => x.id === id)
    if (f) { clearInterval(timer); res(f) }
  }, 10)
  const to = setTimeout(() => { clearInterval(timer); res(undefined) }, timeoutMs)
  send(obj)
  return to
})

const init = await sendAndWait({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1.0' } } })
const toolsList = await sendAndWait({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
// 重复 initialize（模拟 WorkBuddy 双握手）—— 预期被忽略，无响应
const dupInit = await sendAndWait({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18' } })

console.log('INIT_OK:', !!init?.result?.protocolVersion, 'protocolVersion=', init?.result?.protocolVersion)
const names = toolsList?.result?.tools?.map((t) => t.name) || []
console.log('TOOLS_COUNT:', names.length)
console.log('TOOL_NAMES:', JSON.stringify(names))
console.log('DUP_INIT_IGNORED:', dupInit === undefined ? 'NO_RESPONSE(ignored)' : JSON.stringify(dupInit).slice(0, 80))

// name → intent 映射校验
const toIntent = (n) => String(n).replace('_', ':')
console.log('INTENT_MAP:', JSON.stringify(names.map((n) => [n, toIntent(n)])))

proc.kill()
process.exit(0)
