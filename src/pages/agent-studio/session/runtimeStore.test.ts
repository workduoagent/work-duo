/**
 * F018 关键路径单测：runtimeStore 事件归属路由（F007 回归锚）。
 * mock Tauri event listen 捕获各事件处理器，真实驱动 ensureRuntimeBridge 注册的回调——
 * 核心契约：**外来会话的终态事件不得误清当前运行态**（并发 run 串台是 F007 修复的真实事故）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = (ev: { payload: unknown }) => void
const listeners = new Map<string, Listener>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: Listener) => {
    listeners.set(name, cb)
    return () => {}
  }),
}))
vi.mock('@/core/config', () => ({ isTauri: true }))

import {
  beginRun,
  endRun,
  ensureRuntimeBridge,
  getRunningSessionId,
  isSessionRunning,
  setTerminalHandler,
  resetRuntime,
  __debugEntryStats,
} from './runtimeStore'

function fire(name: string, payload: unknown) {
  const cb = listeners.get(name)
  expect(cb, `事件 ${name} 的监听器应已注册`).toBeTruthy()
  cb!({ payload })
}

describe('runtimeStore 事件归属路由（F007）', () => {
  beforeEach(() => {
    // 注意：listeners 不清空——bridge 与生产语义一致只注册一次（S.bridgeStarted 跨用例保持），
    // 清空后 ensureRuntimeBridge 不会重注册，捕获表就永远为空。
    endRun()
    ensureRuntimeBridge()
  })

  it('bridge 只注册一次，且 agent-task-done / agent-event 均在册', () => {
    ensureRuntimeBridge()
    expect(listeners.has('agent-task-done')).toBe(true)
    expect(listeners.has('agent-event')).toBe(true)
    expect(listeners.has('agent-task-error')).toBe(true)
  })

  it('beginRun 置运行态；归属终态清空运行态并携带用量触发终态回调', () => {
    const terminals: Array<{ sessionId: string; ok: boolean; usage: unknown }> = []
    setTerminalHandler('f018-test', (info) =>
      terminals.push({ sessionId: info.sessionId, ok: info.ok, usage: info.usage }),
    )
    beginRun('s1', 'a1', { roundId: 'r1', lastPrompt: 'hi' })
    expect(getRunningSessionId()).toBe('s1')
    expect(isSessionRunning('s1')).toBe(true)

    fire('agent-task-done', {
      sessionId: 's1',
      promptTokens: 10,
      completionTokens: 20,
    })
    expect(getRunningSessionId()).toBeNull()
    expect(isSessionRunning('s1')).toBe(false)
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ sessionId: 's1', ok: true, usage: { promptTokens: 10, completionTokens: 20 } })
  })

  it('F007 核心：外来会话的终态事件不清当前运行态（并发 run 不串台）', () => {
    const terminals: Array<{ sessionId: string; ok: boolean }> = []
    setTerminalHandler('f018-test', (info) => terminals.push({ sessionId: info.sessionId, ok: info.ok }))
    beginRun('s1', 'a1', { lastPrompt: '' })
    // s2 的终态事件到达（用户已切到 s1 跑新任务）
    fire('agent-task-done', { sessionId: 's2', promptTokens: 1, completionTokens: 1 })
    // 当前运行态不受外来终态影响
    expect(getRunningSessionId()).toBe('s1')
    expect(isSessionRunning('s1')).toBe(true)
    // 但外来会话自身收到终态回调（落库/提醒照常）
    expect(terminals.map((t) => t.sessionId)).toEqual(['s2'])

    // s1 自己的终态到达才清运行态
    fire('agent-task-done', { sessionId: 's1', promptTokens: 0, completionTokens: 0 })
    expect(getRunningSessionId()).toBeNull()
  })

  it('task-error 与 task-done 同享归属路由契约', () => {
    beginRun('s1', 'a1', { lastPrompt: '' })
    fire('agent-task-error', { sessionId: 's2', message: 'boom' })
    expect(getRunningSessionId()).toBe('s1')
    fire('agent-task-error', { sessionId: 's1', message: 'boom' })
    expect(getRunningSessionId()).toBeNull()
  })

  it('无归属会话且无当前运行时，事件被安全忽略（不抛错）', () => {
    endRun()
    expect(() => fire('agent-task-done', { promptTokens: 1, completionTokens: 1 })).not.toThrow()
    expect(() => fire('agent-event', { payload: { sessionId: undefined } })).not.toThrow()
  })
})

/**
 * F023 回归：运行态条目 LRU 淘汰。
 *
 * 背景：entries 原本只增不减——每访问过一个会话就永久驻留（toolSteps / segments /
 * traceThinking 数组全量保留）。加了上限后必须保证「正在运行的会话绝不淘汰」，
 * 否则 UI 会立刻丢失进行中的工具步骤。
 */
describe('runtimeStore 条目 LRU（F023）', () => {
  beforeEach(() => {
    endRun()
    ensureRuntimeBridge()
  })

  it('超过上限时淘汰旧条目，条目数不超上限', () => {
    const { max } = __debugEntryStats()
    for (let i = 0; i < max + 20; i++) {
      beginRun('bulk-${i}', 'agent-x', { lastPrompt: '' })
      endRun()
    }
    const after = __debugEntryStats()
    expect(after.size).toBeLessThanOrEqual(after.max)
  })

  it('正在运行的会话不被淘汰（工具步骤不丢）', () => {
    const { max } = __debugEntryStats()
    // 先造满并全部结束（可淘汰）
    for (let i = 0; i < max + 5; i++) {
      beginRun('old-${i}', 'agent-x', { lastPrompt: '' })
      endRun()
    }
    // 再建一个「正在运行」的会话
    beginRun('hot-running', 'agent-x', { lastPrompt: '' })
    // 继续造大量新条目，迫使淘汰
    for (let i = 0; i < max + 5; i++) {
      beginRun('new-${i}', 'agent-y', { lastPrompt: '' })
      endRun()
    }
    // 运行中的会话必须仍在
    expect(isSessionRunning('hot-running')).toBe(true)
  })

  it('resetRuntime 后条目回到初始态且不再占额度优势', () => {
    beginRun('r1', 'agent-x', { lastPrompt: '' })
    endRun()
    resetRuntime('r1')
    expect(isSessionRunning('r1')).toBe(false)
  })
})
