// WorkDuo 内建 MCP 标准任务驱动库（ESM，供各驱动脚本 import 复用）。
// 职责：JSON-RPC 客户端 / 终态轮询 + 三类挂起自动应答（计划审批·工具审批·恢复门禁）/
//       轨迹解包与 KB 事件提取 / 增量日志抓取。业务断言放各脚本，本库不做断言。
// 用法：import { initMcp, callTool, pollRun, … } from './agent_task_driver.mjs'
import http from 'node:http'

export const MCP = { host: '127.0.0.1', port: 18755, path: '/mcp' }

let SESSION = null
let idc = 0

function post(body, { timeoutMs = 200000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(payload) }
    if (SESSION) headers['Mcp-Session-Id'] = SESSION
    const req = http.request({ ...MCP, method: 'POST', headers, timeout: timeoutMs }, (res) => {
      if (!SESSION && res.headers['mcp-session-id']) SESSION = res.headers['mcp-session-id']
      const chunks = []; res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode === 202) return resolve(null)
        const dataLines = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6).trim())
        const last = dataLines[dataLines.length - 1]
        try { resolve(last ? JSON.parse(last) : null) } catch (e) { reject(new Error('raw(' + res.statusCode + '): ' + raw.slice(0, 200))) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('HTTP 超时'))); req.on('error', reject); req.write(payload); req.end()
  })
}

/** 初始化 MCP 会话（initialize + initialized 通知）。 */
export async function initMcp(clientName = 'workduo-driver') {
  await post({ jsonrpc: '2.0', id: ++idc, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: clientName, version: '1.0' } } })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { isNotification: true })
}

/** 原始 JSON-RPC 请求（非工具调用场景，如 tools/list；初始化后自动携带会话）。 */
export const rawPost = post

/** 调用 MCP 工具，返回解析后的 content JSON（isError/JSON-RPC error 抛异常）。 */
export async function callTool(name, args, { timeoutMs = 200000 } = {}) {
  const resp = await post({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args } }, { timeoutMs })
  const content = resp?.result?.content?.[0]?.text
  if (resp?.result?.isError) throw new Error(`${name} 工具错误: ${content}`)
  if (resp?.error) throw new Error(`${name} 失败: ${JSON.stringify(resp)}`)
  return content ? JSON.parse(content) : resp.result
}

/** 剥 UI 级 {ok,data} 信封。 */
export function unw(r) { return r && typeof r === 'object' && 'ok' in r && 'data' in r ? r.data : r }

