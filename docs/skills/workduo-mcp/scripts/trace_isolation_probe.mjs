// #8 per-run trace 隔离探针（集成自测，2026-09-22 沉淀）
// 目的：验证「并发多 Agent 运行」时各 run 的轨迹缓冲互不串台——这是 #8 修复前
// （三个全局单例 + reset_trace）的已知缺陷：两 run 写同一缓冲会互相覆盖。
//
// 机制层已由 events.rs 的 Rust 单测（per_run_trace_isolation / reset_is_per_run /
// unknown_run_returns_empty）覆盖；本脚本在「应用已重建 + 真实 Agent + LLM 可用」
// 时做端到端并发回归，属于 skill+mcp 自测闭环的一部分。
//
// 运行前提：WorkDuo 桌面端正在运行（内建 MCP Server 127.0.0.1:18755/mcp 可达）。
// 用法：node trace_isolation_probe.mjs
// 退出码：0 = PASS（两 run 轨迹隔离）；1 = FAIL；2 = 环境/前置错误（如 Agent 不存在）。
//
// 入参（环境变量，可选）：
//   PROBE_AGENT_ID   用于并发试跑的 Agent 主键 id（必填，无默认值）
//   PROBE_PROMPT     两个并发 run 共用的基础 prompt（默认一个无害的闲聊问题）
import { initMcp, callTool, unw, traceInner } from './agent_task_driver.mjs'

const AGENT_ID = process.env.PROBE_AGENT_ID
const BASE_PROMPT = process.env.PROBE_PROMPT || '请用一句话介绍你自己。'
const TOKEN = 'TISO'

function fail(msg) { console.error('FAIL: ' + msg); process.exit(1) }

async function mkSession() {
  const s = unw(await callTool('agent_session_create', { payload: { agentIdentifier: AGENT_ID, sessionName: `${TOKEN}-probe` } }))
  if (!s?.id) throw new Error('agent_session_create 未返回 id: ' + JSON.stringify(s).slice(0, 160))
  return s.id
}

// 同步发起一个 run（round_create → run_task），立即返回 run_id，不等待完成。
async function launch(agentId, sessionId, marker) {
  const roundIndex = Date.now() % 100000
  const rd = unw(await callTool('agent_round_create', { payload: { sessionId, roundIndex, userQuestion: `${BASE_PROMPT} [${marker}]` } }))
  const rt = unw(await callTool('agent_run_task', {
    agentId, prompt: `${BASE_PROMPT} 必含标记词 ${marker}。`, sessionId, roundId: rd?.id,
  }, { timeoutMs: 30000 }))
  const runId = rt?.run_id || rt?.runId
  if (!runId) throw new Error('agent_run_task 未返回 run_id: ' + JSON.stringify(rt).slice(0, 160))
  return runId
}

async function waitDone(runId, agentId, maxMs = 180000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const st = unw(await callTool('agent_get_status', { run_id: runId }))
    const s = JSON.stringify(st || {})
    if (s.includes('"recoveryWaiting":true') || s.includes('"kind":"recovery"')) {
      try { await callTool('agent_submit_recovery_decision', { decision: 'skip', agentId }) } catch {}
      continue
    }
    if (st?.status && st.status !== 'running' && st.status !== 'pending') return st.status
  }
  return 'timeout'
}

async function main() {
  if (!AGENT_ID) fail('请设置 PROBE_AGENT_ID（用于并发试跑的 Agent 主键 id）')
  await initMcp('trace-isolation-probe')
  const sessionId = await mkSession()

  const markerA = `${TOKEN}_A_${Date.now()}`
  const markerB = `${TOKEN}_B_${Date.now()}`

  // 并发发起两个 run
  const [runIdA, runIdB] = await Promise.all([
    launch(AGENT_ID, sessionId, markerA),
    launch(AGENT_ID, sessionId, markerB),
  ])
  console.log(`[probe] 并发启动两 run: A=${runIdA} B=${runIdB}`)

  const [stA, stB] = await Promise.all([
    waitDone(runIdA, AGENT_ID),
    waitDone(runIdB, AGENT_ID),
  ])
  console.log(`[probe] 终态: A=${stA} B=${stB}`)

  // 取各自 run 的轨迹（#8 后必须带 run_id）
  const ta = traceInner(unw(await callTool('agent_get_run_trace', { run_id: runIdA })))
  const tb = traceInner(unw(await callTool('agent_get_run_trace', { run_id: runIdB })))

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

  if (problems.length) fail(problems.join(' | '))
  console.log('PASS: #8 per-run 隔离通过——并发两 run 的轨迹互不包含对方内容')
  process.exit(0)
}

main().catch((e) => fail(e.message))
