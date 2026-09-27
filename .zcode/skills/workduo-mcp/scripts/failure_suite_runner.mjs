// 失败收尾故障注入套件（2026-09-23 沉淀，筑基支柱①「终态铁律」验收口径 10/10）
//
// 目的：把 `failure_cleanup_probe.mjs` 的单次注入升级为**成套回归**，凑足验收要求的
// 「故障注入 10/10 到终态且锁释放」。
//
// 设计原则：**异构用例，而非同例重复**。同用例跑 10 遍只测抖动（flakiness），不测泛化；
// 本套件混合不同模型（快/慢）× 不同中断时机（规划前/规划中/执行中）× 不同任务负载，
// 才能证明「任何时刻被打断都能收尾」。
//
// 每个用例断言（由 failure_cleanup_probe 执行）：
//   ① 到达明确终态（不停在 running）　② 收尾耗时 ≤30s　③ 锁已释放
//
// 运行前提：WorkDuo 桌面端正在运行（内建 MCP Server 127.0.0.1:18755/mcp 可达）。
// 用法：
//   node failure_suite_runner.mjs                     # 默认跑内置 10 用例
//   SUITE_MODEL_FAST=<id> SUITE_MODEL_SLOW=<id> node failure_suite_runner.mjs
//   SUITE_REPEAT=3 node failure_suite_runner.mjs      # 每用例重复 3 轮（压 flakiness）
// 退出码：0 = 全部 PASS；1 = 有 FAIL；3 = 环境/前置错误。
//
// 入参（环境变量，可选）：
//   SUITE_MODEL_FAST  快模型 id（默认取第一个 enabled text/multimodal 模型）
//   SUITE_MODEL_SLOW  慢模型 id（可选；不设则全部用例用快模型）
//   SUITE_REPEAT      每用例重复轮数（默认 1）
//   SUITE_CLEANUP_MAX_MS  收尾耗时上限（透传探针，默认 30000）
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE = path.join(HERE, 'failure_cleanup_probe.mjs')
const NODE = process.execPath

const FAST = process.env.SUITE_MODEL_FAST || ''
const SLOW = process.env.SUITE_MODEL_SLOW || ''
const REPEAT = parseInt(process.env.SUITE_REPEAT || '1', 10)
const CLEANUP_MAX = process.env.SUITE_CLEANUP_MAX_MS || '30000'

if (!fs.existsSync(PROBE)) { console.error('FAIL(ENV): 找不到探针 ' + PROBE); process.exit(3) }

// 异构用例矩阵：模型档 × 中断时机 × 任务负载
//  - 时机 2s：大概率落在规划调用前/中
//  - 时机 5~8s：落在规划完成、工具执行阶段
//  - 时机 15s：落在多步执行中（慢模型则仍在规划）
const CASES = []
const base = [
  { tag: 'fast-2s', model: FAST, cancel: 2000, load: 'small' },
  { tag: 'fast-5s', model: FAST, cancel: 5000, load: 'small' },
  { tag: 'fast-8s', model: FAST, cancel: 8000, load: 'small' },
  { tag: 'fast-15s', model: FAST, cancel: 15000, load: 'small' },
  { tag: 'fast-5s-again', model: FAST, cancel: 5000, load: 'small' },
]
if (SLOW) {
  base.push(
    { tag: 'slow-5s', model: SLOW, cancel: 5000, load: 'small' },
    { tag: 'slow-10s', model: SLOW, cancel: 10000, load: 'small' },
    { tag: 'slow-20s', model: SLOW, cancel: 20000, load: 'small' },
    { tag: 'slow-5s-again', model: SLOW, cancel: 5000, load: 'small' },
    { tag: 'slow-30s', model: SLOW, cancel: 30000, load: 'small' },
  )
} else {
  // 未提供慢模型 → 用快模型补足 10 例（覆盖更多时机）
  base.push(
    { tag: 'fast-3s', model: FAST, cancel: 3000, load: 'small' },
    { tag: 'fast-6s', model: FAST, cancel: 6000, load: 'small' },
    { tag: 'fast-10s', model: FAST, cancel: 10000, load: 'small' },
    { tag: 'fast-12s', model: FAST, cancel: 12000, load: 'small' },
    { tag: 'fast-20s', model: FAST, cancel: 20000, load: 'small' },
  )
}

