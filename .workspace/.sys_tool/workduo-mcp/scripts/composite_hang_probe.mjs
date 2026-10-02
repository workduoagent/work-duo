// 复合任务（COMPOSITE 路径）挂死诊断驱动（2026-09-22 沉淀）
//
// 目的：定位「run 永不终止」的根因到底在哪一步。历史背景（2026-09-22 E2E 审计）：
// 3 个 COMPOSITE_TASK run 均 status=running / finished_at=null 永不终止，轨迹
// thinking=0 / reply=0 / events={} / 零 tool_started —— 死在规划阶段零产出。
// 该缺陷**从未被修复**，只是被 #1（KB 问答降为 SIMPLE_CHAT 快路径）**绕开**，
// 因此「复合任务主干道是否健康」成了未验证的盲区——而复合任务恰是 Agent 核心价值。
//
// 与 trace_isolation_probe 的区别：那个验「并发隔离」，这个验「单 run 是否会挂死 +
// 卡在哪一步」。做法是**周期性采样**（而非只等终态）：每 SAMPLE_MS 取一次
// agent_get_status + agent_get_run_trace，用事件的 ts_ms 打出时间线，并计算
// 「最长静默段」——静默的起点就是卡死点。
//
// 关键判据（区分三种截然不同的失败）：
//   ① 有 pending 挂起信号（plan/tool/recovery）→ 卡在人工门禁，非引擎挂死（自动应答即可）
//   ② 无任何事件、Thinking/Reply 均 0 → 死在规划/首个 LLM 调用前（模型或网关侧不返回）
//   ③ 有事件推进但某步后永久静默 → 死在该步骤（引擎或工具侧）
//
// 运行前提：WorkDuo 桌面端正在运行（内建 MCP Server 127.0.0.1:18755/mcp 可达）。
// 用法：
//   node composite_hang_probe.mjs                        # 默认自建临时 Agent + 临时 workspace
//   PROBE_MODEL_ID=<id> node composite_hang_probe.mjs    # 指定模型
//   PROBE_AGENT_ID=<id> node composite_hang_probe.mjs    # 复用现成 Agent（自动解析 identifier）
//   PROBE_WAIT_MS=600000 node composite_hang_probe.mjs   # 放宽终态等待上限
// 退出码：0 = 到终态且有文件产出；1 = 到终态但零产物；2 = 超时未达终态（暴露挂死）；3 = 环境/前置错误。
//
// 入参（环境变量，可选）：
//   PROBE_CREATE_AGENT   默认 '1'：自建临时 Agent 并跑完删除；'0' 复用 PROBE_AGENT_ID
//   PROBE_MODEL_ID       自建模式使用的模型主键 id（默认取第一个 enabled text/multimodal 模型）
//   PROBE_AGENT_ID       复用模式的 Agent 主键 id（自动经 agent_ui_get 解析 identifier）
//   PROBE_PROMPT         复合任务 prompt（默认要求创建 3 个文件，必然触发 COMPOSITE_TASK）
//   PROBE_WORKSPACE      工作目录绝对路径（默认在系统临时目录下建 wd_composite_ws）
//   PROBE_WAIT_MS        终态等待上限（默认 480000 = 8min；网关慢时需放宽）
//   PROBE_SAMPLE_MS      采样间隔（默认 10000 = 10s）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { initMcp, callTool, unw, asRows, traceInner, sleep } from './agent_task_driver.mjs'

const CREATE = (process.env.PROBE_CREATE_AGENT ?? '1') !== '0'
const MODEL_ID = process.env.PROBE_MODEL_ID
const AGENT_ID = process.env.PROBE_AGENT_ID
const WAIT_MS = parseInt(process.env.PROBE_WAIT_MS || '480000', 10)
const SAMPLE_MS = parseInt(process.env.PROBE_SAMPLE_MS || '10000', 10)
const WS = process.env.PROBE_WORKSPACE || path.join(os.tmpdir(), 'wd_composite_ws')
const PROMPT = process.env.PROBE_PROMPT
  || '请在工作目录下完成以下任务：1) 创建 src/calculator.ts，实现并导出 add、subtract、multiply、divide 四个函数，其中 divide 在除数为 0 时抛出 Error；2) 创建 src/calculator.test.ts，为上述四个函数各编写至少一个测试用例；3) 创建 README.md，说明如何运行这些测试。完成后，列出你创建的所有文件的完整路径。'

function die(code, msg) { console.error(msg); process.exit(code) }

// 递归收集 workspace 下的文件（业务产物验收：机制到终态 ≠ 真做了事）
function collectFiles(root) {
  const out = []
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push({ rel: path.relative(root, p).replace(/\\/g, '/'), size: fs.statSync(p).size })
    }
  }
  walk(root)
  return out
}

async function resolveIdent(id) {
  const a = unw(await callTool('agent_ui_get', { id }, { timeoutMs: 20000 }))
  return a?.identifier || id
}

