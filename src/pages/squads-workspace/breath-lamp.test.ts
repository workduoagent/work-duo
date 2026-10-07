/**
 * 小分队呼吸灯回归：lastSpeakerId 必须跳过系统轮。
 *
 * 背景（2026-10-07 真机实测，用户报「轮到谁发言，右上角像素小人和成员状态
 * 呼吸灯没了」）：原实现直接取 `rounds[rounds.length - 1]`的 speakerAgentId，
 * 但 rounds 末尾会追加**系统轮**（kind = summary / metrics / delivery，
 * speakerAgentId 为 null）。而运行中的会话正是最常出现这些系统轮的时刻 ——
 * 于是 lastSpeakerId 恒为 null，谁都不亮，呼吸灯整个失效。
 *
 * 真机证据（技术评审圆桌会话，9 轮）：
 *   [0]-[5]真实发言（挑刺评审 / 方案陈述 交替）
 *   [6] summary  speaker=null
 *   [7] metrics  speaker=null
 *   [8] delivery speaker=null← 旧实现取这里 → null
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DETAIL = join(__dirname, 'SquadDetailPage.tsx')
const SCSS = join(__dirname, 'index.scss')

/** 复刻修复后的 lastSpeakerId 计算逻辑（保持与源码一致）。 */
const lastSpeakerId = (rounds: Array<{ speakerAgentId?: string | null }>): string | null => {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const id = rounds[i].speakerAgentId
    if (id) return id
  }
  return null
}

describe('呼吸灯 lastSpeakerId：跳过系统轮', () => {
  const SYS = { speakerAgentId: null }

  it('末尾是系统轮时，仍应取到最后一个真实发言者', () => {
    // 真机数据形状：6 条真实发言 + 3 条系统轮
    const rounds = [
      { speakerAgentId: 'agent-A' },
      { speakerAgentId: 'agent-B' },
      { speakerAgentId: 'agent-A' },
      { speakerAgentId: 'agent-B' },
      { speakerAgentId: 'agent-A' },
      { speakerAgentId: 'agent-B' },
      SYS, // summary
      SYS, // metrics
      SYS, // delivery
    ]
    // 旧实现：rounds[len-1].speakerAgentId ?? null ⇒ null ⇒ 无人点亮
    expect(rounds[rounds.length - 1].speakerAgentId ?? null).toBeNull()
    // 修复后：跳过系统轮回溯 ⇒ agent-B
    expect(lastSpeakerId(rounds)).toBe('agent-B')
  })

  it('单个系统轮（仅一轮）也会误伤旧实现', () => {
    const rounds = [{ speakerAgentId: 'agent-A' }, SYS]
    expect(lastSpeakerId(rounds)).toBe('agent-A')
  })

  it('全为系统轮时返回 null（无人在发言）', () => {
    expect(lastSpeakerId([SYS, SYS, SYS])).toBeNull()
  })

  it('空轮次返回 null，不抛异常', () => {
    expect(lastSpeakerId([])).toBeNull()
  })

  it('末轮是真实发言时，取值与旧实现一致（不引入回归）', () => {
    const rounds = [{ speakerAgentId: 'agent-A' }, { speakerAgentId: 'agent-B' }]
    const legacy = rounds[rounds.length - 1].speakerAgentId ?? null
    expect(lastSpeakerId(rounds)).toBe(legacy)
    expect(lastSpeakerId(rounds)).toBe('agent-B')
  })
})

describe('源码未回退（F039）', () => {
  it('SquadDetailPage 不应再直接取最后一轮', () => {
    const src = readFileSync(DETAIL, 'utf8')
    // 旧写法：rounds.length ? rounds[rounds.length - 1].speakerAgentId : null
    expect(
      src,
      'lastSpeakerId 不应再直接取 rounds[length-1]（会落在系统轮上）',
    ).not.toMatch(/rounds\.length\s*\?\s*rounds\[rounds\.length\s*-\s*1\]/)
  })

  it('改为从后往前找第一个有发言者的轮次', () => {
    const src = readFileSync(DETAIL, 'utf8')
    // ⚠️ 用字符串包含而非正则：源码是 CRLF，且 `useMemo(() => {` 里的
    // `{` 在正则中会被当量词开头导致匹配失败（实测踩过）。
    expect(src).toContain('const lastSpeakerId = useMemo')
    expect(src).toContain('for (let i = rounds.length - 1; i >= 0; i--)')
    expect(src).toContain('const id = rounds[i].speakerAgentId')
  })
})

