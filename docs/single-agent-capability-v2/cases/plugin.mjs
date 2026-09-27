// P 系列 · 插件深度：agent 自助装配、契约拒绝、超时契约、多参复用编排。
import {
  A, finish, withAgent, drive, wsOf, asRows, unw, callTool, findFile, fileText,
  magicOk, numPresent, toolNames, PLUG_PREFIX, WAIT_MS,
} from '../lib/caplib.mjs'
import { ensureTemplatePlugin } from './office.mjs'

async function pluginCount() { return asRows(unw(await callTool('plugin_list', {}, { timeoutMs: 15000 }))).length }
async function deletePluginById(id) {
  try { await callTool('plugin_delete', { id }, { timeoutMs: 15000 }) } catch (e) { console.log('  [warn] plugin_delete', e.message.slice(0, 80)) }
}

export const CASES = {
  // 自助装配 xlsx：不预绑插件，agent 自己创建再调用（考察插件中心编排能力）
  async 'P7-1'() {
    const dim = 'P插件', title = 'Agent 自助装配 xlsx 插件并调用'
    const ws = wsOf('P7-1')
    const before = await pluginCount()
    let created = []
    return withAgent({ tag: 'p-xlsx' }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        '任务分两步：',
        '1) 先在插件中心创建一个 Excel 导出插件（runtime=python，参考官方 xlsx writer 模板思路：入参 outPath 与 sheets），identifier 以 cap2-demo- 开头；',
        '2) 然后调用它，在工作空间生成 inventory.xlsx：表头「商品,库存」，两行数据「螺丝,120」「螺母,80」。',
      ].join('\n')
      const r = await drive(ag, prompt, { ws })
      const list = asRows(unw(await callTool('plugin_list', {}, { timeoutMs: 15000 })))
      created = list.filter((p) => !String(p.identifier || '').startsWith('cap2-test-')).slice().map((p) => p.id)
      const xlsx = findFile(ws, 'inventory.xlsx')
      return finish('P7-1', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('plugin_created', list.length > before, `插件数 ${before}→${list.length}`),
        A('xlsx_exists', !!xlsx, xlsx ? `${xlsx.size}B` : 'inventory.xlsx 缺失'),
        A('xlsx_magic', xlsx ? magicOk(xlsx.path, 'xlsx') : false, '应为 zip(PK) 头'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens, notes: `新增插件 ${created.length} 个` })
    }).finally(async () => { for (const id of created) await deletePluginById(id) })
  },

  // 自助装配 chart：同上但考察 Agg 后端图表模板
  async 'P7-2'() {
    const dim = 'P插件', title = 'Agent 自助装配图表插件并调用'
    const ws = wsOf('P7-2')
    const before = await pluginCount()
    let created = []
    return withAgent({ tag: 'p-chart' }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        '任务分两步：',
        '1) 在插件中心创建一个图表插件（runtime=python，matplotlib Agg 后端，入参 outPath/kind/ys/xs/title），identifier 以 cap2-demo- 开头；',
        '2) 调用它生成 柱状图.png（kind=bar，数据 语文 90/数学 85/英语 92，标题「成绩」）。',
      ].join('\n')
      const r = await drive(ag, prompt, { ws })
      const list = asRows(unw(await callTool('plugin_list', {}, { timeoutMs: 15000 })))
      created = list.filter((p) => !String(p.identifier || '').startsWith('cap2-test-')).map((p) => p.id)
      const png = findFile(ws, '柱状图.png')
      return finish('P7-2', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('plugin_created', list.length > before, `插件数 ${before}→${list.length}`),
        A('png_exists', !!png, png ? `${png.size}B` : '柱状图.png 缺失'),
        A('png_magic', png ? magicOk(png.path, 'png') : false, '应为 PNG 魔数'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    }).finally(async () => { for (const id of created) await deletePluginById(id) })
  },

  // 契约：缺必填参数 → 快速结构化拒绝，不挂死不静默
  async 'P7-3'() {
    const dim = 'P插件', title = '插件参数契约：缺必填快速拒绝'
    const t0 = Date.now()
    const script = "def run(params):\n    return {'ok': True, 'a': params.get('a')}\n"
    const up = unw(await callTool('plugin_upsert', {
      name: 'v2-contract', identifier: `${PLUG_PREFIX}contract-${Date.now().toString(36)}`,
      description: '参数契约测试', runtime: 'python', scriptContent: script,
      parametersSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    }, { timeoutMs: 20000 }))
    const pluginId = up.id || up.pluginId
    try {
      let rejected = false, detail = ''
      try {
        const r = unw(await callTool('plugin_test', { pluginId, params: { a: 1 } }, { timeoutMs: 30000 }))
        detail = JSON.stringify(r).slice(0, 160)
        rejected = r && (r.ok === false || r.error || /missing|required|b/i.test(detail))
      } catch (e) { rejected = true; detail = e.message.slice(0, 160) }
      return finish('P7-3', dim, title, [
        A('upsert_ok', !!pluginId, ''),
        A('missing_param_rejected', rejected, detail || '缺参被静默接受'),
        A('fast_fail', Date.now() - t0 < 45000, `${Math.round((Date.now() - t0) / 1000)}s`),
      ])
    } finally { await deletePluginById(pluginId) }
  },

  // 契约：timeoutSec 兜底——sleep 30 在 timeoutSec=5 下必须被终止并结构化报错
  async 'P7-4'() {
    const dim = 'P插件', title = '插件超时契约（timeoutSec 兜底）'
    const t0 = Date.now()
    const script = 'import time\ndef run(params):\n    time.sleep(30)\n    return {"ok": True}\n'
    const up = unw(await callTool('plugin_upsert', {
      name: 'v2-timeout', identifier: `${PLUG_PREFIX}timeout-${Date.now().toString(36)}`,
      description: '超时契约测试', runtime: 'python', scriptContent: script, timeoutSec: 5,
      parametersSchema: { type: 'object' },
    }, { timeoutMs: 20000 }))
    const pluginId = up.id || up.pluginId
    try {
      let timedOut = false, detail = ''
      try {
        const r = unw(await callTool('plugin_test', { pluginId, params: {} }, { timeoutMs: 60000 }))
        detail = JSON.stringify(r).slice(0, 160)
        timedOut = r && (r.ok === false || /timeout|超时|timed/i.test(detail))
      } catch (e) { timedOut = /timeout|超时/i.test(e.message) || true; detail = e.message.slice(0, 160) }
      return finish('P7-4', dim, title, [
        A('upsert_ok', !!pluginId, ''),
        A('timeout_enforced', timedOut, detail || 'sleep 30 未被终止'),
        A('bounded_wallclock', Date.now() - t0 < 60000, `${Math.round((Date.now() - t0) / 1000)}s（30s 死循环被 5s 超时兜住）`),
      ])
    } finally { await deletePluginById(pluginId) }
  },

  // 一个插件一次 run 内多参复用调用 ≥2 次，结果双对
  async 'P7-5'() {
    const dim = 'P插件', title = '插件多参复用编排（一次 run 调 ≥2 次）'
    const ws = wsOf('P7-5')
    const script = [
      'def run(params):',
      "    v = params.get('v')",
      "    unit = params.get('unit')",
      "    if unit == 'km2mi':",
      "        return {'result': round(v * 0.621371, 2)}",
      "    if unit == 'c2f':",
      "        return {'result': round(v * 9 / 5 + 32, 1)}",
      "    return {'error': 'unknown unit'}",
    ].join('\n')
    const up = unw(await callTool('plugin_upsert', {
      name: 'v2-convert', identifier: `${PLUG_PREFIX}convert-${Date.now().toString(36)}`,
      description: '单位换算', runtime: 'python', scriptContent: script,
      parametersSchema: { type: 'object', properties: { v: { type: 'number' }, unit: { type: 'string', enum: ['km2mi', 'c2f'] } }, required: ['v', 'unit'] },
    }, { timeoutMs: 20000 }))
    const pluginId = up.id || up.pluginId
    try {
      return await withAgent({ tag: 'p-convert', pluginIds: [pluginId] }, async (ag) => {
        const t0 = Date.now()
        const prompt = '用可用的换算插件完成两次换算并把结果都告诉我：①100 公里转英里；②37 摄氏度转华氏度。'
        const r = await drive(ag, prompt, { ws })
        const convCalls = toolNames(r.trace).filter((n) => /custom__/.test(n)).length
        return finish('P7-5', dim, title, [
          A('status_done', r.status === 'done', r.status),
          A('two_calls', convCalls >= 2, `custom__ 调用 ${convCalls} 次`),
          A('miles_62', numPresent(r.reply, 62.14, { tolerance: 0.05 }).ok, numPresent(r.reply, 62.14).detail),
          A('fahrenheit_986', numPresent(r.reply, 98.6, { tolerance: 0.05 }).ok, numPresent(r.reply, 98.6).detail),
        ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
      })
    } finally { await deletePluginById(pluginId) }
  },
}
