// caplib —— capability-v2 共享库：环境/装配/驱动/轨迹/断言/文件/seed 装载。
// 约定与 v1 对齐：一律 import 复用 workduo-mcp skill 的 agent_task_driver.mjs，禁止复刻客户端逻辑。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---- 驱动库解析（项目内副本优先）----
const DRIVER_CANDIDATES = [
  path.resolve(__dirname, '../../skills/workduo-mcp/scripts/agent_task_driver.mjs'),
  path.resolve(__dirname, '../../../skills/workduo-mcp/scripts/agent_task_driver.mjs'),
]
const driverPath = DRIVER_CANDIDATES.find((p) => fs.existsSync(p))
if (!driverPath) {
  console.error('找不到 agent_task_driver.mjs，已尝试：', DRIVER_CANDIDATES)
  process.exit(3)
}
const drv = await import (pathToFileURL(driverPath))
export const { initMcp, callTool, unw, asRows, sleep, traceInner, pollRun, startRun, rawPost, extractKbEvents, hitsOf, logFetcher } = drv

// ---- 环境与路径 ----
export const ROOT = process.env.CAP2_WS_ROOT || 'E:/Codes/ABC/work-duo/eval-workspace/capability2'
export const OUT = process.env.OUT || path.resolve(__dirname, '../../eval-results/capability2-' + stamp())
export const WAIT_MS = parseInt(process.env.CAP2_WAIT_MS || '600000', 10)
export const TOKEN_BUDGET_SIMPLE = parseInt(process.env.CAP2_TOKEN_BUDGET_SIMPLE || '8000', 10)
export const DEMO_PREFIX = 'cap2-demo-'
export const SKILL_PREFIX = 'cap2-test-skill-'
export const PLUG_PREFIX = 'cap2-test-pl-'
export const KB_PREFIX = 'cap2-test-kb-'
export const SEEDS_DIR = path.resolve(__dirname, '../../skills/workduo-mcp/scripts/seeds')
const PLUGIN_SCRIPTS_DIR = path.resolve(__dirname, '../../skills/workduo-mcp/scripts')

/** 读 workduo-mcp skill 的官方插件模板文本（plugin.xlsx_writer.template.py 等）。 */
export function readSkillScript(name) {
  return readFileSafe(path.join(PLUGIN_SCRIPTS_DIR, name))
}

export function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
export function ensureOut() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(ROOT, { recursive: true })
}
export function wsOf(caseId, sub = '') {
  const dir = sub ? path.join(ROOT, caseId, sub) : path.join(ROOT, caseId)
  fs.mkdirSync(dir, { recursive: true })
  return dir.replace(/\\/g, '/')
}
export function saveResult(obj) {
  ensureOut()
  fs.writeFileSync(path.join(OUT, `${obj.caseId}.json`), JSON.stringify(obj, null, 2))
  return obj
}

// ---- 断言助手 ----
export function A(name, ok, detail = '') {
  return { name, ok: !!ok, detail: String(detail).slice(0, 400) }
}
export function finish(caseId, dim, title, asserts, extra = {}) {
  const autoPass = asserts.length > 0 && asserts.every((a) => a.ok)
  const obj = {
    caseId, dim, title,
    status: extra.status || (autoPass ? 'done' : 'failed'),
    autoPass, autoScore: autoPass ? 1 : 0,
    durationMs: extra.durationMs || 0,
    asserts, counts: extra.counts || {}, runId: extra.runId || null,
    notes: extra.notes || '', at: new Date().toISOString(),
  }
  console.log(`  → ${caseId} autoPass=${autoPass} ${asserts.filter((x) => x.ok).length}/${asserts.length}`)
  return saveResult(obj)
}
export function skipResult(caseId, dim, title, reason) {
  console.log(`  → ${caseId} SKIPPED: ${reason}`)
  return saveResult({ caseId, dim, title, status: 'skipped', autoPass: false, autoScore: 0, asserts: [A('skipped', true, reason)], notes: reason, at: new Date().toISOString() })
}

// ---- 条件等待 ----
export async function waitFor(desc, fn, { maxMs = 120000, intervalMs = 3000 } = {}) {
  const t0 = Date.now()
  for (;;) {
    let v
    try { v = await fn() } catch (e) { v = null }
    if (v) return v
    if (Date.now() - t0 > maxMs) throw new Error(`waitFor 超时: ${desc}（${Math.round(maxMs / 1000)}s）`)
    await sleep(intervalMs)
  }
}

