// capability-v2 入口：list / env / run / score / sheet
// 用例实现在 cases/*.mjs（按系列拆分），共享库 lib/caplib.mjs。
// 用法：
//   node run_capability_suite_v2.mjs list
//   node run_capability_suite_v2.mjs env
//   node run_capability_suite_v2.mjs run --suite smoke|chat|code|office|data|memory|kb|plugin|skill|e2e|adversarial|modules|full|quick
//   node run_capability_suite_v2.mjs run --ids C1-1,T4-1
//   node run_capability_suite_v2.mjs score
//   node run_capability_suite_v2.mjs sheet   # 重新生成 scoring-sheet.csv
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initMcp, rawPost, asRows, unw, callTool, ensureOut, saveResult, finish, A, pickModel, currentModel, OUT, stamp } from './lib/caplib.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---- 用例元数据（显示/分套/打分表用；执行体在 cases/*.mjs）----
const CASE_META = {
  // C 对话与交互
  'C1-1': { dim: 'C对话', title: '多轮指代链（3 轮同会话）', llm: true },
  'C1-2': { dim: 'C对话', title: '长文本附件摘要（token 纪律）', llm: true },
  'C1-3': { dim: 'C对话', title: '结构化 JSON 输出遵循', llm: true },
  'C1-4': { dim: 'C对话', title: '幻觉对抗（不存在的文件）', llm: true },
  'C1-5': { dim: 'C对话', title: '风格与硬约束遵循', llm: true },
  'C1-6': { dim: 'C对话', title: 'file 附件落盘与跨轮重解析', llm: true },
  // K 编码任务（seeds）
  'K2-1': { dim: 'K编码', title: '真实缺陷修复：Date 月份 0 基', llm: true },
  'K2-2': { dim: 'K编码', title: '真实缺陷修复：正则 ReDoS', llm: true },
  'K2-3': { dim: 'K编码', title: '跨文件功能：库存对账报告', llm: true },
  'K2-4': { dim: 'K编码', title: 'TDD 新功能：先测试后实现', llm: true },
  'K2-5': { dim: 'K编码', title: '回归保持绿：购物车加折扣', llm: true },
  'K2-6': { dim: 'K编码', title: '代码评审：只出报告不改码', llm: true },
  // O 办公任务
  'O3-1': { dim: 'O办公', title: 'Excel 周报产物（xlsx 模板插件链路）', llm: true },
  'O3-2': { dim: 'O办公', title: '营收走势图（PNG 模板插件链路）', llm: true },
  'O3-3': { dim: 'O办公', title: '会议纪要转待办清单', llm: true },
  'O3-4': { dim: 'O办公', title: '流水账周报结构化（三节格式）', llm: true },
  'O3-5': { dim: 'O办公', title: '商务邮件草稿（要素齐全）', llm: true },
  // T 数据处理（runner 独立重算）
  'T4-1': { dim: 'T数据', title: 'CSV 区域汇总（独立重算核对）', llm: true },
  'T4-2': { dim: 'T数据', title: '脏数据清洗（重复/空值/非法日期）', llm: true },
  'T4-3': { dim: 'T数据', title: 'JSON 结构转换与按月聚合', llm: true },
  'T4-4': { dim: 'T数据', title: '双表对账差异（3 处差异全捕获）', llm: true },
  'T4-5': { dim: 'T数据', title: '金额精度：分单位核算（浮点陷阱）', llm: true },
  // M 记忆与个性化
  'M5-1': { dim: 'M记忆', title: '跨会话个性化偏好（锚定→召回）', llm: true },
  'M5-2': { dim: 'M记忆', title: '记忆更新冲突（MySQL→PostgreSQL）', llm: true },
  'M5-3': { dim: 'M记忆', title: 'forced 记忆双轨（宫殿+工程文件）', llm: true },
  'M5-4': { dim: 'M记忆', title: '蒸馏候选闭环（观测型）', llm: false },
  // B 知识库 RAG
  'B6-1': { dim: 'B知识库', title: '单库事实问答（三连问全命中）', llm: true },
  'B6-2': { dim: 'B知识库', title: '多库归属（产品 A/B 不混淆）', llm: true },
  'B6-3': { dim: 'B知识库', title: '标签辅助检索（CRUD+命中）', llm: true },
  'B6-4': { dim: 'B知识库', title: '答案溯源（引用来源文件名）', llm: true },
  'B6-5': { dim: 'B知识库', title: '知识更新即生效（增量索引闭环）', llm: true },
  // P 插件深度
  'P7-1': { dim: 'P插件', title: 'Agent 自助装配 xlsx 插件并调用', llm: true },
  'P7-2': { dim: 'P插件', title: 'Agent 自助装配图表插件并调用', llm: true },
  'P7-3': { dim: 'P插件', title: '插件参数契约：缺必填快速拒绝', llm: false },
  'P7-4': { dim: 'P插件', title: '插件超时契约（timeoutSec 兜底）', llm: false },
  'P7-5': { dim: 'P插件', title: '插件多参复用编排（一次 run 调 ≥2 次）', llm: true },
  // S 技能编排
  'S8-1': { dim: 'S技能', title: '技能工作流服从（纪要模板规范）', llm: true },
  'S8-2': { dim: 'S技能', title: '技能导出→导入→一致性闭环', llm: false },
  'S8-3': { dim: 'S技能', title: '双技能择路（周报 vs 纪要）', llm: true },
  // E 整体编排旗舰
  'E9-1': { dim: 'E编排', title: '🏆 月度经营简报全链', llm: true },
  'E9-2': { dim: 'E编排', title: '跨 run 项目推进', llm: true },
  'E9-3': { dim: 'E编排', title: '中断-快照回滚-重跑闭环', llm: true },
  'E9-4': { dim: 'E编排', title: '附件需求评审流', llm: true },
  'E9-5': { dim: 'E编排', title: '无人值守全自动四步任务', llm: true },
  'E9-6': { dim: 'E编排', title: '记忆驱动偏好复用', llm: true },
  // X 边界与对抗
  'X10-1': { dim: 'X边界', title: '提示注入抵抗（文件内伪指令）', llm: true },
  'X10-2': { dim: 'X边界', title: '沙箱离线纪律（联网失败如实报告）', llm: true },
  'X10-3': { dim: 'X边界', title: '越权删除防护（真实诱饵文件）', llm: true },
  'X10-4': { dim: 'X边界', title: '超长复合指令遵循（6 项约束）', llm: true },
  'X10-5': { dim: 'X边界', title: '重复任务幂等（两跑无垃圾副本）', llm: true },
  // N 模块契约快验（无 LLM）
  'N11-1': { dim: 'N模块', title: '全模块枚举一致性（零副作用）', llm: false },
  'N11-2': { dim: 'N模块', title: 'server_host 凭证红线（secret 拒收）', llm: false },
  'N11-3': { dim: 'N模块', title: 'agent×MCP 引用契约（未知 mcpId）', llm: false },
  'N11-4': { dim: 'N模块', title: '快照契约（空态形状）', llm: false },
  'N11-5': { dim: 'N模块', title: '孤儿清扫幂等（双扫）', llm: false },
}

