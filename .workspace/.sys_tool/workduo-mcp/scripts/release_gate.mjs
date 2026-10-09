// 发布门禁（A' 门禁运营化，2026-09-24）
// 三层：①L2 gate 全量断言（在线，复用 harness gate）或种子资产静态层（--offline 离线）
//      ②发布指标聚合（done率/产物达成/客观 resolved，同 caseId 取最新口径）
//      ③版本归档 + 环比对比（上一版本指标降幅超阈值 → 阻断）
//
// 用法：
//   node release_gate.mjs --version v20260924-01                # 全量（App 在线时）
//   node release_gate.mjs --version v20260924-01 --offline      # 离线静态层（无 App 环境）
//   node release_gate.mjs --version v1 --out <证据目录>          # 指定证据目录
// 退出码：0 = PASS（可发布）；1 = FAIL（阻断）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const flag = (k) => argv.includes('--' + k)
const VERSION = get('version', 'v' + new Date().toISOString().slice(0, 10).replace(/-/g, ''))

// ── 路径解析：默认相对仓库根（可用 --repo-root 覆盖）────────────────────
// 历史问题：这五处曾硬编码本机 Windows 绝对路径（E:/Codes/...），
// 在 Linux CI 上目录不存在 → 写文件失败 / 误判证据缺失。
// 改为「默认相对仓库根 + 可参数覆盖」，CI 与本地都能跑。
//
// 注意：__dirname = <repo>/.workspace/.sys_tool/workduo-mcp/scripts，
//向上 4 层才是仓库根（scripts→workduo-mcp→.sys_tool→.workspace→repo）。
const REPO_ROOT = path.resolve(get('repo-root', path.join(__dirname, '..', '..', '..', '..')))
// 命令行传入的路径按 CWD 解析（CI 里 CWD= 仓库根），避免被再拼一层前缀
const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p))
const EVAL_DIR = abs(get('eval-dir', path.join(REPO_ROOT, '.workspace', '.eval-results')))
const OUT = abs(get('out', path.join(EVAL_DIR, 'latest')))
const OFFLINE = flag('offline')
const RELEASE_DIR = abs(get('release-dir', path.join(EVAL_DIR, 'release')))
const SQUAD_DIR = abs(get('squad-dir', path.join(EVAL_DIR, 'squad-20260929-final')))
const FAULTS_DIR = abs(get('faults-dir', OUT))
const DROP_PCT = 5 // 指标环比降幅阈值（百分点）

// 发布指标聚合（与 buildScorecard 同款去重口径：同 caseId 多槽位取 mtime 最新）
function collectMetrics(outDir) {
  const files = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => f.endsWith('.json') && !['scorecard.json', 'env.json', 'gate.json', 'release_gate.json'].includes(f) && !f.startsWith('concurrency-'))
    : []
  const latest = new Map()
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'))
      if (!j.caseId || !j.status) continue
      const mt = fs.statSync(path.join(outDir, f)).mtimeMs
      const prev = latest.get(j.caseId)
      if (!prev || mt > prev.__mt) latest.set(j.caseId, { ...j, __mt: mt })
    } catch { /* 跳过坏 JSON */ }
  }
  const cases = [...latest.values()]
  const total = cases.length
  const done = cases.filter((c) => c.status === 'done').length
  const terminal = cases.filter((c) => ['done', 'error', 'cancelled', 'canceled'].includes(c.status)).length
  const art = total ? cases.reduce((n, c) => n + (c.artifactScore || 0), 0) / total : 0
  const judged = cases.filter((c) => c.resolved != null)
  const resolved = judged.length ? judged.filter((c) => c.resolved === true).length / judged.length : null
  return {
    total,
    donePct: total ? +(100 * done / total).toFixed(1) : 0,
    terminalPct: total ? +(100 * terminal / total).toFixed(1) : 0,
    artifactPct: +(100 * art).toFixed(1),
    resolvedPct: resolved == null ? null : +(100 * resolved).toFixed(1),
    judgedCount: judged.length,
  }
}