// ---- 装配 ----
let MODEL = null
export function currentModel() { return MODEL }
export async function pickModel() {
  const models = asRows(await callTool('agent_list_models', {}))
  const pref = process.env.CAP2_MODEL_ID
  const hit = pref
    ? models.find((m) => m.id === pref)
    : models.find((m) => String(m.enabled) === '1' && String(m.tool_calls) === '1' && m.category === 'multimodal')
      || models.find((m) => String(m.enabled) === '1' && String(m.tool_calls) === '1')
  if (!hit) throw new Error('无可用 tool_calls 模型')
  MODEL = hit
  return hit
}
export function hasVisionModel() {
  const models = asRows(cachedModels || [])
  return models.some((m) => String(m.enabled) === '1' && m.category === 'multimodal')
}
let cachedModels = null
export async function loadModels() { cachedModels = await callTool('agent_list_models', {}); return asRows(cachedModels) }

export async function createAgent({ tag, skillIds = [], pluginIds = [], kbIds = [], memoryMode = 'off', autoToolExecMode = true, planAutoApproveMode = 'never', allowSandbox = true, systemPrompt = '你是 WorkDuo 测试助手，用简体中文回答，按用户要求严格产出。' } = {}) {
  if (!MODEL) await pickModel()
  const scenarios = asRows(await callTool('agent_list_scenarios', {}))
  const identifier = `${DEMO_PREFIX}${tag}-${Date.now().toString(36)}`
  const llmConfig = typeof MODEL.config === 'string' ? JSON.parse(MODEL.config) : (MODEL.config || {})
  const ag = unw(await callTool('agent_ui_create', {
    payload: {
      name: `能力测评v2-${tag}`, identifier,
      scenario: scenarios.find((s) => s.value === 'dev-programming')?.value || scenarios[0]?.value || 'dev-programming',
      description: 'capability v2 demo', systemPrompt,
      llmId: MODEL.id, llmConfig,
      isActive: true, autoToolExecMode, allowSandbox, memoryMode,
      planAutoApproveMode, skillIds, pluginIds, kbIds,
    },
  }, { timeoutMs: 20000 }))
  return { ...ag, identifier }
}
export async function deleteAgent(id) {
  try { await callTool('agent_ui_delete', { id }, { timeoutMs: 15000 }) } catch (e) { console.log('  [warn] delete agent', e.message.slice(0, 80)) }
}
export async function mkSession(agentIdentifier, name = 'cap2') {
  return unw(await callTool('agent_session_create', { payload: { agentIdentifier, sessionName: name } }, { timeoutMs: 20000 }))
}
export async function getTrace(runId) {
  return traceInner(unw(await callTool('agent_get_run_trace', { run_id: runId }, { timeoutMs: 20000 })))
}

// ---- 轨迹视图 ----
export function toolNames(trace) {
  const evs = Array.isArray(trace?.events) ? trace.events : []
  const names = []
  for (const e of evs) {
    const p = e?.payload || {}
    if ((p.type || p.eventType) === 'tool_started') names.push(p.step?.toolName || '?')
  }
  return names
}
export function eventTypes(trace) {
  const evs = Array.isArray(trace?.events) ? trace.events : []
  return evs.map((e) => (e?.payload || {}).type || (e?.payload || {}).eventType || '?')
}
export function hasWrite(trace) {
  return toolNames(trace).some((n) => /write|edit|create_file|delete|replace/i.test(n))
}
export function replyOf(trace) { return String(trace?.reply || '') }
export function tokensOf(trace) {
  const c = trace?.counts || {}
  return { prompt: c.prompt_tokens || c.promptTokens || 0, completion: c.completion_tokens || c.completionTokens || 0 }
}

// ---- 文件视图 ----
export function filesIn(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      const st = fs.statSync(p)
      if (st.isDirectory()) { if (!/\.wd_mem$|\.attachments$|node_modules$/.test(f)) walk(p) } else out.push({ name: f, path: p, size: st.size })
    }
  }
  walk(dir)
  return out
}
export function fileHas(dir, name, substr) {
  const hit = filesIn(dir).find((f) => f.name === name || f.name.endsWith(name))
  if (!hit) return { ok: false, detail: `missing ${name}` }
  if (substr === undefined || substr === null || substr === '') return { ok: true, detail: hit.path, path: hit.path }
  const text = fs.readFileSync(hit.path, 'utf8')
  return { ok: text.includes(substr), detail: text.slice(0, 120), path: hit.path }
}
export function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
export function findFile(dir, name) { return filesIn(dir).find((f) => f.name === name || f.name.endsWith(name)) || null }
/** 取工作空间内指定名文件的完整文本（找不到返回 null）。 */
export function fileText(dir, name) {
  const hit = findFile(dir, name)
  return hit ? readFileSafe(hit.path) : null
}

