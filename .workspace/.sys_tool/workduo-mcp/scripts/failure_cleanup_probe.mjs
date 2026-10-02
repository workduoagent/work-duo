// 失败收尾回归探针（2026-09-22 沉淀，筑基支柱①「终态铁律」）
//
// 目的：验证「任何一次运行，无论成功/失败/中断，都必须到达终态并释放运行锁」。
// 这是筑基三支柱里地基中的地基——一次挂死能卡住整个 App。
//
// 背景（2026-09-22 定位）：`runtime.rs call_llm` 原**无任何 HTTP 超时**，模型/网关不返回时
// future 永不 resolve → `run_task` 永不结束 → `RunningGuard` 永不 drop → **运行锁永占**
// （历史「3 run 永久挂死」的机制性根因）。已修：加 `LLM_CALL_TIMEOUT=180s` 超时兜底，
// 让上层 `planner.rs:148` / `pipeline.rs:1306` 本就存在的 Err 容错真正生效；并加等待心跳
// （每 30s 一条日志）使「慢」与「死」在观测上可区分。
//
// 本探针用**故障注入**验证收尾闭环：启动复合任务 → 中途 `agent_cancel_task` 中断 →
// 断言三件事：
//   ① 到达明确终态（done / error / cancelled），**绝不停在 running**；
//   ② 从中断到终态的**收尾耗时 ≤30s**（对应新口径第 2 层，见 README 超时阈值铁律）；
//   ③ **锁已释放**——立即再次 `agent_run_task`，不得返回「已有任务正在运行」。
//
// 注意：判据用「收尾耗时」而非「总耗时」。正常复合任务实测可达 240s（Qwen3.6），
// 用总耗时做阈值会误杀全部正常任务——慢 ≠ 死。
//
// 运行前提：WorkDuo 桌面端正在运行（内建 MCP Server 127.0.0.1:18755/mcp 可达）。
// 用法：
//   node failure_cleanup_probe.mjs                      # 默认自建临时 Agent
//   PROBE_MODEL_ID=<id> node failure_cleanup_probe.mjs  # 指定模型（建议用慢模型以确保中断落在执行中）
//   PROBE_AGENT_ID=<id> node failure_cleanup_probe.mjs  # 复用现成 Agent
// 退出码：0 = PASS（终态 + 收尾≤30s + 锁释放）；1 = FAIL；3 = 环境/前置错误。
//
// 入参（环境变量，可选）：
//   PROBE_CREATE_AGENT      默认 '1'：自建临时 Agent 并跑完删除；'0' 复用 PROBE_AGENT_ID
//   PROBE_MODEL_ID          自建模式使用的模型主键 id（默认取第一个 enabled text/multimodal 模型）
//   PROBE_AGENT_ID          复用模式的 Agent 主键 id（自动经 agent_ui_get 解析 identifier）
//   PROBE_CANCEL_AFTER_MS   启动后多久注入中断（默认 5000；需落在任务执行中）
//   PROBE_TERM_MS           等待终态上限（默认 90000）
//   PROBE_CLEANUP_MAX_MS    收尾耗时上限（默认 30000，对应验收口径）
//   PROBE_WORKSPACE         工作目录绝对路径（默认系统临时目录下 wd_failure_ws）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { initMcp, callTool, unw, asRows, traceInner, sleep } from './agent_task_driver.mjs'

const CREATE = (process.env.PROBE_CREATE_AGENT ?? '1') !== '0'
const MODEL_ID = process.env.PROBE_MODEL_ID
const AGENT_ID = process.env.PROBE_AGENT_ID
const CANCEL_AFTER_MS = parseInt(process.env.PROBE_CANCEL_AFTER_MS || '5000', 10)
const TERM_MS = parseInt(process.env.PROBE_TERM_MS || '90000', 10)
const CLEANUP_MAX_MS = parseInt(process.env.PROBE_CLEANUP_MAX_MS || '30000', 10)
const WS = process.env.PROBE_WORKSPACE || path.join(os.tmpdir(), 'wd_failure_ws')
const PROMPT = '请在工作目录下创建 src/mathx.ts，实现并导出 add 与 mul 两个函数，并创建 README.md 说明用法。完成后列出创建的文件路径。'