// ---- 套件 ----
const SUITES = {
  quick: ['N11-1', 'N11-2', 'N11-4', 'N11-5', 'S8-2', 'P7-3', 'P7-4'], // 无 LLM，约 1 分钟
  smoke: ['N11-1', 'C1-1', 'O3-3', 'T4-1', 'K2-4', 'E9-5'],
  chat: ['C1-1', 'C1-2', 'C1-3', 'C1-4', 'C1-5', 'C1-6'],
  code: ['K2-1', 'K2-2', 'K2-3', 'K2-4', 'K2-5', 'K2-6'],
  office: ['O3-1', 'O3-2', 'O3-3', 'O3-4', 'O3-5'],
  data: ['T4-1', 'T4-2', 'T4-3', 'T4-4', 'T4-5'],
  memory: ['M5-1', 'M5-2', 'M5-3', 'M5-4'],
  kb: ['B6-1', 'B6-2', 'B6-3', 'B6-4', 'B6-5'],
  plugin: ['P7-1', 'P7-2', 'P7-3', 'P7-4', 'P7-5'],
  skill: ['S8-1', 'S8-2', 'S8-3'],
  e2e: ['E9-1', 'E9-2', 'E9-3', 'E9-4', 'E9-5', 'E9-6'],
  adversarial: ['X10-1', 'X10-2', 'X10-3', 'X10-4', 'X10-5'],
  modules: ['N11-1', 'N11-2', 'N11-3', 'N11-4', 'N11-5'],
}
SUITES.full = Object.keys(CASE_META)

// ---- 用例执行体装载（cases/*.mjs 的 CASES 合并）----
async function loadRunners() {
  const dir = path.join(__dirname, 'cases')
  const merged = {}
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, f)))
    for (const [id, fn] of Object.entries(mod.CASES || {})) {
      if (!CASE_META[id]) { console.warn(`⚠ ${f} 中用例 ${id} 不在 CASE_META，跳过`); continue }
      merged[id] = fn
    }
  }
  return merged
}

// ---- 命令 ----
function cmdList() {
  console.log(`capability-v2 用例（共 ${Object.keys(CASE_META).length}）\n`)
  for (const [id, m] of Object.entries(CASE_META)) {
    const suites = Object.entries(SUITES).filter(([k, ids]) => k !== 'full' && ids.includes(id)).map(([k]) => k).join(',')
    console.log(`${id.padEnd(6)} ${m.dim.padEnd(5)} ${m.llm ? 'LLM ' : '快验'} ${m.title}  [${suites}]`)
  }
}

async function cmdEnv() {
  ensureOut()
  const toolsResp = await rawPost({ jsonrpc: '2.0', id: 999001, method: 'tools/list', params: {} })
  const toolCount = toolsResp?.result?.tools?.length || 0
  const models = asRows(unw(await callTool('agent_list_models', {})))
  const env = {
    tools: toolCount, toolsExpected: 84,
    models: models.map((m) => ({ id: m.id, name: m.name || m.model_name, tool_calls: m.tool_calls, category: m.category, enabled: m.enabled })),
    out: OUT, at: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(OUT, 'env.json'), JSON.stringify(env, null, 2))
  console.log(JSON.stringify(env, null, 2))
}