async function createTestAgent(model) {
  const ident = `comp-probe-${Date.now()}`
  let llmConfig = {}
  try { llmConfig = typeof model.config === 'string' ? JSON.parse(model.config || '{}') : (model.config || {}) } catch {}
  const ag = unw(await callTool('agent_ui_create', { payload: {
    name: '复合任务诊断', identifier: ident, scenario: 'dev-programming',
    description: 'COMPOSITE 挂死诊断临时 Agent', systemPrompt: '你是一个高效的编程助手，按要求完成文件创建任务。',
    llmId: model.id, llmConfig, isActive: true, autoToolExecMode: true, allowSandbox: true,
    memoryMode: 'off',
    // 注意语义反直觉：never = 计划全自动放行（无人值守），always = 最严格门禁。
    planAutoApproveMode: 'never',
  } }, { timeoutMs: 30000 }))
  if (!ag?.id) throw new Error('agent_ui_create 未返回 id: ' + JSON.stringify(ag).slice(0, 160))
  return { id: ag.id, identifier: ident }
}

async function deleteAgent(id) {
  try { await callTool('agent_ui_delete', { id }, { timeoutMs: 20000 }) } catch (e) { console.error('  清理 Agent 失败: ' + e.message.slice(0, 100)) }
}

async function mkSession(agentIdentifier) {
  const s = unw(await callTool('agent_session_create', { payload: { agentIdentifier, sessionName: 'comp-probe' } }, { timeoutMs: 20000 }))
  if (!s?.id) throw new Error('agent_session_create 未返回 id')
  return s.id
}

/** 发起 run，立即返回 run_id（不等待）。workspace 绑定工作目录，复合任务才能落文件。 */
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

/**
 * 采样循环：每 SAMPLE_MS 取 status + trace，记录快照；自动应答三类挂起。
 * 返回 { finalStatus, elapsedMs, samples, hangSignals, trace }
 */
async function sampleLoop(runId, agentId, t0) {
  const samples = []
  const hangSignals = []
  const toolApproved = new Set()
  let planApproved = 0
  let finalStatus = 'timeout'
  let lastTrace = null

  while (Date.now() - t0 < WAIT_MS) {
    await sleep(SAMPLE_MS)
    const at = Date.now() - t0

    // ① 状态：判终态 + 捕获挂起信号（有信号 = 卡在人工门禁，非引擎挂死）
    let st = null
    try { st = unw(await callTool('agent_get_status', { run_id: runId })) } catch (e) {
      samples.push({ at, kind: 'status-error', note: e.message.slice(0, 80) }); continue
    }
    const s = JSON.stringify(st || {})

    if (s.includes('"recoveryWaiting":true') || s.includes('"kind":"recovery"')) {
      hangSignals.push({ at, kind: 'recovery' })
      try { unw(await callTool('agent_submit_recovery_decision', { decision: 'skip', agentId })) } catch {}
      samples.push({ at, kind: 'recovery-auto-skip' })
      continue
    }
    const aid = (s.match(/"approvalId"\s*:\s*"([^"]+)"/) || [])[1]
    if (aid && !toolApproved.has(aid)) {
      toolApproved.add(aid)
      hangSignals.push({ at, kind: 'tool-approval', id: aid.slice(0, 20) })
      try { unw(await callTool('agent_submit_approval', { approvalId: aid, decision: 'approve', agentId })) } catch {}
      continue
    }
    if (s.includes('"waitingApproval":true')) {
      planApproved++
      hangSignals.push({ at, kind: 'plan-approval' })
      try { unw(await callTool('agent_submit_plan_decision', { decision: 'approve', agentId })) } catch {}
      continue
    }

    // ② 轨迹：记录事件数 / 思考 / 正文长度，用于画时间线与找静默段
    let snap = { events: 0, thinking: 0, reply: 0, lastType: null }
    try {
      const t = traceInner(unw(await callTool('agent_get_run_trace', { run_id: runId })))
      lastTrace = t
      const evs = Array.isArray(t?.events) ? t.events : []
      const last = evs[evs.length - 1]
      snap = {
        events: evs.length,
        thinking: (t?.thinking || '').length,
        reply: (t?.reply || '').length,
        lastType: last?.payload?.type || last?.event || null,
      }
    } catch (e) { snap.note = 'trace-err' }

    samples.push({ at, kind: 'sample', status: st?.status, ...snap })

    if (st?.status && st.status !== 'running' && st.status !== 'pending') { finalStatus = st.status; break }
    if (st?.error) { finalStatus = 'error'; break }
  }
  return { finalStatus, elapsedMs: Date.now() - t0, samples, hangSignals, trace: lastTrace }
}

