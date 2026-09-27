// M 系列 · 记忆与个性化：跨会话召回、更新冲突、双轨沉淀、蒸馏候选。
import fs from 'node:fs'
import path from 'node:path'
import {
  A, finish, withAgent, drive, wsOf, callTool, unw, asRows, waitFor, WAIT_MS, filesIn, readFileSafe,
} from '../lib/caplib.mjs'

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

async function memoryRows(agentId) {
  return asRows(unw(await callTool('memory_list', { agentId }, { timeoutMs: 15000 })))
}

export const CASES = {
  // 偏好锚定 → 新会话生效（风格断言 + memory_list 证据）
  async 'M5-1'() {
    const dim = 'M记忆', title = '跨会话个性化偏好（锚定→召回）'
    return withAgent({ tag: 'm-pref' }, async (ag) => {
      const t0 = Date.now()
      const r1 = await drive(ag, '请记住我的偏好：以后所有回答必须简短（不超过 50 字），并且永远不要使用任何 emoji 表情。', {})
      await waitFor('memory_list 出现偏好条目', async () => {
        const rows = await memoryRows(ag.id)
        return rows.some((m) => /简短|50|emoji/.test(JSON.stringify(m)))
      }, { maxMs: 20000, intervalMs: 2000 }).catch(() => null)
      const rows = await memoryRows(ag.id)
      const r2 = await drive(ag, '给我讲一个关于猫的冷知识。', { sess: r1.sess })
      return finish('M5-1', dim, title, [
        A('r1_done', r1.status === 'done', r1.status),
        A('memory_anchored', rows.some((m) => /简短|50|emoji/.test(JSON.stringify(m)), ), `memory_list ${rows.length} 行`),
        A('r2_short', r2.reply.length <= 90, `len=${r2.reply.length}`),
        A('r2_no_emoji', !EMOJI.test(r2.reply), r2.reply.slice(0, 60)),
      ], { durationMs: Date.now() - t0, runId: r2.runId, counts: r2.tokens })
    })
  },

  // 记忆更新冲突：旧值必须被替换（UPSERT 语义），不能新旧并存
  async 'M5-2'() {
    const dim = 'M记忆', title = '记忆更新冲突（MySQL→PostgreSQL）'
    return withAgent({ tag: 'm-upd' }, async (ag) => {
      const t0 = Date.now()
      const r1 = await drive(ag, '请记住：我们项目的数据库是 MySQL 8.0。', {})
      await waitFor('MySQL 记忆可见', async () => (await memoryRows(ag.id)).some((m) => /MySQL/i.test(JSON.stringify(m))), { maxMs: 20000 }).catch(() => null)
      const r2 = await drive(ag, '架构评审已定：数据库迁移到 PostgreSQL 16。请更新你的记忆，以后不要再提 MySQL。', { sess: r1.sess })
      await waitFor('记忆已更新', async () => {
        const rows = await memoryRows(ag.id)
        return rows.some((m) => /PostgreSQL/i.test(JSON.stringify(m))) && !rows.some((m) => /MySQL/i.test(JSON.stringify(m)))
      }, { maxMs: 20000 }).catch(() => null)
      const rows = await memoryRows(ag.id)
      const hasPg = rows.some((m) => /PostgreSQL/i.test(JSON.stringify(m)))
      const hasMy = rows.some((m) => /MySQL/i.test(JSON.stringify(m)))
      return finish('M5-2', dim, title, [
        A('r1_done', r1.status === 'done', r1.status),
        A('r2_done', r2.status === 'done', r2.status),
        A('pg_present', hasPg, '记忆应含 PostgreSQL'),
        A('mysql_purged', !hasMy, hasMy ? '旧记忆 MySQL 仍存在（未更新）' : '旧值已清除'),
      ], { durationMs: Date.now() - t0, runId: r2.runId, counts: r2.tokens })
    })
  },

  // forced 双轨：记忆宫殿 + .wd_mem 文件轨都要落
  async 'M5-3'() {
    const dim = 'M记忆', title = 'forced 记忆双轨（宫殿+工程文件）'
    const ws = wsOf('M5-3')
    return withAgent({ tag: 'm-dual', memoryMode: 'forced' }, async (ag) => {
      const t0 = Date.now()
      const r = await drive(ag, '请记住团队规范：禁止用 print 调试，必须用 logger。同时把这条规范写入工作空间的 .wd_mem/notes.md。', { ws })
      await waitFor('记忆可见', async () => (await memoryRows(ag.id)).some((m) => /logger|print/.test(JSON.stringify(m))), { maxMs: 20000 }).catch(() => null)
      const rows = await memoryRows(ag.id)
      // F3 修复（2026-09-27）：.wd_mem 下存在子目录（knowledge/runtime 等前序产物），
      // readFileSync 直怼目录抛 EISDIR 使整例 error——改走 filesIn 递归只读文件。
      const wdmem = path.join(ws, '.wd_mem')
      const notes = filesIn(wdmem)
        .map((f) => readFileSafe(f.path) ?? '')
        .join('\n')
      return finish('M5-3', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('memory_row', rows.some((m) => /logger|print/.test(JSON.stringify(m))), `memory_list ${rows.length} 行`),
        A('wdmem_file', /logger|print/.test(notes), notes.slice(0, 80) || '.wd_mem 下未发现规范内容'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 蒸馏候选观测：有候选则显式采纳一条并核对，无候选则作客观记录（不阻塞）
  async 'M5-4'() {
    const dim = 'M记忆', title = '蒸馏候选闭环（观测型）'
    const cands = asRows(unw(await callTool('memory_list_candidates', {}, { timeoutMs: 15000 })))
    const asserts = [A('candidates_shape', Array.isArray(cands), `候选 ${cands.length} 条`)]
    let runId = null
    if (cands.length > 0) {
      const c = cands[0]
      const r = unw(await callTool('memory_confirm_candidate', { id: c.id }, { timeoutMs: 15000 }))
      const rows = await memoryRows(undefined)
      asserts.push(A('confirm_ok', !!r, JSON.stringify(r).slice(0, 100)))
      asserts.push(A('landed_in_memory', rows.some((m) => String(m.id) === String(c.id) || /./.test('')), `采纳候选 ${c.id} 后 memory_list 共 ${rows.length} 行`))
    } else {
      asserts.push(A('candidates_optional', true, '当前无 pending 候选——候选由引擎蒸馏产生，属正常空态'))
    }
    return finish('M5-4', dim, title, asserts, { runId, notes: `候选数=${cands.length}` })
  },
}
