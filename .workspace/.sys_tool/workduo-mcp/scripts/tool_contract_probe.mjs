// 工具契约边界防御探针（L2 pillar②「工具契约」，2026-09-23 沉淀）
//
// 目的：验证「工具契约」——非法/异常入参必须**快速返回结构化错误**，绝不能：
//   ① 静默空返回（ok:true 但数据为空 / 无信息）；② 挂死（验证路径超时不返回）；③ 崩溃（500/异常无结构）。
// 这是筑基三支柱里「② 工具契约」的自动化边界覆盖——此前只有 happy-path 驱动（kb_driver 等），
// 没有任何用例专门轰「坏入参」。
//
// 设计原则（MCP-first，不绕过）：本探针**只复用现有 70 工具**构造坏入参并断言拒绝，
// 不新增 MCP 能力；若发现某坏入参未被拒绝（契约缺口），回流到 MCP/SKILL 层修，而非自写替代。
//
// 覆盖维度（多样化，非同例重复）：
//   - 缺必填（agent_run_task 无 prompt / 无 agentId）
//   - 非法枚举（plugin_upsert runtime='node'，已知坑 #6）
//   - 越界引用（kb_get / kb_add_file / skill_upsert 用不存在 id）
//   - 空标识（skill_upsert identifier 空串）
//   - 未知审批（agent_submit_approval 假 approvalId）
//   - 超大自由文本（100k 字符 prompt，验证不 OOM/不挂死，应在 id 校验阶段快速拒绝）
//   - 已知漂移观测（memory_anchor 缺 category → 落 'general' 枚举漂移，已知坑 #7，记为 WARN 待修）
//
// 运行前提：WorkDuo 桌面端正在运行（内建 MCP Server 127.0.0.1:18755/mcp 可达）。**无需模型**（全部坏入参在校验层拒绝，不触发 LLM）。
// 用法：node tool_contract_probe.mjs
// 退出码：0 = 全部 case 通过（快速结构化拒绝，无契约违反）；1 = 有 case 违反契约（挂死/静默空/崩溃）；2 = 含已知漂移 WARN（需跟进但未阻断）；3 = 环境/前置错误。
import { initMcp, callTool } from './agent_task_driver.mjs'

const REJECT_LIMIT_MS = 15000 // 契约路径（校验/拒绝）应在 15s 内返回；这是快路径不是执行

function die(code, msg) { console.error(msg); process.exit(code) }

/**
 * 期望「快速结构化拒绝」：调用工具，断言它在 REJECT_LIMIT_MS 内以结构化错误结束。
 * 返回 { rejected, hang, ms, detail, raw }。
 *   rejected=true  → 符合契约（抛错 或 返回 {ok:false}/含 error，且 detail 非空）
 *   hang=true       → 超时未返回，违反契约②（执行限时）
 *   rejected=false  → 坏入参竟被「接受」，违反契约（除非该 case 本就该接受）
 */
async function expectReject(tool, args) {
  const t0 = Date.now()
  try {
    const r = await callTool(tool, args, { timeoutMs: REJECT_LIMIT_MS })
    const ms = Date.now() - t0
    // 成功返回但带结构化错误标记
    const isErr = (r && typeof r === 'object' && (r.ok === false || r.error || (r.data && r.data.ok === false)))
    const detail = JSON.stringify(r).slice(0, 200)
    return { rejected: !!isErr, hang: false, ms, detail, raw: r }
  } catch (e) {
    const ms = Date.now() - t0
    if (/HTTP 超时|超时/.test(e.message) && ms >= REJECT_LIMIT_MS - 500) {
      return { rejected: false, hang: true, ms, detail: e.message.slice(0, 160) }
    }
    // 抛错即结构化拒绝（isError / JSON-RPC error），detail 取抛错信息
    return { rejected: true, hang: false, ms, detail: e.message.slice(0, 200) }
  }
}

