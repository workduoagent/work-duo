// T 系列 · 数据处理：runner 端独立重算（ground-truth）→ 断言 agent 产出数值一致。
// 这是 v2 相对 v1 的关键升级：客观核对不依赖模型自报。
import fs from 'node:fs'
import path from 'node:path'
import {
  A, finish, withAgent, drive, wsOf, fileText, numPresent, parseCsv, toCsv, waitFor,
  callTool, unw, asRows, fileHas, WAIT_MS,
} from '../lib/caplib.mjs'

function writeFixture(ws, name, text) {
  fs.writeFileSync(path.join(ws, name), text, 'utf8')
}

export const CASES = {
  // 30 行 CSV 区域汇总；runner 端独立重算各区域总额与总计
  async 'T4-1'() {
    const dim = 'T数据', title = 'CSV 区域汇总（runner 独立重算）'
    const ws = wsOf('T4-1')
    const rows = [['region', 'month', 'amount']]
    const regions = ['华东', '华南', '华北']
    const base = { 华东: 1200, 华南: 950, 华北: 780 }
    regions.forEach((rg, i) => {
      for (let m = 1; m <= 10; m++) rows.push([rg, `2026-${String(m).padStart(2, '0')}`, base[rg] + i * 37 + m * 11])
    })
    writeFixture(ws, 'sales.csv', toCsv(rows))
    const csv = parseCsv(fs.readFileSync(path.join(ws, 'sales.csv'), 'utf8')).slice(1)
    // F3 修复（2026-09-27）：行结构为 [region, month, amount]——原 [, rg, amt] 跳过 region
    // 把 month 当区域键，sums 全落 undefined（首跑 sum:三区域全误报，total 反而碰对）。
    const sums = {}
    for (const [rg, , amt] of csv) sums[rg] = (sums[rg] || 0) + Number(amt)
    const total = Object.values(sums).reduce((a, b) => a + b, 0)
    return withAgent({ tag: 't-sum' }, async (ag) => {
      const t0 = Date.now()
      const prompt = '工作空间有 sales.csv（region,month,amount）。请统计每个 region 的销售总额和全部区域的总计，把结果写入 summary.md（含各区域金额与总计，单位元，不用千分位）。'
      const r = await drive(ag, prompt, { ws })
      const text = fileText(ws, 'summary.md') || r.reply
      return finish('T4-1', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('summary_md', (fileText(ws, 'summary.md') || '').length > 0, 'summary.md 缺失'),
        ...regions.map((rg) => A(`sum:${rg}`, numPresent(text, sums[rg]).ok, `期望 ${sums[rg]}：${numPresent(text, sums[rg]).detail}`)),
        A('total', numPresent(text, total).ok, `期望 ${total}：${numPresent(text, total).detail}`),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 脏数据清洗：重复行/空值/非法日期；断言无重复、行数收敛
  async 'T4-2'() {
    const dim = 'T数据', title = '脏数据清洗（重复/空值/非法日期）'
    const ws = wsOf('T4-2')
    const good = [
      ['id', 'name', 'date', 'qty'],
      ['1', '甲', '2026-09-01', '5'],
      ['2', '乙', '2026/09/02', '3'],
      ['3', '丙', '2026-09-03', '7'],
      ['4', '丁', '2026-09-04', '2'],
      ['5', '戊', '2026-09-05', '9'],
      ['6', '己', '2026-09-06', '1'],
      ['7', '庚', '2026-09-07', '4'],
      ['8', '辛', '2026-09-08', '6'],
    ]
    const dirty = [...good, good[1], ['9', '', '2026-09-09', '8'], ['10', '壬', '2026-13-40', '3']]
    writeFixture(ws, 'dirty.csv', toCsv(dirty))
    return withAgent({ tag: 't-clean' }, async (ag) => {
      const t0 = Date.now()
      const prompt = '工作空间有 dirty.csv，存在重复行、关键列缺失、非法日期三类问题。请清洗为 cleaned.csv（统一日期为 YYYY-MM-DD；无法修复的行剔除并在 cleaning-report.md 说明每类处理了多少行）。'
      const r = await drive(ag, prompt, { ws })
      const cleanedRaw = fileText(ws, 'cleaned.csv')
      const lines = (cleanedRaw || '').trim().split(/\r?\n/).filter(Boolean)
      const dataLines = lines.slice(1)
      const uniq = new Set(dataLines)
      const rep = fileText(ws, 'cleaning-report.md') || r.reply
      return finish('T4-2', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('cleaned_exists', !!cleanedRaw, 'cleaned.csv 缺失'),
        A('dups_removed', dataLines.length === uniq.size, `${dataLines.length} 行 / 去重后 ${uniq.size} 行`),
        A('row_count_converged', dataLines.length >= 7 && dataLines.length <= 10, `清洗后 ${dataLines.length} 行（期望 7~10）`),
        A('report_explains', /重复|缺失|日期|剔除|修复/.test(rep), rep.slice(0, 120)),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // JSON 嵌套 → 扁平化+按月分组；runner 端精确比对数值
  async 'T4-3'() {
    const dim = 'T数据', title = 'JSON 结构转换与按月聚合'
    const ws = wsOf('T4-3')
    const orders = [
      { id: 'A1', month: '2026-08', customer: { name: '客户甲' }, items: [{ sku: 's1', qty: 2, price: 100 }, { sku: 's2', qty: 1, price: 50 }] },
      { id: 'A2', month: '2026-08', customer: { name: '客户乙' }, items: [{ sku: 's1', qty: 3, price: 100 }] },
      { id: 'A3', month: '2026-09', customer: { name: '客户甲' }, items: [{ sku: 's3', qty: 4, price: 25 }] },
      { id: 'A4', month: '2026-09', customer: { name: '客户丙' }, items: [{ sku: 's2', qty: 1, price: 50 }, { sku: 's3', qty: 2, price: 25 }] },
    ]
    writeFixture(ws, 'orders.json', JSON.stringify(orders, null, 2))
    const expect = {}
    for (const o of orders) {
      const amt = o.items.reduce((s, it) => s + it.qty * it.price, 0)
      expect[o.month] = (expect[o.month] || 0) + amt
    } // 2026-08: 250+300=550 ; 2026-09: 100+100=200
    return withAgent({ tag: 't-json' }, async (ag) => {
      const t0 = Date.now()
      const prompt = '工作空间有 orders.json（嵌套结构）。请转换成扁平明细 lines.jsonl（每行一个 JSON：id,month,customer,sku,qty,amount=qty*price），并按月汇总金额写 summary.json（形如 {"2026-08": 金额, ...}，不要千分位）。'
      const r = await drive(ag, prompt, { ws })
      const raw = fileText(ws, 'summary.json')
      let got = null
      try { got = JSON.parse(raw) } catch {}
      const okMonth = (m) => got && Math.abs(Number(got[m]) - expect[m]) < 0.01
      const linesRaw = fileText(ws, 'lines.jsonl') || ''
      const lineCount = linesRaw.trim() ? linesRaw.trim().split(/\r?\n/).length : 0
      return finish('T4-3', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('lines_jsonl', lineCount === 6, `lines.jsonl 应 6 行，实得 ${lineCount}`),
        A('summary_parseable', !!got, (raw || '').slice(0, 100)),
        ...Object.keys(expect).map((m) => A(`sum:${m}`, okMonth(m), `期望 ${expect[m]}，实得 ${got ? got[m] : 'N/A'}`)),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 双表对账：3 处差异（缺失/多出/金额不一致）必须全被找出
  async 'T4-4'() {
    const dim = 'T数据', title = '双表对账差异（3 处差异全捕获）'
    const ws = wsOf('T4-4')
    const rowsA = [['sku', 'qty'], ['S001', '10'], ['S002', '120'], ['S003', '30'], ['S004', '8']]
    const rowsB = [['sku', 'qty'], ['S001', '10'], ['S002', '210'], ['S003', '30'], ['S007', '5']]
    writeFixture(ws, 'system-a.csv', toCsv(rowsA))
    writeFixture(ws, 'system-b.csv', toCsv(rowsB))
    return withAgent({ tag: 't-recon' }, async (ag) => {
      const t0 = Date.now()
      const prompt = '工作空间有 system-a.csv 与 system-b.csv 两份库存表。请逐 SKU 对账，把差异写入 diff-report.md：数量不一致、仅 A 有、仅 B 有，三类都要列全，并给出总差异数。'
      const r = await drive(ag, prompt, { ws })
      const text = fileText(ws, 'diff-report.md') || r.reply
      return finish('T4-4', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('diff_md', (fileText(ws, 'diff-report.md') || '').length > 0, 'diff-report.md 缺失'),
        A('qty_mismatch_S002', /S002/.test(text) && /(120|210|不?一致)/.test(text), '应指出 S002 数量不一致'),
        A('only_a_S004', /S004/.test(text), '应指出 S004 仅 A 有'),
        A('only_b_S007', /S007/.test(text), '应指出 S007 仅 B 有'),
        A('diff_count_3', /[3三]/.test(text), '应给出总差异数 3'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 精度纪律：浮点陷阱题，要求以分为单位核算
  async 'T4-5'() {
    const dim = 'T数据', title = '金额精度：分单位核算（浮点陷阱）'
    const ws = wsOf('T4-5')
    const prices = [19.99, 5.01, 0.07]
    const total = Math.round(prices.reduce((a, b) => a + b, 0) * 100) // 2507 分 = 25.07 元
    return withAgent({ tag: 't-prec' }, async (ag) => {
      const t0 = Date.now()
      const prompt = '工作空间有 prices.txt（三行单价：19.99、5.01、0.07 元）。请核算总价（元）。注意浮点精度：建议先换算成「分」的整数运算再换回元。把结果与算法说明写进 calc.md。'
      fs.writeFileSync(path.join(ws, 'prices.txt'), prices.join('\n'), 'utf8')
      const r = await drive(ag, prompt, { ws })
      const text = (fileText(ws, 'calc.md') || '') + r.reply
      const longFloat = /25\.0\d{3,}/.test(text)
      return finish('T4-5', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('calc_md', (fileText(ws, 'calc.md') || '').length > 0, 'calc.md 缺失'),
        A('total_2507_fen_or_2507', numPresent(text, 2507).ok || numPresent(text, total / 100, { tolerance: 0.001 }).ok, `期望 2507 分 / 25.07 元`),
        A('no_long_float_as_answer', !longFloat || /0\.3000000000|浮点|误差/.test(text), '不应把长浮点串当最终答案（说明性提及可接受）'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },
}
