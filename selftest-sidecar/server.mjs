/**
 * WorkDuo 自测闭环 · sidecar MCP Server（零外部依赖，仅用 Node 内置模块）。
 *
 * 职责：
 *  1. 作为 MCP Server 监听 stdio（JSON-RPC 2.0 + Content-Length 分帧），供 WorkBuddy MCP 连接器接入。
 *  2. 作为 WebSocket 服务端监听 localhost（默认 18755），供 WorkDuo 前端 mcpBridge 连接。
 *  3. 把 WorkBuddy 的 MCP 工具调用转成意图 { intent, payload } 推给前端桥，
 *     等前端经真实入口（invoke / mapper）执行完毕回传结果，再作为 MCP 响应返回。
 *
 * 启动： node server.mjs   （端口可用环境变量 MCP_BRIDGE_PORT 覆盖）
 * 日志一律走 stderr，stdout 仅输出 MCP 协议帧，避免污染连接器解析。
 */
import { createServer as createTcpServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'

const WS_PORT = Number(process.env.MCP_BRIDGE_PORT || 18755)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// 文件级诊断日志（不受 WorkBuddy 是否保留 stderr 影响），路径跟随本脚本位置
const LOG_PATH = fileURLToPath(new URL('./sidecar.log', import.meta.url))
function logF(...args) {
  const ts = new Date().toISOString()
  const line = args
    .map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)))
    .join(' ')
  try {
    appendFileSync(LOG_PATH, `[${ts}] ${line}\n`)
  } catch {}
}
logF('[boot] sidecar process started, pid=', process.pid, 'argv=', process.argv)

// ───────────────────────── 最小 WebSocket 服务端 ─────────────────────────
class WsServer {
  constructor(port) {
    this.port = port
    this.clients = new Set()
    this.onMessage = null // (socket, text) => void
    this.server = createTcpServer((socket) => this._handle(socket))
    this.server.on('error', (e) => console.error('[sidecar] WS server error', e))
    this.server.listen(port, () => {
      console.error(`[sidecar] WebSocket 服务端已监听 ws://127.0.0.1:${port}`)
    })
  }

  _handle(socket) {
    socket._buf = Buffer.alloc(0)
    socket._handshaked = false
    socket.on('data', (chunk) => {
      if (!socket._handshaked) {
        socket._buf = Buffer.concat([socket._buf, chunk])
        const idx = socket._buf.indexOf('\r\n\r\n')
        if (idx === -1) return
        const header = socket._buf.slice(0, idx).toString()
        const km = header.match(/Sec-WebSocket-Key:\s*(.+)\r/i)
        if (!km) {
          socket.destroy()
          return
        }
        const accept = createHash('sha1')
          .update(km[1].trim() + WS_GUID)
          .digest('base64')
        const resp =
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        socket.write(resp)
        socket._handshaked = true
        socket._buf = socket._buf.slice(idx + 4)
        this.clients.add(socket)
        console.error('[sidecar] 前端桥接已连接')
        this._parse(socket)
      } else {
        socket._buf = Buffer.concat([socket._buf, chunk])
        this._parse(socket)
      }
    })
    socket.on('close', () => {
      this.clients.delete(socket)
      console.error('[sidecar] 前端桥接断开')
    })
    socket.on('error', () => this.clients.delete(socket))
  }

  _parse(socket) {
    while (true) {
      const buf = socket._buf
      if (buf.length < 2) break
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < offset + 2) break
        len = buf.readUInt16BE(offset)
        offset += 2
      } else if (len === 127) {
        if (buf.length < offset + 8) break
        len = Number(buf.readBigUInt64BE(offset))
        offset += 8
      }
      let maskKey
      if (masked) {
        if (buf.length < offset + 4) break
        maskKey = buf.slice(offset, offset + 4)
        offset += 4
      }
      if (buf.length < offset + len) break
      let payload = buf.slice(offset, offset + len)
      if (masked) {
        const un = Buffer.alloc(len)
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3]
        payload = un
      }
      socket._buf = buf.slice(offset + len)
      if (opcode === 0x8) {
        socket.end()
        break
      } else if (opcode === 0x9) {
        this._send(socket, payload, 0xa) // ping → pong
      } else if (opcode === 0x1 || opcode === 0x0) {
        if (this.onMessage) this.onMessage(socket, payload.toString('utf8'))
      }
    }
  }

  _send(socket, data, opcode = 0x1) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len])
    } else if (len < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    socket.write(Buffer.concat([header, payload]))
  }

  sendToBridge(text) {
    for (const c of this.clients) {
      if (!c.destroyed && c.writable) {
        this._send(c, text)
        return true
      }
    }
    return false
  }

  get connected() {
    return this.clients.size > 0
  }
}

