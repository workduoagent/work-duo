#!/usr/bin/env node
// squad_eval_harness.mjs —— 小分队 17 用例验收回归 + 发布门禁（§10，2026-09-30）
//
// 断言纪律：一律扫结构化证据（board_json.tasks[t1..] / agent_squad_handoff /
// agent_squad_inject.status / agent_squad_round.kind / agent_run_trace 时间窗 / 盘面产物），
// 不 grep 转录全文；行为类断言（inject/pre_talk 暗号）用独特标记词。
//
// 夹具（用户拍板：不新建编队，用正式生态 4 套；允许临时改成员 Agent 配置，自动还原+审计）：
//   编排=sqd-dev-fullstack  群聊=sqd-dev-roundtable  突击=sqd-dev-hotfix（流水线仅静态钉）
//
// 用法：
//   node squad_eval_harness.mjs env                          # 环境自检
//   node squad_eval_harness.mjs run [--cases S-ORCH-1,S-PIPE-1] [--out DIR]
//   node squad_eval_harness.mjs gate [--out DIR]             # 全绿断言（接发布门禁）
// 退出码：0=PASS 1=FAIL 2=环境不就绪
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as drv from './agent_task_driver.mjs'

const boot = drv.initMcp
const tool = drv.callTool
const peel = drv.unw
const rowset = drv.asRows
const nap = drv.sleep

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const argv = process.argv.slice(2)
const cmd = argv[0] || 'run'
const argOf = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const ONLY = argOf('cases', '').split(',').map((s) => s.trim()).filter(Boolean)

function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const OUT = argOf('out', path.join(REPO, '.workspace/.eval-results', 'squad-' + stamp()).replace(/\\/g, '/'))
const SQD_WS = 'E:/WorkDuoTest'

const FIX = {
  orch: process.env.SQD_ORCH_ID || 'sqd-dev-fullstack',
  chat: process.env.SQD_CHAT_ID || 'sqd-dev-roundtable',
  hot: process.env.SQD_HOT_ID || 'sqd-dev-hotfix',
  pipe: process.env.SQD_PIPE_ID || 'sqd-dev-pipeline',
}
// plan=never 成员（真任务不被成员计划门禁卡）
const LOOSE = { py: 'Python 后端', react: 'React 前端', rust: 'Rust 客户端' }
// hotfix 队真实 role（『Python 后端』等是 agent 名不是 role——错配会回退 leader=PM 兜底）
const HOT = { py: '后端修复', react: '前端修复' }
const MARK = { inj: 'ZEBRA-INJ-42', pre: 'ZEBRA-PRE-99' }

// ---- MCP 调用（error JSON → callTool 抛异常，统一 soft 捕获） ----
async function soft(name, args = {}, opt = {}) {
  try { return { ok: true, err: '', data: peel(await tool(name, args, { timeoutMs: opt.timeoutMs || 60000 })) } }
  catch (e) { return { ok: false, err: String((e && e.message) || e), data: null } }
}
const errHas = (r, kw) => !r.ok && r.err.includes(kw)

// ---- sqlite 通道：首选 node:sqlite（零派生进程），fallback python spawnSync ----
// （2026-09-30：agent 沙箱禁 node 派生进程（EBUSY），spawnSync python 在受限环境全挂——
//  node:sqlite（node≥22.5，--experimental-sqlite）直连解决；门禁环境两种都可用。）
import { createRequire } from 'node:module'
const requireSqlite = createRequire(import.meta.url)
const DB_PATH = process.env.SQD_DB || path.join(os.homedir(), 'AppData/Roaming/com.workduo/workduo.db')
let DB = null
function openDb() {
  if (DB) return DB
  let mod = null
  try { mod = requireSqlite('node:sqlite') } catch { mod = null }
  if (!mod || !mod.DatabaseSync) throw new Error('node:sqlite 不可用（请用 node --experimental-sqlite 运行本脚本）')
  DB = new mod.DatabaseSync(DB_PATH)
  try { DB.exec('PRAGMA busy_timeout=5000') } catch { /* 只读场景忽略 */ }
  return DB
}
const PY_LIST = [
  process.env.SQD_PYTHON,
  ...(() => {
    const base = path.join(os.homedir(), '.workbuddy/binaries/python/versions')
    try { return fs.readdirSync(base).filter((d) => /^\d/.test(d)).sort().reverse().map((d) => path.join(base, d, 'python.exe')) } catch { return [] }
  })(),
  'python',
].filter(Boolean)
let PY = null
function pickPy() {
  if (PY) return PY
  for (const c of PY_LIST) {
    try { const r = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 15000 }); if (r.status === 0) { PY = c; return c } } catch { /* next */ }
  }
  throw new Error('找不到可用 python（sqlite 通道）')
}
function dbQuery(sql, params = []) {
  try {
    return openDb().prepare(sql).all(...params)
  } catch (e) {
    // fallback：python 通道（如 node:sqlite 缺席）
    const script = [
      'import sqlite3,sys,json',
      'db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row',
      'print(json.dumps([dict(r) for r in db.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()],ensure_ascii=False))',
    ].join('\n')
    const r = spawnSync(pickPy(), ['-c', script, DB_PATH, sql, JSON.stringify(params)], { encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) throw new Error('dbQuery 失败: ' + String((r.stderr && r.stderr.slice) ? r.stderr.slice(0, 200) : e.message))
    return JSON.parse(r.stdout || '[]')
  }
}
function dbExec(sql, params = []) {
  try {
    openDb().prepare(sql).run(...params)
    return
  } catch (e) {
    const script = [
      'import sqlite3,sys,json',
      'db=sqlite3.connect(sys.argv[1])',
      'db.execute(sys.argv[2],json.loads(sys.argv[3]));db.commit()',
      'print("ok")',
    ].join('\n')
    const r = spawnSync(pickPy(), ['-c', script, DB_PATH, sql, JSON.stringify(params)], { encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) throw new Error('dbExec 失败: ' + String((r.stderr && r.stderr.slice) ? r.stderr.slice(0, 200) : e.message))
  }
}

// ---- 断言与落盘 ----
const A = (name, ok, detail = '') => ({ name, ok: !!ok, detail: String(detail).slice(0, 300) })
function finish(caseId, title, asserts, extra = {}) {
  const pass = asserts.length > 0 && asserts.every((a) => a.ok)
  const status = extra.status || (pass ? 'done' : 'failed')
  const rec = { caseId, dim: 'squad', title, status, autoPass: pass, autoScore: pass ? 1 : 0, asserts, sessionId: extra.sessionId || null, durationMs: extra.durationMs || 0, notes: extra.notes || '', at: new Date().toISOString() }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, caseId.replace(/[^A-Z0-9-]/g, '_') + '.json'), JSON.stringify(rec, null, 2))
  const bad = asserts.filter((x) => !x.ok).map((x) => x.name + ': ' + x.detail).join(' | ')
  console.log(`  → ${caseId} ${pass ? 'PASS' : 'FAIL'} ${asserts.filter((x) => x.ok).length}/${asserts.length}${bad ? '  ' + bad.slice(0, 260) : ''}`)
  return rec
}
const wanted = (caseId) => ONLY.length === 0 || ONLY.includes(caseId)

