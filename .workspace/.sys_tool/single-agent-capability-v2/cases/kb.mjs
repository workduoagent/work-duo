// B 系列 · 知识库 RAG：事实问答、多库归属、标签辅助、文档溯源、知识更新即生效。
import {
  A, finish, withAgent, drive, callTool, unw, asRows, waitFor, extractKbEvents, hitsOf,
  KB_PREFIX, WAIT_MS,
} from '../lib/caplib.mjs'

/** 建 KB（cap2-test-kb- 前缀）→ 导入文件 → 等全部索引完成。files: [{relPath, content}] */
async function makeKb(caseId, files) {
  const identifier = `${KB_PREFIX}${caseId.toLowerCase()}-${Date.now().toString(36)}`
  const kb = unw(await callTool('kb_create', { identifier, name: `v2-${caseId}`, description: 'capability v2 测试库' }, { timeoutMs: 20000 }))
  const kbId = kb.id
  for (const f of files) {
    unw(await callTool('kb_add_file', { kbId, relPath: f.relPath, content: f.content }, { timeoutMs: 30000 }))
  }
  await waitFor(`${caseId} 索引完成`, async () => {
    const assets = asRows(unw(await callTool('kb_list_assets', { kbId }, { timeoutMs: 15000 })))
    return assets.length >= files.length && assets.every((a) => a.indexedAt || a.indexed_at)
  }, { maxMs: 180000, intervalMs: 3000 })
  return { kbId, identifier }
}
async function dropKb(kbId) {
  try { await callTool('kb_delete', { id: kbId }, { timeoutMs: 20000 }) } catch (e) { console.log('  [warn] kb_delete', e.message.slice(0, 80)) }
}