/** 行集合兼容解包（数组 / {rows} / {data} / {data:{rows}}）。 */
export function asRows(r) {
  r = unw(r)
  if (!r) return []
  if (Array.isArray(r)) return r
  if (Array.isArray(r.rows)) return r.rows
  if (r.data && Array.isArray(r.data)) return r.data
  if (r.data && Array.isArray(r.data.rows)) return r.data.rows
  return []
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轨迹解包：agent_get_run_trace 返回外层 {"trace":{…}}，取字段须先剥一层。 */
export function traceInner(t) { return t?.trace || t || {} }

/** 从轨迹 events 提取 native__kb_search 的 tool_finished（args/parsed/raw）。 */
export function extractKbEvents(trace) {
  const evs = Array.isArray(trace?.events) ? trace.events : []
  const out = []
  for (const e of evs) {
    const p = e?.payload || {}
    if ((p.type || p.eventType) !== 'tool_finished') continue
    const step = p.step || {}
    if (!/kb_search/i.test(step.toolName || '')) continue
    let parsed = null
    try { parsed = JSON.parse(typeof step.result === 'string' ? step.result : JSON.stringify(step.result)) } catch {}
    out.push({ status: step.status, args: typeof step.args === 'string' ? step.args : JSON.stringify(step.args || {}), parsed })
  }
  return out
}

/** kb 事件命中数（兼容数组形态 / {hits} 包装形态）。 */
export function hitsOf(parsed) {
  return Array.isArray(parsed) ? parsed.length : Array.isArray(parsed?.hits) ? parsed.hits.length : 0
}

/** 增量日志抓取器：内部去重，每次只返回新行。 */
export function logFetcher(limit = 500) {
  const seen = new Set()
  return async function fetchNewLogs() {
    try {
      const r = unw(await callTool('agent_get_run_logs', { limit }))
      const fresh = (r?.lines || []).filter((l) => !seen.has(l))
      for (const l of fresh) seen.add(l)
      return fresh
    } catch (e) { return [`<log fetch failed: ${e.message}>`] }
  }
}

/**
 * 终态轮询 + 三类挂起自动应答（HITL）：
 *  - pending.kind='recovery'（recoveryWaiting=true）→ agent_submit_recovery_decision（默认 skip）
 *  - pending.request.approvalId（敏感工具审批）→ agent_submit_approval approve
 *  - waitingApproval=true（计划门禁）→ agent_submit_plan_decision approve（30s 兜底各一次）
 * 返回 { status }：done / error / timeout / gone。
 */
export async function pollRun(runId, agentId, { maxMs = 200000, intervalMs = 3000, recoveryDecision = 'skip' } = {}) {
  const t0 = Date.now()
  let planApproved = 0, recoveryCount = 0
  const toolApproved = new Set()
  while (Date.now() - t0 < maxMs) {
    await sleep(intervalMs)
    let st
    try { st = unw(await callTool('agent_get_status', { run_id: runId })) } catch (e) { return { status: 'gone' } }
    const s = JSON.stringify(st || {})
    // ① 恢复门禁：步骤失败重试耗尽，不回应则永久挂起
    if (s.includes('"recoveryWaiting":true') || s.includes('"kind":"recovery"')) {
      recoveryCount++
      try { unw(await callTool('agent_submit_recovery_decision', { decision: recoveryDecision, agentId })); console.log(`  [auto-recovery] 第${recoveryCount}次 → ${recoveryDecision}`) } catch (e) { console.log('  [auto-recovery ERR]', e.message.slice(0, 110)) }
      continue
    }
    // ② 敏感工具审批：approvalId 精确放行
    const aid = (s.match(/"approvalId"\s*:\s*"([^"]+)"/) || [])[1]
    if (aid && !toolApproved.has(aid)) {
      toolApproved.add(aid)
      try { unw(await callTool('agent_submit_approval', { approvalId: aid, decision: 'approve', agentId })); console.log('  [auto-approve-tool]', aid.slice(0, 20)) } catch (e) { console.log('  [auto-approve-tool ERR]', e.message.slice(0, 110)) }
      continue
    }
    // ③ 计划门禁
    if (planApproved < 2 && s.includes('"waitingApproval":true')) {
      planApproved++
      try { unw(await callTool('agent_submit_plan_decision', { decision: 'approve', agentId })); console.log('  [auto-approve-plan]') } catch (e) { console.log('  [auto-approve-plan ERR]', e.message.slice(0, 110)) }
      continue
    }
    if (planApproved === 0 && Date.now() - t0 > 30000 && (st?.status === 'running' || st?.status === 'pending')) {
      planApproved++
      try { unw(await callTool('agent_submit_plan_decision', { decision: 'approve', agentId })) } catch {}
    }
    if (st?.status && st.status !== 'running' && st.status !== 'pending') return { status: st.status }
    if (st?.error) return { status: 'gone' }
  }
  return { status: 'timeout' }
}

/** 组装一次 run（round_create → run_task → pollRun）。extra 透传额外参数（如 workspace）。 */
export async function startRun(agentId, prompt, sessionId, extra = {}, { maxMs, intervalMs, recoveryDecision } = {}) {
  const roundIndex = Date.now() % 100000 // 时间戳尾数作 roundIndex，避免驱动脚本间冲突
  const rd = unw(await callTool('agent_round_create', { payload: { sessionId, roundIndex, userQuestion: prompt.slice(0, 60) } }))
  const rt = unw(await callTool('agent_run_task', { agentId, prompt, sessionId, roundId: rd?.id, ...extra }, { timeoutMs: 30000 }))
  const runId = rt?.run_id || rt?.runId
  if (!runId) throw new Error('agent_run_task 未返回 run_id: ' + JSON.stringify(rt).slice(0, 160))
  const pr = await pollRun(runId, agentId, { maxMs, intervalMs, recoveryDecision })
  return { runId, status: pr.status }
}
