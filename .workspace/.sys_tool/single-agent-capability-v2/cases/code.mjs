// K 系列 · 编码任务：复用 workduo-mcp L2 seeds 的真实缺陷项目（runner 端有独立 ground-truth）。
import fs from 'node:fs'
import path from 'node:path'
import {
  A, finish, withAgent, drive, wsOf, stageSeed, seedChanged, fileHas, findFile, readFileSafe,
  toolNames, hasWrite, WAIT_MS,
} from '../lib/caplib.mjs'

// 通用：把 seed 自带题目原样发给 agent，断言产物 + 指定源码改动 + 测试通过证据
function seedCase(caseId, dim, title, seedId, { changedFile } = {}) {
  return async () => {
    const staged = stageSeed(caseId, seedId)
    return withAgent({ tag: `k-${seedId}` }, async (ag) => {
      const t0 = Date.now()
      const r = await drive(ag, staged.seed.prompt, { ws: staged.ws })
      const asserts = [
        A('status_done', r.status === 'done', r.status),
        A('reply_nonempty', r.reply.trim().length > 0, r.reply.slice(0, 80)),
      ]
      for (const art of staged.seed.artifacts || []) {
        const name = art.split('/').pop()
        asserts.push(A(`artifact:${name}`, !!findFile(staged.ws, name), `工作空间应存在 ${art}`))
      }
      if (changedFile) asserts.push(A(`changed:${changedFile}`, seedChanged(staged, changedFile), `${changedFile} 内容应相对 seed 发生修改`))
      asserts.push(A('test_cmd_evidence', /command_succeeded|tests_passed/.test(JSON.stringify(r.trace?.events || [])) || /通过|passed|全绿|all green/i.test(r.reply), '轨迹或回复应有测试通过证据'))
      return finish(caseId, dim, title, asserts, { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  }
}

export const CASES = {
  // 真实缺陷：ECMA-262 Date 月份 0 基偏移（JS 语义题）；额外断言修复语义
  'K2-1': seedCase('K2-1', 'K编码', '真实缺陷修复：Date 月份 0 基（js-logic-date-month0）', 'js-logic-date-month0', {
    changedFile: 'datefmt.js',
  }),

  // 真实缺陷：ReDoS 灾难性回溯正则
  'K2-2': seedCase('K2-2', 'K编码', '真实缺陷修复：正则 ReDoS（py-security-auth-regex-redos）', 'py-security-auth-regex-redos'),

  // 真实缺陷：跨文件小功能（stock + report 双文件协作）
  'K2-3': seedCase('K2-3', 'K编码', '跨文件功能：库存对账报告（py-cross-file-inventory）', 'py-cross-file-inventory'),

  // TDD 新功能：先测试后实现，顺序与证据都要有
  async 'K2-4'() {
    const dim = 'K编码', title = 'TDD 新功能：先测试后实现'
    const ws = wsOf('K2-4')
    return withAgent({ tag: 'k-tdd' }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        '在工作空间完成一个 TDD 小任务，严格按顺序：',
        "1) 先创建 test_palindrome.py，用 pytest 写三个用例：is_palindrome('') 为 True、is_palindrome('Aba') 为 True（忽略大小写）、is_palindrome('abc') 为 False；",
        '2) 再创建 palindrome.py 实现 is_palindrome(s)；',
        '3) 运行 pytest 确认全部通过。',
      ].join('\n')
      const r = await drive(ag, prompt, { ws })
      const t = fileHas(ws, 'test_palindrome.py', 'is_palindrome')
      const implPath = findFile(ws, 'palindrome.py')
      const implText = implPath ? readFileSafe(implPath.path) || '' : ''
      return finish('K2-4', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('test_file', t.ok, t.detail),
        A('impl_file', !!implPath && /def\s+is_palindrome/.test(implText), implText.slice(0, 80)),
        A('impl_logic', /lower|upper|reversed|\[::-1\]/i.test(implText), '实现应含大小写归一或反转逻辑'),
        A('tests_passed_evidence', /command_succeeded|tests_passed/.test(JSON.stringify(r.trace?.events || [])) || /通过|passed|全绿/i.test(r.reply), '轨迹或回复应有 pytest 通过证据'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 回归保持绿：既有全绿项目加功能，旧测试不得变红（seed：py-logic-cart）
  async 'K2-5'() {
    const dim = 'K编码', title = '回归保持绿：购物车加折扣（py-logic-cart）'
    const staged = stageSeed('K2-5', 'py-logic-cart')
    return withAgent({ tag: 'k-cart' }, async (ag) => {
      const t0 = Date.now()
      const prompt = [
        `项目在 ${staged.target.replace(/\\/g, '/')} 子目录，现有测试全绿。`,
        '请新增「满 200 减 30」折扣逻辑（风格与现有函数一致），并在 test_cart.py 补 2 个边界用例（恰满 200 / 199 不满），',
        '运行全部测试确认旧用例依旧全绿、新用例通过。',
      ].join(' ')
      const r = await drive(ag, prompt, { ws: staged.ws })
      return finish('K2-5', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('impl_changed', seedChanged(staged, 'cart.py'), 'cart.py 应有修改'),
        A('tests_added', seedChanged(staged, 'test_cart.py'), 'test_cart.py 应新增用例'),
        A('old_still_green', /command_succeeded|tests_passed/.test(JSON.stringify(r.trace?.events || [])) || /全绿|通过|passed/i.test(r.reply), '旧用例保持通过的证据'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },

  // 代码评审不改码：报告覆盖三类问题，源文件逐字节原样
  async 'K2-6'() {
    const dim = 'K编码', title = '代码评审：只出报告不改码'
    const ws = wsOf('K2-6')
    const src = [
      'import os',
      'def load(path):',
      '    f = open(path)',
      '    data = f.read()',
      '    return json.loads(data)',
      'def save(path, obj):',
      '    f = open(path, "w")',
      '    f.write(str(obj))',
      '    f.close()',
    ].join('\n')
    fs.writeFileSync(path.join(ws, 'legacy.py'), src, 'utf8')
    return withAgent({ tag: 'k-review' }, async (ag) => {
      const t0 = Date.now()
      const prompt = '工作空间有 legacy.py。请做代码评审但【禁止修改任何源文件】：产出 review.md，逐条列出问题（至少覆盖三点：文件句柄未关闭、json 模块未导入、str(obj) 不是 JSON 序列化），每条给「问题/后果/修复建议」，最后一节给整体结论。'
      const r = await drive(ag, prompt, { ws })
      const review = fileHas(ws, 'review.md', 'json')
      const untouched = fs.readFileSync(path.join(ws, 'legacy.py'), 'utf8') === src
      return finish('K2-6', dim, title, [
        A('status_done', r.status === 'done', r.status),
        A('review_md', review.ok, review.detail),
        A('covers_handle_or_import', /close|句柄|import/.test(review.detail || ''), '报告应覆盖句柄/导入类问题'),
        A('source_untouched', untouched, 'legacy.py 必须逐字节原样（禁改码）'),
      ], { durationMs: Date.now() - t0, runId: r.runId, counts: r.tokens })
    })
  },
}
