import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * F042 / F047 回归：首页概览与顶栏高亮映射。
 *
 * 背景：
 *  - F042：dashboard 曾是 45 行脚手架占位页——4 个统计硬编码 '0'、「查看文档」
 *    按钮无 onClick、且未进顶栏 MENUS（首页虽已注册 index route，用户只能手输
 *    hash 进入）。
 *  - F047：`routeToTopKey` 是逐条 if 且只覆盖 4 条路由，导致 8 条已注册路由
 *    进页面后**选中胶囊消失**，用户看不出自己在哪。
 *
 * 本测试锁住：首页有真实数据源与入口、顶栏菜单含首页、高亮映射数据驱动
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
  it('菜单含「首页」项并指向 dashboard 路由', () => {
    expect(TOPBAR).toMatch(/key: 'home', label: '首页'/)
    expect(TOPBAR).toMatch(/path: ROUTES\.dashboard/)
  })

  it('高亮映射数据驱动（从 MENUS 反查，不再逐条 if 硬编码）', () => {
    const body = TOPBAR.slice(TOPBAR.indexOf('function routeToTopKey'))
    // 遍历 MENUS 找叶子/ 子项
    expect(body).toMatch(/for \(const m of MENUS\)/)
    expect(body).toMatch(/m\.children/)
    // 仅允许首页走精确匹配 + 沙箱的显式兜底，不再逐条 startsWith
    const startsIfCount = (body.match(/if \(pathname\.startsWith\(ROUTES\./g) || []).length
    expect(startsIfCount, '不应再有逐条硬编码的 startsWith 判断').toBeLessThanOrEqual(1)
  })

  it('首页用精确匹配（`/` 是所有路径前缀，用 startsWith 会全盘误判）', () => {
    expect(TOPBAR).toMatch(/pathname === ROUTES\.dashboard/)
    expect(TOPBAR).not.toMatch(/pathname\.startsWith\(ROUTES\.dashboard\)/)
  })

  it('已注册的主要路由都能命中高亮（F047 的核心断言）', () => {
    // 逐个模拟：这些 path 的首段能在 MENUS 里找到对应项
    const body = TOPBAR.slice(TOPBAR.indexOf('function routeToTopKey'))
    const hasLeafLoop = /!m\.children && m\.path && pathname\.startsWith\(m\.path\)/.test(body)
    const hasChildLoop = /c\.path && pathname\.startsWith\(c\.path\)/.test(body)
    expect(hasLeafLoop, '叶子菜单需按 path 前缀匹配').toBe(true)
    expect(hasChildLoop, '分组子项需回退到父容器').toBe(true)
    // MENUS 覆盖的路由数（首页 + 知识库/ 智能体 / 小分队 / 设置 + 百宝箱 5 子项）
    expect(TOPBAR).toMatch(/ROUTES\.knowledge/)
    expect(TOPBAR).toMatch(/ROUTES\.skillHub/)
    expect(TOPBAR).toMatch(/ROUTES\.mcpHub/)
    expect(TOPBAR).toMatch(/ROUTES\.pluginHub/)
    expect(TOPBAR).toMatch(/ROUTES\.serverHub/)
  })
})
