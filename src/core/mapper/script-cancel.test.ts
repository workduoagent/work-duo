/**
 * F049 收尾回归：沙箱脚本取消的三条不变量。
 *
 * 背景（2026-10-07 真机实测暴露，非单测能发现）：
 * 用户点「停止」后出现两个现象 —— ①弹红 toast「脚本运行错误」而非「已取消」；
 * ② 第二次运行点「停止」无效、脚本照跑到底。根因分别是：
 * -取消判定靠 `error.includes('已取消')` 匹配中文文案，而 Tauri 会把 Rust 的
 *   `Err(String)` 包一层再抛回，字符串形态与源码文案不保证一致 → 判定失效。
 * - 前端先查`lastScriptRunId()` 再 `runScript()`，两次均异步，Rust 的 register
 *   未必赶在查询之前完成 → 读到上一次遗留的陈旧 run_id（且注销未清 LAST_ID）。
 *
 * 这三个断言锁住修复后的行为契约。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CANCELLED_PREFIX,
  isScriptCancelled,
  stripCancelledPrefix,
} from './script-cancel'

const ROOT = join(__dirname, '..', '..')

describe('取消判定基于机器可读前缀（F049）', () => {
  it('带前缀的错误判为已取消', () => {
    expect(isScriptCancelled(`${CANCELLED_PREFIX}沙箱脚本已被用户取消，进程已终止。`)).toBe(true)
  })

  it('中文文案本身不足以判为取消（原缺陷）', () => {
    // 只有中文、没有前缀 ⇒ 必须判为「非取消」。
    // 这条是回归核心：旧实现靠 includes('已取消') 会被真机上的错误形态骗过。
    expect(isScriptCancelled('沙箱脚本已被用户取消，进程已终止。')).toBe(false)
    expect(isScriptCancelled('Command "python cancel_test.py" not found')).toBe(false)
  })

  it('真实失败不会被误判为取消', () => {
    expect(isScriptCancelled('脚本文件不存在：E:\\x.py')).toBe(false)
    expect(isScriptCancelled('沙箱脚本执行超时（600s），已强制终止进程。')).toBe(false)
    expect(isScriptCancelled(undefined)).toBe(false)
    expect(isScriptCancelled(null)).toBe(false)
  })

  it('展示文案剥掉前缀，不泄漏实现细节', () => {
    expect(stripCancelledPrefix(`${CANCELLED_PREFIX}进程已终止。`)).toBe('进程已终止。')
    // 非取消消息原样返回
    expect(stripCancelledPrefix('普通错误')).toBe('普通错误')
  })
})

describe('前后端取消契约一致（F049）', () => {
  it('Rust 与 TS 的前缀逐字一致', () => {
    const rust = readFileSync(join(ROOT, '..', 'src-tauri', 'src', 'script_cancel.rs'), 'utf8')
    // Rust 侧常量定义：`pub const CANCELLED_PREFIX: &str = "CANCELLED:";`
    const m = rust.match(/pub const CANCELLED_PREFIX: &str = "([^"]+)"/)
    expect(m, 'Rust 侧应定义 CANCELLED_PREFIX').toBeTruthy()
    expect(m![1]).toBe(CANCELLED_PREFIX)
  })

  it('Python 与 Node 两侧取消分支都带前缀（防一侧漏改）', () => {
    for (const f of ['mamba_manager.rs', 'bun_manager.rs']) {
      const src = readFileSync(join(ROOT, '..', 'src-tauri', 'src', f), 'utf8')
      expect(src, `${f} 应使用 CANCELLED_PREFIX`).toContain('script_cancel::CANCELLED_PREFIX')
    }
  })
})

describe('run_id 时序：不得先查后跑（F049）', () => {
  /**
  * 取真正的调用行（排除注释里出现的同名文本 —— 注释提到旧写法会造成误判）。
  *
  * ⚠️ 两个坑（都实测踩过）：
  * ① 源文件是 **CRLF**，`trim()` 不会去掉行尾的 `\r`，故要用正则匹配整行；
  * ② 调用行形态有两种：`runScript(...)` 与 `const running = runScript(...)`。
  */
  const callSite = (src: string, fn: string): number => {
    const lines = src.split('\n')
    let offset = 0
    for (const line of lines) {
      const t = line.trim()
      // 真实调用行的前缀形态：`runScript(` / `const x = runScript(` / `void lastScriptRunId(`
      const re = new RegExp(`^(const\\s+\\w+\\s*=\\s*|void\\s+)?${fn}\\(`)
      if (re.test(t)) return offset
      offset += line.length + 1
    }
    return -1
  }

  it('两页的取 id 都排在 runScript 调用之后（防陈旧 run_id）', () => {
    for (const p of [
      join(ROOT, 'pages', 'sandbox', 'python', 'index.tsx'),
      join(ROOT, 'pages', 'sandbox', 'node', 'index.tsx'),
    ]) {
      const src = readFileSync(p, 'utf8')
      const handleAt = src.indexOf('const handleRun')
      expect(handleAt, `${p} 应含 handleRun`).toBeGreaterThan(-1)
      // 只截取 handleRun 函数体，避开 handleStop（那里用 await 是合理的兜底）
      const body = src.slice(handleAt, src.indexOf('const handleStop', handleAt))
      const runAt = callSite(body, 'runScript')
      const idAt = callSite(body, 'lastScriptRunId')
      expect(runAt, `${p}: handleRun 内应调用 runScript`).toBeGreaterThan(-1)
      expect(idAt, `${p}: handleRun 内应取 run_id`).toBeGreaterThan(-1)
      expect(
        idAt,
        `${p}: 取 run_id 必须晚于 runScript（否则读到陈旧 run_id）`,
      ).toBeGreaterThan(runAt)
    }
  })

  it('取 run_id 走并发链而非 await（await 会等到脚本跑完，按钮就废了）', () => {
    for (const p of [
      join(ROOT, 'pages', 'sandbox', 'python', 'index.tsx'),
      join(ROOT, 'pages', 'sandbox', 'node', 'index.tsx'),
    ]) {
      const src = readFileSync(p, 'utf8')
      const handleAt = src.indexOf('const handleRun')
      const body = src.slice(handleAt, src.indexOf('const handleStop', handleAt))
      expect(
        body,
        `${p}: 应先发起 runScript（存 promise）再并发取 id`,
      ).toMatch(/const running = runScript\(/)
      // 不得写成 `await lastScriptRunId()` ——那会等到脚本结束
      expect(body, `${p}: 取 id 不应 await`).not.toMatch(/await lastScriptRunId\(/)
    }
  })

  it('不应再用中文文案匹配判定取消', () => {
    for (const p of [
      join(ROOT, 'pages', 'sandbox', 'python', 'index.tsx'),
      join(ROOT, 'pages', 'sandbox', 'node', 'index.tsx'),
    ]) {
      const src = readFileSync(p, 'utf8')
      expect(src, `${p} 不应再 includes('已取消') 判定`).not.toContain("includes('已取消')")
      expect(src, `${p} 应改用 isScriptCancelled`).toContain('isScriptCancelled(res.error)')
    }
  })

  it('Rust 注销时同步清空 LAST_ID（防陈旧 run_id）', () => {
    const rust = readFileSync(join(ROOT, '..', 'src-tauri', 'src', 'script_cancel.rs'), 'utf8')
    const fnAt = rust.indexOf('pub fn unregister_script_run')
    expect(fnAt).toBeGreaterThan(-1)
    // 注销函数体内必须处理 LAST_ID
    const body = rust.slice(fnAt, fnAt + 700)
    expect(body, 'unregister_script_run 应同步清理 LAST_ID').toContain('LAST_ID')
  })
})