/**
 * 源码断言辅助：**剔除注释行**再检查。
 *
 * ⚠️ 必做：修复说明写在注释里（「原为 `isRunning && ...`」），若直接对整文件
 * 做 `toContain` / 正则，会匹配到**注释文本**导致假失败（本次实测踩到两次）。
 * 故按行剔除以 `//` 或 `*` 开头的注释后再判定。
 */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')

describe('发言者判定不按运行状态分叉', () => {
  /** 复刻修复后的 memberState 核心判定。 */
  const speakingOf = (
    agentId: string,
    lastSpeakerId: string | null,
    motion: Record<string, string> = {},
    role = 'r',
  ): string => {
    const ev = motion[role]
    if (ev && ev !== 'idle') return ev
    if (lastSpeakerId && agentId === lastSpeakerId) return 'speaking'
    return 'idle'
  }

  it('会话已结束时，发言者仍应点亮', () => {
    // isRunning 已从判定中移除 —— 不再传该参数
    expect(speakingOf('agent-A', 'agent-A')).toBe('speaking')
  })

  it('非发言者保持 idle', () => {
    expect(speakingOf('agent-B', 'agent-A')).toBe('idle')
  })

  it('无发言者（空会话）时全员 idle', () => {
    expect(speakingOf('agent-A', null)).toBe('idle')
  })

  it('成员事件优先于发言者判定（执行中的成员不该被覆盖）', () => {
    expect(speakingOf('agent-A', 'agent-A', { r: 'working' })).toBe('working')
    expect(speakingOf('agent-A', 'agent-A', { r: 'cheer' })).toBe('cheer')
  })

  it('源码：memberState 不应再含 isRunning 前置门', () => {
    const code = codeOnly(readFileSync(DETAIL, 'utf8'))
    expect(
      code,
      'memberState 不应再用 isRunning 当发言者前置门（会话一结束呼吸灯全灭）',
    ).not.toMatch(/isRunning\s*&&\s*agentId === lastSpeakerId/)
    expect(code).toContain('if (lastSpeakerId && agentId === lastSpeakerId) return')
  })

  it('源码：isRunning 变量已随该门一并移除', () => {
    const code = codeOnly(readFileSync(DETAIL, 'utf8'))
    expect(code).not.toContain('const isRunning =')
  })
})

describe('右栏成员状态与舞台同源', () => {
  it('右栏复用 memberState（不得另算一套）', () => {
    const code = codeOnly(readFileSync(DETAIL, 'utf8'))
    expect(code).toContain('const motion = memberState(m.agentId, m.role)')
  })

  it('右栏把 speaking 显示为「发言中」而非落到 idle 兜底', () => {
    const code = codeOnly(readFileSync(DETAIL, 'utf8'))
    expect(code).toContain("motion === 'speaking' ? '发言中'")
    // PixelAgent 必须真收到 speaking（此前右栏从未传过该值）
    expect(code).toMatch(/speaking\s*\?\s*'speaking'/)
    // 发言者行高亮 class
    expect(code).toContain('sw-mrow${speaking ? \' is-speaking\' : \'\'}')
  })

  it('样式：is-speaking 已定义且不涉位移缩放', () => {
    const scss = readFileSync(SCSS, 'utf8')
    expect(scss).toContain('.sw-mrow.is-speaking')
    // 遵守项目铁律：状态禁transform 缩放/位移
    const block = scss.slice(
      scss.indexOf('.sw-mrow.is-speaking'),
      scss.indexOf('.sw-mrow.is-speaking') + 400,
    )
    expect(block).not.toMatch(/transform:\s*scale/)
    expect(block).not.toMatch(/translate/)
  })
})