async function cmdRun(get) {
  const runners = await loadRunners()
  await pickModel()
  console.log(`模型: ${currentModel().name || currentModel().model_name} (${currentModel().id})`)
  let ids = (get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean)
  const suite = get('suite')
  if (!ids.length && suite) ids = SUITES[suite] || []
  if (!ids.length) { console.error('请指定 --suite 或 --ids'); return }
  const results = []
  for (const id of ids) {
    const meta = CASE_META[id]
    if (!meta) { console.error(`未知用例 ${id}`); continue }
    if (!runners[id]) { saveResult({ caseId: id, ...meta, status: 'skipped', autoPass: false, autoScore: 0, asserts: [A('runner', false, 'not implemented')], notes: 'not implemented' }); continue }
    console.log(`\n▶ ${id} ${meta.title}`)
    const t0 = Date.now()
    try {
      results.push(await runners[id]())
    } catch (e) {
      console.error('  [ERR]', e.message)
      finish(id, meta.dim, meta.title, [A('runner_ok', false, e.message)], { durationMs: Date.now() - t0, status: 'error', notes: e.message })
    }
  }
  buildScorecard()
  return results
}

function buildScorecard() {
  ensureOut()
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && f !== 'env.json')
  const cases = []
  for (const f of files) { try { const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); if (j.caseId) cases.push(j) } catch {} }
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0)
  const group = (fn) => cases.reduce((m, x) => { const k = fn(x); (m[k] = m[k] || []).push(x); return m }, {})
  const md = [`# 单 Agent 能力测评 v2 · 客观评分卡`, '', `> ${new Date().toISOString()} · 样本 ${cases.length} · OUT=${OUT}`, '',
    `| 指标 | 值 |`, `|---|---|`,
    `| 用例数 | ${cases.length} |`,
    `| autoPass | ${pct(cases.filter((c) => c.autoPass).length, cases.length)}% |`,
    `| status=done | ${pct(cases.filter((c) => c.status === 'done').length, cases.length)}% |`, '',
    `## 分维度 autoPass`, '', `| 维度 | n | pass% | 用例 |`, `|---|---|---|---|`]
  for (const [dim, arr] of Object.entries(group((c) => c.dim || '?'))) {
    md.push(`| ${dim} | ${arr.length} | ${pct(arr.filter((c) => c.autoPass).length, arr.length)}% | ${arr.map((c) => c.caseId).join(' ')} |`)
  }
  md.push('', `## 明细`, '', `| ID | 维度 | 标题 | status | pass | ms | 失败断言 |`, `|---|---|---|---|---|---|---|`)
  for (const c of cases.sort((a, b) => (a.caseId || '').localeCompare(b.caseId || ''))) {
    const fails = (c.asserts || []).filter((a) => !a.ok).map((a) => a.name).join('; ')
    md.push(`| ${c.caseId} | ${c.dim} | ${c.title} | ${c.status} | ${c.autoPass} | ${c.durationMs || ''} | ${fails.slice(0, 60)} |`)
  }
  md.push('', `> 客观 autoPass 不能替代五维分。按 scoring-rubric.md 人工填 scoring-sheet.csv（C30/P25/V15/E15/S15 + 硬扣）。`)
  const text = md.join('\n')
  fs.writeFileSync(path.join(OUT, 'scorecard.md'), text)
  fs.writeFileSync(path.join(OUT, 'scorecard.json'), JSON.stringify({ cases: cases.length, pass: cases.filter((c) => c.autoPass).length, at: new Date().toISOString() }, null, 2))
  console.log(text)
  return text
}

function cmdSheet() {
  const header = 'caseId,dim,title,suite,autoPass,autoScore,durationMs,tokensIn,tokensOut,C_complete,P_process,V_verify,E_eff,S_safe,hard_penalty,penalty_note,final_0_5,notes'
  const suiteOf = (id) => Object.entries(SUITES).filter(([k, ids]) => ids.includes(id)).map(([k]) => k).join('+')
  const lines = Object.entries(CASE_META).map(([id, m]) => `${id},${m.dim},"${m.title}",${suiteOf(id)},,,,,,,, ,,,, ,,`)
  const csv = [header, ...lines].join('\n')
  fs.writeFileSync(path.join(__dirname, 'scoring-sheet.csv'), csv, 'utf8')
  console.log(`scoring-sheet.csv 已生成（${Object.keys(CASE_META).length} 行）`)
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0] || 'list'
  const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }

  if (cmd === 'list') return cmdList()
  if (cmd === 'score') return buildScorecard()
  if (cmd === 'sheet') return cmdSheet()

  await initMcp('capability-suite-v2')
  if (cmd === 'env') return cmdEnv()
  if (cmd === 'run') return cmdRun(get)
  console.log('用法: node run_capability_suite_v2.mjs list|env|run|score|sheet')
}

if (process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('run_capability_suite_v2.mjs'))) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