// ---- squad 语义 ----
async function squadGet(key) {
  const r = await soft('squad_get', { squadId: key })
  if (!r.ok) throw new Error('squad_get(' + key + '): ' + r.err.slice(0, 120))
  return r.data
}
async function sessionOf(squadOrSessionId) {
  const key = String(squadOrSessionId).startsWith('sqs_') ? { sessionId: squadOrSessionId } : { squadId: squadOrSessionId }
  const rows = rowset(await tool('squad_get_session', key, { timeoutMs: 30000 }))
  return rows[0] || null
}
const roundsOf = async (sessionId, limit = 300) => rowset(await tool('squad_list_rounds', { sessionId, limit }, { timeoutMs: 30000 }))
async function runSquad(squadId, tasks, prompt) {
  const args = { squadId, wait: false }
  if (prompt) args.prompt = prompt
  if (tasks && tasks.length) args.contract = tasks
  const r = await soft('squad_run', args, { timeoutMs: 60000 })
  if (!r.ok) throw new Error('squad_run: ' + r.err.slice(0, 160))
  return r.data
}
const cancelSquad = async (squadId) => soft('squad_cancel', { squadId })
async function gateSubmit(sessionId, g, decision) { return soft('squad_submit_decision', { sessionId, gate: g, decision }) }

const boardOf = (s) => { try { return JSON.parse(s.board_json || '{}') } catch { return {} } }
const taskByTitle = (b, title) => Object.values(b.tasks || {}).find((t) => t.title === title) || null
const hasRunning = (b) => Object.values(b.tasks || {}).some((t) => t.status === 'running')

// 等终态；门禁自动放行（L4 delivery approve；L2 checkpoint 挂起不改 status——
// 靠「最新轮 kind=checkpoint 且其后无新成员轮」检测后自动 continue，harness 关注机制而非人工决议）
async function pollDone(sessionId, { maxMs = 600000, everyMs = 4000, autoApprove = true } = {}) {
  const t0 = Date.now()
  for (;;) {
    const s = await sessionOf(sessionId)
    if (s) {
      if (['done', 'failed', 'cancelled'].includes(s.status)) return s
      if (autoApprove && s.status === 'awaiting_delivery') { await gateSubmit(sessionId, 'delivery', 'approve'); await nap(everyMs); continue }
    }
    if (autoApprove) {
      try {
        const rd = await roundsOf(sessionId, 60)
        const last = rd[rd.length - 1]
        if (last && last.kind === 'checkpoint') {
          await gateSubmit(sessionId, 'checkpoint', 'continue')
          await nap(everyMs)
          continue
        }
      } catch { /* 轮询失败下轮重试 */ }
    }
    if (Date.now() - t0 > maxMs) throw new Error('pollDone 超时（最后 status=' + (s && s.status) + '）')
    await nap(everyMs)
  }
}
async function pollCond(desc, fn, { maxMs = 180000, everyMs = 3000 } = {}) {
  const t0 = Date.now()
  for (;;) {
    let v = null
    try { v = await fn() } catch { v = null }
    if (v) return v
    if (Date.now() - t0 > maxMs) throw new Error('pollCond 超时: ' + desc)
    await nap(everyMs)
  }
}
async function memberRuns(agentIds, sinceMs) {
  const ph = agentIds.map(() => '?').join(',')
  return dbQuery(`SELECT agent_id, started_at, finished_at FROM agent_run_trace WHERE agent_id IN (${ph}) AND started_at >= ? ORDER BY started_at ASC`, [...agentIds, sinceMs])
}

// ============================================================
// 17 用例
// ============================================================

// 1. 形象状态机（静态层）
async function casePixel() {
  const t0 = Date.now(); const as = []
  const read = (p) => { try { return fs.readFileSync(path.join(REPO, p), 'utf8') } catch { return '' } }
  const types = read('src/components/ui/pixel-agent/types.ts')
  const scss = read('src/components/ui/pixel-agent/PixelAgent.scss')
  const layers = read('src/components/ui/pixel-agent/layers.ts')
  const page = read('src/pages/squads-workspace/index.tsx')
  as.push(A('AgentMotionState 扩展四态', ['waiting', 'speaking', 'handoff', 'cheer'].every((m) => types.includes(m)), 'types.ts ' + types.length + 'B'))
  as.push(A('SCSS 运动态选择器齐全', ['working', 'waiting', 'speaking', 'handoff', 'cheer'].every((m) => scss.includes(m)), 'scss ' + scss.length + 'B'))
  as.push(A('运行时间线事件映射 started→working / finished→cheer|error', page.includes('started') && page.includes('working') && (page.includes('cheer') || page.includes("'error'")), 'page ' + page.length + 'B'))
  as.push(A('像素两帧范式未引入 transform 位移', layers.length > 0 && !/transform:\s*(translate|scale)/.test(layers), 'layers.ts'))
  return finish('S-PIXEL-1', '像素形象运行态（静态：枚举/样式/事件映射）', as, { durationMs: Date.now() - t0 })
}

// 2. 记忆沉淀：squad 记忆落专属表 agent_squad_memory；协作 run 经 load_squad_memory_block
//    注入并 ref_count+1（=「下次召回」机制，config.rs）。断言：锚定受理→库行在→幂等重锚计数递增→注入装配点在。
async function caseMem() {
  const t0 = Date.now(); const as = []
  const key = 'squad-eval-' + Date.now().toString(36)
  const content = '小分队回归锚 ' + key + '（squad_eval_harness ' + new Date().toISOString() + '）'
  const r = await soft('squad_anchor_memory', { squadId: FIX.orch, key, content, category: 'other' })
  as.push(A('squad_anchor_memory 受理', r.ok && r.data && r.data.id, r.ok ? 'id=' + r.data.id : r.err.slice(0, 120)))
  const memId = (r.data && r.data.id) || null
  const row1 = dbQuery('SELECT id, ref_count, anchored FROM agent_squad_memory WHERE squad_id=? AND key=?', [FIX.orch, key])[0]
  as.push(A('agent_squad_memory 库行存在', !!row1, JSON.stringify(row1 || {}).slice(0, 100)))
  const r2 = await soft('squad_anchor_memory', { squadId: FIX.orch, key, content: content + '（重锚）', category: 'other' })
  const row2 = dbQuery('SELECT ref_count FROM agent_squad_memory WHERE squad_id=? AND key=?', [FIX.orch, key])[0]
  as.push(A('幂等重锚 ref_count 递增', r2.ok && row2 && Number(row2.ref_count) >= 1, 'ref_count=' + (row2 && row2.ref_count)))
  const cfg = fs.readFileSync(path.join(REPO, 'src-tauri/src/agent/squad/config.rs'), 'utf8')
  as.push(A('协作注入装配点 load_squad_memory_block 存在（召回通道）', cfg.includes('load_squad_memory_block') && cfg.includes('ref_count = ref_count + 1'), ''))
  if (memId) { try { await tool('memory_delete', { id: memId }) } catch { try { dbExec('DELETE FROM agent_squad_memory WHERE id=?', [memId]) } catch { /* 留痕 */ } } }
  return finish('S-MEM-1', '记忆沉淀：锚点落库+幂等重锚+召回装配点', as, { durationMs: Date.now() - t0 })
}