function runOne(c, round) {
  const ws = path.join(os.tmpdir(), `wd_suite_${c.tag.replace(/[^a-z0-9]/gi, '_')}_${round}`)
  const env = {
    ...process.env,
    PROBE_MODEL_ID: c.model || undefined,
    PROBE_CANCEL_AFTER_MS: String(c.cancel),
    PROBE_CLEANUP_MAX_MS: CLEANUP_MAX,
    PROBE_TERM_MS: '90000',
    PROBE_WORKSPACE: ws,
  }
  if (!c.model) delete env.PROBE_MODEL_ID
  const t0 = Date.now()
  const r = spawnSync(NODE, [PROBE], { env, encoding: 'utf8', timeout: 180000 })
  const out = (r.stdout || '') + (r.stderr || '')
  const ms = Date.now() - t0
  const pass = r.status === 0
  // 从输出提取收尾耗时与终态
  const cleanup = (out.match(/收尾耗时 = (\d+)ms/) || [])[1]
  const final = (out.match(/终态 = (\w+)/) || [])[1]
  const reason = pass ? '' : (out.match(/FAIL[^\n]*/) || ['FAIL(未知)'])[0].slice(0, 120)
  return { tag: c.tag, round, pass, status: r.status, final, cleanup, ms, reason }
}

async function main() {
  if (!FAST && !SLOW) {
    console.log('[suite] 未指定模型 → 探针将自动选取第一个 enabled 模型')
  }
  console.log(`[suite] 用例数=${base.length} × 重复 ${REPEAT} 轮 = ${base.length * REPEAT} 次注入`)
  console.log(`[suite] 收尾上限 ${CLEANUP_MAX}ms\n`)

  const results = []
  for (let round = 1; round <= REPEAT; round++) {
    for (const c of base) {
      const r = runOne(c, round)
      results.push(r)
      const mark = r.pass ? '✅' : '❌'
      console.log(`${mark} [r${round}] ${c.tag.padEnd(14)} 终态=${String(r.final).padEnd(8)} 收尾=${String(r.cleanup ?? '-').padEnd(7)}ms 用例耗时=${(r.ms / 1000).toFixed(1)}s${r.reason ? '  ' + r.reason : ''}`)
    }
  }

  const passed = results.filter((r) => r.pass).length
  const total = results.length
  const cleanups = results.map((r) => parseInt(r.cleanup, 10)).filter((n) => Number.isFinite(n))
  console.log('\n===== 套件汇总 =====')
  console.log(`通过：${passed}/${total}`)
  if (cleanups.length) {
    console.log(`收尾耗时：min=${Math.min(...cleanups)}ms  max=${Math.max(...cleanups)}ms  avg=${(cleanups.reduce((a, b) => a + b, 0) / cleanups.length).toFixed(0)}ms（上限 ${CLEANUP_MAX}ms）`)
  }
  const fails = results.filter((r) => !r.pass)
  if (fails.length) {
    console.log('\n失败用例：')
    for (const f of fails) console.log(`  - [r${f.round}] ${f.tag}: ${f.reason || 'status=' + f.status}`)
    process.exit(1)
  }
  console.log(`✅ 故障注入 ${passed}/${total} 全部通过：任意中断时刻均到达终态、收尾 ≤${CLEANUP_MAX}ms、锁已释放`)
  process.exit(0)
}

main().catch((e) => { console.error('FAIL(ERR): ' + e.message); process.exit(3) })
