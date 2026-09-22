// #8 per-run trace 隔离探针（集成自测，2026-09-22 沉淀 / 2026-09-22 晚重构）
// 目的：验证「并发多 Agent 运行」时各 run 的轨迹缓冲互不串台——这是 #8 修复前
// （三个全局单例 + reset_trace）的已知缺陷：两 run 写同一缓冲会互相覆盖。
//
// 机制层已由 events.rs 的 Rust 单测（per_run_trace_isolation / reset_is_per_run /
// unknown_run_returns_empty）覆盖；本脚本在「应用已重建 + 真实 Agent + LLM 可用」
// 时做端到端并发回归，属于 skill+mcp 自测闭环的一部分。
//
// 并发来源：WorkDuo 单 Agent 同时只能跑一个 run（运行锁），因此真正的并发必须来自
// 两个不同 Agent 同时 run。本探针默认自建两个临时 Agent（PROBE_CREATE_AGENTS=1，
// 跑完自动删除），绕开锁限制；也可传现成两 Agent 的主键 id 复用。
//
// 隔离断言核心：A 桶不得含 B 的标记、B 桶不得含 A 的标记（prompt 要求模型回显标记，
// 故标记必落各自 reply 桶）；若 #8 未修复，全局缓冲会让 A 桶混入 B 的标记。
//
// 运行前提：WorkDuo 桌面端正在运行（内建 MCP Server 127.0.0.1:18755/mcp 可达）。
// 用法：
//   node trace_isolation_probe.mjs                      # 默认自建两 Agent（需 PROBE_MODEL_ID）
//   PROBE_MODEL_ID=<id> node trace_isolation_probe.mjs  # 同上，指定模型
//   PROBE_AGENT_ID_A=<idA> PROBE_AGENT_ID_B=<idB> node trace_isolation_probe.mjs  # 复用现成两 Agent
// 退出码：0 = PASS（两 run 轨迹隔离）；1 = FAIL；2 = 环境/前置错误（如模型不存在）。
//
// 入参（环境变量，可选）：
//   PROBE_CREATE_AGENTS  默认 '1'：自建两临时 Agent 并跑完删除；置 '0' 则复用现成两 Agent
//   PROBE_MODEL_ID       自建模式使用的模型主键 id（默认取第一个 enabled text/multimodal 模型）
//   PROBE_AGENT_ID_A/B   复用模式：两个现成 Agent 的主键 id（必填）；标识符自动经 agent_ui_get 解析
//   PROBE_PROMPT         两并发 run 共用的基础 prompt（默认无害闲聊）
//   PROBE_WAIT_MS        单 run 终态轮询上限（默认 180000）
import { initMcp, callTool, unw, asRows, traceInner } from './agent_task_driver.mjs'

const CREATE = (process.env.PROBE_CREATE_AGENTS ?? '1') !== '0'
const AGENT_A = process.env.PROBE_AGENT_ID_A
const AGENT_B = process.env.PROBE_AGENT_ID_B
const MODEL_ID = process.env.PROBE_MODEL_ID
const BASE_PROMPT = process.env.PROBE_PROMPT || '请用一句话介绍你自己。'
const WAIT_MS = parseInt(process.env.PROBE_WAIT_MS || '180000', 10)
const TOKEN = 'TISO'

function fail(msg) { console.error('FAIL: ' + msg); process.exit(1) }

async function resolveIdent(id) {
  const a = unw(await callTool('agent_ui_get', { id }, { timeoutMs: 20000 }))
  return a?.identifier || id
}

async function createTestAgent(suffix, model) {
  const ident = `iso-${TOKEN}-${suffix}-${Date.now()}`
  let llmConfig = {}
  try { llmConfig = typeof model.config === 'string' ? JSON.parse(model.config || '{}') : (model.config || {}) } catch {}
  const ag = unw(await callTool('agent_ui_create', { payload: {
    name: `隔离测试${suffix}`, identifier: ident, scenario: 'dev-programming',
    description: '#8 隔离自测临时 Agent', systemPrompt: '你是一个简洁的助手，直接回答用户问题。',
    llmId: model.id, llmConfig, isActive: true, autoToolExecMode: true, allowSandbox: true,
    memoryMode: 'off', planAutoApproveMode: 'never',
  } }, { timeoutMs: 30000 }))
  if (!ag?.id) throw new Error('agent_ui_create 未返回 id: ' + JSON.stringify(ag).slice(0, 160))
  return { id: ag.id, identifier: ident }
}

async function deleteAgent(id) {
  try { await callTool('agent_ui_delete', { id }, { timeoutMs: 20000 }) } catch (e) { console.error('  清理 Agent 失败 ' + id + ': ' + e.message.slice(0, 100)) }
}

async function mkSession(agentIdentifier) {
  const s = unw(await callTool('agent_session_create', { payload: { agentIdentifier, sessionName: `${TOKEN}-probe` } }, { timeoutMs: 20000 }))
  if (!s?.id) throw new Error('agent_session_create 未返回 id')
  return s.id
}