// 二进制产物魔数校验（xlsx=PK zip 头 / png=89 50 4E 47）
export function magicOk(p, kind) {
  try {
    const fd = fs.openSync(p, 'r')
    const buf = Buffer.alloc(8)
    fs.readSync(fd, buf, 0, 8, 0)
    fs.closeSync(fd)
    if (kind === 'png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    if (kind === 'xlsx') return buf[0] === 0x50 && buf[1] === 0x4b
    return false
  } catch { return false }
}

// ---- 附件构造（流程 1.2 契约：text=content 内联 / file=dataUrl 落盘）----
export function textAttachment(name, content) { return { type: 'text', name, content } }
export function fileAttachment(name, content, mime = 'text/markdown') {
  return { type: 'file', name, mime, dataUrl: `data:${mime};base64,${Buffer.from(content, 'utf8').toString('base64')}`, size: Buffer.byteLength(content) }
}

// ---- seed 装载（复用 workduo-mcp L2 真实缺陷种子）----
export function stageSeed(caseId, seedId) {
  const dir = path.join(SEEDS_DIR, seedId)
  const seed = JSON.parse(fs.readFileSync(path.join(dir, 'seed.json'), 'utf8'))
  const ws = wsOf(caseId)
  const target = path.join(ws, seed.targetDir || 'proj')
  fs.mkdirSync(target, { recursive: true })
  for (const f of fs.readdirSync(dir)) {
    if (f === 'seed.json') continue
    fs.copyFileSync(path.join(dir, f), path.join(target, f))
  }
  const originals = {}
  for (const f of fs.readdirSync(target)) originals[f] = readFileSafe(path.join(target, f))
  return { ws, seed, target, originals, wsForward: ws.replace(/\\/g, '/') }
}
export function seedChanged(staged, name) {
  const now = readFileSafe(path.join(staged.target, name))
  return now !== null && now !== staged.originals[name]
}

// ---- 数字核对（T/E 系列：runner 端独立重算 → 断言 reply/report 含一致数值）----
export function normalizeNums(text) { return String(text).replace(/[,，\s]/g, '').replace(/[¥￥$]/g, '') }
export function numPresent(text, n, { tolerance = 0.5 } = {}) {
  const t = normalizeNums(text)
  const want = String(Math.round(n))
  if (t.includes(want)) return { ok: true, detail: `含 ${want}` }
  // 容差匹配：正则找所有数字比对
  const nums = [...t.matchAll(/\d+(\.\d+)?/g)].map((m) => parseFloat(m[0]))
  const hit = nums.find((x) => Math.abs(x - n) <= tolerance)
  return hit !== undefined ? { ok: true, detail: `近似 ${hit}` } : { ok: false, detail: `未找到 ${n}；文本数字样例=${nums.slice(0, 12).join(',')}` }
}

// ---- 简易 CSV（runner 端 fixtures 与重算用，无外部依赖）----
export function toCsv(rows) { return rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',')).join('\n') }
export function parseCsv(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean)
  return lines.map((l) => {
    const cells = []; let cur = '', inQ = false
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]
      if (inQ) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') inQ = false; else cur += ch }
      else if (ch === '"') inQ = true
      else if (ch === ',') { cells.push(cur); cur = '' }
      else cur += ch
    }
    cells.push(cur)
    return cells
  })
}

// ---- 标准用例骨架：建 Agent → 建会话 → run（可多次）→ 取轨迹 → 清理 ----
export async function withAgent(opts, fn) {
  const ag = await createAgent(opts)
  try { return await fn(ag) } finally { await deleteAgent(ag.id) }
}
export async function drive(ag, prompt, { ws, extra = {}, maxMs = WAIT_MS, recoveryDecision, sess } = {}) {
  const s = sess || await mkSession(ag.identifier, 'cap2')
  const { runId, status } = await startRun(ag.id, prompt, s.id, ws ? { workspace: ws, ...extra } : extra, { maxMs, recoveryDecision })
  const trace = await getTrace(runId)
  return { sess: s, runId, status, trace, types: eventTypes(trace), tools: toolNames(trace), reply: replyOf(trace), tokens: tokensOf(trace) }
}
