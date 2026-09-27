// E 系列 · 整体编排旗舰：单个 Agent 在真实工作场景中串联 知识库/沙箱/插件/产物/记忆/回滚 全能力。
// 这是 v2 的差异化重点：v1 测「单点能力」，E 系列测「能力编排」。
import fs from 'node:fs'
import path from 'node:path'
import {
  A, finish, withAgent, drive, wsOf, callTool, unw, asRows, waitFor, fileText, findFile,
  magicOk, numPresent, toolNames, eventTypes, extractKbEvents, readSkillScript, stageSeed,
  WAIT_MS,
} from '../lib/caplib.mjs'
import { ensureTemplatePlugin } from './office.mjs'

const XLSX_TEMPLATE = 'plugin.xlsx_writer.template.py'
const CHART_TEMPLATE = 'plugin.chart_png.template.py'

async function makeKbLight(caseId, files) {
  const identifier = `cap2-test-kb-${caseId.toLowerCase()}-${Date.now().toString(36)}`
  const kb = unw(await callTool('kb_create', { identifier, name: `v2-${caseId}`, description: 'v2 编排背景库' }, { timeoutMs: 20000 }))
  for (const f of files) unw(await callTool('kb_add_file', { kbId: kb.id, relPath: f.relPath, content: f.content }, { timeoutMs: 30000 }))
  await waitFor(`${caseId} 索引`, async () => {
    const assets = asRows(unw(await callTool('kb_list_assets', { kbId: kb.id }, { timeoutMs: 15000 })))
    return assets.length >= files.length && assets.every((a) => a.indexedAt || a.indexed_at)
  }, { maxMs: 180000 }).catch(() => null)
  return kb.id
}
async function dropKb(kbId) { try { await callTool('kb_delete', { id: kbId }, { timeoutMs: 20000 }) } catch {} }

