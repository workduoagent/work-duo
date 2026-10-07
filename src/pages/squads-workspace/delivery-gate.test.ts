/**
 * 交付确认门禁卡回归（2026-10-07 真机反馈驱动）。
 *
 * 用户反馈原文：「delivery 审批只出现在对话模式里面，舞台模式并没有出现
 * delivery 审批卡片，这就导致用户需要切换到对话模式去审批才可以」。
 *
 * 根因：门禁卡挂在 TimelineView 内（仅对话视图渲染），StageView 完全没有
 * 审批入口 —— 舞台模式只有成员授权请求（pendingApprovals），没有交付门禁。
 *
 * 本文件锁住三件事：
 * 1. 舞台模式必须能拿到 delivery 门禁与决议回调；
 * 2. 门禁显示条件 = 事件置位 OR 会话状态，且终态一律不显示；
 * 3. 决议后必须清本地置位（否则卡挂住不消失）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DETAIL = join(__dirname, 'SquadDetailPage.tsx')
const SCSS = join(__dirname, 'index.scss')
const EVENTS = join(__dirname, 'useSquadRunEvents.ts')

/** 剔除注释行后再断言（本会话已因此踩坑两次）。 */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')

const detail = codeOnly(readFileSync(DETAIL, 'utf8'))
const detailRaw = readFileSync(DETAIL, 'utf8')

describe('舞台模式必须有交付审批入口', () => {
  it('StageView 接收 delivery 与 onGate props', () => {
    expect(detail).toContain('delivery?: boolean')
    expect(detail).toMatch(/onGate\?:\s*\(cmd: string/)
  })

  it('调用处把 deliveryGate 与 gateCall 传给 StageView', () => {
    // 舞台与对话两个视图都必须拿到同一个判定结果
    const stageAt = detail.indexOf('<StageView')
    expect(stageAt).toBeGreaterThan(-1)
    const stageBlock = detail.slice(stageAt, stageAt + 900)
    expect(stageBlock).toContain('delivery={deliveryGate}')
    expect(stageBlock).toContain('onGate={gateCall}')
  })

  it('舞台内渲染交付确认卡（含确认交付 / 要求修订两个动作）', () => {
    const stageAt = detail.indexOf('const StageView')
    const timelineAt = detail.indexOf('const TimelineView')
    expect(stageAt).toBeGreaterThan(-1)
    expect(timelineAt).toBeGreaterThan(stageAt)
    const stageBody = detail.slice(stageAt, timelineAt)
    expect(stageBody).toContain('sw-say-approval is-delivery')
    expect(stageBody).toContain('交付待确认')
    // 两个决议动作，命令与对话视图一致
    expect(stageBody).toContain("'squad_delivery_resolve', { approved: true }")
    expect(stageBody).toContain("'squad_delivery_resolve', { approved: false }")
  })

  it('有气泡时才展开（has-word 条件含 delivery）', () => {
    const stageAt = detail.indexOf('const StageView')
    const timelineAt = detail.indexOf('const TimelineView')
    const stageBody = detail.slice(stageAt, timelineAt)
    expect(stageBody).toMatch(/systemWord\s*\|\|\s*pendingApprovals\?\.length\s*\|\|\s*delivery/)
  })
})

describe('门禁显示条件：事件置位 OR 状态，终态不显示', () => {
  /** 复刻 deliveryGate 判定。 */
  const gateOf = (status: string | undefined, pending: boolean): boolean => {
    const TERMINAL = new Set(['done', 'cancelled', 'failed'])
    if (!status || TERMINAL.has(status)) return false
    return pending || status === 'awaiting_delivery'
  }

  it('事件置位时立即显示（不等轮询）', () => {
    expect(gateOf('running', true)).toBe(true)
  })

  it('状态为 awaiting_delivery 时显示（覆盖进入页面时门禁已挂）', () => {
    expect(gateOf('awaiting_delivery', false)).toBe(true)
  })

  it('终态一律不显示（后端门禁已释放，点击无人接收）', () => {
    expect(gateOf('done', true)).toBe(false)
    expect(gateOf('cancelled', true)).toBe(false)
    expect(gateOf('failed', true)).toBe(false)
  })

  it('无会话 / 普通运行态且无门禁时不显示', () => {
    expect(gateOf(undefined, false)).toBe(false)
    expect(gateOf('running', false)).toBe(false)
  })

  it('源码：两个视图统一用 deliveryGate，不再各自推导 status', () => {
    expect(detail).toContain('const deliveryGate = useMemo')
    expect(detail).toContain('delivery={deliveryGate}')
    // 旧的裸推导不得残留
    expect(detail).not.toContain("delivery={selectedSession?.status === 'awaiting_delivery'}")
  })

  it('源码：终态集合已定义并被 deliveryGate 使用', () => {
    expect(detail).toContain("TERMINAL_STATUSES_FRONT = new Set(['done', 'cancelled', 'failed'])")
    expect(detail).toContain('TERMINAL_STATUSES_FRONT.has(st)')
  })
})

describe('事件驱动与决议清理', () => {
  it('详情页接了 onDeliveryPending（落 delivery 轮即置位）', () => {
    expect(detail).toContain('onDeliveryPending: () => {')
    expect(detail).toContain('setDeliveryPending(true)')
  })

  it('决议后清置位（gateCallAsync 三态一起清）', () => {
    expect(detail).toContain(
      'setPlanPending(false); setCheckpointPending(false); setDeliveryPending(false)',
    )
  })

  it('共用事件层定义了 onDeliveryResolved 供调用方清理', () => {
    const ev = readFileSync(EVENTS, 'utf8')
    expect(ev).toContain('onDeliveryResolved?: () => void')
    // delivery 轮事件仍需触发 onDeliveryPending（不得因新增而破坏既有链路）
    expect(ev).toContain("if (pl.kind === 'delivery') opts.onDeliveryPending?.()")
  })

  it('本地 state 声明存在', () => {
    expect(detail).toContain('const [deliveryPending, setDeliveryPending] = useState(false)')
  })
})

describe('交付卡样式', () => {
  it('is-delivery 变体已定义（绿色区分「可交付」）', () => {
    const scss = readFileSync(SCSS, 'utf8')
    expect(scss).toContain('.sw-say-approval.is-delivery')
  })

  it('暗色主题已适配（原样式是固定浅底 + 深字）', () => {
    const scss = readFileSync(SCSS, 'utf8')
    expect(scss).toContain('.dark .sw-say-approval')
    expect(scss).toContain('.dark .sw-say-approval.is-delivery')
  })
})

describe('原注释的错误论断已修正', () => {
  it('不再声称「详情页靠轮询不是漂移」（那正是缺陷）', () => {
    // 旧注释：两页门禁的数据来源本就不同…不是漂移
    expect(detailRaw).not.toContain('两页门禁的数据来源')
    expect(detailRaw).not.toContain('故这里无需 onDeliveryPending')
  })
})