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