export const CASES = {
  // 🏆 旗舰：月度经营简报——KB 目标 → 沙箱算数 → xlsx → PNG → md 结论 → 记忆沉淀，一 run 串联
  async 'E9-1'() {
    const dim = 'E编排', title = '🏆 月度经营简报全链（KB+沙箱+xlsx+PNG+md+记忆）'
    const ws = wsOf('E9-1')
    const rows = [
      ['month', 'product', 'amount'],
      ['2026-08', '硬件', '300000'], ['2026-08', '软件', '260000'], ['2026-08', '服务', '190000'],
      ['2026-09', '硬件', '412000'], ['2026-09', '软件', '268000'], ['2026-09', '服务', '154000'],
    ]
    fs.writeFileSync(path.join(ws, 'sales-2026.csv'), rows.map((r) => r.join(',')).join('\n'), 'utf8')
    const total08 = 750000, total09 = 834000 // 环比 +11.2% ≥ Q3 目标 10% → 达标
    const kbId = await makeKbLight('E9-1', [
      { relPath: 'q3-goal.md', content: '# Q3 经营目标\n公司第三季度目标：月度营收环比增长率不低于 10%；若达标，简报结论必须写明「目标达成」并给出环比百分数。' },
    ])
    const xlsxPlugin = await ensureTemplatePlugin('python', XLSX_TEMPLATE, 'cap2-test-pl-xlsx', 'v2 多 sheet Excel 写出器（官方模板）')
    const chartPlugin = await ensureTemplatePlugin('python', CHART_TEMPLATE, 'cap2-test-pl-chart', 'v2 图表 PNG 写出器（官方模板，Agg 后端）')
    try {
      return await withAgent({ tag: 'e-report', kbIds: [kbId], pluginIds: [xlsxPlugin, chartPlugin] }, async (ag) => {
        const t0 = Date.now()
        const prompt = [
          '你是经营助理，请在工作空间独立完成 2026 年 9 月经营简报（一个任务内完成全部步骤）：',
          '1) 检索知识库了解 Q3 目标判定规则；',
          '2) 读取 sales-2026.csv，计算 8 月与 9 月总营收和环比增长率；',
          '3) 用可用的 Excel 插件生成 简报/经营明细.xlsx（Sheet「明细」放全部行，Sheet「月度汇总」放两月总额）；',
          '4) 用可用的图表插件生成 简报/营收走势.png（柱状图：8 月与 9 月总额）；',
          '5) 写 简报/九月经营简报.md：含总额、环比百分数、对照 Q3 目标的达标结论；',
          '6) 把「9 月总额与环比结论」锚定到你的记忆。',
        ].join('\n')
        const r = await drive(ag, prompt, { ws, extra: { expectedArtifacts: ['简报/九月经营简报.md', '简报/经营明细.xlsx', '简报/营收走势.png'] } })
        const md = fileText(ws, '九月经营简报.md') || ''
        const xlsx = findFile(ws, '经营明细.xlsx')
        const png = findFile(ws, '营收走势.png')
        const mem = asRows(unw(await callTool('memory_list', { agentId: ag.id }, { timeoutMs: 15000 })))
        const kbFired = extractKbEvents(r.trace).length >= 1
        const pluginFired = toolNames(r.trace).filter((n) => /custom__/.test(n)).length >= 2
        const mrr = numPresent(md || r.reply, (total09 - total08) / total08 * 100, { tolerance: 0.3 })
        return finish('E9-1', dim, title, [
          A('status_done', r.status === 'done', r.status),
          A('md_exists', md.length > 0, '九月经营简报.md 缺失'),
          A('xlsx_ok', !!xlsx && magicOk(xlsx.path, 'xlsx'), xlsx ? `${xlsx.size}B` : '经营明细.xlsx 缺失'),
          A('png_ok', !!png && magicOk(png.path, 'png'), png ? `${png.size}B` : '营收走势.png 缺失'),
          A('mom_percent_11_2', mrr.ok, mrr.detail),
          A('verdict_correct', /达成|达标/.test(md), '结论应为「目标达成」（11.2%≥10%）'),
          A('kb_search_fired', kbFired, '应检索 KB'),
          A('plugin_calls_ge2', pluginFired, `custom__ 调用 ${toolNames(r.trace).filter((n) => /custom__/.test(n)).length} 次`),
          A('memory_anchored', mem.some((m) => /834|环比|达标|11\.2/.test(JSON.stringify(m))), `memory_list ${mem.length} 行`),
        ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
      })
    } finally { await dropKb(kbId) }
  },

  // 跨 run 项目推进：run1 骨架 → run2 续作（须知道 run1 结构）→ run3 评审收尾
  async 'E9-2'() {
    const dim = 'E编排', title = '跨 run 项目推进（博客骨架→续作→评审）'
    const ws = wsOf('E9-2')
    return withAgent({ tag: 'e-blog' }, async (ag) => {
      const t0 = Date.now()
      const r1 = await drive(ag, '开始一个多轮项目（这是第 1 步）：在工作空间搭建个人博客骨架，创建 index.html（导航栏含指向 about.html 的链接）与 style.css（简洁暗色风格）。', { ws })
      const idxAfter1 = fileText(ws, 'index.html') || ''
      const r2 = await drive(ag, '项目第 2 步：创建 about.html，风格与现有 index.html 保持一致，两页导航要互相链接。', { ws, sess: r1.sess })
      const idxAfter2 = fileText(ws, 'index.html') || ''
      const about = fileText(ws, 'about.html') || ''
      const r3 = await drive(ag, '项目第 3 步（收尾）：评审整个目录，写 README.md 说明文件结构与每页用途。', { ws, sess: r1.sess })
      const readme = fileText(ws, 'README.md') || ''
      return finish('E9-2', dim, title, [
        A('r1_skeleton', (fileText(ws, 'index.html') || '').includes('index') && (fileText(ws, 'style.css') || '').length > 0, 'run1 应产出 index.html + style.css'),
        A('r2_about_linked', about.length > 0 && /index\.html/.test(about) && /about\.html/.test(idxAfter2), 'run2 应产出 about.html 且与 index 互链'),
        A('r2_no_regression', idxAfter2.includes('导航') || idxAfter2.length >= idxAfter1.length, 'run2 不应破坏 run1 产物'),
        A('r3_readme_covers', /index|about/.test(readme), 'run3 README 应覆盖既有文件'),
        A('all_done', r1.status === 'done' && r2.status === 'done' && r3.status === 'done', `${r1.status}/${r2.status}/${r3.status}`),
      ], { durationMs: Date.now() - t0, runId: r3.runId, counts: r3.tokens })
    })
  },

  // 中断-回滚-重跑闭环：run2 写坏 → 快照回滚到 run1 → run3 重做正确版本
  async 'E9-3'() {
    const dim = 'E编排', title = '中断-快照回滚-重跑闭环（D\' 实战）'
    const ws = wsOf('E9-3')
    return withAgent({ tag: 'e-rollback' }, async (ag) => {
      const t0 = Date.now()
      const r1 = await drive(ag, '在工作空间创建 config.json，内容恰好为 {"version":"v1","features":["a"]}，不要创建其他文件。', { ws })
      const v1 = fileText(ws, 'config.json') || ''
      const r2 = await drive(ag, '现在把 config.json 覆盖成 {"version":"v2-broken"}，并创建 broken.txt 标记坏状态。', { ws, sess: r1.sess })
      const brokenSeen = (fileText(ws, 'config.json') || '').includes('v2-broken')
      const snaps = unw(await callTool('agent_snapshot_list', { agentId: ag.id }, { timeoutMs: 15000 }))
      const list = snaps?.snapshots || []
      // F3 修复（2026-09-27）：agent_snapshot_list 返回旧→新排序，list[0] 是「run1 开始前
      // 的空工作区」快照——回滚到它会把 config.json 清没（首跑 restored_v1 误败实锤）。
      // 改按 stamp 降序取真正最新的一份（= run2 开始前的 run1 完好状态）。
      const target = [...list].sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)))[0]
      let rolled = false
      if (target?.stamp) {
        const rb = unw(await callTool('agent_snapshot_rollback', { agentId: ag.id, stamp: target.stamp, workspace: ws }, { timeoutMs: 60000 }))
        rolled = !!rb
      }
      const afterRollback = fileText(ws, 'config.json') || ''
      const brokenGone = !fs.existsSync(path.join(ws, 'broken.txt'))
      const r3 = await drive(ag, '重新做正确升级：把 config.json 改为 {"version":"v2","features":["a","b"]}，删除 broken.txt（如存在）。', { ws, sess: r1.sess })
      const finalCfg = fileText(ws, 'config.json') || ''
      return finish('E9-3', dim, title, [
        A('r1_v1_written', v1.includes('v1'), v1.slice(0, 60)),
        A('r2_broken_seen', brokenSeen, 'run2 应写入 v2-broken（破坏态）'),
        A('snapshots_available', list.length >= 1, `快照 ${list.length} 份`),
        A('rollback_executed', rolled, target?.stamp ? `回滚到 ${target.stamp}` : '无可用 stamp'),
        A('restored_v1', afterRollback.includes('v1') && !afterRollback.includes('broken'), afterRollback.slice(0, 60)),
        A('broken_txt_gone', brokenGone, 'broken.txt 应随回滚消失'),
        A('r3_final_v2', /v2/.test(finalCfg) && /"b"/.test(finalCfg) && !/broken/.test(finalCfg), finalCfg.slice(0, 80)),
      ], { durationMs: Date.now() - t0, runId: r3.runId, counts: r3.tokens })
    })
  },

  // 附件驱动评审流：text 附件需求 → 风险评审 md → xlsx checklist
  async 'E9-4'() {
    const dim = 'E编排', title = '附件需求评审流（附件+分析+xlsx）'
    const ws = wsOf('E9-4')
    const req = [
      '# 「闪电配送」需求文档 v1.3',
      '背景：为骑手提供实时导航与单量热力图。核心需求：',
      '1. 接入第三方支付通道完成骑手保证金代扣（供应商仅提供 SOAP 接口）；',
      '2. 旧版押金数据从 Excel 迁移到新库（涉及 12 万行历史数据）；',
      '3. 热力图每 5 秒刷新，覆盖全国 300 城；',
      '4. 离线模式下缓存最近 50 单导航记录；',
      '5. 管理后台支持按城市配置费率。',
      '约束：工期 6 周，预算不变。',
    ].join('\n')
    const xlsxPlugin = await ensureTemplatePlugin('python', XLSX_TEMPLATE, 'cap2-test-pl-xlsx', 'v2 多 sheet Excel 写出器（官方模板）')
    return withAgent({ tag: 'e-review', pluginIds: [xlsxPlugin] }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        '附件是一份需求文档。请完成：',
        '1) 阅读并在工作空间写 risk-review.md：识别至少 3 个实现风险，每条含「风险/影响/应对」；',
        '2) 用可用的 Excel 插件生成 review-checklist.xlsx：表头「风险,应对,状态」，每行一个风险，状态列填「待评审」。',
      ].join('\n')
      const r = await drive(ag, prompt, { ws, extra: { attachments: [{ type: 'text', name: 'requirement-v1.3.md', content: req }] } })
      const md = fileText(ws, 'risk-review.md') || ''
      const xlsx = findFile(ws, 'review-checklist.xlsx')
      return finish('E9-4', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('risk_md', md.length > 100, `len=${md.length}`),
        A('planted_risks_covered', /支付|SOAP|迁移/.test(md) && /热力|刷新|离线/.test(md), '附件中的显性风险（支付/迁移/热力图）应被识别'),
        A('xlsx_ok', !!xlsx && magicOk(xlsx.path, 'xlsx'), xlsx ? `${xlsx.size}B` : 'review-checklist.xlsx 缺失'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 无人值守全自动：never+auto 四步任务一次通过（不挂任何门禁）
  async 'E9-5'() {
    const dim = 'E编排', title = '无人值守全自动四步任务（不挂门禁）'
    const ws = wsOf('E9-5')
    const nums = Array.from({ length: 10 }, (_, i) => (i + 3) * 7) // 21..90，sum=555
    const chartPlugin = await ensureTemplatePlugin('python', CHART_TEMPLATE, 'cap2-test-pl-chart', 'v2 图表 PNG 写出器（官方模板，Agg 后端）')
    return withAgent({ tag: 'e-auto', autoToolExecMode: true, planAutoApproveMode: 'never', pluginIds: [chartPlugin] }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        '无人值守任务，一次完成：',
        `1) 在工作空间创建 data/nums.txt，内容为以下 10 个数字每行一个：${nums.join('、')}；`,
        '2) 用沙箱计算它们的总和，写入 data/sum.txt（只写数字）；',
        `3) 用可用的图表插件生成 data/trend.png（折线图，ys 为这 10 个数）；`,
        '4) 写 data/report.md：说明总和与图表文件名。',
      ].join('\n')
      const r = await drive(ag, prompt, { ws })
      const sumTxt = (fileText(ws, 'sum.txt') || '').trim()
      const png = findFile(ws, 'trend.png')
      const total = nums.reduce((a, b) => a + b, 0)
      return finish('E9-5', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('sum_correct', numPresent(sumTxt || r.reply, total).ok, `期望总和 ${total}，sum.txt=${sumTxt}`),
        A('png_ok', !!png && magicOk(png.path, 'png'), png ? `${png.size}B` : 'trend.png 缺失'),
        A('report_md', /trend\.png|总和|sum/i.test(fileText(ws, 'report.md') || ''), 'report.md 应引用总和与图表'),
        A('no_hang_within_budget', Date.now() - t0 < WAIT_MS, `${Math.round((Date.now() - t0) / 60000)}min`),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 记忆驱动偏好复用：R1 锚定格式偏好 → R2 生成简报必须复用偏好
  async 'E9-6'() {
    const dim = 'E编排', title = '记忆驱动偏好复用（格式约束跨轮生效）'
    const ws = wsOf('E9-6')
    return withAgent({ tag: 'e-pref' }, async (ag) => {
      const t0 = Date.now()
      const r1 = await drive(ag, '请记住我的简报格式偏好：标题必须以【简报】开头，正文不超过 200 字。', {})
      const r2 = await drive(ag, '按我的偏好生成本月简报，写入工作空间的 briefing.md：本月营收 120 万，成本 80 万，利润 40 万。', { ws, sess: r1.sess })
      const md = fileText(ws, 'briefing.md') || ''
      return finish('E9-6', dim, title, [
        A('r1_done', r1.status === 'done', r1.status),
        A('r2_done', r2.status === 'done', r2.status),
        A('title_prefix', md.startsWith('【简报】') || /【简报】/.test(md.slice(0, 30)), md.slice(0, 40)),
        A('len_bounded', md.length > 0 && md.length <= 400, `len=${md.length}`),
        A('numbers_kept', /120/.test(md) && /40/.test(md), '应含 120 万与 40 万'),
      ], { durationMs: Date.now() - t0, runId: r2.runId, counts: r2.tokens })
    })
  },
}
