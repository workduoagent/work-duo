// 意图探针：KB 事实问答在「绑 KB + planAutoApproveMode=never + autoToolExecMode」下的
// 意图分类 / 检索命中一站式核验（#1 快路径回归件：期望 intent=SIMPLE_CHAT 且命中>0）。
// 前置：WorkDuo 客户端运行中；KB_ID 指向一个已索引的知识库（可用 PROBE_KB_ID 覆盖）。
// 用法：node docs/skills/workduo-mcp/scripts/agent_intent_probe.mjs
import { initMcp, callTool, unw, asRows, traceInner, extractKbEvents, hitsOf, startRun } from './agent_task_driver.mjs'

const KB_ID = process.env.PROBE_KB_ID || 'fdb2c6f9-9985-4833-b90f-bda67b52ba09'

async function main() {
  await initMcp('intent-probe')
  const models = asRows(await callTool('agent_list_models', {}))
  const BAD = '6001e0c3-eb75-47e0-a020-c3a3bc4e5f40'
  const enabled = models.filter((m) => m.id !== BAD && (m.category === 'text' || m.category === 'multimodal') && m.enabled === 1)
  const model = enabled.find((m) => /glm/i.test(`${m.name}${m.model_name || ''}`)) || enabled[0]
  let llmConfig = {}; try { llmConfig = typeof model.config === 'string' ? JSON.parse(model.config || '{}') : (model.config || {}) } catch {}
  const scenarios = asRows(await callTool('agent_list_scenarios', {}))
  const ident = `iprobe-${Date.now()}`
  const ag = unw(await callTool('agent_ui_create', { payload: { name: '意图探针', identifier: ident, scenario: scenarios[0]?.value || 'dev-programming', description: 'intent probe', systemPrompt: '你是知识库问答助手，引用时句末标注 [1]。', llmId: model.id, llmConfig, isActive: true, autoToolExecMode: true, allowSandbox: true, memoryMode: 'off', planAutoApproveMode: 'never', kbIds: [KB_ID] } }))
  const sess = unw(await callTool('agent_session_create', { payload: { agentIdentifier: ident, sessionName: 'IP' } }))
  console.log(`[agent] ${ag?.id} session=${sess?.id}`)

  const prompt = '请检索知识库回答：重试策略规定的最大重试次数是多少？基于知识库作答并在引用处标注 [1]。'
  const { status } = await startRun(ag?.id, prompt, sess?.id, {}, { maxMs: 180000 })

  const trace = traceInner(unw(await callTool('agent_get_run_trace', {})))
  const str = JSON.stringify(trace)
  const intent = (str.match(/intent_type["']?\s*[:=]\s*["']?(\w+)/i) || [])[1]
  const reason = (str.match(/"reason"\s*:\s*"([^"]{0,90})/) || [])[1]
  const kbHits = Math.max(0, ...extractKbEvents(trace).map((e) => hitsOf(e.parsed)))
  console.log('\n===== 探针结论 =====')
  console.log('status =', status, '| intent =', intent, '| kb_hits =', kbHits, '| reply_len =', (trace?.reply || '').length)
  console.log('| reason =', reason)
  const pass = intent === 'SIMPLE_CHAT' && kbHits > 0
  console.log('PASS =', pass ? '✅ SIMPLE_CHAT 快路径 + 检索命中' : '❌ 未达预期')
  console.log('RESULT_JSON ' + JSON.stringify({ intent, kbHits, status, pass }))
  if (!pass) process.exitCode = 1
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1) })
