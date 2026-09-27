// 同步 docs/skills/workduo-mcp（单一事实源） → ~/.workbuddy/skills/workduo-mcp（客户端）
// 约定：递归拷贝 + MD5 逐字节校验 + 清理客户端过时文件
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const SRC = path.resolve('E:/Codes/ABC/work-duo/docs/skills/workduo-mcp')
const DST = path.join(process.env.USERPROFILE, '.workbuddy/skills/workduo-mcp')

function md5File(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')
}
function walk(dir, base = SRC) {
  let out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name)
    if (e.isDirectory()) out = out.concat(walk(fp))
    else out.push(path.relative(base, fp))
  }
  return out
}

const rels = walk(SRC)
let copied = 0, matched = 0, mism = 0
for (const rel of rels) {
  const sp = path.join(SRC, rel)
  const dp = path.join(DST, rel)
  fs.mkdirSync(path.dirname(dp), { recursive: true })
  fs.copyFileSync(sp, dp)
  copied++
  const sm = md5File(sp), dm = md5File(dp)
  if (sm === dm) matched++
  else { mism++; console.log('MD5 MISMATCH', rel) }
}

// 清理客户端有但源没有的文件（保持严格一致）
function walkDst(dir, base = DST) {
  let out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name)
    if (e.isDirectory()) out = out.concat(walkDst(fp))
    else out.push(path.relative(base, fp))
  }
  return out
}
let removed = 0
for (const rel of walkDst(DST)) {
  if (!rels.includes(rel)) {
    fs.rmSync(path.join(DST, rel), { force: true })
    removed++
    console.log('REMOVED stale', rel)
  }
}

console.log(`SYNC_OK copied=${copied} md5matched=${matched} mismatched=${mism} removedStale=${removed}`)
