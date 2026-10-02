// S 系列 · 技能编排：技能工作流服从、导出导入闭环、双技能择路。
import {
  A, finish, withAgent, drive, wsOf, callTool, unw, asRows, fileText,
  SKILL_PREFIX, WAIT_MS,
} from '../lib/caplib.mjs'

async function makeSkill(caseId, tag, name, markdown, scripts = []) {
  const identifier = `${SKILL_PREFIX}${tag}-${Date.now().toString(36)}`
  const r = unw(await callTool('skill_upsert', {
    skill: { identifier, name, description: `v2 ${caseId}`, skillMarkdown: markdown },
    scripts,
  }, { timeoutMs: 30000 }))
  return { id: r.id || r.skillId, identifier }
}
async function dropSkill(id) {
  try { await callTool('skill_delete', { id }, { timeoutMs: 20000 }) } catch (e) { console.log('  [warn] skill_delete', e.message.slice(0, 80)) }
}

export const CASES = {
  // 技能模板约束：产物结构必须服从技能规范（且不得把 skill__ 当工具调）
  async 'S8-1'() {
    const dim = 'S技能', title = '技能工作流服从（纪要模板规范）'
    const ws = wsOf('S8-1')
    const sk = await makeSkill('S8-1', 'minutes', 'v2纪要规范', [
      '---',
      'name: v2-minutes-spec',
      'description: 会议纪要统一模板规范',
      '---',
      '',
      '# 会议纪要模板规范',
      '',
      '所有会议纪要产物 meeting.md 必须严格包含以下四个部分，顺序不可变：',
      '1. 一级标题「# 会议纪要」',
      '2. 「## 参会人」小节，列出全部参会人',
      '3. 「## 决议」小节，逐条列决议',
      '4. 「## 行动项」小节，必须用表格（列：事项|负责人|期限）',
    ].join('\n'))
    try {
      return await withAgent({ tag: 's-spec', skillIds: [sk.id] }, async (ag) => {
        const t0 = Date.now()
        const prompt = '请按照 cap2-test-skill 开头的纪要规范技能里定义的模板，把以下内容整理为工作空间的 meeting.md。素材：周五评审会，参会人赵敏、钱进；决议：v2 方案通过；行动项：钱进下二提交详细设计。'
        const r = await drive(ag, prompt, { ws })
        const text = fileText(ws, 'meeting.md') || ''
        const usedSkillTool = /skill__/i.test(r.tools.join(','))
        return finish('S8-1', dim, title, [
          A('status_done', r.status === 'done', r.status),
          A('four_sections_in_order', ['# 会议纪要', '## 参会人', '## 决议', '## 行动项'].map((h) => text.indexOf(h)).every((v, i, arr) => v >= 0 && (i === 0 || v > arr[i - 1])), '四节应存在且按序'),
          A('action_table', /\|.+\|\s*\n?\s*\|[-| :]+\|/.test(text) || /\|事项\|/.test(text) || /事项.*负责人.*期限/.test(text), '行动项应为表格'),
          A('no_skill_tool_antipattern', !usedSkillTool, '技能是指引注入，不应出现 skill__ 工具调用'),
        ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
      })
    } finally { await dropSkill(sk.id) }
  },

  // 导出→导入→一致性（无 LLM，秒级）
  async 'S8-2'() {
    const dim = 'S技能', title = '技能导出→导入→一致性闭环'
    const sk = await makeSkill('S8-2', 'export', 'v2导出源', [
      '---', 'name: v2-export-source', 'description: 导出导入闭环测试', '---', '', '# 源技能', '正文内容保持一致性校验用。ABC123。',
    ].join('\n'), [{ name: 'helper.py', language: 'python', content: 'def run(params):\n    return {"ok": True}\n' }])
    let importedId = null
    try {
      const t0 = Date.now()
      const exp = unw(await callTool('skill_export', { identifier: sk.identifier }, { timeoutMs: 30000 }))
      const zip = exp?.zipBase64 || exp?.base64 || (typeof exp === 'string' ? exp : null)
      const impIdentifier = `${SKILL_PREFIX}imp-${Date.now().toString(36)}`
      const imp = unw(await callTool('skill_import', {
        identifier: impIdentifier, name: 'v2导入件', zipBase64: zip,
      }, { timeoutMs: 30000 }))
      importedId = imp?.id
      // 真实契约（2026-09-27 实测）：skill_import 后 skill_get 不回 skillMarkdown 字段（疑似缺陷，
      // 磁盘 SKILL.md 完好）——因此磁盘真相走 skill_read_file 解 base64 校验。
      const got = unw(await callTool('skill_get', { id: importedId }, { timeoutMs: 15000 }))
      const rd = unw(await callTool('skill_read_file', { identifier: impIdentifier, relPath: 'SKILL.md' }, { timeoutMs: 15000 }))
      const mdOnDisk = Buffer.from(rd?.base64 || '', 'base64').toString('utf8')
      const files = unw(await callTool('skill_list_files', { identifier: impIdentifier }, { timeoutMs: 15000 })) // {identifier, tree} 形状，非行集合
      const mdSame = mdOnDisk.includes('ABC123')
      const hasScripts = JSON.stringify(files).includes('helper.py')
      const mdFieldMissing = !('skillMarkdown' in (got || {}))
      return finish('S8-2', dim, title, [
        A('export_zip', !!zip, `base64 ${zip ? zip.length : 0} chars`),
        A('import_ok', !!importedId, ''),
        A('markdown_on_disk', mdSame, '导入件磁盘 SKILL.md 应与源一致'),
        A('files_structure', hasScripts, '导入件应含 scripts/helper.py'),
        A('skill_get_md_field_absent', mdFieldMissing, mdFieldMissing
          ? '记录：skill_get 不回 skillMarkdown（已回流为缺陷发现 #F1）'
          : 'skill_get 回了 skillMarkdown——文档与实现一致，#F1 已修复'),
        A('fast_no_llm', Date.now() - t0 < 60000, `${Math.round((Date.now() - t0) / 1000)}s`),
      ])
    } finally { await dropSkill(sk.id); if (importedId) await dropSkill(importedId) }
  },

  // 双技能择路：同 agent 绑两个模板技能，两类任务必须各取所需
  async 'S8-3'() {
    const dim = 'S技能', title = '双技能择路（周报 vs 纪要）'
    const ws = wsOf('S8-3')
    const weekly = await makeSkill('S8-3', 'weekly', 'v2周报模板', [
      '---', 'name: v2-weekly-tpl', 'description: 周报模板', '---', '',
      '# 周报模板规范', '周报.md 必须包含小节「## 数据看板」（仅周报有）、「## 本周成果」、「## 下周计划」。',
    ].join('\n'))
    const minutes = await makeSkill('S8-3', 'minutes2', 'v2纪要模板', [
      '---', 'name: v2-minutes-tpl', 'description: 纪要模板', '---', '',
      '# 纪要模板规范', 'meeting.md 必须包含小节「## 参会人」（仅纪要有）、「## 决议」。',
    ].join('\n'))
    try {
      return await withAgent({ tag: 's-pick', skillIds: [weekly.id, minutes.id] }, async (ag) => {
        const t0 = Date.now()
        const r1 = await drive(ag, '请按可用的周报模板技能，生成工作空间的 周报.md：本周完成登录改版，下周做压测，数据看板放 DAU 1.2 万。', { ws })
        const r2 = await drive(ag, '请按可用的纪要模板技能，生成工作空间的 meeting.md：参会人孙俪、周柯；决议：压测方案通过。', { ws, sess: r1.sess })
        const w = fileText(ws, '周报.md') || ''
        const m = fileText(ws, 'meeting.md') || ''
        return finish('S8-3', dim, title, [
          A('r1_done', r1.status === 'done', r1.status),
          A('r2_done', r2.status === 'done', r2.status),
          A('weekly_uses_weekly_tpl', /数据看板/.test(w) && !/参会人/.test(w), '周报应含「数据看板」且不含「参会人」'),
          A('minutes_uses_minutes_tpl', /参会人/.test(m) && !/数据看板/.test(m), '纪要应含「参会人」且不含「数据看板」'),
        ], { durationMs: Date.now() - t0, runId: r2.runId, counts: r2.tokens })
      })
    } finally { await dropSkill(weekly.id); await dropSkill(minutes.id) }
  },
}