// ───────────────────────── 桥接调用（MCP ↔ 前端） ─────────────────────────
let ws = null // 由 startSidecar 创建
let mcpSink = (s) => process.stdout.write(s)
// 防止同一进程被客户端重复 initialize 导致响应流交错（WorkBuddy 实测同一进程发了两次 initialize）
let mcpSessionInitialized = false
const pending = new Map() // id → { resolve, reject, timer }

function attachBridge(server) {
  server.onMessage = (_socket, text) => {
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg && msg.id) {
      const p = pending.get(msg.id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(msg.id)
        if (msg.ok === false) p.reject(new Error(msg.error || 'bridge error'))
        else p.resolve(msg.data)
      }
    }
  }
}

/**
 * 启动 sidecar。直接运行（node server.mjs）默认开启 stdio(MCP) 监听；
 * 测试时可传 { stdio:false } 并在同进程内直接调用 handleMcp，避免 child spawn。
 * @param {object} [opts]
 * @param {number} [opts.port]
 * @param {boolean} [opts.stdio] 是否接管 process.stdin 作为 MCP 输入
 * @param {(s:string)=>void} [opts.onStdout] MCP 帧输出接收器（默认 stdout）
 */
export { handleMcp }
export function startSidecar({ port = WS_PORT, stdio = true, onStdout } = {}) {
  ws = new WsServer(port)
  attachBridge(ws)
  if (onStdout) mcpSink = onStdout
  if (stdio) {
    let stdioBuf = Buffer.alloc(0)
    process.stdin.on('data', (chunk) => {
      logF('[stdin] recv bytes=', chunk.length)
      stdioBuf = Buffer.concat([stdioBuf, chunk])
      while (true) {
        const headerEnd = stdioBuf.indexOf('\r\n\r\n')
        if (headerEnd === -1) break
        const header = stdioBuf.slice(0, headerEnd).toString()
        const m = header.match(/Content-Length:\s*(\d+)/i)
        if (!m) {
          stdioBuf = stdioBuf.slice(headerEnd + 4)
          continue
        }
        const len = parseInt(m[1], 10)
        const start = headerEnd + 4
        if (stdioBuf.length < start + len) break
        const body = stdioBuf.slice(start, start + len).toString('utf8')
        stdioBuf = stdioBuf.slice(start + len)
        handleMcp(body).catch((e) => console.error('[sidecar] mcp handle error', e))
      }
    })
  }
  console.error(`[sidecar] MCP Server 已就绪（stdio=${stdio}），等待 WorkBuddy 连接器接入…`)
  return ws
}

async function callBridge(intent, payload, timeoutMs = 180000) {
  if (!ws.connected) {
    throw new Error(
      '前端桥接未连接：请确认 WorkDuo 以 ?selftest=1 启动（main.tsx 已接入 connectMcpBridge）。',
    )
  }
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`桥接调用超时 (${timeoutMs}ms): ${intent}`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    const ok = ws.sendToBridge(JSON.stringify({ id, intent, payload }))
    if (!ok) {
      clearTimeout(timer)
      pending.delete(id)
      reject(new Error('发送桥接消息失败'))
    }
  })
}

