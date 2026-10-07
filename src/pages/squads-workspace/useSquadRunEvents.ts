import { listen } from '@tauri-apps/api/event'
import type { BoardRound } from './index'

/**
 * 小分队运行事件订阅（F039 · 抽取共用层）。
 *
 * 背景：`squads-workspace/index.tsx`（列表页内嵌控制台）与 `SquadDetailPage.tsx`
 * （独立详情页）各自实现同一套事件订阅与状态更新，两处逻辑同源却各写一遍。
 * 走查时已出现实际漂移：`agent-squad-round` 的 `delivery` 门禁只在列表页处理，
 * 详情页收不到「交付待确认」信号。
 *
 * 抽取原则：**只收敛「事件 → 状态更新」这一层，不碰两页各自的注册时机与页面特有
 * 逻辑**（列表页在 handleRun 内部按需注册并随 cleanup 解除；详情页在useEffect
 * 常驻）。强行统一注册时机会改变生命周期语义，属F038 拆分时才该处理的问题。
 *
 * 事件载荷类型与两页原先的本地 `listen<T>` 泛型逐字一致（不引入新 mapper，
 * 避免载荷字段与 Rust 侧悄悄脱节）。
 */

export interface SquadRoundPayload {
  squadId: string
  sessionId: string
  speakerAgentId: string | null
  role: string
  kind: string
  content: string
}

export interface SquadSessionDonePayload {
  squadId: string
  sessionId: string
  summary: string
}

export interface SquadSessionStartedPayload {
  squadId: string
  sessionId: string
}

export interface SquadMemberEventPayload {
  squadId: string
  memberRole: string
  phase: string
  ok: boolean
}

export interface SubscribeOptions<S extends string = string> {
  squadId: string
  /** round 事件是否接纳（调用方按当前选中会话过滤）。返回 false 则丢弃。 */
  acceptRound?: (pl: SquadRoundPayload) => boolean
  setRounds: (updater: (prev: BoardRound[]) => BoardRound[]) => void
  onPlanPending?: () => void
  onCheckpointPending?: () => void
  onDeliveryPending?: () => void
  /**
   * 交付门禁**已决议**（确认/ 要求修订）后清掉本地置位。
   *
   * 为什么需要：`onDeliveryPending` 是「收到 delivery 轮 ⇒ 立即亮卡」，但决议后
   * 若不清，卡会一直挂着直到下次轮询刷 status。舞台模式没有底部审批条兜着，
   * 挂住的卡比不显示更糟（用户点了没反应）。
   */
  onDeliveryResolved?: () => void
  setSummary: (s: string) => void
  setMemberMotion: (updater: (prev: Record<string, S>) => Record<string, S>) => void
  /**
   * 成员动作态取值策略，默认映射到 `AgentMotionState` 枚举
   * （idle / working / thinking / error / waiting / speaking / handoff / cheer）。
   *
   * F039 修复的两个真实缺陷：
   *  1. `delivery` 门禁此前仅列表页处理，详情页收不到「交付待确认」；
   *  2. 详情页原先产出 `` `${phase}-${ok?'ok':'err'}` `` 形态（如 `started-ok`），
   *     而其消费方（`memberState` / `isBusyPose` / `PixelAgent`）只识别枚举值
   *     —— **格式不匹配导致详情页小人动画对成员事件完全无响应**。现统一为
   *     枚举映射，两页行为一致。
   */
  memberMotionOf?: (pl: SquadMemberEventPayload) => S
  onSessionStarted?: (sessionId: string) => void
  onSessionDone?: () => void
}

/**
 * 注册四个小分队运行事件，返回解除函数数组。
 * 调用方负责在适当时机调用解除（列表页随 run 结束，详情页随组件卸载）。
 */
export async function subscribeSquadRunEvents<S extends string = string>(
  opts: SubscribeOptions<S>,
): Promise<Array<() => void>> {
  const { squadId } = opts

  const offStart = await listen<SquadSessionStartedPayload>(
    'agent-squad-session-started',
    (e) => {
      if (e.payload.squadId !== squadId) return
      opts.onSessionStarted?.(e.payload.sessionId)
    },
  )

  const offRound = await listen<SquadRoundPayload>('agent-squad-round', (e) => {
    const pl = e.payload
    if (pl.squadId !== squadId) return
    if (opts.acceptRound && !opts.acceptRound(pl)) return
    if (pl.kind === 'plan') opts.onPlanPending?.()
    if (pl.kind === 'checkpoint') opts.onCheckpointPending?.()
    // F039：此前只有列表页处理 delivery，详情页收不到「交付待确认」信号
    if (pl.kind === 'delivery') opts.onDeliveryPending?.()
    opts.setRounds((r) => [
      ...r,
      {
        role: pl.role,
        kind: pl.kind,
        content: pl.content,
        speakerAgentId: pl.speakerAgentId,
      },
    ])
  })

  const offDone = await listen<SquadSessionDonePayload>(
    'agent-squad-session-done',
    (e) => {
      if (e.payload.squadId !== squadId) return
      opts.setSummary(e.payload.summary)
      opts.onSessionDone?.()
    },
  )

  const offMember = await listen<SquadMemberEventPayload>('squad-member-event', (e) => {
    if (e.payload.squadId !== squadId) return
    const role = e.payload.memberRole
    const st = opts.memberMotionOf
      ? opts.memberMotionOf(e.payload)
      : (defaultMemberMotion(e.payload) as S)
    opts.setMemberMotion((m) => ({ ...m, [role]: st }))
    // 非 started 的动作在 3s 后回落 idle（两页原本同值，抽到一处）
    if (e.payload.phase !== 'started') {
      // 'idle' 是回落态，两页的动作态联合类型都含它；用 as S 收窄泛型写入
      setTimeout(() => opts.setMemberMotion((m) => ({ ...m, [role]: 'idle' as S })), 3000)
    }
  })

  return [offStart, offRound, offDone, offMember]
}

/**
 * `squad-member-event` → `AgentMotionState` 枚举的**默认映射**。
 *
 * 抽到共用层的理由：原先两页各写一份，且详情页写成了 `` `${phase}-${ok}` `` 形态
 * 与消费方（`memberState`/`isBusyPose`/`PixelAgent`）的枚举校验完全不匹配 ——
 * 详情页小人动画因此对成员事件无响应。统一后两页行为一致。
 */
export function defaultMemberMotion(pl: SquadMemberEventPayload): string {
  if (pl.phase === 'started') return 'working'
  if (!pl.ok) return 'error'
  // Rust 侧 phase 取值：completed / failed / checkpoint / delivery 等
  if (pl.phase === 'completed') return 'cheer'
  return 'handoff'
}