export const CASES = {
  // 单库三连问：数值必须全部命中 + 检索事件真实发生
  async 'B6-1'() {
    const dim = 'B知识库', title = '单库事实问答（三连问全命中）'
    const kb = await makeKb('B6-1', [
      { relPath: 'docs/考勤制度.md', content: '# 考勤制度\n公司上班打卡时间为每天 9:30，下班 18:30。\n迟到超过 3 次取消当月全勤奖。' },
      { relPath: 'docs/休假制度.md', content: '# 休假制度\n正式员工年假为 15 天，司龄每满一年加一天，上限 20 天。' },
      { relPath: 'docs/报销制度.md', content: '# 报销制度\n日常办公报销单笔上限为 800 元，超过需部门总监审批。' },
    ])
    try {
      return await withAgent({ tag: 'b-fact', kbIds: [kb.kbId] }, async (ag) => {
        const t0 = Date.now()
        const r = await drive(ag, '请根据知识库回答三个问题：①年假有几天？②上班打卡时间是几点？③日常报销单笔上限是多少元？逐条简答。', {})
        const kbHits = extractKbEvents(r.trace).reduce((s, e) => s + hitsOf(e.parsed), 0)
        return finish('B6-1', dim, title, [
          A('status_done', r.status === 'done', r.status),
          A('annual_15', /15\s*天|15天/.test(r.reply), r.reply.slice(0, 100)),
          A('clock_930', /9[::：]30|九点半|九点三十/.test(r.reply), ''),
          A('reimburse_800', /800/.test(r.reply), ''),
          A('kb_search_fired', extractKbEvents(r.trace).length >= 1 || kbHits >= 1, `kb_search 事件 ${extractKbEvents(r.trace).length} 次`),
        ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
      })
    } finally { await dropKb(kb.kbId) }
  },

  // 多库归属：同字段不同值，必须答对库
  async 'B6-2'() {
    const dim = 'B知识库', title = '多库归属（产品 A/B 规格不混淆）'
    const kbA = await makeKb('B6-2a', [{ relPath: '产品A.md', content: '# 产品 A 规格\n电池容量 4000mAh，屏幕 6.1 英寸，重量 168g。' }])
    const kbB = await makeKb('B6-2b', [{ relPath: '产品B.md', content: '# 产品 B 规格\n电池容量 5500mAh，屏幕 6.7 英寸，重量 201g。' }])
    try {
      return await withAgent({ tag: 'b-multi', kbIds: [kbA.kbId, kbB.kbId] }, async (ag) => {
        const t0 = Date.now()
        const r = await drive(ag, '产品 B 的电池容量是多少？只回答容量。', {})
        return finish('B6-2', dim, title, [
          A('status_done', r.status === 'done', r.status),
          A('answers_5500', /5500/.test(r.reply), r.reply.slice(0, 80)),
          A('not_confused_with_A', !/4000/.test(r.reply), '不应把产品 A 的 4000mAh 混入'),
        ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
      })
    } finally { await dropKb(kbA.kbId); await dropKb(kbB.kbId) }
  },

  // 标签辅助：runner 先做标签 CRUD 往返，再验证打标文档可被检索命中
  async 'B6-3'() {
    const dim = 'B知识库', title = '标签辅助检索（标签 CRUD + 命中）'
    const kb = await makeKb('B6-3', [
      { relPath: 'finance-travel.md', content: '# 差旅制度\n国内差旅住宿报销上限为每晚 600 元，需提供增值税发票。' },
      { relPath: 'team-building.md', content: '# 团建制度\n每季度一次团建，人均预算 300 元。' },
    ])
    try {
      const assets = asRows(unw(await callTool('kb_list_assets', { kbId: kb.kbId }, { timeoutMs: 15000 })))
      const fin = assets.find((a) => (a.relPath || a.path || a.name || '').includes('finance-travel'))
      let tagRoundtrip = false
      if (fin?.id) {
        unw(await callTool('kb_add_tag', { kbId: kb.kbId, assetId: fin.id, tag: '财务' }, { timeoutMs: 15000 }))
        const tags = unw(await callTool('kb_get_tags', { kbId: kb.kbId, assetId: fin.id }, { timeoutMs: 15000 }))
        tagRoundtrip = JSON.stringify(tags).includes('财务')
      }
      return await withAgent({ tag: 'b-tag', kbIds: [kb.kbId] }, async (ag) => {
        const t0 = Date.now()
        const r = await drive(ag, '出差住酒店一晚最多能报销多少钱？', {})
        return finish('B6-3', dim, title, [
          A('tag_roundtrip', tagRoundtrip, 'kb_add_tag→kb_get_tags 往返应含「财务」'),
          A('status_done', r.status === 'done', r.status),
          A('answer_600', /600/.test(r.reply), r.reply.slice(0, 80)),
        ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
      })
    } finally { await dropKb(kb.kbId) }
  },

  // 文档溯源：答案 + 来源文件名
  async 'B6-4'() {
    const dim = 'B知识库', title = '答案溯源（引用来源文件名）'
    const kb = await makeKb('B6-4', [
      { relPath: '研发管理制度.md', content: '# 研发管理制度\n代码冻结期为版本发布前 3 天，冻结期内仅允许修复 P0 缺陷。' },
      { relPath: '采购制度.md', content: '# 采购制度\n单笔采购超过 5000 元需进行三方比价。' },
    ])
    try {
      return await withAgent({ tag: 'b-cite', kbIds: [kb.kbId] }, async (ag) => {
        const t0 = Date.now()
        const r = await drive(ag, '代码冻结期是几天？请同时标注该答案的来源文件名。', {})
        return finish('B6-4', dim, title, [
          A('status_done', r.status === 'done', r.status),
          A('answer_3days', /3\s*天|3天|三天/.test(r.reply), r.reply.slice(0, 100)),
          A('cites_source', /研发管理制度/.test(r.reply), '回复应引用来源文件名'),
        ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
      })
    } finally { await dropKb(kb.kbId) }
  },

  // 知识更新即生效：先「不知道」→ 补文件 → 再问即会
  async 'B6-5'() {
    const dim = 'B知识库', title = '知识更新即生效（增量索引闭环）'
    const kb = await makeKb('B6-5', [{ relPath: '产品说明.md', content: '# 产品说明\nX 产品是一款双频路由器，支持 Mesh 组网。' }])
    try {
      return await withAgent({ tag: 'b-update', kbIds: [kb.kbId] }, async (ag) => {
        const t0 = Date.now()
        const r1 = await drive(ag, '什么是极光模式？', {})
        unw(await callTool('kb_add_file', {
          kbId: kb.kbId, relPath: 'docs/aurora.md',
          content: '# 极光模式\n极光模式是 X 产品的夜间省电模式：电量低于 20% 时自动触发，关闭指示灯并降频。',
        }, { timeoutMs: 30000 }))
        await waitFor('aurora.md 索引完成', async () => {
          const assets = asRows(unw(await callTool('kb_list_assets', { kbId: kb.kbId }, { timeoutMs: 15000 })))
          return assets.some((a) => JSON.stringify(a).includes('aurora') && (a.indexedAt || a.indexed_at))
        }, { maxMs: 120000 })
        const r2 = await drive(ag, '现在告诉我：什么是极光模式？', { sess: r1.sess })
        return finish('B6-5', dim, title, [
          A('status_done', r1.status === 'done' && r2.status === 'done', `${r1.status}/${r2.status}`),
          A('before_honest', /没有|未|找不到|不包含|不清楚|暂无/.test(r1.reply), r1.reply.slice(0, 80)),
          A('after_knows', /极光模式是/.test(r2.reply) && /20%|省电/.test(r2.reply), r2.reply.slice(0, 100)),
        ], { durationMs: Date.now() - t0, runId: r2.runId, counts: r2.tokens })
      })
    } finally { await dropKb(kb.kbId) }
  },
}