function die(code, msg) { console.error(msg); process.exit(code) }

async function resolveIdent(id) {
  const a = unw(await callTool('agent_ui_get', { id }, { timeoutMs: 20000 }))
  return a?.identifier || id
}

async function createTestAgent(model) {
  const ident = `failclean-${Date.now()}`
  let llmConfig = {}
  try { llmConfig = typeof model.config === 'string' ? JSON.parse(model.config || '{}') : (model.config || {}) } catch {}
  const ag = unw(await callTool('agent_ui_create', { payload: {
    name: '失败收尾回归', identifier: ident, scenario: 'dev-programming',
    description: '终态铁律故障注入临时 Agent', systemPrompt: '你是一个高效的编程助手。',
    llmId: model.id, llmConfig, isActive: true, autoToolExecMode: true, allowSandbox: true,
    memoryMode: 'off', planAutoApproveMode: 'never',
  } }, { timeoutMs: 30000 }))
  if (!ag?.id) throw new Error('agent_ui_create 未返回 id: ' + JSON.stringify(ag).slice(0, 160))
  return { id: ag.id, identifier: ident }
}

async function deleteAgent(id) {
  try { await callTool('agent_ui_delete', { id }, { timeoutMs: 20000 }) } catch (e) { console.error('  清理 Agent 失败: ' + e.message.slice(0, 100)) }
}

async function mkSession(agentIdentifier) {
  const s = unw(await callTool('agent_session_create', { payload: { agentIdentifier, sessionName: 'failclean' } }, { timeoutMs: 20000 }))
  if (!s?.id) throw new Error('agent_session_create 未返回 id')
  return s.id
}

async function launch(agentId, sessionId) {
  const roundIndex = Date.now() % 100000
  const rd = unw(await callTool('agent_round_create', { payload: { sessionId, roundIndex, userQuestion: PROMPT.slice(0, 60) } }, { timeoutMs: 20000 }))
  const rt = unw(await callTool('agent_run_task', {
    agentId, prompt: PROMPT, sessionId, roundId: rd?.id, workspace: WS,
  }, { timeoutMs: 30000 }))
  const runId = rt?.run_id || rt?.runId
  if (!runId) throw new Error('agent_run_task 未返回 run_id: ' + JSON.stringify(rt).slice(0, 160))
  return runId
}

async function getStatus(runId) {
  try { return unw(await callTool('agent_get_status', { run_id: runId })) } catch { return null }
}

