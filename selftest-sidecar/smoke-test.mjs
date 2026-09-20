/**
 * sidecar 冒烟测试（同进程，避免 child spawn 受沙箱限制）：
 *  - 启动 startSidecar({ port, stdio:false })，用 onStdout 以 Buffer 累积 MCP 帧；
 *  - 用 Node22 内置 WebSocket 当"前端桥"客户端，连上后回传桥接响应；
 *  - 验证服务端握手/帧往返 + MCP stdio 分帧闭环（含多字节 UTF-8 内容）。
 */
import { startSidecar, handleMcp } from './server.mjs'

const PORT = 18799
let accBuf = Buffer.alloc(0) // 累积 MCP 字节流（按字节而非字符切片，正确处理 UTF-8）
const pendingMcp = []
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms))

function feedMcp() {
  while (true) {
    const idx = accBuf.indexOf('\r\n\r\n')
    if (idx === -1) break
    const header = accBuf.slice(0, idx).toString('utf8')
    const m = header.match(/Content-Length:\s*(\d+)/i)
    if (!m) break
    const len = parseInt(m[1], 10)
    const start = idx + 4
    if (accBuf.length < start + len) break
    const body = accBuf.slice(start, start + len).toString('utf8')
    accBuf = accBuf.slice(start + len)
    pendingMcp.push(JSON.parse(body))
  }
}
function sendMcp(obj) {
  handleMcp(JSON.stringify(obj)).catch((e) => console.error('[test] handleMcp error', e))
}

const server = startSidecar({
  port: PORT,
  stdio: false,
  onStdout: (s) => {
    accBuf = Buffer.concat([accBuf, Buffer.from(s, 'utf8')])
    feedMcp()
  },
})

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
ws.onopen = () => {
  console.error('[test] WS 握手成功（标准客户端）')
  sendMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  WAIT(150).then(() =>
    sendMcp({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'agent.ui_list', arguments: {} },
    }),
  )
}
ws.onmessage = (ev) => {
  const req = JSON.parse(ev.data)
  console.error('[test] 收到桥接意图:', req.intent)
  const reply =
    req.intent === 'agent.ui_list'
      ? { id: req.id, ok: true, data: [{ id: 'a1', name: '测试智能体', identifier: 'test-agent' }] }
      : { id: req.id, ok: true, data: { echo: req.intent } }
  ws.send(JSON.stringify(reply))
}
ws.onerror = (e) => console.error('[test] WS 错误', e.message || e)

const timer = setInterval(() => {
  while (pendingMcp.length) {
    const resp = pendingMcp.shift()
    if (resp.id === 1) {
      console.error('[test] initialize OK, server=', resp.result.serverInfo.name)
    } else if (resp.id === 2) {
      const text = resp.result?.content?.[0]?.text
      console.error('[test] tools/call 响应:', text)
      const ok = resp.result && !resp.result.isError && /测试智能体/.test(text || '')
      console.log(ok ? 'SMOKE_OK' : 'SMOKE_FAIL')
      clearInterval(timer)
      ws.close()
      server.server.close()
      process.exit(ok ? 0 : 1)
    }
  }
}, 50)

setTimeout(() => {
  console.error('[test] 超时')
  console.log('SMOKE_TIMEOUT')
  process.exit(2)
}, 5000)
