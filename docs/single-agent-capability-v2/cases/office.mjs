// O 系列 · 办公任务：Excel/图表产物契约、纪要转待办、周报格式化、商务文案。
// 产物契约（与 workduo-mcp skill 流程 2.1 同步）：二进制禁手写——用官方模板插件；文件名逐字一致。
import fs from 'node:fs'
import path from 'node:path'
import {
  A, finish, withAgent, drive, wsOf, readSkillScript, asRows, unw, callTool,
  fileHas, findFile, fileText, magicOk, numPresent, toolNames, WAIT_MS,
} from '../lib/caplib.mjs'

const XLSX_TEMPLATE = 'plugin.xlsx_writer.template.py'
const CHART_TEMPLATE = 'plugin.chart_png.template.py'

/** runner 侧装配官方模板插件并返回插件 id（与前端「百宝箱→插件」同链路）。 */
export async function ensureTemplatePlugin(runtime, scriptName, identifier, description) {
  const list = asRows(unw(await callTool('plugin_list', {})))
  const exist = list.find((p) => p.identifier === identifier)
  const script = readSkillScript(scriptName)
  if (!script) throw new Error(`官方模板缺失: ${scriptName}`)
  if (exist) return exist.id
  const r = unw(await callTool('plugin_upsert', {
    name: identifier.replace(/^cap2-test-pl-/, 'v2-'),
    identifier, description,
    runtime, scriptContent: script,
    parametersSchema: runtime === 'python'
      ? (scriptName === XLSX_TEMPLATE
        ? { type: 'object', properties: { outPath: { type: 'string' }, sheets: { type: 'object' } }, required: ['outPath', 'sheets'] }
        : { type: 'object', properties: { outPath: { type: 'string' }, kind: { type: 'string' }, ys: { type: 'array' }, xs: { type: 'array' }, title: { type: 'string' } }, required: ['outPath', 'kind', 'ys'] })
      : { type: 'object' },
  }, { timeoutMs: 20000 }))
  return r.id || r.pluginId || r.data?.id
}