// 同步发起一个 run（round_create → run_task），立即返回 run_id，不等待完成。
async function launch(agentId, sessionId, marker) {
  const roundIndex = Date.now() % 100000
  const rd = unw(await callTool('agent_round_create', { payload: { sessionId, roundIndex, userQuestion: `${BASE_PROMPT} [${marker}]` } }, { timeoutMs: 20000 }))
  const rt = unw(await callTool('agent_run_task', {
    agentId, prompt: `${BASE_PROMPT} 请在回复结尾附上标记词「${marker}」。`, sessionId, roundId: rd?.id,
  }, { timeoutMs: 30000 }))
  const runId = rt?.run_id || rt?.runId
  if (!runId) throw new Error('agent_run_task 未返回 run_id: ' + JSON.stringify(rt).slice(0, 160))
  return runId
}

async function waitDone(runId, agentId) {
  const t0 = Date.now()
  while (Date.now() - t0 < WAIT_MS) {
    await new Promise((r) => setTimeout(r, 2000))
    const st = unw(await callTool('agent_get_status', { run_id: runId }, { timeoutMs: 20000 }))
    const s = JSON.stringify(st || {})
    if (s.includes('"recoveryWaiting":true') || s.includes('"kind":"recovery"')) {
      try { await callTool('agent_submit_recovery_decision', { decision: 'skip', agentId }, { timeoutMs: 20000 }) } catch {}
      continue
    }
    if (st?.status && st.status !== 'running' && st.status !== 'pending') return st.status
  }
  return 'timeout'
}

async function main() {
  await initMcp('trace-isolation-probe')
  let agentA, agentB, created = []
  if (CREATE) {
    const models = asRows(await callTool('agent_list_models', {}, { timeoutMs: 20000 }))
    const model = (MODEL_ID ? models.find((m) => m.id === MODEL_ID) : null)
      || models.find((m) => (m.category === 'text' || m.category === 'multimodal') && m.enabled === 1)
    if (!model) fail('找不到可用模型（PROBE_CREATE_AGENTS=1 需 enabled 的 text/multimodal 模型）')
    console.log(`[probe] 使用模型 ${model.id} (${model.name})`)
    agentA = await createTestAgent('A', model); created.push(agentA.id)
    agentB = await createTestAgent('B', model); created.push(agentB.id)
    console.log(`[probe] 已自建两临时 Agent: A=${agentA.id} B=${agentB.id}`)
  } else {
    if (!AGENT_A || !AGENT_B) fail('复用模式需 PROBE_AGENT_ID_A 与 PROBE_AGENT_ID_B')
    agentA = { id: AGENT_A, identifier: await resolveIdent(AGENT_A) }
    agentB = { id: AGENT_B, identifier: await resolveIdent(AGENT_B) }
  }

  const sessionA = await mkSession(agentA.identifier)
  const sessionB = await mkSession(agentB.identifier)

  const markerA = `${TOKEN}_A_${Date.now()}`
  const markerB = `${TOKEN}_B_${Date.now()}`

  // 并发发起两个 run（落在两个不同 Agent，各自独立 run_id 桶）
  const [runIdA, runIdB] = await Promise.all([
    launch(agentA.id, sessionA, markerA),
    launch(agentB.id, sessionB, markerB),
  ])
  console.log(`[probe] 并发启动两 run: A=${runIdA} B=${runIdB}`)

  const [stA, stB] = await Promise.all([
    waitDone(runIdA, agentA.id),
    waitDone(runIdB, agentB.id),
  ])
  console.log(`[probe] 终态: A=${stA} B=${stB}`)

  // 取各自 run 的轨迹（#8 后必须带 run_id，按 run 取独立桶）
  const ta = traceInner(unw(await callTool('agent_get_run_trace', { run_id: runIdA }, { timeoutMs: 20000 })))
  const tb = traceInner(unw(await callTool('agent_get_run_trace', { run_id: runIdB }, { timeoutMs: 20000 })))

  const dump = (t) => {
    const s = JSON.stringify(t || {})
    return { containsA: s.includes(markerA), containsB: s.includes(markerB), reply: (t?.reply || '').slice(0, 40), events: (t?.events || []).length }
  }
  const da = dump(ta), db = dump(tb)
  console.log('[probe] A 桶:', JSON.stringify(da))
  console.log('[probe] B 桶:', JSON.stringify(db))

  const problems = []
  if (!ta || da.events === 0) problems.push('A 桶为空（并发未写入？）')
  if (!tb || db.events === 0) problems.push('B 桶为空（并发未写入？）')
  // 隔离核心断言：A 桶不得含 B 的标记，B 桶不得含 A 的标记
  if (da.containsB) problems.push('A 桶泄露了 B 的标记词（串台！）')
  if (db.containsA) problems.push('B 桶泄露了 A 的标记词（串台！）')
  if (da.containsA && db.containsB) { /* 各自含自身标记，正确 */ }
  else { if (!da.containsA) problems.push('A 桶未含自身标记词'); if (!db.containsB) problems.push('B 桶未含自身标记词') }

  // 清理临时 Agent
  for (const id of created) await deleteAgent(id)

  if (problems.length) fail(problems.join(' | '))
  console.log('PASS: #8 per-run 隔离通过——并发两 run 的轨迹互不包含对方内容')
  process.exit(0)
}

main().catch((e) => fail(e.message))
