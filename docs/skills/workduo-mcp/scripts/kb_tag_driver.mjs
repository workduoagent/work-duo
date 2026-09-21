// WorkDuo 知识库标签管理驱动示例（Streamable HTTP MCP 直连 127.0.0.1:18755/mcp）。
// 纯 Node 标准库实现，无需任何依赖。用法：node kb_tag_driver.mjs
//
// 覆盖：kb_create → kb_add_file → kb_add_tag（增，幂等）→ kb_list_assets 核对 metaData.tags
// → kb_rename_tag（改）→ kb_remove_tag（删）→ kb_get_tags（查，与 list 对照）→ 最终核对。
// 标签留痕不删，便于人工抽查。

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
  if (result && typeof result === 'object' && 'ok' in result && 'data' in result) {
    result = result.data
  }
  return result
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 取某资产的当前标签（从 kb_list_assets 的 metaData.tags 解析）
async function assetTags(kbId, assetId) {
  const assets = await callTool('kb_list_assets', { kbId })
  const a = (Array.isArray(assets) ? assets : []).find((x) => x.id === assetId)
  if (!a) return undefined
  try {
    const m = a.metaData ? JSON.parse(a.metaData) : {}
    return Array.isArray(m.tags) ? m.tags : []
  } catch {
    return []
  }
}

async function main() {
  await post({
    jsonrpc: '2.0',
    id: reqCounter++,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kb-tag-driver', version: '1.0' },
    },
  })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { isNotification: true })
  console.log('[handshake] session =', SESSION)

  const tl = await post({ jsonrpc: '2.0', id: reqCounter++, method: 'tools/list', params: {} })
  const tools = tl?.result?.tools || []
  const tagTools = ['kb_add_tag', 'kb_remove_tag', 'kb_rename_tag', 'kb_get_tags'].filter((n) =>
    tools.some((t) => t.name === n),
  )
  console.log('[tools/list] count =', tools.length, '| tag 工具在线:', tagTools.join(', ') || '缺失!')
  if (tagTools.length < 4) throw new Error('标签工具未全部在线，请确认已 npm run tauri 重建')

  const stamp = Date.now()
  const identifier = `demo_kbtag_${stamp}`
  const name = `Demo KBTAG ${stamp}`

  const created = await callTool('kb_create', { identifier, name, description: '标签管理示例' })
  const kbId = created?.id
  console.log('[kb_create] id =', kbId)
  if (!kbId) throw new Error('kb_create 未返回 id')

  const addRes = await callTool('kb_add_file', {
    kbId,
    relPath: 'docs/tag-demo.md',
    content: '# 标签示例\n\n用于验证资产级标签增改删链路。\n',
  })
  console.log('[kb_add_file]', JSON.stringify(addRes))

  const assets = await callTool('kb_list_assets', { kbId })
  const assetId = Array.isArray(assets) ? assets[0]?.id : undefined
  console.log('[kb_list_assets] 资产 id =', assetId)
  if (!assetId) throw new Error('未取到资产 id')

  // 1) 增（首次）
  const t1 = await callTool('kb_add_tag', { kbId, assetId, tag: '设计' })
  console.log('[kb_add_tag 1]', JSON.stringify(t1))
  console.log('  实际标签 =', JSON.stringify(await assetTags(kbId, assetId)))

  // 2) 增（重复，应幂等 existed=true）
  const t2 = await callTool('kb_add_tag', { kbId, assetId, tag: '设计' })
  console.log('[kb_add_tag 2 重复]', JSON.stringify(t2), '→ existed 应为 true')

  // 3) 增（第二个）
  await callTool('kb_add_tag', { kbId, assetId, tag: '架构' })
  console.log('  增第二个后标签 =', JSON.stringify(await assetTags(kbId, assetId)))

  // 4) 改（设计 → 设计方案）
  const r1 = await callTool('kb_rename_tag', { kbId, assetId, from: '设计', to: '设计方案' })
  console.log('[kb_rename_tag]', JSON.stringify(r1))
  console.log('  改名后标签 =', JSON.stringify(await assetTags(kbId, assetId)))

  // 5) 删（架构）
  const d1 = await callTool('kb_remove_tag', { kbId, assetId, tag: '架构' })
  console.log('[kb_remove_tag]', JSON.stringify(d1))
  const finalTags = await assetTags(kbId, assetId)
  console.log('  最终标签 =', JSON.stringify(finalTags))
  if (!finalTags.includes('设计方案') || finalTags.includes('架构')) {
    throw new Error('标签增改删结果不符合预期: ' + JSON.stringify(finalTags))
  }

  // 6) 按文件取标签（新增工具 kb_get_tags，Agent 检索某文件主题用）
  const g1 = await callTool('kb_get_tags', { kbId, assetId })
  console.log('[kb_get_tags]', JSON.stringify(g1))
  const viaList = await assetTags(kbId, assetId)
  console.log('  对照 kb_list_assets.metaData.tags =', JSON.stringify(viaList))
  if (!Array.isArray(g1?.tags) || JSON.stringify(g1.tags) !== JSON.stringify(viaList)) {
    throw new Error('kb_get_tags 与 kb_list_assets 标签不一致: ' + JSON.stringify(g1))
  }

  console.log('\n[done] 标签管理链路验证通过 ✅（增/改/删/查全绿）；演示知识库 identifier=' + identifier + ' 已留痕（含标签「设计方案」），可到 WorkDuo 知识库详情页抽查。')
}

main().catch((e) => {
  console.error('DRIVER_ERROR:', e.message)
  process.exit(1)
})