async function main() {
  await initMcp('failure-cleanup-probe')
  fs.mkdirSync(WS, { recursive: true })
  console.log(`[probe] workspace = ${WS}`)

  let agent, created = null
  if (CREATE) {
    const models = asRows(await callTool('agent_list_models', {}, { timeoutMs: 20000 }))
    const model = (MODEL_ID ? models.find((m) => m.id === MODEL_ID) : null)
      || models.find((m) => (m.category === 'text' || m.category === 'multimodal') && m.enabled === 1)
    if (!model) die(3, 'FAIL(ENV): 找不到可用模型')
    console.log(`[probe] 使用模型 ${model.id} (${model.name})`)
    agent = await createTestAgent(model); created = agent.id
  } else {
    if (!AGENT_ID) die(3, 'FAIL(ENV): 复用模式需 PROBE_AGENT_ID')
    agent = { id: AGENT_ID, identifier: await resolveIdent(AGENT_ID) }
  }
  console.log(`[probe] Agent = ${agent.id}`)

  const sessionId = await mkSession(agent.identifier)
  const runId = await launch(agent.id, sessionId)
  console.log(`[probe] run 已启动: ${runId}`)

  // —— 故障注入：任务执行中途取消 ——
  await sleep(CANCEL_AFTER_MS)
  const beforeCancel = await getStatus(runId)
  const cancelAt = Date.now()
  console.log(`[probe] +${CANCEL_AFTER_MS}ms 注入中断（取消前 status=${beforeCancel?.status}）`)
  let cancelErr = null
  try { await callTool('agent_cancel_task', { agentId: agent.id }, { timeoutMs: 20000 }) }
  catch (e) { cancelErr = e.message.slice(0, 120) }
  if (cancelErr) console.log(`[probe] 取消调用返回: ${cancelErr}`)

  // —— 等待终态，记录收尾耗时 ——
  let finalStatus = 'timeout'
  let cleanupMs = -1
  const t0 = Date.now()
  while (Date.now() - t0 < TERM_MS) {
    await sleep(1000)
    const st = await getStatus(runId)
    if (st?.status && st.status !== 'running' && st.status !== 'pending') {
      finalStatus = st.status
      cleanupMs = Date.now() - cancelAt
      break
    }
    if (st?.error) { finalStatus = 'error'; cleanupMs = Date.now() - cancelAt; break }
  }
  console.log(`[probe] 终态 = ${finalStatus}，收尾耗时 = ${cleanupMs < 0 ? '未到达终态' : cleanupMs + 'ms'}`)

  // —— 锁释放验证：立即再启动一次，不得被「已有任务正在运行」拒绝 ——
  let lockReleased = false
  let lockNote = ''
  try {
    const rd = unw(await callTool('agent_round_create', { payload: { sessionId, roundIndex: Date.now() % 100000, userQuestion: '锁释放验证' } }, { timeoutMs: 20000 }))
    const rt = unw(await callTool('agent_run_task', {
      agentId: agent.id, prompt: 'ping', sessionId, roundId: rd?.id, workspace: WS,
    }, { timeoutMs: 30000 }))
    const id2 = rt?.run_id || rt?.runId
    if (id2) {
      lockReleased = true
      // 立即取消掉这次验证性 run，避免长时间占用
      try { await callTool('agent_cancel_task', { agentId: agent.id }, { timeoutMs: 15000 }) } catch {}
    } else {
      lockNote = JSON.stringify(rt).slice(0, 140)
    }
  } catch (e) {
    lockNote = e.message.slice(0, 140)
    // 「已有任务正在运行」正是锁未释放的判据
    lockReleased = !/已有任务正在运行|正在运行/.test(e.message)
  }
  console.log(`[probe] 锁释放 = ${lockReleased ? '是' : '否'}${lockNote ? '（' + lockNote + '）' : ''}`)

  // 取轨迹与日志补证
  try {
    const t = traceInner(unw(await callTool('agent_get_run_trace', { run_id: runId }, { timeoutMs: 20000 })))
    console.log(`[probe] 轨迹: events=${(t?.events || []).length} reply=${(t?.reply || '').length} 字`)
  } catch {}
  try {
    const lg = unw(await callTool('agent_get_run_logs', { limit: 300 }))
    const hb = (lg?.lines || []).filter((l) => /等待响应已|超时|cancel/i.test(l))
    if (hb.length) {
      console.log('[probe] 相关日志（等待打点 / 超时 / 取消）:')
      for (const l of hb.slice(-8)) console.log('  ' + l)
    }
  } catch {}

  if (created) await deleteAgent(created)

  // —— 断言 ——
  const problems = []
  if (finalStatus === 'timeout' || finalStatus === 'running' || finalStatus === 'pending') {
    problems.push(`未到达明确终态（停留在 ${finalStatus}）——运行挂死，锁可能永占`)
  }
  if (cleanupMs < 0) problems.push('未能在等待上限内到达终态')
  else if (cleanupMs > CLEANUP_MAX_MS) problems.push(`收尾耗时 ${cleanupMs}ms 超过上限 ${CLEANUP_MAX_MS}ms`)
  if (!lockReleased) problems.push('锁未释放：再次启动被拒绝（"已有任务正在运行"）')

  console.log('\n===== 结论 =====')
  if (problems.length) die(1, 'FAIL: ' + problems.join(' | '))
  console.log(`✅ 失败收尾通过：终态=${finalStatus}，收尾 ${cleanupMs}ms（≤${CLEANUP_MAX_MS}ms），锁已释放`)
  process.exit(0)
}

main().catch((e) => die(3, 'FAIL(ERR): ' + e.message))
