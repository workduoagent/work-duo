// WorkDuo 知识库集成驱动示例（Streamable HTTP MCP 直连 127.0.0.1:18755/mcp）。
// 纯 Node 标准库实现，无需任何依赖。用法：node kb_driver.mjs
//
// 覆盖：kb_create → kb_add_file → kb_rebuild_index（轮询 indexedAt）→ kb_list_assets 核对 →
// agent_get_run_logs 抓取后端日志（含前端经 log_frontend 投递的 [fe] 行，需新构建）。
// 示例知识库以 demo_ 前缀命名，留痕不删，便于人工抽查。

import http from 'node:http'

const PORT = 18755
const HOST = '127.0.0.1'
const BASE = { host: HOST, port: PORT, path: '/mcp' }

let SESSION = null
let reqCounter = 1

function post(body, { isNotification = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(payload),
    }
    if (SESSION) headers['Mcp-Session-Id'] = SESSION
    const req = http.request(
      { ...BASE, method: 'POST', headers },
      (res) => {
        if (!SESSION && res.headers['mcp-session-id']) {
          SESSION = res.headers['mcp-session-id']
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          // 通知类（202）无响应体
          if (isNotification || res.statusCode === 202) return resolve(null)
          // SSE：抽取 data: 行
          const dataLines = raw
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6).trim())
          const last = dataLines[dataLines.length - 1]
          try {
            resolve(last ? JSON.parse(last) : null)
          } catch (e) {
            reject(new Error('解析响应失败: ' + raw.slice(0, 200)))
          }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function callTool(name, args) {
  const resp = await post({
    jsonrpc: '2.0',
    id: reqCounter++,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  if (!resp || resp.error) throw new Error(`${name} 失败: ${JSON.stringify(resp)}`)
  const content = resp.result?.content?.[0]?.text
  let result = content ? JSON.parse(content) : resp.result
  // UI 级工具经 dispatch_ui 统一回包 {ok,data}，这里自动拆 data。
  if (result && typeof result === 'object' && 'ok' in result && 'data' in result) {
    result = result.data
  }
  return result
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 1) 握手
  await post({
    jsonrpc: '2.0',
    id: reqCounter++,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kb-driver', version: '1.0' },
    },
  })
  await post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { isNotification: true },
  )
  console.log('[handshake] session =', SESSION)

  // 2) 工具数核对
  const tl = await post({
    jsonrpc: '2.0',
    id: reqCounter++,
    method: 'tools/list',
    params: {},
  })
  console.log('[tools/list] count =', tl?.result?.tools?.length)

  const stamp = Date.now()
  const identifier = `demo_kb_${stamp}`
  const name = `Demo KB ${stamp}`

  // 3) 创建知识库
  const created = await callTool('kb_create', {
    identifier,
    name,
    description: '知识库集成示例，可抽查后删除',
  })
  const kbId = created?.id
  console.log('[kb_create] id =', kbId, 'identifier =', identifier)
  if (!kbId) throw new Error('kb_create 未返回 id')

  // 4) 新增文件（触发增量索引）
  const addRes = await callTool('kb_add_file', {
    kbId,
    relPath: 'docs/readme.md',
    content:
      '# 知识库集成示例\n\n这是一段用于验证前端日志透传与后端索引链路的示例文本。\n',
  })
  console.log('[kb_add_file]', JSON.stringify(addRes))

  // 5) 全量重建索引（异步）
  const rbRes = await callTool('kb_rebuild_index', { kbId })
  console.log('[kb_rebuild_index]', JSON.stringify(rbRes))

  // 6) 轮询 indexedAt 直到非空或超时
  let assets = null
  for (let i = 0; i < 20; i++) {
    await sleep(1500)
    assets = await callTool('kb_list_assets', { kbId })
    const allIndexed = Array.isArray(assets)
      ? assets.every((a) => a.indexedAt)
      : false
    console.log(
      `[poll ${i}] assets=${Array.isArray(assets) ? assets.length : '?'} allIndexed=${allIndexed}`,
    )
    if (allIndexed) break
  }
  if (Array.isArray(assets)) {
    for (const a of assets) {
      console.log(
        `  - asset ${a.id} path=${a.file_path} size=${a.file_size} indexedAt=${a.indexedAt ?? 'NULL'}`,
      )
    }
  }

  // 7) 抓取后端日志（前端 [fe] 行需新构建才会出现）
  const logs = await callTool('agent_get_run_logs', { limit: 60 })
  const lines = logs?.lines || []
  console.log('\n===== 后端日志（最近 60 行，含 [fe] 前端透传行）=====')
  for (const l of lines) console.log(l)
  const feLines = lines.filter((l) => l.includes('][fe]['))
  console.log(`\n[summary] 命中前端透传日志 [fe] 行数 = ${feLines.length}`)

  console.log('\n[done] 示例知识库已留痕（identifier=' + identifier + '），可到 WorkDuo 知识库页抽查，无需删除。')
}

main().catch((e) => {
  console.error('DRIVER_ERROR:', e.message)
  process.exit(1)
})
