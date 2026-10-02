// WorkDuo 记忆宫殿集成驱动示例（Streamable HTTP MCP 直连 127.0.0.1:18755/mcp）。
// 纯 Node 标准库实现，无需任何依赖。用法：node memory_driver.mjs
//
// 覆盖：memory_anchor → memory_list → memory_heatmap → memory_recall →
// memory_update → memory_list_candidates → memory_delete（仅对临时记忆验证删除路径）。
// 主演示记忆用固定 key（UPSERT，重跑幂等）并保留供人工抽查；category 严格显式传 'other'。
// 不调用 memory_confirm_candidate / memory_reject_candidate，避免自动采纳未知蒸馏候选污染用户记忆。

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
          if (isNotification || res.statusCode === 202) return resolve(null)
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

// 从 list 结果里按 key 取第一条记忆的 id
function findIdByKey(list, key) {
  if (!Array.isArray(list)) return undefined
  const m = list.find((x) => x.key === key)
  return m?.id
}

async function main() {
  // 1) 握手
  await post({
    jsonrpc: '2.0',
    id: reqCounter++,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memory-driver', version: '1.0' },
    },
  })
  await post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { isNotification: true },
  )
  console.log('[handshake] session =', SESSION)

  // 2) 工具数核对 + 确认 9 个 memory_* 工具都在
  const tl = await post({
    jsonrpc: '2.0',
    id: reqCounter++,
    method: 'tools/list',
    params: {},
  })
  const tools = tl?.result?.tools || []
  console.log('[tools/list] count =', tools.length)
  const memTools = tools.filter((t) => t.name.startsWith('memory_')).map((t) => t.name)
  console.log('[memory tools]', memTools.join(', '))
  const expected = [
    'memory_list', 'memory_heatmap', 'memory_anchor', 'memory_update',
    'memory_delete', 'memory_recall', 'memory_list_candidates',
    'memory_confirm_candidate', 'memory_reject_candidate',
  ]
  const missing = expected.filter((n) => !memTools.includes(n))
  if (missing.length) throw new Error('缺失 memory 工具: ' + missing.join(', '))
  console.log('[check] 9 个 memory_* 工具齐全 ✅')

  const DEMO_KEY = 'demo_palace_mcp'
  const EPH_KEY = `demo_palace_ephemeral_${Date.now()}`

  // 3) memory_anchor（主演示，固定 key UPSERT；category 显式传 'other'）
  const anchored = await callTool('memory_anchor', {
    key: DEMO_KEY,
    content: 'WorkDuo 记忆宫殿 UI 级集成自测锚点：MCP 驱动的记忆沉淀链路验证。',
    category: 'other',
  })
  console.log('[memory_anchor] raw =', JSON.stringify(anchored))
  const demoId = anchored?.id || anchored?.data?.id
  console.log('[memory_anchor] id =', demoId, 'category =', anchored?.category)
  if (!demoId) throw new Error('memory_anchor 未返回 id')
  if (anchored?.category && anchored.category !== 'other') {
    console.warn('[warn] category 回写为', anchored.category, '（预期 other）')
  }

  // 4) memory_list（全局视图，按 key 找回）
  const list = await callTool('memory_list', {})
  console.log('[memory_list] 总数 =', Array.isArray(list) ? list.length : '?')
  const demoInList = Array.isArray(list) ? list.find((x) => x.key === DEMO_KEY) : null
  console.log('[memory_list] 命中演示记忆 category=', demoInList?.category, 'recallCount=', demoInList?.recallCount)

  // 5) memory_heatmap
  const heat = await callTool('memory_heatmap', {})
  console.log('[memory_heatmap]', JSON.stringify(heat)?.slice(0, 200))

  // 6) memory_recall（手动召回 +1）
  const recall = await callTool('memory_recall', { id: demoId })
  console.log('[memory_recall]', JSON.stringify(recall))

  // 7) memory_update（仅更新 content）
  const updated = await callTool('memory_update', {
    id: demoId,
    content: 'WorkDuo 记忆宫殿 UI 级集成自测锚点（已更新）：MCP 驱动的记忆沉淀链路验证 + 召回计数自增验证。',
  })
  console.log('[memory_update]', JSON.stringify(updated)?.slice(0, 200))

  // 8) memory_list_candidates（仅列出，不 confirm/reject 以免污染）
  const cands = await callTool('memory_list_candidates', {})
  console.log('[memory_list_candidates] 待蒸馏候选数 =', Array.isArray(cands) ? cands.length : '?')

  // 9) memory_delete 删除路径验证（仅对临时记忆，主演示保留供抽查）
  const eph = await callTool('memory_anchor', {
    key: EPH_KEY,
    content: '临时记忆，用于验证删除路径，随后即删。',
    category: 'other',
  })
  const ephId = eph?.id || eph?.data?.id
  console.log('[ephemeral anchor] id =', ephId)
  const del = await callTool('memory_delete', { id: ephId })
  console.log('[memory_delete]', JSON.stringify(del))
  // 验证确实删除
  const afterDel = await callTool('memory_list', {})
  const stillThere = Array.isArray(afterDel) ? afterDel.find((x) => x.id === ephId) : null
  console.log('[verify] 临时记忆删除后仍存在?', stillThere ? '是(异常!)' : '否 ✅')

  console.log('\n[done] 主演示记忆已留痕（key=' + DEMO_KEY + '，category=other），可到 WorkDuo 设置→记忆宫殿抽查；未调用 confirm/reject 以免污染。')
}

main().catch((e) => {
  console.error('DRIVER_ERROR:', e.message)
  process.exit(1)
})
