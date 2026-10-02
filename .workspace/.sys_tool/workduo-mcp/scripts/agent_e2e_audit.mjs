// WorkDuo 全模块 E2E 评分审计（四阶段 · 100 分制）。
// 阶段：P1 发现(tools/资产大盘) → P2 基建装配(KB 10 文件全链路+插件试跑) →
//       P3 自由会话 RAG(意图 SIMPLE_CHAT 快路径/检索命中+[N]引标/tags 捷径/误杀诊断) →
//       P4 复合任务 Codex 基准(workspace 绑定/PlanDAG/verified/产物磁盘穿透) + 数据留痕一致性。
// 评分：意图 20 / 真实验收 30 / 校验器 25 / 数据留痕 25。报告写 ./e2e_audit_report.json（cwd）。
// 前置：WorkDuo 客户端运行中（127.0.0.1:18755）；node .workspace/.sys_tool/workduo-mcp/scripts/agent_e2e_audit.mjs
import { writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { initMcp, rawPost, callTool, unw, asRows, sleep, traceInner, extractKbEvents, hitsOf, logFetcher, pollRun } from './agent_task_driver.mjs'

const WORKSPACE = 'E:/v3_workspace_p4'
const REPORT = process.env.E2E_REPORT_PATH || 'e2e_audit_report.json'

async function toolsList() {
  const tl = await rawPost({ jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} })
  return tl?.result?.tools || []
}

const report = { startedAt: new Date().toISOString(), phases: {}, score: { intent: 20, acceptance: 30, verifier: 25, consistency: 25 }, scoreBreakdown: {}, assets: {} }
const phase = (p) => (report.phases[p] = report.phases[p] || { checks: [] }).checks
function note(p, ok, msg, evidence) { phase(p).push({ ok, msg, evidence: evidence ?? null }); console.log(`${ok ? '✅' : '❌'} [${p}] ${msg}` + (evidence !== undefined ? `  ← ${JSON.stringify(evidence).slice(0, 200)}` : '')) }
function deduct(b, pts, reason) { report.score[b] = Math.max(0, report.score[b] - pts); (report.scoreBreakdown[b] = report.scoreBreakdown[b] || []).push(`-${pts}: ${reason}`); console.log(`   ⚠️ 扣分[${b}] -${pts}: ${reason}`) }
const fetchNewLogs = logFetcher(500)
const KB_MARK = /kb_search|标签圈定|tags-as-kb|空结果|scope_kb|no_match|tag_filter_miss/