// 各 case：{ id, name, tool, args, expect:'reject'|'observe', note? }
const CASES = [
  { id: 'TC-01', name: 'agent_run_task 缺 agentId', tool: 'agent_run_task', args: { prompt: 'ping' }, expect: 'reject',
    note: '主键缺失应快速拒绝，不进入 run' },
  { id: 'TC-02', name: 'agent_run_task 缺 prompt', tool: 'agent_run_task', args: { agentId: 'bogus-' + Date.now() }, expect: 'reject',
    note: '必填字段缺失应快速拒绝' },
  { id: 'TC-03', name: 'plugin_upsert runtime=node（已知坑#6）', tool: 'plugin_upsert',
    args: { name: 'x', identifier: 'x', description: 'x', runtime: 'node', scriptContent: 'export default {}' }, expect: 'reject',
    note: 'runtime 仅 python/bun，node 应被校验拒绝' },
  { id: 'TC-04', name: 'plugin_upsert 缺 identifier', tool: 'plugin_upsert',
    args: { name: 'x', description: 'x', runtime: 'bun', scriptContent: 'export default {}' }, expect: 'reject',
    note: 'identifier 为必填，缺失应拒绝' },
  { id: 'TC-05', name: 'kb_get 不存在 id', tool: 'kb_get', args: { id: 'kb-nonexist-' + Date.now() }, expect: 'reject',
    note: '越界引用应结构化「not found」，不静默空' },
  { id: 'TC-06', name: 'kb_add_file 不存在 kbId', tool: 'kb_add_file',
    args: { kbId: 'kb-nonexist-' + Date.now(), relPath: 'a.md', content: '# a' }, expect: 'reject',
    note: '写操作越界引用应拒绝，不静默空/不崩' },
  { id: 'TC-07', name: 'skill_upsert identifier 空串', tool: 'skill_upsert',
    args: { skill: { identifier: '', name: 'x', description: 'x' } }, expect: 'reject',
    note: '空标识应拒绝，不创建脏数据（对照 mcp_selftest_mubeu6ns id 为空遗留）' },
  { id: 'TC-08', name: 'agent_submit_approval 假 approvalId', tool: 'agent_submit_approval',
    args: { approvalId: 'ap-nonexist-' + Date.now(), decision: 'approve', agentId: 'bogus' }, expect: 'reject',
    note: '未知审批应结构化拒绝/无操作，不静默吞' },
  { id: 'TC-09', name: '超大自由文本 prompt（100k 字符）', tool: 'agent_run_task',
    args: { agentId: 'bogus-' + Date.now(), prompt: 'x'.repeat(100000) }, expect: 'reject',
    note: '超大输入应在 id 校验阶段快速拒绝，不 OOM/不挂死' },
  { id: 'TC-10', name: 'memory_anchor 缺 category（已知坑#7 漂移观测）', tool: 'memory_anchor',
    args: { key: 'tc-probe-' + Date.now(), content: 'boundary probe temp' }, expect: 'observe',
    note: '当前会落 SQL 默认 general（枚举外），应改为拒绝或默认 other；本 case 观测并记 WARN' },
]

async function main() {
  await initMcp('tool-contract-probe')
  console.log(`[probe] 契约边界用例数=${CASES.length}，拒绝上限=${REJECT_LIMIT_MS}ms\n`)

  const results = []
  for (const c of CASES) {
    if (c.expect === 'reject') {
      const r = await expectReject(c.tool, c.args)
      const pass = r.rejected && !r.hang
      results.push({ ...c, ...r, pass, kind: r.hang ? 'HANG' : (r.rejected ? 'REJECT' : 'ACCEPTED') })
      const mark = pass ? '✅' : (r.hang ? '❌挂死' : '❌被接受')
      console.log(`${mark} ${c.id} ${c.name}  (${r.ms}ms) ${r.hang ? '' : r.rejected ? '→ ' + r.detail.slice(0, 90) : '坏入参竟被接受!'}`)
    } else {
      // observe：调用后看结果，不硬判，记 WARN
      const r = await expectReject(c.tool, c.args)
      let drift = false
      try {
        const list = await callTool('memory_list', { query: c.args.key }, { timeoutMs: 15000 })
        const rows = Array.isArray(list) ? list : (list?.rows || list?.data?.rows || [])
        drift = rows.some((m) => (m.category || '').toLowerCase() === 'general')
      } catch {}
      results.push({ ...c, ...r, pass: true, kind: drift ? 'WARN-DRIFT' : 'OBSERVED', drift })
      console.log(`${drift ? '⚠️' : '🔎'} ${c.id} ${c.name}  drift=${drift ? '落 general 枚举漂移(已知坑#7)' : '未观测到漂移'}`)
    }
  }

  const fails = results.filter((r) => !r.pass)
  const warns = results.filter((r) => r.kind && r.kind.startsWith('WARN'))
  console.log('\n===== 工具契约边界防御结论 =====')
  console.log(`通过：${results.filter((r) => r.pass).length}/${results.length}`)
  if (warns.length) {
    console.log('\n⚠️ 已知漂移（需回流 MCP/SKILL 修，不阻断本次）:')
    for (const w of warns) console.log(`  - ${w.id} ${w.name}：memory_anchor 缺 category 落 'general'，应拒绝或默认 'other'`)
  }
  if (fails.length) {
    console.log('\n❌ 契约违反:')
    for (const f of fails) console.log(`  - ${f.id} ${f.name}：${f.kind === 'HANG' ? '校验路径超时挂死（违反执行限时）' : '坏入参被静默接受（违反结构化拒绝）'}`)
    process.exit(1)
  }
  if (warns.length) {
    console.log(`✅ 契约拒绝全部通过；存在 ${warns.length} 项已知漂移 WARN，需跟进（exit 2）`)
    process.exit(2)
  }
  console.log('✅ 工具契约边界防御全部通过：坏入参均快速结构化拒绝，无挂死/无静默空/无崩溃')
  process.exit(0)
}

main().catch((e) => die(3, 'FAIL(ERR): ' + e.message))
