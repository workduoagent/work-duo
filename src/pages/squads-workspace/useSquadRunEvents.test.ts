import { describe, expect, it } from 'vitest'
import { defaultMemberMotion } from './useSquadRunEvents'

/**
 * F039 回归：小分队运行事件共用层的映射语义。
 *
 * 背景：`squads-workspace/index.tsx`（列表页内嵌控制台）与 `SquadDetailPage.tsx`
 * （独立详情页）原先各写一套 `listen`，改一处漏一处。本测试锁住收敛后最关键的一环：
 * **成员动作态必须映射到 `AgentMotionState` 枚举**。
 *
 * 真实缺陷背景：详情页原先产出 `` `${phase}-${ok?'ok':'err'}` `` 形态（如
 * `started-ok`），而消费方（`memberState` / `isBusyPose` / `PixelAgent`）只识别
 * 枚举值 —— 格式不匹配导致详情页小人动画对成员事件**完全无响应**。
 */

describe('小分队成员动作态映射（F039）', () => {
  it('started → working', () => {
    expect(defaultMemberMotion({ squadId: 'sq', memberRole: 'r', phase: 'started', ok: true })).toBe('working')
  })

  it('完成且成功 → cheer', () => {
    expect(defaultMemberMotion({ squadId: 'sq', memberRole: 'r', phase: 'completed', ok: true })).toBe('cheer')
  })

  it('失败（ok=false）→ error（优先级高于 phase）', () => {
    expect(defaultMemberMotion({ squadId: 'sq', memberRole: 'r', phase: 'completed', ok: false })).toBe('error')
    expect(defaultMemberMotion({ squadId: 'sq', memberRole: 'r', phase: 'started', ok: false })).toBe('working')
  })

  it('中间态（交接/门禁）→ handoff', () => {
    expect(defaultMemberMotion({ squadId: 'sq', memberRole: 'r', phase: 'handoff', ok: true })).toBe('handoff')
    expect(defaultMemberMotion({ squadId: 'sq', memberRole: 'r', phase: 'checkpoint', ok: true })).toBe('handoff')
  })

  /**
   * 关键回归：返回值必须落在 `AgentMotionState` 枚举内。
   * 若再出现 `started-ok` 这类拼接形态，此断言会失败——而那正是详情页动画失效的根因。
   */
  it('所有取值都落在 AgentMotionState 枚举内（消费方只认枚举）', () => {
    const VALID = new Set([
      'idle',
      'working',
      'thinking',
      'error',
      'waiting',
      'speaking',
      'handoff',
      'cheer',
    ])
    const phases = ['started', 'completed', 'failed', 'handoff', 'checkpoint', 'delivery', '']
    for (const phase of phases) {
      for (const ok of [true, false]) {
        const out = defaultMemberMotion({ squadId: 'sq', memberRole: 'r', phase, ok })
        expect(VALID.has(out), `phase="${phase}" ok=${ok} → "${out}" 不在枚举内`).toBe(true)
      }
    }
  })
})