export const CASES = {
  // Excel 产物契约：绑定官方 xlsx 模板插件 → agent 产出 周报.xlsx（PK 魔数 + 汇总数字正确）
  async 'O3-1'() {
    const dim = 'O办公', title = 'Excel 周报产物（xlsx 模板插件链路）'
    const ws = wsOf('O3-1')
    const pluginId = await ensureTemplatePlugin('python', XLSX_TEMPLATE, 'cap2-test-pl-xlsx', 'v2 多 sheet Excel 写出器（官方模板）')
    return withAgent({ tag: 'o-xlsx', pluginIds: [pluginId] }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        '请在工作空间生成《周报.xlsx》（文件名必须逐字一致）：',
        'Sheet「销售明细」放三个部门 7-9 月销售额（万元）：研发部 120/135/150，市场部 90/95/110，销售部 200/180/220（表头：部门,七月,八月,九月）；',
        'Sheet「汇总」放各部门合计与总合计（研发部 405、市场部 295、销售部 600、总计 1300）；',
        '完成后读回确认两个 Sheet 都在。',
      ].join('\n')
      const r = await drive(ag, prompt, { ws })
      const xlsx = findFile(ws, '周报.xlsx')
      return finish('O3-1', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('xlsx_exists', !!xlsx, xlsx ? `${xlsx.path} (${xlsx.size}B)` : '周报.xlsx 缺失'),
        A('xlsx_magic_pk', xlsx ? magicOk(xlsx.path, 'xlsx') : false, '文件头应为 zip(PK)——手写二进制会假成功'),
        A('total_1300', numPresent(r.reply, 1300).ok, numPresent(r.reply, 1300).detail),
        A('used_plugin_or_sandbox', toolNames(r.trace).some((n) => /custom__|plugin/i.test(n)) || /插件/.test(r.reply), toolNames(r.trace).slice(0, 8).join(',')),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 图表产物契约：官方 chart 模板 → 走势图.png（PNG 魔数）
  async 'O3-2'() {
    const dim = 'O办公', title = '营收走势图（PNG 模板插件链路）'
    const ws = wsOf('O3-2')
    const pluginId = await ensureTemplatePlugin('python', CHART_TEMPLATE, 'cap2-test-pl-chart', 'v2 图表 PNG 写出器（官方模板，Agg 后端）')
    return withAgent({ tag: 'o-chart', pluginIds: [pluginId] }, async (ag) => {
      const t0 = Date.now()
      const prompt = '请根据 4-9 月营收（万元）4 月 82、5 月 91、6 月 87、7 月 105、8 月 118、9 月 126，在工作空间生成《营收走势图.png》（文件名逐字一致，折线图，标题「2026 年 4-9 月营收」）。'
      const r = await drive(ag, prompt, { ws })
      const png = findFile(ws, '营收走势图.png')
      return finish('O3-2', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('png_exists', !!png, png ? `${png.path} (${png.size}B)` : '营收走势图.png 缺失'),
        A('png_magic', png ? magicOk(png.path, 'png') : false, '文件头应为 PNG 魔数'),
        A('size_reasonable', png ? png.size > 2000 : false, png ? `${png.size}B` : '无文件'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 会议纪要 → 待办清单：信息抽取 + 表格结构
  async 'O3-3'() {
    const dim = 'O办公', title = '会议纪要转待办清单'
    const ws = wsOf('O3-3')
    return withAgent({ tag: 'o-minutes' }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        '以下是项目周会纪要，请整理为工作空间的 action-items.md：',
        '内容要求：①「待办事项」表格，列：事项/负责人/期限，一条不能漏；②「决议」小节；③「风险」小节。',
        '纪要正文：',
        '本周三例会，张三主持。决议：新版登录页采用手机号+验证码方案。李四下周五前完成验证码服务联调；王五下周一前给出 UI 走查报告；',
        '张三负责在月底前把灰度方案提交风控评审。风险：短信通道供应商报价未定，可能影响联调进度；老版本 App 还有 3% 用户未升级。',
      ].join('\n')
      const r = await drive(ag, prompt, { ws })
      const text = fileText(ws, 'action-items.md') || ''
      return finish('O3-3', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('action_md_exists', text.length > 0, 'action-items.md 缺失' ),
        A('all_owners_covered', ['李四', '王五', '张三'].every((n) => text.includes(n)), `负责人命中：${['李四', '王五', '张三'].filter((n) => text.includes(n)).join(',')}`),
        A('has_deadline', /周一|周五|月底|下周/.test(text), '应含期限信息'),
        A('has_structure', /决议/.test(text), '应含决议小节'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 周报格式化：流水账 → 三节结构
  async 'O3-4'() {
    const dim = 'O办公', title = '流水账周报结构化（三节格式）'
    const ws = wsOf('O3-4')
    return withAgent({ tag: 'o-weekly' }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        '把以下流水账整理成工作空间的 周报.md，必须分三节（用二级标题）：「本周成果」「风险与阻塞」「下周计划」，',
        '每节 2-3 条，量化数字必须保留。流水账：修了登录页 3 个 bug；新人培训讲了 2 场；接口平均响应从 480ms 降到 210ms；',
        '测试环境本周宕机 2 次待排查；下周要做压测和发版评审。',
      ].join('\n')
      const r = await drive(ag, prompt, { ws })
      const text = fileText(ws, '周报.md') || ''
      return finish('O3-4', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('weekly_md_exists', text.length > 0, '周报.md 缺失'),
        A('three_sections', /本周成果/.test(text) && /风险/.test(text) && /下周计划/.test(text), '三节标题都应在'),
        A('numbers_kept', /210|480/.test(text), '量化数字应保留'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 商务文案：要素齐全 + 长度得体
  async 'O3-5'() {
    const dim = 'O办公', title = '商务邮件草稿（要素齐全）'
    const ws = wsOf('O3-5')
    return withAgent({ tag: 'o-mail' }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        '给客户写一封道歉邮件，落盘为工作空间的 email.md。背景：我方交付延期一周。',
        '必须包含：①诚肯致歉；②新的交付日期 10 月 9 日；③补偿方案（赠送 6 个月延保）；④语气专业、不超过 400 字。',
      ].join('\n')
      const r = await drive(ag, prompt, { ws })
      const text = fileText(ws, 'email.md') || ''
      return finish('O3-5', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('email_md_exists', text.length > 0, 'email.md 缺失'),
        A('apology', /抱歉|致歉|歉意/.test(text), '应含致歉表述'),
        A('new_date', /10\s*月\s*9|10\.9|10月9日/.test(text), '应含新交付日期'),
        A('compensation', /延保/.test(text), '应含补偿方案'),
        A('length_ok', text.length >= 80 && text.length <= 500, `len=${text.length}`),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },
}