async function main() {
  const checks = []
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(ok ? '  ✓' : '  ✗', name, '—', detail) }

  console.log(`# 发布门禁（release gate）${VERSION} · 证据=${OUT}${OFFLINE ? ' [离线]' : ''}`)

  // ① L2 gate 全量断言（在线）或种子资产静态层（离线）
  if (!OFFLINE) {
    try {
      const h = await import('file:///' + path.resolve(__dirname, 'l2_eval_harness.mjs').replace(/\\/g, '/'))
      // 故障注入证据目录：OUT 无 fault 证据时回退到 2026-09-23 基线目录
      const hasFaults = fs.existsSync(OUT) && fs.readdirSync(OUT).some((f) => f.startsWith('fault-'))
      const faultsDir = get('faults-dir', hasFaults ? OUT : FAULTS_DIR)
      const r = await h.gate({ outDir: OUT, faultsDir })
      const gateJson = JSON.parse(fs.readFileSync(path.join(OUT, 'gate.json'), 'utf8'))
      add('L2 gate 全量断言', !!r, `${gateJson.checks.filter((c) => c.ok).length}/${gateJson.checks.length} 项`)
      for (const c of gateJson.checks.filter((c) => !c.ok)) add('└ ' + c.name, false, String(c.detail).slice(0, 100))
    } catch (e) {
      add('L2 gate 全量断言', false, '执行异常: ' + e.message.slice(0, 100))
    }
  } else {
    const seedsDir = path.join(__dirname, 'seeds')
    let bad = 0, files = 0
    const pkgs = fs.existsSync(seedsDir) ? fs.readdirSync(seedsDir) : []
    for (const s of pkgs) {
      try {
        JSON.parse(fs.readFileSync(path.join(seedsDir, s, 'seed.json'), 'utf8'))
        files += fs.readdirSync(path.join(seedsDir, s)).filter((f) => f !== 'seed.json').length
      } catch { bad++ }
    }
    add('种子资产完整（离线）', bad === 0 && pkgs.length > 0, `${pkgs.length} 包 / ${files} 文件 / 损坏 ${bad}`)
  }

  // ② 发布指标聚合与阈值
  const cur = collectMetrics(OUT)
  add('证据规模≥5 用例', cur.total >= 5, `${cur.total} 用例`)
  add('done率≥90%', cur.donePct >= 90, `${cur.donePct}%`)
  add('产物达成≥90%', cur.artifactPct >= 90, `${cur.artifactPct}%`)
  if (cur.resolvedPct != null) add('客观判分 resolved≥80%', cur.resolvedPct >= 80, `${cur.resolvedPct}%（${cur.judgedCount} 判分用例）`)

  // ②b Squad suite 门禁（§10：17 用例回归全绿；--squad-dir 指定证据目录，缺目录记 SKIP 不阻断）
  // 注：squadGate 必须声明在块外——归档步骤（§3）也要引用它。
  // 历史 bug：曾声明在此{} 块内却在块外使用 → ReferenceError: squadGate is not defined
  const squadGate = path.join(SQUAD_DIR, 'gate.json')
  {
    if (fs.existsSync(squadGate)) {
      try {
        const g = JSON.parse(fs.readFileSync(squadGate, 'utf8'))
        add('Squad suite 全绿（§10）', !!g.pass, `${g.results.filter((r) => r.autoPass).length}/${g.results.length} 用例 @ ${path.basename(SQUAD_DIR)}`)
        for (const r of g.results.filter((r) => !r.autoPass)) add('└ ' + r.caseId, false, r.status)
      } catch (e) {
        add('Squad suite 全绿（§10）', false, 'gate.json 解析失败: ' + e.message.slice(0, 80))
      }
    } else {
      add('Squad suite 全绿（§10）', true, `SKIP（无 ${path.basename(SQUAD_DIR)}/gate.json——跑 squad_eval_harness.mjs run+gate 生成）`)
    }
  }

  // ③ 版本归档
  const vDir = path.join(RELEASE_DIR, VERSION)
  fs.mkdirSync(vDir, { recursive: true })
  fs.writeFileSync(path.join(vDir, 'metrics.json'), JSON.stringify({ version: VERSION, at: new Date().toISOString(), out: OUT, offline: OFFLINE, ...cur }, null, 2))
  const gateJson = path.join(OUT, 'gate.json')
  if (fs.existsSync(gateJson)) fs.copyFileSync(gateJson, path.join(vDir, 'gate.json'))
  if (fs.existsSync(squadGate)) fs.copyFileSync(squadGate, path.join(vDir, 'squad_gate.json'))
  add('版本归档', true, vDir)

  // ④ 环比对比（最近一个其他版本为基线）
  if (fs.existsSync(RELEASE_DIR)) {
    const others = fs.readdirSync(RELEASE_DIR)
      .filter((d) => d !== VERSION && fs.existsSync(path.join(RELEASE_DIR, d, 'metrics.json')))
      .map((d) => ({ d, mt: fs.statSync(path.join(RELEASE_DIR, d, 'metrics.json')).mtimeMs }))
      .sort((a, b) => b.mt - a.mt)
    if (others.length) {
      const prev = JSON.parse(fs.readFileSync(path.join(RELEASE_DIR, others[0].d, 'metrics.json'), 'utf8'))
      console.log(`  ↳ 对比基线：${others[0].d}（${prev.at}）`)
      const cmp = (label, curV, prevV) => {
        if (prevV == null || curV == null) return add(`环比 ${label}`, true, 'n/a')
        const drop = +(prevV - curV).toFixed(1)
        add(`环比 ${label}`, drop <= DROP_PCT, `prev ${prevV}% → cur ${curV}%（降幅 ${drop}pt，阈值 ${DROP_PCT}pt）`)
      }
      cmp('done率', cur.donePct, prev.donePct)
      cmp('产物达成', cur.artifactPct, prev.artifactPct)
      cmp('resolved', cur.resolvedPct, prev.resolvedPct)
    } else {
      add('环比对比', true, '无历史版本（首版基线建立）')
    }
  }

  const pass = checks.every((c) => c.ok)
  fs.writeFileSync(path.join(vDir, 'release_gate.json'), JSON.stringify({ version: VERSION, at: new Date().toISOString(), pass, checks }, null, 2))
  console.log(pass ? `🟢 RELEASE GATE PASS — ${VERSION} 可发布` : `🔴 RELEASE GATE FAIL — ${VERSION} 阻断发布`)
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error('release gate 异常:', e.message); process.exit(1) })
