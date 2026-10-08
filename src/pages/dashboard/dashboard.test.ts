import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * F042 / F047 回归：首页概览与顶栏高亮映射。
 *
 * 背景：
 *  - F042：dashboard 曾是 45 行脚手架占位页——4 个统计硬编码 '0'、「查看文档」
 *    按钮无onClick、且未进顶栏 MENUS（首页虽已注册 index route，用户只能手输
 *    hash 进入）。
 *  - F047：`routeToTopKey` 是逐条 if 且只覆盖 4 条路由，导致 8 条已注册路由
 *    进页面后**选中胶囊消失**，用户看不出自己在哪。
 *
 * 🔴 2026-10-08 变更：首页菜单项已移除（用户：首页内容尚未设计好，不想在正式菜单
 * 暴露半成品入口）。首页仍是**默认落地页**（hash 为空即渲染 index route）。
 * 「菜单含首页」一条断言随之反转为「菜单不含首页」，见下方describe。
 *
 * 本测试锁住：首页有真实数据源与入口、顶栏菜单不含首页、高亮映射数据驱动
 * 且覆盖全部已注册路由。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, 'index.tsx'), 'utf8')
const TOPBAR = readFileSync(join(HERE, '..', '..', 'components', 'layout', 'TopBar.tsx'), 'utf8')

describe('首页概览（F042）', () => {
  it('四个统计接真实数据源（非硬编码 0）', () => {
    for (const fn of ['listKnowledgeBases', 'listAgents', 'listSquads', 'listModels']) {
      expect(PAGE, `缺少真实数据源 ${fn}`).toContain(fn)
    }
    // 旧实现的硬编码 '0'
    expect(PAGE).not.toMatch(/value:\s*'0'/)
  })

  it('四路并行加载且各自成败独立（allSettled 而非 all）', () => {
    expect(PAGE).toMatch(/Promise\.allSettled/)
    //串行会把首屏耗时累加；用 all 会让单点失败整块报错
    expect(PAGE).not.toMatch(/Promise\.all\(/)
  })

  it('三态齐备：loading /失败 / 空态', () => {
    expect(PAGE).toMatch(/spinning=\{loading\}/)
    expect(PAGE).toMatch(/allFailed/)
    expect(PAGE).toMatch(/allEmpty/)
    expect(PAGE).toMatch(/<Empty/)
  })

  it('统计卡与入口均可点击跳转（首页是导航入口而非数字墙）', () => {
    expect(PAGE).toMatch(/onClick=\{\(\) => nav\(s\.path\)\}/)
    expect(PAGE).toMatch(/onClick=\{\(\) => nav\(e\.path\)\}/)
    // 旧的「查看文档」按钮无 onClick，已替换为真实入口网格。
    // 只查 JSX 文本（本文件注释里也会提到这四个字，故排除注释行）。
    const jsxOnly = PAGE.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
    expect(jsxOnly).not.toMatch(/查看文档/)
  })
})

describe('顶栏菜单与高亮映射（F042 / F047）', () => {
  // 🔴 2026-10-08：首页菜单项已移除（首页内容尚未设计完成，用户决定不在正式
  // 菜单暴露半成品入口）。原先锁的是「菜单含首页」，现改为锁「菜单不含首页」。
  // 首页仍是默认落地页（hash 为空 → index route → dashboard），只是没有菜单入口。

  it('菜单不含「首页」项（2026-10-08 移除）', () => {
    // 剔除注释行后再断言——MENUS 上方注释里保留了「待定稿后加回」的示例写法
    const codeOnly = TOPBAR.split('\n')
      .filter((l) => {
        const t = l.trim()
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
      })
      .join('\n')
    expect(codeOnly, '首页菜单项应已移除').not.toMatch(/key:\s*'home'/)
    // lucide 的 Home 图标也一并移除，避免未使用 import 触发 tsc/ts(6133)
    expect(codeOnly).not.toMatch(/^\s*Home,\s*$/m)
  })

  it('移除后其余菜单项完整保留', () => {
    for (const label of ['百宝箱', '知识库', '智能体', '小分队', '设置']) {
      expect(TOPBAR, `菜单项 ${label} 不应被误删`).toContain(`label: '${label}'`)
    }
    // 百宝箱 5 个子项
    for (const r of ['modelSettings', 'mcpHub', 'skillHub', 'pluginHub', 'serverHub']) {
      expect(TOPBAR).toContain(`ROUTES.${r}`)
    }
  })

  it('首页无菜单项 ⇒ routeToTopKey 对 `/` 返回 null（不得返回悬空 key）', () => {
    const body = TOPBAR.slice(TOPBAR.indexOf('function routeToTopKey'))
    // 关键：不能return 'home'——MENUS 里已无该项，
    // selected 指向不存在的 key 会让 measure() 找不到元素、滑块静默不定位。
    expect(body).not.toMatch(/return\s*'home'/)
    expect(body).toMatch(/return null/)
  })

  it('高亮映射数据驱动（从 MENUS 反查，不再逐条 if 硬编码）', () => {
    const body = TOPBAR.slice(TOPBAR.indexOf('function routeToTopKey'))
    expect(body).toMatch(/for \(const m of MENUS\)/)
    expect(body).toMatch(/m\.children/)
    // 仅允许沙箱的显式兜底一条
    const startsIfCount = (body.match(/if \(pathname\.startsWith\(ROUTES\./g) || []).length
    expect(startsIfCount, '不应再有逐条硬编码的 startsWith 判断').toBeLessThanOrEqual(1)
  })

  it('已注册的主要路由都能命中高亮（F047 的核心断言）', () => {
    const body = TOPBAR.slice(TOPBAR.indexOf('function routeToTopKey'))
    const hasLeafLoop = /!m\.children && m\.path && pathname\.startsWith\(m\.path\)/.test(body)
    const hasChildLoop = /c\.path && pathname\.startsWith\(c\.path\)/.test(body)
    expect(hasLeafLoop, '叶子菜单需按path 前缀匹配').toBe(true)
    expect(hasChildLoop, '分组子项需回退到父容器').toBe(true)
    // 沙箱页归属「设置」
    expect(TOPBAR).toMatch(/ROUTES\.sandbox/)
    expect(TOPBAR).toMatch(/return 'settings'/)
  })
})
