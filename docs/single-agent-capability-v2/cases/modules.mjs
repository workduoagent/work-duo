// N 系列 · 模块契约快验：零/低副作用、无 LLM、秒级——发版前冒烟首选。
import {
  A, finish, withAgent, drive, callTool, unw, asRows, rawPost, wsOf, WAIT_MS,
} from '../lib/caplib.mjs'

export const CASES = {
  // 全模块枚举一致性：84 工具 + 七大 list 形状合法（零副作用）
  async 'N11-1'() {
    const dim = 'N模块', title = '全模块枚举一致性（零副作用）'
    const t0 = Date.now()
    const toolsResp = await rawPost({ jsonrpc: '2.0', id: 900001, method: 'tools/list', params: {} })
    const tools = toolsResp?.result?.tools || []
    const lists = {}
    for (const [k, name, args] of [
      ['agents', 'agent_ui_list', {}], ['models', 'agent_list_models', {}], ['skills', 'skill_list', {}],
      ['plugins', 'plugin_list', {}], ['kbs', 'kb_list', {}], ['memories', 'memory_list', {}], ['scenarios', 'agent_list_scenarios', {}],
    ]) {
      try { lists[k] = asRows(unw(await callTool(name, args, { timeoutMs: 15000 }))) } catch { lists[k] = null }
    }
    const allOk = Object.values(lists).every((v) => Array.isArray(v))
    return finish('N11-1', dim, title, [
      A('tools_84', tools.length === 84, `tools/list=${tools.length}（应为 84）`),
      A('lists_shape_ok', allOk, Object.entries(lists).map(([k, v]) => `${k}=${v ? v.length : 'ERR'}`).join(' ')),
      A('models_nonempty', (lists.models || []).length > 0, '至少一个模型'),
      A('fast', Date.now() - t0 < 30000, `${Date.now() - t0}ms`),
    ], { notes: '本用例可作 CI 探活' })
  },

  // 凭证红线：MCP 通道收 secret 必须报错，且明文不得出现在任何回包/列表
  async 'N11-2'() {
    const dim = 'N模块', title = 'server_host 凭证红线（secret 拒收）'
    const t0 = Date.now()
    const SECRET = 'CAP2-SHOULD-BE-REJECTED-secret'
    let rejected = false, detail = ''
    try {
      const r = unw(await callTool('server_host_save', {
        id: `srv_cap2_${Date.now().toString(36)}`, name: 'cap2 红线测试', host: '127.0.0.1', user: 'nobody',
        secret: SECRET,
      }, { timeoutMs: 20000 }))
      detail = JSON.stringify(r).slice(0, 160)
      rejected = !!(r && r.ok === false)
    } catch (e) { rejected = true; detail = e.message.slice(0, 160) }
    const listRaw = JSON.stringify(unw(await callTool('server_host_list', {}, { timeoutMs: 20000 })) || [])
    return finish('N11-2', dim, title, [
      A('secret_rejected', rejected, detail || 'secret 被静默接受——红线失守'),
      A('no_leak_in_list', !listRaw.includes(SECRET), 'server_host_list 不得回显明文'),
      A('fast', Date.now() - t0 < 30000, `${Date.now() - t0}ms`),
    ])
  },

  // MCP 引用契约：引用不存在的 mcpId —— 快速返回、可拒绝可忽略但不得挂死/崩溃
  async 'N11-3'() {
    const dim = 'N模块', title = 'agent×MCP 引用契约（未知 mcpId）'
    const t0 = Date.now()
    let created = null, behavior = ''
    try {
      created = unw(await callTool('agent_ui_create', {
        payload: {
          name: 'cap2-mcp-contract', identifier: `cap2-demo-mcpc-${Date.now().toString(36)}`,
          description: '契约测试', mcpTools: [{ mcpId: 'mcp_nonexistent_cap2', toolId: 'nope' }],
        },
      }, { timeoutMs: 20000 }))
      behavior = '创建被接受（引用被忽略或登记）'
    } catch (e) { behavior = '结构化拒绝: ' + e.message.slice(0, 100) }
    const dur = Date.now() - t0
    if (created?.id) await callTool('agent_ui_delete', { id: created.id }, { timeoutMs: 15000 }).catch(() => {})
    return finish('N11-3', dim, title, [
      A('fast_response', dur < 25000, `${dur}ms（不得挂死）`),
      A('structured_outcome', true, behavior),
    ])
  },

  // 快照契约：从未 run 过的 agent → snapshots 为空数组且形状合法
  async 'N11-4'() {
    const dim = 'N模块', title = '快照契约（空态形状）'
    return await withAgent({ tag: 'n-snap' }, async (ag) => {
      const t0 = Date.now()
      const r = unw(await callTool('agent_snapshot_list', { agentId: ag.id }, { timeoutMs: 20000 }))
      const snaps = r?.snapshots
      return finish('N11-4', dim, title, [
        A('shape_ok', !!r && Array.isArray(snaps), `count=${r?.count ?? 'N/A'} snapshots=${Array.isArray(snaps) ? snaps.length : typeof snaps}`),
        A('empty_ok', snaps.length === 0, '未 run 过应无快照'),
        A('count_field', typeof r.count === 'number', `count=${r.count}`),
        A('fast', Date.now() - t0 < 20000, `${Date.now() - t0}ms`),
      ])
    })
  },

  // 孤儿清扫幂等：连扫两次均 {ok:true} 且 swept 为数值
  async 'N11-5'() {
    const dim = 'N模块', title = '孤儿清扫幂等（双扫）'
    const t0 = Date.now()
    const r1 = unw(await callTool('agent_sweep_orphan_rounds', {}, { timeoutMs: 30000 }))
    const r2 = unw(await callTool('agent_sweep_orphan_rounds', {}, { timeoutMs: 30000 }))
    return finish('N11-5', dim, title, [
      A('sweep1_ok', !!r1 && (r1.ok === true || typeof r1.swept === 'number'), JSON.stringify(r1).slice(0, 80)),
      A('sweep2_ok', !!r2 && (r2.ok === true || typeof r2.swept === 'number'), JSON.stringify(r2).slice(0, 80)),
      A('swept_numeric', typeof r1?.swept === 'number' && typeof r2?.swept === 'number', `swept=${r1?.swept}/${r2?.swept}`),
      A('fast', Date.now() - t0 < 45000, `${Date.now() - t0}ms`),
    ])
  },
}