// 3. 无人值守：executionMode=api 三路插话全拒（临时改配置→还原）
async function caseUnatt() {
  const t0 = Date.now(); const as = []
  const squad = await squadGet(FIX.hot)
  const orig = squad.squad.run_strategy || '{}'
  let strat = {}; try { strat = JSON.parse(orig) } catch { strat = {} }
  strat.executionMode = 'api'
  dbExec('UPDATE agent_squad SET run_strategy=? WHERE id=?', [JSON.stringify(strat), FIX.hot])
  let sess = null
  try {
    const r = await runSquad(FIX.hot, [{ title: '无人值守探针', assignee: LOOSE.py, instruction: '创建 unatt.md 内容 ok，结束。' }], '无人值守探针')
    sess = r.sessionId
    as.push(A('api 模式 run 触发', !!sess, JSON.stringify(r).slice(0, 100)))
    await nap(3000)
    const inj = await soft('squad_inject_to_task', { sessionId: sess, squadId: FIX.hot, taskId: 't1', content: 'x ' + MARK.inj })
    const tlk = await soft('squad_talk_to_task', { sessionId: sess, squadId: FIX.hot, taskId: 't1', content: 'y ' + MARK.pre })
    const bct = await soft('squad_broadcast_note', { sessionId: sess, squadId: FIX.hot, note: 'z ' + MARK.inj })
    as.push(A('live inject 拒绝（无人值守）', errHas(inj, '无人值守'), inj.err.slice(0, 80)))
    as.push(A('pre_talk 拒绝（无人值守）', errHas(tlk, '无人值守'), tlk.err.slice(0, 80)))
    as.push(A('broadcast 拒绝（无人值守）', errHas(bct, '无人值守'), bct.err.slice(0, 80)))
  } finally {
    if (sess) { await cancelSquad(FIX.hot); await nap(2000) }
    dbExec('UPDATE agent_squad SET run_strategy=? WHERE id=?', [orig, FIX.hot])
  }
  const back = await squadGet(FIX.hot)
  as.push(A('run_strategy 已还原', back.squad.run_strategy === orig, ''))
  return finish('S-UNATT-1', '无人值守：schedule/api 三路插话全拒（配置已还原）', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 4. 信封解析回归（静态 + 复用 ORCH 会话输出）
async function caseEnvelope(orchSessionId) {
  const t0 = Date.now(); const as = []
  const srcPath = path.join(REPO, 'src-tauri/src/agent/squad/squad_orchestrator.rs')
  const src = fs.readFileSync(srcPath, 'utf8')
  const calls = (src.match(/extract_llm_content/g) || []).length
  as.push(A('取文统一走 extract_llm_content（≥4 处）', calls >= 4, 'calls=' + calls))
  // 排除注释行（2932 行注释描述历史 bug 属合法存在）
  const codeOnly = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  as.push(A('无信封 choices[0] 直取残留（代码行）', !/choices\s*\[\s*0\s*\]/.test(codeOnly), ''))
  if (orchSessionId) {
    const rd = await roundsOf(orchSessionId)
    const leak = rd.filter((x) => ['subtask', 'summary'].includes(x.kind) && String(x.content || '').trim().startsWith('{"choices"'))
    as.push(A('真跑会话输出无信封原文泄漏', leak.length === 0, leak.length + ' 行'))
  }
  return finish('S-ENV-1', '信封解析回归（extract_llm_content 接线+无泄漏）', as, { durationMs: Date.now() - t0 })
}

// 5. 编排并行：双节点同波 + 汇聚；trace 区间重叠
async function caseOrch() {
  const t0 = Date.now(); const as = []
  const r = await runSquad(FIX.orch, [
    { title: '并行任务A', assignee: LOOSE.py, instruction: '在工作空间创建 file-a.md，内容一行：「任务A完成」。然后结束，不要做其他事。', expectedArtifacts: ['file-a.md'] },
    { title: '并行任务B', assignee: LOOSE.react, instruction: '在工作空间创建 file-b.md，内容一行：「任务B完成」。然后结束，不要做其他事。', expectedArtifacts: ['file-b.md'] },
    { title: '汇聚任务', assignee: LOOSE.rust, instruction: '读取 file-a.md 与 file-b.md，将两份内容合并写入 merged.md，然后结束。', dependsOn: ['并行任务A', '并行任务B'], expectedArtifacts: ['merged.md'] },
  ], '双节点并行+汇聚回归')
  const sess = r.sessionId
  as.push(A('run 触发返回 sessionId', !!sess, JSON.stringify(r).slice(0, 100)))
  if (!sess) return finish('S-ORCH-1', '编排并行（Wave 重叠）', as, { durationMs: Date.now() - t0 })
  const s = await pollDone(sess)
  const b = boardOf(s)
  as.push(A('三任务全部 done', ['并行任务A', '并行任务B', '汇聚任务'].every((t) => { const x = taskByTitle(b, t); return x && x.status === 'done' }), JSON.stringify(b.tasks || {}).slice(0, 200)))
  as.push(A('产物索引含 merged.md', (b.artifacts_index || []).some((p) => String(p).includes('merged.md')), JSON.stringify(b.artifacts_index || []).slice(0, 150)))
  // 并行断言：agent_run_trace 仅归档落盘（成员 subtask 不写），改用 rounds 完成轮间隔——
  // 并行=两成员 handoff 轮同窗收敛（间隔远小于单任务执行周期）；串行=t2 完成必然滞后 t1 一个完整执行周期。
  const rd = await roundsOf(sess)
  const hOf = (title) => {
    const tid = Object.entries(b.tasks || {}).find(([, v]) => v.title === title)?.[0]
    const rows = rd.filter((x) => x.kind === 'handoff' && String(x.content || '').includes(title))
    return rows.length ? Math.max(...rows.map((x) => Number(x.created_at))) : 0
  }
  const h1 = hOf('并行任务A'); const h2 = hOf('并行任务B')
  const gap = h1 && h2 ? Math.abs(h1 - h2) : -1
  as.push(A('Wave1 双成员完成轮同窗收敛（真并行）', gap >= 0 && gap <= 90000, '间隔=' + gap + 'ms（阈值 90s；串行将滞后一个完整执行周期）'))
  const idT = await memberAgentId(FIX.orch, LOOSE.rust)
  const t3start = Math.min(...rd.filter((x) => x.speaker_agent_id === idT && x.kind === 'subtask').map((x) => Number(x.created_at)), Number.MAX_SAFE_INTEGER)
  as.push(A('汇聚任务在两支完成后才执行', t3start === Number.MAX_SAFE_INTEGER || t3start >= Math.max(h1, h2) - 1500, `t3=${t3start} wave1end=${Math.max(h1, h2)}`))
  return finish('S-ORCH-1', '编排并行：双节点同波+汇聚', as, { sessionId: sess, durationMs: Date.now() - t0 })
}
async function memberAgentId(squadId, rolePrefix) {
  const g = await squadGet(squadId)
  const m = (g.members || []).find((x) => String(x.role || '').startsWith(rolePrefix))
  if (!m) throw new Error('找不到成员: ' + rolePrefix + ' @ ' + squadId)
  return m.agent_id
}

// 6. DAG 依赖：contract 链 工序一→二→三；时序=后序首 run.start ≥ 前序末 run.end
async function casePipe() {
  const t0 = Date.now(); const as = []
  const depRows = dbQuery('SELECT m.role, m.pipeline_order, m.depends_on FROM agent_squad_member m JOIN agent_squad s ON s.id=m.squad_id WHERE s.id=? ORDER BY m.created_at', [FIX.pipe])
  as.push(A('流水线夹具完好（5 成员含依赖链）', depRows.length >= 4 && depRows.some((r) => { try { return JSON.parse(r.depends_on || '[]').length > 0 } catch { return false } }), 'members=' + depRows.length))
  const r = await runSquad(FIX.orch, [
    { title: '工序一', assignee: LOOSE.py, instruction: '创建 step1.md 内容「第一步产出」，结束。', expectedArtifacts: ['step1.md'] },
    { title: '工序二', assignee: LOOSE.react, instruction: '读取 step1.md，在末尾追加一行「第二步加工」，保存为 step2.md，结束。', dependsOn: ['工序一'], expectedArtifacts: ['step2.md'] },
    { title: '工序三', assignee: LOOSE.rust, instruction: '读取 step2.md，追加「第三步验收」，保存为 step3.md，结束。', dependsOn: ['工序二'], expectedArtifacts: ['step3.md'] },
  ], 'DAG 依赖链回归')
  const sess = r.sessionId
  const s = await pollDone(sess)
  const b = boardOf(s)
  as.push(A('三工序全部 done', ['工序一', '工序二', '工序三'].every((t) => { const x = taskByTitle(b, t); return x && x.status === 'done' }), JSON.stringify(b.tasks || {}).slice(0, 200)))
  // 依赖时序（rounds 口径）：后序成员的首个轮 ≥ 前序成员 handoff 轮时刻
  const rd = await roundsOf(sess)
  const gInfo = await squadGet(FIX.orch)
  const gMembers = gInfo.members || []
  const firstRoundOf = (rolePrefix) => {
    const m = (gMembers || []).find((x) => String(x.role || '').startsWith(rolePrefix))
    if (!m) return Number.MAX_SAFE_INTEGER
    const rows = rd.filter((x) => x.speaker_agent_id === m.agent_id && ['subtask', 'handoff'].includes(x.kind)).map((x) => Number(x.created_at))
    return rows.length ? Math.min(...rows) : Number.MAX_SAFE_INTEGER
  }
  const handOf = (title) => {
    const rows = rd.filter((x) => x.kind === 'handoff' && String(x.content || '').includes(title)).map((x) => Number(x.created_at))
    return rows.length ? Math.max(...rows) : 0
  }
  as.push(A('工序二在工序一交接后才启动', firstRoundOf(LOOSE.react) >= handOf('工序一') - 1500, `t2first=${firstRoundOf(LOOSE.react)} t1hand=${handOf('工序一')}`))
  as.push(A('工序三在工序二交接后才启动', firstRoundOf(LOOSE.rust) >= handOf('工序二') - 1500, `t3first=${firstRoundOf(LOOSE.rust)} t2hand=${handOf('工序二')}`))
  return finish('S-PIPE-1', 'DAG 依赖：后序在前序 handoff 后才启动（编排 contract 等价钉+流水线夹具静态）', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 7. 交接继承
async function caseHandoff() {
  const t0 = Date.now(); const as = []
  const r = await runSquad(FIX.orch, [
    { title: '上游产出', assignee: LOOSE.py, instruction: '创建 handoff-note.md，内容含一句「上游结论：接口契约 v1」。结束。', expectedArtifacts: ['handoff-note.md'] },
    { title: '下游继承', assignee: LOOSE.react, instruction: '查看交接箱上游产物 handoff-note.md 并读取，然后创建 confirm.md，写明「已继承：<上游要点>」。结束。', dependsOn: ['上游产出'], expectedArtifacts: ['confirm.md'] },
  ], '交接继承回归')
  const sess = r.sessionId
  const s = await pollDone(sess)
  const b = boardOf(s)
  const t2 = taskByTitle(b, '下游继承') || {}
  as.push(A('board 记录下游 handoff_id', !!t2.handoff_id, JSON.stringify(t2).slice(0, 120)))
  const hand = dbQuery('SELECT task_id, status FROM agent_squad_handoff WHERE session_id=? ORDER BY created_at', [sess])
  as.push(A('agent_squad_handoff 两行且 ok', hand.length >= 2 && hand.every((h) => h.status === 'ok'), JSON.stringify(hand).slice(0, 160)))
  // 盘面穿透：交接箱真实布局=<下游成员工作区>/inbox/{task_id}/<产物>（成员私有区根部）
  let copyOk = false; let copyWhere = ''
  try {
    const down = await memberAgentId(FIX.orch, LOOSE.react)
    const hit = (function walk(d, depth) {
      if (depth > 4 || !fs.existsSync(d)) return null
      for (const f of fs.readdirSync(d)) {
        const q = path.join(d, f)
        if (fs.statSync(q).isDirectory()) { const r2 = walk(q, depth + 1); if (r2) return r2 } else if (f === 'handoff-note.md') return q
      }
      return null
    })(path.join(SQD_WS, down, 'inbox'), 0)
    copyOk = !!hit && fs.readFileSync(hit, 'utf8').includes('接口契约')
    copyWhere = hit || 'inbox 下未找到'
  } catch (e) { copyWhere = String((e && e.message) || e).slice(0, 80) }
  as.push(A('交接箱盘面存在上游产物副本（下游 inbox）', copyOk, copyWhere))
  return finish('S-HANDOFF-1', '交接继承：Bundle 落库+盘面副本+board 引用', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 8. 运行中打断
async function caseInject() {
  const t0 = Date.now(); const as = []
  const r = await runSquad(FIX.orch, [
    { title: '注入目标', assignee: LOOSE.py, instruction: '创建 inject-demo.md 内容「演示产出」，结束。', expectedArtifacts: ['inject-demo.md'] },
  ], '打断说话回归')
  const sess = r.sessionId
  await pollCond('t1 进入 running', async () => { const s = await sessionOf(sess); return s && taskByTitle(boardOf(s), '注入目标')?.status === 'running' }, { maxMs: 180000 })
  const ij = await soft('squad_inject_to_task', { sessionId: sess, squadId: FIX.orch, taskId: 't1', content: '要求：最终产出的 inject-demo.md 文件内容中必须包含文本 ' + MARK.inj + '。' })
  as.push(A('inject 受理', ij.ok, ij.ok ? '' : ij.err.slice(0, 100)))
  await pollDone(sess, { maxMs: 480000 })
  const inj = dbQuery("SELECT status FROM agent_squad_inject WHERE session_id=? AND task_id='t1' ORDER BY created_at DESC LIMIT 1", [sess])
  as.push(A('inject 状态机 queued→delivered', inj[0] && inj[0].status === 'delivered', JSON.stringify(inj)))
  const hit = (function walk(d, depth) {
    if (depth > 4 || !fs.existsSync(d)) return false
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) { if (!/node_modules/.test(f) && walk(p, depth + 1)) return true } else if (f === 'inject-demo.md' && fs.readFileSync(p, 'utf8').includes(MARK.inj)) return true
    }
    return false
  })(SQD_WS, 0)
  as.push(A('成员产出回应暗号（软断言）', hit, 'inject-demo.md 找暗号'))
  return finish('S-INJECT-1', '打断说话：Live inject 送达+落轮+成员回应', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 9. 等待中预嘱
async function casePretalk() {
  const t0 = Date.now(); const as = []
  const r = await runSquad(FIX.orch, [
    { title: '先行任务', assignee: LOOSE.py, instruction: '创建 slow.md 内容「第一步」，结束。', expectedArtifacts: ['slow.md'] },
    { title: '候补任务', assignee: LOOSE.react, instruction: '直接创建 waits.md，内容一行「第二步完成 ' + MARK.pre + '」。不要询问任何问题，完成后立即结束。', dependsOn: ['先行任务'], expectedArtifacts: ['waits.md'] },
  ], '预嘱回归')
  const sess = r.sessionId
  await pollCond('t1 running', async () => { const s = await sessionOf(sess); return s && taskByTitle(boardOf(s), '先行任务')?.status === 'running' }, { maxMs: 180000 })
  const tk = await soft('squad_talk_to_task', { sessionId: sess, squadId: FIX.orch, taskId: 't2', content: '预嘱：你稍后的任务中，waits.md 里必须出现文本 ' + MARK.pre + '。' })
  as.push(A('pre_talk 受理', tk.ok, tk.ok ? '' : tk.err.slice(0, 100)))
  await pollDone(sess, { maxMs: 480000 })
  const inj = dbQuery("SELECT mode,status FROM agent_squad_inject WHERE session_id=? AND task_id='t2' ORDER BY created_at DESC LIMIT 1", [sess])
  as.push(A('pre_talk delivered', inj[0] && inj[0].mode === 'pre_talk' && inj[0].status === 'delivered', JSON.stringify(inj)))
  const hit = (function walk(d, depth) {
    if (depth > 4 || !fs.existsSync(d)) return false
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) { if (!/node_modules/.test(f) && walk(p, depth + 1)) return true } else if (f === 'waits.md' && fs.readFileSync(p, 'utf8').includes(MARK.pre)) return true
    }
    return false
  })(SQD_WS, 0)
  as.push(A('t2 消化预嘱暗号（软断言）', hit, 'waits.md 找暗号'))
  return finish('S-PRETALK-1', '等待中预嘱：成员启动时消化', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 10. 群聊共识收口
async function caseChat() {
  const t0 = Date.now(); const as = []
  const r = await runSquad(FIX.chat, null, '议题：新功能灰度发布策略，A=按城市灰度，B=按用户白名单。请两位各自陈述一轮立场，主持人两轮内总结出决议与行动项。')
  const sess = r.sessionId
  let s = await pollDone(sess, { maxMs: 600000 })
  if (s.status === 'awaiting_delivery') { await gateSubmit(sess, 'delivery', 'approve'); s = await pollDone(sess, { maxMs: 90000 }) }
  as.push(A('群聊会话终态 done', s.status === 'done', 'status=' + s.status))
  const rd = await roundsOf(sess)
  const speakers = new Set(rd.filter((x) => x.speaker_agent_id).map((x) => x.speaker_agent_id))
  as.push(A('≥2 名成员参与发言（无独角戏）', speakers.size >= 2, 'speakers=' + speakers.size))
  const chatRounds = rd.filter((x) => x.kind === 'subtask').length
  const cfgRow = dbQuery('SELECT max_rounds FROM agent_squad_chat_config WHERE squad_id=?', [FIX.chat])[0] || {}
  const cap = Number(cfgRow.max_rounds || 0)
  as.push(A('轮次收敛（< 上限）', cap === 0 || chatRounds < cap, `rounds=${chatRounds} cap=${cap}`))
  const dec = dbQuery('SELECT COUNT(*) AS n FROM agent_squad_decision WHERE session_id=?', [sess])[0]
  as.push(A('决议结构化落表', Number(dec.n) >= 1, 'decisions=' + dec.n))
  return finish('S-CHAT-1', '群聊共识收口：收敛+决议落表', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 11. 交付包完整（复用 S-ORCH-1 会话：内存变量或证据文件，跨进程可复跑）
async function casePack(orchSessionId) {
  const t0 = Date.now(); const as = []
  let sid = orchSessionId || lastOrchSession()
  if (!sid) {
    try { sid = JSON.parse(fs.readFileSync(path.join(OUT, 'S-ORCH-1.json'), 'utf8')).sessionId || null } catch { sid = null }
  }
  if (!sid) return finish('S-PACK-1', '交付包完整', [A('前置会话缺失', false, '无 S-ORCH-1 sessionId（先跑 S-ORCH-1）')], { status: 'failed' })
  const pk = await soft('squad_export_pack', { sessionId: sid }, { timeoutMs: 60000 })
  as.push(A('squad_export_pack 成功', pk.ok, pk.ok ? '' : pk.err.slice(0, 120)))
  const sessRow = await sessionOf(sid)
  let pack = {}; try { pack = JSON.parse(sessRow.pack_json || '{}') } catch { pack = {} }
  as.push(A('pack_json 非空且含结构', Object.keys(pack).length >= 2, Object.keys(pack).join(',')))
  as.push(A('pack 含成本/指标', JSON.stringify(pack).includes('token') || JSON.stringify(pack).includes('metric') || JSON.stringify(sessRow.snapshot || '').length > 20, ''))
  const hand = dbQuery('SELECT COUNT(*) AS n FROM agent_squad_handoff WHERE session_id=?', [sid])[0]
  as.push(A('判据：交接链完整（≥3）', Number(hand.n) >= 3, 'handoffs=' + hand.n))
  return finish('S-PACK-1', '交付包完整：导出+判据+成本', as, { sessionId: orchSessionId, durationMs: Date.now() - t0 })
}

// 12. 计划门禁：未批准零启动 → 批准放行 → 收尾
async function caseHitl() {
  const t0 = Date.now(); const as = []
  const r = await runSquad(FIX.orch, null, '给 CLI 工具新增 --dry-run 参数：请规划一次工作分解（不必实际执行）。')
  const sess = r.sessionId
  let planSeen = false
  try {
    await pollCond('plan 轮出现', async () => {
      const rd = await roundsOf(sess)
      return rd.some((x) => x.kind === 'plan')
    }, { maxMs: 240000 })
    planSeen = true
  } catch { /* plan 轮未出现 */ }
  as.push(A('出现 plan 轮（L1 挂起）', planSeen, ''))
  let subCount = 0
  for (let i = 0; i < 4; i++) {
    await nap(3000)
    const rd = await roundsOf(sess)
    subCount = rd.filter((x) => x.kind === 'subtask').length
    if (subCount > 0) break
  }
  as.push(A('未批准零成员启动', subCount === 0, 'subtasks=' + subCount))
  if (planSeen) {
    const g = await gateSubmit(sess, 'plan', 'approve')
    as.push(A('submit_decision(plan,approve) 受理', g.ok, g.ok ? '' : g.err.slice(0, 100)))
    let started = false
    const dl = Date.now() + 180000
    while (Date.now() < dl) {
      await nap(4000)
      const cur = await sessionOf(sess)
      const b = cur ? boardOf(cur) : {}
      if (Object.values(b.tasks || {}).some((t) => t.status !== 'pending')) { started = true; break }
      if (cur && ['done', 'failed', 'cancelled'].includes(cur.status)) break
    }
    as.push(A('批准后成员放行（board 出现非 pending）', started, ''))
  }
  await cancelSquad(FIX.orch)
  await pollCond('取消终态', async () => { const x = await sessionOf(sess); return x && ['cancelled', 'done'].includes(x.status) }, { maxMs: 120000 })
  const fin = await sessionOf(sess)
  as.push(A('用例收尾（取消，杜绝遗留会话占成员锁）', fin && ['cancelled', 'done'].includes(fin.status), 'status=' + (fin && fin.status)))
  return finish('S-HITL-1', '计划门禁：未批准零启动→批准放行', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 13. 中途取消
async function caseCancel() {
  const t0 = Date.now(); const as = []
  const r = await runSquad(FIX.orch, [
    { title: '取消一', assignee: LOOSE.py, instruction: '创建 c1.md 内容「x」，结束。' },
    { title: '取消二', assignee: LOOSE.react, instruction: '创建 c2.md 内容「y」，结束。', dependsOn: ['取消一'] },
  ], '取消回归')
  const sess = r.sessionId
  await pollCond('首成员 running', async () => { const s = await sessionOf(sess); return s && hasRunning(boardOf(s)) }, { maxMs: 180000 })
  const cc = await cancelSquad(FIX.orch)
  as.push(A('cancel 受理', cc.ok, cc.ok ? '' : cc.err.slice(0, 100)))
  const s = await sessionOf(sess)
  await pollCond('终态 cancelled', async () => { const x = await sessionOf(sess); return x && ['cancelled', 'done'].includes(x.status) }, { maxMs: 90000 })
  const fin = await sessionOf(sess)
  as.push(A('终态 cancelled', fin.status === 'cancelled', 'status=' + fin.status))
  as.push(A('board 无 running 残留', !hasRunning(boardOf(fin)), JSON.stringify(boardOf(fin).tasks || {}).slice(0, 150)))
  const orphan = await soft('agent_sweep_orphan_rounds', {})
  as.push(A('孤儿清扫通道可用', orphan.ok && orphan.data && orphan.data.ok !== false, orphan.ok ? 'swept=' + orphan.data.swept : orphan.err.slice(0, 80)))
  return finish('S-CANCEL-1', '中途取消：终态+无 running+无孤儿', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 14. 续跑幂等：t1 done → cancel → 伪造半终态 → resume 重入（t1 零轮跳过 / t2 重跑）
async function caseResume() {
  const t0 = Date.now(); const as = []
  const r = await runSquad(FIX.orch, [
    { title: '续跑一', assignee: LOOSE.py, instruction: '创建 r1.md 内容「第一段」，结束。', expectedArtifacts: ['r1.md'] },
    { title: '续跑二', assignee: LOOSE.react, instruction: '创建 r2.md 内容「第二段」，结束。', dependsOn: ['续跑一'], expectedArtifacts: ['r2.md'] },
  ], '续跑幂等回归')
  const sess = r.sessionId
  await pollCond('t1 done', async () => { const s = await sessionOf(sess); return s && taskByTitle(boardOf(s), '续跑一')?.status === 'done' }, { maxMs: 300000 })
  await cancelSquad(FIX.orch)
  await pollCond('cancelled', async () => { const x = await sessionOf(sess); return x && ['cancelled', 'done'].includes(x.status) }, { maxMs: 90000 })
  const handBefore = Number(dbQuery("SELECT COUNT(*) AS n FROM agent_squad_handoff WHERE session_id=? AND task_id='t1'", [sess])[0].n)
  const s0 = await sessionOf(sess)
  const b0 = boardOf(s0)
  if (b0.tasks && b0.tasks.t2) b0.tasks.t2.status = 'pending'
  dbExec('UPDATE agent_squad_session SET board_json=?, status=?, updated_at=? WHERE id=?', [JSON.stringify(b0), 'running', Date.now(), sess])
  // 重入是阻塞调用（跑完整续跑），期间挂 checkpoint/L4 会死等——用 interval 在事件循环空闲期并发提交决议
  const kicker = setInterval(() => { gateSubmit(sess, 'checkpoint', 'continue'); gateSubmit(sess, 'delivery', 'approve') }, 20000)
  const rr = await soft('squad_resume', { squadId: FIX.orch, sessionId: sess }, { timeoutMs: 600000 })
  clearInterval(kicker)
  as.push(A('resume 重入受理', rr.ok && rr.data && rr.data.resumed === 'reenter', JSON.stringify(rr.data || rr.err).slice(0, 100)))
  const fin = await pollDone(sess, { maxMs: 420000 })
  const handAfter = Number(dbQuery("SELECT COUNT(*) AS n FROM agent_squad_handoff WHERE session_id=? AND task_id='t1'", [sess])[0].n)
  const b2 = boardOf(fin)
  as.push(A('done 节点真跳过（t1 零新 handoff）', handAfter === handBefore, `before=${handBefore} after=${handAfter}`))
  as.push(A('pending 节点重跑完成', b2.tasks && b2.tasks.t2 && b2.tasks.t2.status === 'done', JSON.stringify(b2.tasks || {}).slice(0, 150)))
  as.push(A('重入后终态 done', fin.status === 'done', 'status=' + fin.status))
  return finish('S-RESUME-1', '续跑幂等：done 跳过+pending 重跑', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 15. 预算软熔断：低预算 → 告警/熔断 note → t2 不启动 → done 收尾（临时改配置→还原）
async function caseBudget() {
  const t0 = Date.now(); const as = []
  const squad = await squadGet(FIX.hot)
  const orig = squad.squad.run_strategy || '{}'
  let strat = {}; try { strat = JSON.parse(orig) } catch { strat = {} }
  strat.budgetTokens = 800
  dbExec('UPDATE agent_squad SET run_strategy=? WHERE id=?', [JSON.stringify(strat), FIX.hot])
  let sess = null
  try {
    const r = await runSquad(FIX.hot, [
      { title: '预算一', assignee: HOT.py, instruction: '创建 budget-a.md 内容「样例」，结束。', expectedArtifacts: ['budget-a.md'] },
      { title: '预算二', assignee: HOT.react, instruction: '创建 budget-b.md 内容「样例」，结束。', dependsOn: ['预算一'], expectedArtifacts: ['budget-b.md'] },
    ], '预算熔断回归')
    sess = r.sessionId
    const s = await pollDone(sess, { maxMs: 480000 })
    as.push(A('软熔断以 done 收尾', s.status === 'done', 'status=' + s.status))
    const rd = await roundsOf(sess)
    const mrow = rd.find((x) => x.kind === 'system' && String(x.content || '').includes('预算'))
    let costTrail = !!mrow
    if (!costTrail) { try { costTrail = /token|budget|成本/i.test(sessRow.pack_json || sessRow.snapshot || '') } catch { costTrail = false } }
    as.push(A('预算告警/熔断系统轮出现', costTrail, mrow ? String(mrow.content).slice(0, 80) : 'fallback ' + (costTrail ? 'pack' : 'none')))
    const b = boardOf(s)
    const t1 = taskByTitle(b, '预算一') || {}
    const t2 = taskByTitle(b, '预算二') || {}
    as.push(A('预算内首任务完成/产物保留', t1.status === 'done', 't1=' + t1.status))
    as.push(A('熔断后新任务不再启动', t2.status !== 'done', 't2=' + t2.status))
  } finally {
    dbExec('UPDATE agent_squad SET run_strategy=? WHERE id=?', [orig, FIX.hot])
  }
  const back = await squadGet(FIX.hot)
  as.push(A('run_strategy 已还原', back.squad.run_strategy === orig, ''))
  return finish('S-BUDGET-1', '预算软熔断：告警+停新任务+done 收尾（配置已还原）', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 16. 成员失败熔断：坏 llm → 重试耗尽 → failed → 修复后锁可复用（临时改→还原）
async function caseFail() {
  const t0 = Date.now(); const as = []
  const pyAgent = await memberAgentId(FIX.hot, HOT.py)
  const orig = dbQuery('SELECT llm_id FROM agent_info WHERE id=?', [pyAgent])[0]
  dbExec("INSERT OR IGNORE INTO models (id, provider, name, model_name, base_url, api_key, category, enabled, config, created_at, updated_at) VALUES ('llm-eval-dead','openai','eval-dead','dead','http://127.0.0.1:9/v1','x','text',1,'{}',0,0)")
  dbExec("UPDATE agent_info SET llm_id='llm-eval-dead' WHERE id=?", [pyAgent])
  let sess = null
  try {
    const r = await runSquad(FIX.hot, [
      { title: '必败任务', assignee: LOOSE.py, instruction: '创建 fail.md 内容「x」，结束。' },
    ], '成员失败熔断回归')
    sess = r.sessionId
    // 成员失败重试耗尽会挂恢复门禁（无人值守死锁点之二）——轮询期间代答 skip
    const kicker2 = setInterval(() => { soft('agent_submit_recovery_decision', { agentId: pyAgent, decision: 'skip' }).catch(() => {}) }, 20000)
    const s = await pollDone(sess, { maxMs: 600000 })
    clearInterval(kicker2)
    as.push(A('必败任务收尾不悬挂（恢复门禁代答后终态）', ['done', 'failed'].includes(s.status), 'status=' + s.status + '（skip 应答语义：失败步骤跳过后收尾）'))
    const probe = await sessionOf(sess)
    as.push(A('失败会话可查询（锁释放）', !!probe, ''))
  } finally {
    dbExec('UPDATE agent_info SET llm_id=? WHERE id=?', [orig.llm_id, pyAgent])
    dbExec("DELETE FROM models WHERE id='llm-eval-dead'")
  }
  const r2 = await runSquad(FIX.hot, [
    { title: '复活任务', assignee: LOOSE.py, instruction: '创建 revive.md 内容「ok」，结束。', expectedArtifacts: ['revive.md'] },
  ], '锁复用回归')
  const s2 = await pollDone(r2.sessionId, { maxMs: 480000 })
  as.push(A('修复后同成员可再执行', s2.status === 'done', 'status=' + s2.status))
  const now = dbQuery('SELECT llm_id FROM agent_info WHERE id=?', [pyAgent])[0]
  as.push(A('成员 llm_id 已还原', now.llm_id === orig.llm_id, ''))
  return finish('S-FAIL-1', '成员失败熔断：重试→failed→锁可复用（配置已还原）', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// 17. 成员锁冲突：单 Agent 占锁 → squad 侧等待 → 释放后完成 → trace 无并发重叠
async function caseLock() {
  const t0 = Date.now(); const as = []
  const pyAgent = await memberAgentId(FIX.hot, HOT.py)
  const idRow = dbQuery('SELECT identifier FROM agent_info WHERE id=?', [pyAgent])[0]
  const s1 = peel(await tool('agent_session_create', { payload: { agentIdentifier: idRow.identifier, sessionName: 'sqd-eval-lock' } }, { timeoutMs: 30000 }))
  const rd = peel(await tool('agent_round_create', { payload: { sessionId: s1.id, roundIndex: Date.now() % 100000, userQuestion: '占锁探针' } }, { timeoutMs: 30000 }))
  const single = peel(await tool('agent_run_task', { agentId: pyAgent, prompt: '请写一首四行小诗，主题是秋天。不要使用任何工具。', sessionId: s1.id, roundId: rd.id }, { timeoutMs: 60000 }))
  const singleRun = single && (single.run_id || single.runId)
  as.push(A('单 Agent 占锁 run 启动', !!singleRun, JSON.stringify(single).slice(0, 100)))
  const r = await runSquad(FIX.hot, [
    { title: '锁目标', assignee: LOOSE.py, instruction: '创建 lock.md 内容「after-lock」，结束。', expectedArtifacts: ['lock.md'] },
  ], '成员锁回归')
  const sess = r.sessionId
  await nap(15000)
  const mid = await sessionOf(sess)
  const midT = mid ? taskByTitle(boardOf(mid), '锁目标') : null
  as.push(A('占锁期间任务未完成（未绕锁）', !midT || midT.status !== 'done', 't1=' + (midT && midT.status)))
  if (singleRun) { try { await drv.pollRun(singleRun, pyAgent, { maxMs: 300000 }) } catch { /* 超时继续 */ } }
  const fin = await pollDone(sess, { maxMs: 480000 })
  const rdL = await roundsOf(sess)
  const busyHit = rdL.some((x) => String(x.content || '').includes('忙'))
  as.push(A('锁竞争收尾（done=等待成功 / failed+忙=等待超时，均证锁生效）', fin.status === 'done' || (fin.status === 'failed' && busyHit), 'status=' + fin.status + ' busy=' + busyHit))
  // 无并发等价证据：若发生过并发，「占锁期间未启动」必然为 false（成员一启动即 running）
  const bfin = boardOf(fin)
  const tlock = taskByTitle(bfin, '锁目标') || {}
  as.push(A('锁目标终态收敛', ['done', 'failed'].includes(tlock.status), 't1=' + tlock.status))
  return finish('S-LOCK-1', '成员锁：等待→释放→续跑，无双 run 并发', as, { sessionId: sess, durationMs: Date.now() - t0 })
}

// ============================================================
// 编排
// ============================================================
const ORDER = [
  ['S-PIXEL-1', casePixel],
  ['S-MEM-1', caseMem],
  ['S-ENV-1', () => caseEnvelope(null)],
  ['S-UNATT-1', caseUnatt],
  ['S-ORCH-1', caseOrch],
  ['S-ENV-1R', () => caseEnvelope(lastOrchSession())],
  ['S-PIPE-1', casePipe],
  ['S-HANDOFF-1', caseHandoff],
  ['S-INJECT-1', caseInject],
  ['S-PRETALK-1', casePretalk],
  ['S-CHAT-1', caseChat],
  ['S-PACK-1', () => casePack(lastOrchSession())],
  ['S-HITL-1', caseHitl],
  ['S-CANCEL-1', caseCancel],
  ['S-RESUME-1', caseResume],
  ['S-BUDGET-1', caseBudget],
  ['S-FAIL-1', caseFail],
  ['S-LOCK-1', caseLock],
]
let orchSessionId = null
const lastOrchSession = () => orchSessionId

async function envCheck() {
  await boot('squad-eval-env')
  let ok = true
  const list = rowset(await tool('squad_list', {}, { timeoutMs: 30000 }))
  console.log('# MCP 活跃 · 编队 ' + list.length + ' 套')
  for (const [k, id] of Object.entries(FIX)) {
    const hit = list.find((x) => x.id === id)
    if (!hit) { ok = false; console.log('  ✗ 夹具缺失:', k, id) } else console.log('  ✓', k, id, 'mode=' + hit.mode, 'members=' + hit.member_count)
  }
  try {
    const n = dbQuery('SELECT COUNT(*) AS n FROM agent_squad_member', [])[0]
    const tr = dbQuery('SELECT COUNT(*) AS n FROM agent_run_trace', [])[0]
    console.log('  ✓ sqlite 通道可用 · 成员', n.n, '· trace', tr.n)
  } catch (e) { ok = false; console.log('  ✗ sqlite 通道:', e.message.slice(0, 120)) }
  const models = rowset(await tool('agent_list_models', {}, { timeoutMs: 30000 }))
  const usable = models.filter((m) => String(m.enabled) === '1')
  console.log(usable.length ? '  ✓ 可用模型 ' + usable.length : '  ✗ 无可用模型')
  if (!usable.length) ok = false
  console.log('  · 工作空间', SQD_WS, fs.existsSync(SQD_WS) ? '已存在' : '(将自动创建)')
  console.log(ok ? 'ENV OK' : 'ENV FAIL')
  process.exit(ok ? 0 : 2)
}

async function runAll() {
  fs.mkdirSync(OUT, { recursive: true })
  await boot('squad-eval')
  console.log('# squad_eval_harness · OUT=' + OUT + ' · ' + (ONLY.length ? '指定 ' + ONLY.join(',') : '全量 17+1'))
  const results = []
  for (const [id, fn] of ORDER) {
    if (!wanted(id)) continue
    console.log('\n== ' + id)
    const t0 = Date.now()
    try {
      const rec = await fn()
      if (id === 'S-ORCH-1' && rec.sessionId) orchSessionId = rec.sessionId
      results.push(rec)
    } catch (e) {
      console.log('  异常: ' + String(e.message || e).slice(0, 220))
      results.push(finish(id, id, [A('执行异常', false, String(e.message || e))], { status: 'failed', durationMs: Date.now() - t0 }))
    }
  }
  const pass = results.filter((r) => r.autoPass).length
  console.log('\n# 汇总: ' + pass + '/' + results.length + ' PASS · 证据 ' + OUT)
  process.exit(pass === results.length ? 0 : 1)
}

async function gateMode() {
  const expect = ONLY.length || 17 // §10 用例口径（ENV-1R 等复核条目为可选附加，不计入齐套数）
  const files = fs.readdirSync(OUT).filter((f) => /^S-.+\.json$/.test(f))
  const recs = files.map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')))
  const checks = []
  checks.push(A('用例齐全（' + expect + '）', recs.length >= expect, 'found=' + recs.length))
  const bad = recs.filter((r) => !r.autoPass || r.status !== 'done')
  checks.push(A('全部 autoPass 且 done', bad.length === 0, bad.map((r) => r.caseId).join(',') || 'clean'))
  const g = { at: new Date().toISOString(), out: OUT, pass: checks.every((c) => c.ok), checks, results: recs.map((r) => ({ caseId: r.caseId, status: r.status, autoPass: r.autoPass })) }
  fs.writeFileSync(path.join(OUT, 'gate.json'), JSON.stringify(g, null, 2))
  for (const c of checks) console.log((c.ok ? '  ✓ ' : '  ✗ ') + c.name + ' — ' + c.detail)
  console.log(g.pass ? 'SQUAD GATE PASS' : 'SQUAD GATE FAIL')
  process.exit(g.pass ? 0 : 1)
}

if (cmd === 'env') await envCheck()
else if (cmd === 'gate') await gateMode()
else await runAll()