// ───────────────────────── MCP 工具定义 ─────────────────────────
const TOOLS = [
  {
    name: 'agent_run_task',
    description: '启动一轮 Agent 任务并返回 run_id（复用 run_task_ex 命令，含全局互斥锁）。',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        prompt: { type: 'string' },
        workspace: { type: 'string' },
        session_id: { type: 'string' },
        round_id: { type: 'string' },
        attachments: { type: 'array' },
        plan_override: { type: 'object' },
      },
      required: ['agent_id', 'prompt'],
    },
  },
  {
    name: 'agent_get_status',
    description: '按 run_id 查询单次运行状态（running/done/error）。',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
  },
  {
    name: 'agent_wait_task',
    description: '轮询等待 run_id 进入终态（done/error），超时返回错误。',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' }, timeout_ms: { type: 'number' } },
      required: ['run_id'],
    },
  },
  {
    name: 'agent_get_run_logs',
    description: '增量读取 Rust 运行日志（workduo.log.YYYY-MM-DD），按游标/时间窗/等级过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'number' },
        since_ts: { type: 'string' },
        level: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'agent_ui_create',
    description: '创建 Agent（走真实 upsertAgent 入口 → mapper SQL → SQLite 入库）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        identifier: { type: 'string' },
        scenario: { type: 'string' },
        description: { type: 'string' },
        systemPrompt: { type: 'string' },
        llmId: { type: 'string' },
        mcpTools: { type: 'array' },
        skillIds: { type: 'array' },
        pluginIds: { type: 'array' },
        kbIds: { type: 'array' },
      },
      required: ['name', 'identifier'],
    },
  },
  {
    name: 'agent_ui_update',
    description: '更新 Agent（含 id，走真实 upsertAgent 入口）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        identifier: { type: 'string' },
        scenario: { type: 'string' },
        description: { type: 'string' },
        systemPrompt: { type: 'string' },
        llmId: { type: 'string' },
        mcpTools: { type: 'array' },
        skillIds: { type: 'array' },
        pluginIds: { type: 'array' },
        kbIds: { type: 'array' },
      },
      required: ['id'],
    },
  },
  {
    name: 'agent_ui_delete',
    description: '删除 Agent（走真实 deleteAgent 入口）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'agent_ui_get',
    description: '按 id 查询单个 Agent（走真实 getAgent 入口）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'agent_ui_list',
    description: '列出全部 Agent（走真实 listAgents 入口，返回精简字段）。',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ───────────────────────── MCP stdio（JSON-RPC 2.0） ─────────────────────────
function sendMcp(obj) {
  logF('[mcp] -> id=', obj.id, 'hasResult=', !!obj.result, 'hasError=', !!obj.error)
  const json = JSON.stringify(obj)
  const payload = Buffer.from(json, 'utf8')
  mcpSink(`Content-Length: ${payload.length}\r\n\r\n`)
  mcpSink(payload)
}

async function handleMcp(body) {
  let req
  try {
    req = JSON.parse(body)
  } catch {
    return
  }
  if (!req || typeof req.method !== 'string') return
  const { id, method, params } = req
  logF('[mcp] <- method=', method, 'id=', id, 'paramKeys=', params ? Object.keys(params) : undefined)

  if (method === 'initialize') {
    // 重复 initialize：MCP 单连接只允许一次，后续直接忽略，避免响应流交错（WorkBuddy 实测同进程发了两次）
    if (mcpSessionInitialized) {
      logF('[mcp] ignore duplicate initialize, session already established')
      return
    }
    mcpSessionInitialized = true
    // 回显客户端发来的协议版本（MCP 规范推荐），避免版本协商被严格客户端拒绝
    const clientVersion = params?.protocolVersion || '2024-11-05'
    sendMcp({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'workduo-self-test', version: '0.1.0' },
      },
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') {
    sendMcp({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    sendMcp({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {}
    try {
      const data = await callBridge(name, args || {})
      sendMcp({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data) }],
          isError: false,
        },
      })
    } catch (e) {
      sendMcp({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `ERROR: ${e.message}` }],
          isError: true,
        },
      })
    }
    return
  }
  if (id !== undefined) {
    sendMcp({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    })
  }
}

// 直接运行时自动启动（stdin 接管为 MCP 输入）
const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('server.mjs')
if (isMain) {
  startSidecar({ port: WS_PORT })
}