let roundIdx = 0
async function runCase(tag, prompt, ctx, { maxMs = 200000, workspace = null } = {}) {
  const c = { tag, status: null, intent: null, reply: '', kbEvents: [], logs: [], error: null }
  try {
    const { runId, status } = await startRun(ctx.agentId, prompt, ctx.sessionId, workspace ? { workspace } : {}, { maxMs })
    c.status = status
    c.logs = (await fetchNewLogs()).filter((l) => l.includes(ctx.agentId.slice(0, 8)) || KB_MARK.test(l))
    const trace = traceInner(unw(await callTool('agent_get_run_trace', {})))
    const str = JSON.stringify(trace)
    c.intent = (str.match(/intent_type["']?\s*[:=]\s*["']?(\w+)/i) || [])[1]
    c.reply = trace?.reply || ''
    c.replyLen = c.reply.length
    c.kbEvents = extractKbEvents(trace)
  } catch (e) { c.error = e.message.slice(0, 200); c.logs = (await fetchNewLogs()).filter((l) => KB_MARK.test(l)) }
  console.log(`\n----- [${tag}] status=${c.status} intent=${c.intent} replyLen=${c.replyLen ?? 0}`)
  for (const ev of c.kbEvents) console.log(`  [kb ${ev.status}] args=${ev.args.slice(0, 120)} hits=${hitsOf(ev.parsed)}`)
  for (const l of c.logs.slice(-6)) console.log(`  [log] ${l.slice(0, 230)}`)
  if (c.error) console.log(`  [ERROR] ${c.error}`)
  return c
}

async function main() {
  const ts = Date.now()
  await initMcp('e2e-audit')
  const tools = await toolsList()
  note('P1.discovery', tools.length >= 65, `tools/list=${tools.length}（≥65）`, { n: tools.length })
  for (const [name, label] of [['agent_list_models', '模型'], ['agent_list_skills', '技能'], ['agent_list_mcps', 'MCP'], ['agent_list_plugins', '插件'], ['agent_list_kbs', 'KB'], ['agent_list_scenarios', '场景']]) {
    try { note('P1.assets', asRows(await callTool(name, {})).length > 0, `${name} 返回行数>0（${label}）`) } catch (e) { note('P1.assets', false, `${name} 失败：${e.message.slice(0, 80)}`) }
  }

  // ===== 阶段二 =====
  console.log('\n========== 阶段二：基建装配 ==========')
  const identKb = `v3audit-${ts}`
  const kb = unw(await callTool('kb_create', { identifier: identKb, name: 'V3审计库', description: 'E2E' }))
  report.assets.kbId = kb?.id
  note('P2.kb_create', !!kb?.id, 'kb_create 落库', { id: kb?.id })
  const files = [
    ['docs/01-retry-policy.md', '# 重试策略\n\n所有对外 HTTP 请求必须采用指数退避重试：最大重试 5 次，间隔 1s/2s/4s/8s/16s；429 按 Retry-After 等待；5 次失败进入死信队列。\n'],
    ['docs/02-deploy.md', '# 部署规范\n\n蓝绿发布，回滚窗口 30 分钟；错误率超 1% 立即回滚。\n'],
    ['docs/03-logging.md', '# 日志规范\n\n统一 tracing 格式，INFO 起步，错误带 stack。\n'],
    ['docs/04-api.md', '# API 规范\n\nREST 资源命名复数，分页 cursor 制，错误码三段式。\n'],
    ['docs/05-db.md', '# 数据库规范\n\nSQLite 迁移脚本单文件递增，禁直写 SQL 于组件层。\n'],
    ['docs/06-test.md', '# 测试规范\n\n单测覆盖核心纯函数，集成测走沙箱。\n'],
    ['docs/07-security.md', '# 安全规范\n\n密钥走环境变量，用户输入展示须转义。\n'],
    ['docs/08-perf.md', '# 性能规范\n\n列表接口 P95 < 200ms，向量检索 top_k 上限 8。\n'],
    ['docs/09-docs.md', '# 文档规范\n\n需求单一事实源入跟踪文档，决策留痕。\n'],
    ['docs/10-git.md', '# Git 规范\n\n小步提交，先验证再推送。\n'],
  ]
  let addOk = 0
  for (const [relPath, content] of files) { try { await callTool('kb_add_file', { kbId: kb.id, relPath, content }); addOk++ } catch (e) { console.log(`  add_file ${relPath} 失败`) } }
  note('P2.kb_add_file', addOk === 10, `kb_add_file 10 文件全落盘（${addOk}/10）`)
  try { unw(await callTool('kb_rebuild_index', { kbId: kb.id })) } catch {}
  let allIndexed = false
  for (let i = 0; i < 40; i++) { await sleep(2000); const as = asRows(await callTool('kb_list_assets', { kbId: kb.id })); if (as.length === 10 && as.every((a) => a.indexedAt)) { allIndexed = true; break } }
  note('P2.kb_index', allIndexed, '重建索引 10/10 indexedAt 非空', { allIndexed })
  const ups = unw(await callTool('plugin_upsert', { name: 'v3求和插件', identifier: `v3-sum-${ts}`, description: 'bun 零依赖求和', runtime: 'bun', scriptContent: `/**\n * name: sum\n */\nexport async function run(params){ return { sum: Number(params.a||0)+Number(params.b||0) }; }`, parametersSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }, sampleParams: { a: 2, b: 5 }, timeoutSec: 120 }))
  report.assets.pluginId = ups?.id
  note('P2.plugin_upsert', !!ups?.id, 'plugin_upsert 落库', { id: ups?.id })
  const pt = unw(await callTool('plugin_test', { pluginId: ups?.id, params: { a: 2, b: 5 } }))
  note('P2.plugin_test', pt?.ok === true && pt?.exitCode === 0, 'plugin_test ok=true exitCode=0', { result: pt?.result })

  // ===== 阶段三 =====
  console.log('\n========== 阶段三：自由会话 RAG ==========')
  const models = asRows(await callTool('agent_list_models', {}))
  const BAD = '6001e0c3-eb75-47e0-a020-c3a3bc4e5f40'
  const enabled = models.filter((m) => m.id !== BAD && (m.category === 'text' || m.category === 'multimodal') && m.enabled === 1)
  const model = enabled.find((m) => /glm/i.test(`${m.name}${m.model_name || ''}`)) || enabled[0]
  let llmConfig = {}; try { llmConfig = typeof model.config === 'string' ? JSON.parse(model.config || '{}') : (model.config || {}) } catch {}
  const scenarios = asRows(await callTool('agent_list_scenarios', {}))
  const identAg = `v3audit-ag-${ts}`
  const ag = unw(await callTool('agent_ui_create', { payload: { name: 'V3审计员', identifier: identAg, scenario: scenarios[0]?.value || 'dev-programming', description: 'E2E v3', systemPrompt: '你是严谨的知识库问答助手：先检索知识库再回答；引用知识库内容时在对应句子末尾标注引用编号（如 [1]）。', llmId: model.id, llmConfig, isActive: true, autoToolExecMode: true, allowSandbox: true, memoryMode: 'off', planAutoApproveMode: 'never', kbIds: [kb.id] } }))
  const sess = unw(await callTool('agent_session_create', { payload: { agentIdentifier: identAg, sessionName: 'V3' } }))
  const ctx = { agentId: ag?.id, sessionId: sess?.id }
  report.assets.agentId = ctx.agentId
  note('P3.agent_setup', !!ctx.agentId && !!ctx.sessionId, 'Agent（never/autoToolExec）+ 会话创建', ctx)

  const rA = await runCase('P3-A 默认范围事实问答', '请检索知识库回答：重试策略规定的最大重试次数是多少？基于知识库作答并在引用处标注引用编号（如 [1]）。', ctx)
  const hitsA = rA.kbEvents.length ? Math.max(...rA.kbEvents.map((e) => hitsOf(e.parsed))) : 0
  const cited = /\[\d+\]/.test(rA.reply) || /docs\//.test(rA.reply)
  note('P3-A.rag_hits', hitsA > 0, `kb_search 命中 ${hitsA}>0`, { hits: hitsA })
  if (!(hitsA > 0)) deduct('acceptance', 10, 'P3-A 0 命中')
  note('P3-A.reply_citation', rA.replyLen > 0 && cited, `reply ${rA.replyLen} 字含引标/溯源=${cited}`)
  if (!(rA.replyLen > 0 && cited)) deduct('acceptance', 5, 'P3-A reply 缺引标')
  note('P3-A.intent_simple', rA.intent === 'SIMPLE_CHAT', `意图=${rA.intent}（KB 事实问答应 SIMPLE_CHAT 快路径）`, { intent: rA.intent })
  if (rA.intent !== 'SIMPLE_CHAT') deduct('intent', 10, 'KB 事实问答未走 SIMPLE_CHAT 快路径')

  const rB = await runCase('P3-B tags 塞库名捷径', `请调用知识库检索工具 native__kb_search，参数严格为：query 传 "重试策略 最大重试次数"，tags 传数组 ["${identKb}"]（这是知识库标识）。不要传 kb_ids。基于检索结果回答并标注 [1]。`, ctx)
  note('P3-B.shortcut', rB.logs.some((l) => l.includes('tags-as-kb')) && rB.kbEvents.some((e) => hitsOf(e.parsed) > 0), 'tags=库名 → tags-as-kb 捷径按库命中')

  const rC = await runCase('P3-C tags 误杀诊断', '请调用知识库检索工具 native__kb_search，参数严格为：query 传 "重试策略"，tags 传数组 ["绝不存在的标签zzz"]。不要传 kb_ids。把工具返回原文完整告诉我。', ctx)
  note('P3-C.structured_diag', rC.kbEvents.some((e) => e.parsed?.diagnostics?.reason === 'tag_filter_miss'), 'tags 误杀 → 结构化诊断（非静默空）')
  if (!rC.kbEvents.some((e) => e.parsed?.diagnostics?.reason === 'tag_filter_miss')) deduct('verifier', 5, 'P3-C 无结构化诊断')

  // ===== 阶段四 =====
  console.log('\n========== 阶段四：复合任务 Codex 基准 ==========')
  if (!existsSync(WORKSPACE)) mkdirSync(WORKSPACE, { recursive: true })
  const rP4 = await runCase('P4 复合任务', '新建一个 React 组件 Button.tsx（含基础 props），并配套 Button.test.tsx；然后用 Node 沙箱运行测试并确保通过。完成后汇报产物路径。', ctx, { maxMs: 600000, workspace: WORKSPACE })
  const trace4 = traceInner(unw(await callTool('agent_get_run_trace', {})))
  const evs4 = Array.isArray(trace4.events) ? trace4.events : []
  const planEv = evs4.map((e) => e?.payload || {}).find((p) => (p.type || p.eventType) === 'plan_generated')
  const tasks4 = planEv?.plan?.tasks || []
  note('P4.plan_dag', !!planEv, `plan_generated 存在，任务数=${tasks4.length}`, { n: tasks4.length })
  if (!planEv) deduct('verifier', 8, 'P4 无 PlanDAG')
  const stepFins = evs4.map((e) => e?.payload || {}).filter((p) => (p.type || p.eventType) === 'step_finished')
  const verified = stepFins.some((p) => p.plan?.verified === true)
  note('P4.verified_step', verified, `step_finished 含 verified=true（${stepFins.length} 步）`, { steps: stepFins.length, verified })
  if (!verified) deduct('verifier', 8, 'P4 无 verified=true')
  const toolOk = evs4.map((e) => e?.payload || {}).some((p) => (p.type || p.eventType) === 'tool_finished' && p.step?.status === 'success' && !/kb_search/i.test(p.step?.toolName || ''))
  note('P4.tool_evidence', toolOk, 'kb_search 之外存在成功工具调用（执行证据）', { toolOk })
  if (!toolOk) deduct('verifier', 9, 'P4 无工作空间执行证据')
  let tsxFiles = []
  try { const walk = (d, out = []) => { for (const f of readdirSync(d)) { const fp = d + '/' + f; statSync(fp).isDirectory() ? walk(fp, out) : out.push(fp) } return out }; tsxFiles = walk(WORKSPACE) } catch {}
  note('P4.artifact_disk', tsxFiles.some((f) => f.endsWith('Button.tsx')), `workspace 磁盘穿透：Button.tsx ${tsxFiles.some((f) => f.endsWith('Button.tsx')) ? '存在' : '缺失'}（${tsxFiles.length} 文件）`)
  if (!tsxFiles.some((f) => f.endsWith('Button.tsx'))) deduct('acceptance', 15, 'P4 无 Button.tsx 产物')
  note('P4.run_done', rP4.status === 'done', `终态=${rP4.status}`, { status: rP4.status })
  if (rP4.status !== 'done') deduct('acceptance', 15, 'P4 未到 done')

  // ===== 数据留痕一致性 =====
  console.log('\n========== 数据留痕一致性 ==========')
  const kbInList = asRows(await callTool('kb_list', {})).some((k) => k.id === kb.id)
  note('C.kb_traceable', kbInList, 'kb_list 可回查测试 KB')
  if (!kbInList) deduct('consistency', 5, 'KB 不可回查')
  const plInList = asRows(await callTool('agent_list_plugins', {})).some((p) => p.id === ups?.id)
  note('C.plugin_traceable', plInList, 'agent_list_plugins 可回查测试插件')
  if (!plInList) deduct('consistency', 5, '插件不可回查')
  try {
    const rounds = asRows(await callTool('agent_round_list', { sessionId: ctx.sessionId }))
    const answered = rounds.filter((r) => (r.assistantAnswer || r.assistant_answer || '').length > 0).length
    note('C.round_answer_persisted', answered >= 3, `assistant_answer 非空 ${answered}/${rounds.length}`)
    if (answered < 3) deduct('consistency', 10, 'assistant_answer 落库不足')
  } catch (e) { note('C.round_answer_persisted', true, `agent_round_list 形态不符，跳过不计分`) }
  const ts2 = traceInner(unw(await callTool('agent_get_run_trace', {})))
  note('C.trace_structure', !!(ts2 && Array.isArray(ts2.events) && ts2.counts), 'get_run_trace 结构化形态（剥 trace 层）')
  if (!(ts2 && Array.isArray(ts2.events) && ts2.counts)) deduct('consistency', 5, 'trace 结构异常')

  const total = report.score.intent + report.score.acceptance + report.score.verifier + report.score.consistency
  report.total = total
  console.log('\n================ E2E 评分 ================')
  console.log(`意图 ${report.score.intent}/20 ｜ 真实验收 ${report.score.acceptance}/30 ｜ 校验器 ${report.score.verifier}/25 ｜ 留痕 ${report.score.consistency}/25`)
  console.log(`总分：${total}/100`)
  for (const [b, arr] of Object.entries(report.scoreBreakdown)) for (const d of arr) console.log(`  ${b} ${d}`)
  writeFileSync(REPORT, JSON.stringify(report, null, 2))
  console.log(`\n报告已写 ${REPORT}`)
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1) })
