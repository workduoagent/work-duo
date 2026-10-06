import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * F050 回归：长列表渲染优化（content-visibility）。
 *
 * 背景：长会话（数百轮）此前全量渲染 DOM —— 消息流（MessageList）与协作轮次
 * （squads rounds）都无分页/虚拟化，滚动与输入回显随轮次增长明显变慢。
 *
 * 方案选择：**`content-visibility: auto` 而非虚拟化库**。理由：
 *  1. 消息内容高度不一（且含流式打字机），虚拟化需要测量与动态高度维护，
 *     极易出滚动跳变与「行高突变」问题；
 *  2. 项目未装@tanstack/react-virtual，引入新依赖需用户决策；
 *  3. `content-visibility` 是浏览器原生能力，零依赖、零行为风险
 *     （不影响事件绑定、Ctrl+F、可访问性树）。
 *
 * 关键不变量：**必须配`contain-intrinsic-size` 兜底高度** ——
 * 否则视口外元素按 0 高度计算，滚动条长度随滚动跳变（用户能明显感到抖动）。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CHAT = readFileSync(join(ROOT, 'src', 'pages', 'agent-studio', 'chat.scss'), 'utf8')
const SQUADS = readFileSync(join(ROOT, 'src', 'pages', 'squads-workspace', 'index.scss'), 'utf8')

describe('长列表渲染优化（F050）', () => {
  it('消息流：.agent-chat__msg 启用 content-visibility + 兜底高度', () => {
    // BEM 嵌套写法：&__msg { ... }
    expect(CHAT).toMatch(/&__msg \{[\s\S]*?content-visibility: auto;/)
    expect(CHAT).toMatch(/&__msg \{[\s\S]*?contain-intrinsic-size: auto \d+px;/)
  })

  it('协作轮次：.squad-round 启用 content-visibility + 兜底高度', () => {
    expect(SQUADS).toMatch(/\.squad-round \{[\s\S]*?content-visibility: auto;/)
    expect(SQUADS).toMatch(/\.squad-round \{[\s\S]*?contain-intrinsic-size: auto \d+px;/)
  })

  /**
   * 最终汇总（`--final`）是用户最关心的内容，被跳过会有感知 —— 须显式恢复渲染。
   * 这条容易在后续「统一优化」时被误删。
   */
  it('最终汇总轮次不参与跳过（content-visibility: visible）', () => {
    expect(SQUADS).toMatch(/&--final \{[\s\S]*?content-visibility: visible;/)
  })

  it('两处都用 auto+ 尺寸兜底的成对写法（缺一即失效或抖动）', () => {
    for (const [name, text, sel] of [
      ['chat', CHAT, /&__msg \{/],
      ['squads', SQUADS, /\.squad-round \{/],
    ] as const) {
      const block = text.slice(text.search(sel))
      // 取该选择器后的第一个 } 之前的内容
      const body = block.slice(0, block.indexOf('}') + 1)
      expect(body, `${name} 缺 content-visibility`).toMatch(/content-visibility:/)
      expect(body, `${name} 缺 contain-intrinsic-size 兜底高度`).toMatch(/contain-intrinsic-size:/)
    }
  })
})