/** 从轨迹事件算时间线 + 最长静默段（静默起点 = 卡死点）。 */
function timeline(trace, t0Epoch) {
  const evs = Array.isArray(trace?.events) ? trace.events : []
  const pts = evs.map((e) => ({
    at: (e?.ts_ms ?? t0Epoch) - t0Epoch,
    type: e?.payload?.type || e?.event || '?',
  })).filter((p) => Number.isFinite(p.at))
  let maxGap = { from: null, to: null, gapMs: 0 }
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i].at - pts[i - 1].at
    if (g > maxGap.gapMs) maxGap = { from: pts[i - 1], to: pts[i], gapMs: g }
  }
  return { pts, maxGap, count: pts.length }
}

async function main() {
  await initMcp('composite-hang-probe')

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
  const t0 = Date.now()
  const runId = await launch(agent.id, sessionId)
  console.log(`[probe] run 已启动: ${runId}（t0=${new Date(t0).toLocaleTimeString()}）`)

  const { finalStatus, elapsedMs, samples, hangSignals, trace } = await sampleLoop(runId, agent.id, t0)
  const tl = timeline(trace, t0)

  // —— 诊断输出 ——
  console.log('\n===== 诊断报告 =====')
  console.log(`终态        : ${finalStatus}（耗时 ${(elapsedMs / 1000).toFixed(1)}s，等待上限 ${(WAIT_MS / 1000).toFixed(0)}s）`)
  console.log(`轨迹事件数  : ${tl.count}｜thinking=${(trace?.thinking || '').length} 字｜reply=${(trace?.reply || '').length} 字`)
  console.log(`挂起信号    : ${hangSignals.length ? hangSignals.map((h) => `${(h.at / 1000).toFixed(0)}s:${h.kind}`).join(', ') : '无'}`)

  if (tl.count) {
    console.log('\n-- 事件时间线（相对 t0，秒）--')
    for (const p of tl.pts.slice(0, 40)) console.log(`  +${(p.at / 1000).toFixed(1)}s  ${p.type}`)
    if (tl.maxGap.gapMs > 0) {
      console.log(`\n最长静默段  : +${(tl.maxGap.from.at / 1000).toFixed(1)}s (${tl.maxGap.from.type}) → +${(tl.maxGap.to.at / 1000).toFixed(1)}s (${tl.maxGap.to.type})，静默 ${(tl.maxGap.gapMs / 1000).toFixed(1)}s`)
    }
    const lastPt = tl.pts[tl.pts.length - 1]
    console.log(`最后事件    : +${(lastPt.at / 1000).toFixed(1)}s ${lastPt.type}（之后静默 ${((elapsedMs - lastPt.at) / 1000).toFixed(1)}s）`)
  } else {
    console.log('\n轨迹事件为 0 → 死在规划/首个 LLM 调用之前（无任何产出）')
  }

  console.log('\n-- 采样快照（每 ' + (SAMPLE_MS / 1000) + 's）--')
  for (const s of samples.slice(-25)) {
    if (s.kind === 'sample') console.log(`  +${(s.at / 1000).toFixed(0)}s status=${s.status} events=${s.events} think=${s.thinking} reply=${s.reply} last=${s.lastType || '-'}`)
    else console.log(`  +${(s.at / 1000).toFixed(0)}s [${s.kind}]`)
  }

  // 业务产物验收（铁律：机制到终态 ≠ 真做了事）
  const files = collectFiles(WS)
  console.log(`\n产物文件    : ${files.length ? files.map((f) => `${f.rel}(${f.size}B)`).join(', ') : '无（零产物）'}`)

  // 抓尾部日志补证（get_run_logs 只回 Rust tracing；since_ts 坑：不要传 ISO 格式）
  try {
    const lg = unw(await callTool('agent_get_run_logs', { limit: 400 }))
    const lines = (lg?.lines || []).filter((l) => /agent|llm|planner|tool|error|timeout|panic/i.test(l))
    console.log('\n-- 相关日志尾部 --')
    for (const l of lines.slice(-18)) console.log('  ' + l)
  } catch (e) { console.log('\n日志抓取失败: ' + e.message.slice(0, 80)) }

  if (created) await deleteAgent(created)

  // 结论与退出码
  console.log('\n===== 结论 =====')
  if (finalStatus === 'timeout') {
    console.log(`❌ 挂死确认：${(WAIT_MS / 1000).toFixed(0)}s 内未达终态。`)
    console.log(tl.count === 0
      ? '  类型②：零事件 → 卡在规划/首个 LLM 调用前（模型或网关侧不返回）'
      : `  类型③：有 ${tl.count} 个事件后停滞 → 卡在最后事件「${tl.pts[tl.pts.length - 1]?.type}」之后`)
    process.exit(2)
  }
  if (!files.length) {
    console.log(`⚠️  run 到达终态（${finalStatus}），但零文件产物 —— 走了空转路径或未真正执行写文件`)
    process.exit(1)
  }
  console.log(`✅ 复合任务完成：终态=${finalStatus}，产出 ${files.length} 个文件，耗时 ${(elapsedMs / 1000).toFixed(1)}s`)
  process.exit(0)
}

main().catch((e) => die(3, 'FAIL(ERR): ' + e.message))
