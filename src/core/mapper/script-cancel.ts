/**
 * 沙箱脚本执行的取消通道（F049）—— Python / Node 两页共用。
 *
 * 为什么独立成模块：`sandbox-mapper`（Python）与 `bun-mapper`（Node）各自
 * 只暴露本语言的 `runScript`，但「取 run_id / 取消」两个动作调的是**同一组
 * Tauri 命令**（`last_script_run_id` / `cancel_script`），逻辑完全相同。
 * 抽到这里避免两个 mapper 各写一份。
 *
 * run_id 的获取方式：`runScript` 的返回契约是「stdout 字符串」（前端 invoke
 * 依赖，不可改），拿不到 run_id。故 Rust 侧提供「最近一次注册」查询——
 * 单用户单窗口下「最近一次注册」即当前这次运行（UI 已限制同一时刻只跑一个）。
 */
import { invoke } from '@tauri-apps/api/core'

/**
 * 取最近一次脚本运行的 run_id。
 *
 * 须在调用 `runScript` **之后**立即取（Rust 侧 `register_script_run()`
 * 在 spawn 之前执行，故此时查到的就是本次运行）。
 *
 * @returns run_id；查询失败返回 null（此时「停止」按钮会提示无运行中脚本）
 */
export async function lastScriptRunId(): Promise<string | null> {
  try {
    return await invoke<string | null>('last_script_run_id')
  } catch {
    return null
  }
}

/**
 * 取消一次脚本运行。
 *
 * Rust 侧会终止**进程组**（连带脚本 spawn 的子进程，如 pip / npm 的子进程），
 * 而不只是父进程。
 *
 * @param runId 来自 {@link lastScriptRunId}
 * @returns true=已发出取消信号；false=该 run 已结束/已被取消/传错
 */
export async function cancelScript(runId: string): Promise<boolean> {
  try {
    return await invoke<boolean>('cancel_script', { runId })
  } catch {
    return false
  }
}

/**
 * 「本次执行是被用户取消」的机器可读前缀 —— **必须与 Rust 侧
 * `script_cancel::CANCELLED_PREFIX` 逐字一致**（后端加前缀、前端据此判定）。
 *
 * 🔴 为什么不能靠中文文案匹配（2026-10-07 真机实测教训）：
 * 原实现用 `error.includes('已取消')`，但 Tauri 会把 Rust 的 `Err(String)`
 * 包一层再抛给前端，字符串形态与源码文案不保证一致 —— 实测导致「已取消」
 * 被误判为「脚本运行错误」弹红 toast。判定必须基于稳定前缀，不能基于文案。
 */
export const CANCELLED_PREFIX = 'CANCELLED:'

/**
 * 判断一次脚本执行的结果是否属于「用户主动取消」。
 *
 * @param error `OpResult.error` 的原文
 * @returns true=用户取消（前端应显示「已取消」）；false=真实失败
 */
export function isScriptCancelled(error: string | undefined | null): boolean {
  return typeof error === 'string' && error.includes(CANCELLED_PREFIX)
}

/**
 * 剥掉机器可读前缀，取出给用户看的中文文案。
 *
 * 失败/取消都要展示点什么，直接把 `CANCELLED:` 显示给用户是实现细节泄漏。
 */
export function stripCancelledPrefix(error: string): string {
  return error.startsWith(CANCELLED_PREFIX) ? error.slice(CANCELLED_PREFIX.length) : error
}
