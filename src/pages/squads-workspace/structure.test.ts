import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * F038 回归：squads-workspace 的拆分结构与依赖方向。
 *
 * 背景：原`index.tsx` 2670 行里挤了 8 个组件，其中 `SquadRunConsole`（运行控制台，
 * 305 行）被内嵌在 `SquadEditorModal` 内部，但它与编辑器**完全无关**——自己持有
 * 13 个 state、自己注册事件订阅、独立成面板/Modal。混在一起使编辑器膨胀到
 * 1400+ 行，也让两者状态归属边界模糊。
 *
 * 本测试锁住三条不变量：
 *  1. 拆分出的模块存在且各司其职；
 *  2. **依赖方向单向**——子组件不得 import `./index`（否则 index → 子组件 → index
 *     循环依赖，这是拆分时最容易踩的坑）；
 *  3. `index.tsx` 仍 re-export 原有对外 API（`SquadDetailPage` 等从中取用）。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, 'index.tsx'), 'utf8')

/** 拆分出的模块清单：文件名 → 职责说明（用于报告与人工核对） */
const EXTRACTED = {
  'SquadCard.tsx': '列表卡片（F045，React.memo）',
  'SquadRunConsole.tsx': '运行控制台（F038，本轮抽出）',
  'MetricsRoundView.tsx': '花费账目渲染（F038，本轮抽出）',
  'roundTags.ts': '轮次类型 → 标签映射（F038，本轮抽出）',
  'squad-shared.ts': 'agentAppearanceOf / memberLabel / MODE_OPTIONS（F038，本轮抽出）',
  'useSquadRunEvents.ts': '运行事件订阅共用层（F039）',
  'useSquadRunEvents.test.ts': 'F039 回归',
  'SquadCard.test.ts': 'F045 回归',
}

describe('squads-workspace 拆分结构（F038）', () => {
  it('拆分出的模块均存在', () => {
    for (const f of Object.keys(EXTRACTED)) {
      expect(readdirSync(HERE).includes(f), `缺少模块 ${f}`).toBe(true)
    }
  })

  it('index.tsx 不再包含运行控制台与花费账目的实现（已抽离）', () => {
    expect(PAGE, 'SquadRunConsole 应已抽离').not.toMatch(/export function SquadRunConsole\(/)
    expect(PAGE, 'MetricsRoundView 应已抽离').not.toMatch(/function MetricsRoundView\(/)
    expect(PAGE, 'roundTagMeta 应已抽离').not.toMatch(/function roundTagMeta\(/)
    expect(PAGE, 'agentAppearanceOf 应已抽离').not.toMatch(/function agentAppearanceOf\(/)
  })

  /**
   * 关键不变量：依赖方向必须单向。
   * 拆分时子组件若从 `./index` 取共享函数，会形成 index → 子 → index 循环依赖。
   */
  it('子组件不从 ./index 取共享工具（避免循环依赖）', () => {
    const children = ['SquadCard.tsx', 'SquadRunConsole.tsx', 'MetricsRoundView.tsx']
    for (const f of children) {
      const text = readFileSync(join(HERE, f), 'utf8')
      const fromIndex = text.match(/^import .*from '\.\/index'/m)
      expect(fromIndex, `${f} 不应从 './index' 导入（会成循环依赖）：${fromIndex?.[0] ?? ''}`).toBeNull()
    }
  })

  it('共享工具走 squad-shared（agentAppearanceOf / memberLabel / MODE_OPTIONS）', () => {
    const shared = readFileSync(join(HERE, 'squad-shared.ts'), 'utf8')
    expect(shared).toMatch(/export function agentAppearanceOf/)
    expect(shared).toMatch(/export function memberLabel/)
    expect(shared).toMatch(/export const MODE_OPTIONS/)
  })

  it('index.tsx 仍 re-export 原有对外 API（DetailPage 等从中取用）', () => {
    for (const name of [
      'SquadRunConsole',
      'MetricsRoundView',
      'roundTagMeta',
      'agentAppearanceOf',
      'memberLabel',
      'MODE_OPTIONS',
    ]) {
      expect(PAGE, `index.tsx 应 re-export ${name}`).toMatch(new RegExp(`export \\{[^}]*${name}`))
    }
  })

  it('运行控制台的 state 归属已随组件迁移（不在 index 内）', () => {
    // 这些 state 是运行控制台的核心，迁走即说明组件主体已抽走。
    // 注意：setRounds 在 index 里仍有一处同名 state，属SquadHistoryPanel（历史
    // 面板，与运行控制台无关），故只断言其余四个。
    for (const st of ['setPrompt', 'setRunning', 'setMemberMotion', 'setInjectText']) {
      expect(PAGE, `${st} 应随 SquadRunConsole 迁走`).not.toMatch(new RegExp(`const \\[.*${st}`))
    }
  })

  it('index.tsx 体量已明显下降（拆分生效）', () => {
    const lines = PAGE.split(/\r?\n/).length
    expect(lines, 'index.tsx 应显著缩短（基线 2670 行）').toBeLessThan(2400)
  })
})
