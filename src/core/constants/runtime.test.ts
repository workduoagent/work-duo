import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LONG_RUN_WARN_MS, MCP_TIMEOUT_SEC_DEFAULT, timeoutHint } from './runtime'

/**
 * F027 回归：前端阈值单一事实源。
 *
 * 背景：阈值此前散落成字面量，且与 Rust 侧 `WD_*` 各写一份：
 *  - MCP 默认超时 `120` 在 4 处重复，超时文案却写「>15s」——用户按 15s 排查
 *    一个 120s 的问题；
 *  - run 过长告警写死 20min，而 Rust 硬预算是 `WD_RUN_MAX_SECS`（默认 1800s
 *    = 30min），两份数字不同源。
 *
 * 本测试锁住：① 阈值模块是唯一来源（源码里不再出现裸字面量）；② 文案由实参生成。
 */

const ROOT = join(__dirname, '..', '..', '..')

describe('运行时阈值单一事实源（F027）', () => {
  it('MCP 默认超时为 120s 且与文案口径一致', () => {
    expect(MCP_TIMEOUT_SEC_DEFAULT).toBe(120)
    // 修复前文案硬写「>15s」；现由实参生成，不会再与代码漂移
    expect(timeoutHint(15)).toBe('>15s')
    expect(timeoutHint(120)).toBe('>2 分钟')
  })

  it('timeoutHint 按量级选择单位', () => {
    expect(timeoutHint(30)).toBe('>30s')
    expect(timeoutHint(60)).toBe('>1 分钟')
    expect(timeoutHint(300)).toBe('>5 分钟')
  })

  it('长任务告警阈值小于 Rust 侧 30min 硬预算（留取消余量）', () => {
    const RUST_RUN_MAX_SECS = 1800 // src-tauri/src/agent/engine/runtime.rs DEFAULT_RUN_MAX_SECS
    expect(LONG_RUN_WARN_MS).toBeLessThan(RUST_RUN_MAX_SECS * 1000)
    // 不宜过早提醒（用户会误判为卡死）
    expect(LONG_RUN_WARN_MS).toBeGreaterThan(RUST_RUN_MAX_SECS * 1000 * 0.5)
  })

  it('mcp-connection 不再出现裸 120 / >15s 字面量', () => {
    const text = readFileSync(join(ROOT, 'src', 'core', 'mapper', 'mcp-connection.ts'), 'utf8')
    expect(text, 'MCP 超时应统一走 MCP_TIMEOUT_SEC_DEFAULT').not.toMatch(/\?\?\s*120\b/)
    expect(text, '超时文案应由 timeoutHint 生成，不硬编码秒数').not.toMatch(/>\d+s[，,]/)
  })

  it('useAgentSession 的告警阈值走常量（不写字面量）', () => {
    const text = readFileSync(
      join(ROOT, 'src', 'pages', 'agent-studio', 'session', 'useAgentSession.ts'),
      'utf8',
    )
    expect(text).toContain('LONG_RUN_WARN_MS')
    expect(text).not.toMatch(/20\s*\*\s*60_000/)
  })
})
