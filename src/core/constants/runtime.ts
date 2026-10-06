/**
 * 前端运行时阈值（F027）—— 单一事实源。
 *
 * 背景：这些数字此前散落在各处字面量里，与 Rust 侧 `WD_*` 环境变量默认值
 * 各写一份，存在漂移：
 *  - run 硬预算：Rust `DEFAULT_RUN_MAX_SECS = 1800`（30min），前端「任务过长」
 *    告警却写死 20min —— 两份数字不同源，用户看到告警时距离真正超时还有 10min，
 *    容易误判为「卡死」；
 *  - MCP 超时：默认值 120s（`timeoutSec ?? 120`）在 4 处重复，而超时错误文案
 *    写「>15s」—— 用户按 15s 排查一个 120s 的问题。
 *
 * 本模块只收「前端自己决定」的前端常量。**跨端阈值（run 预算、LLM 超时、
 * 限流 RPM）由 Rust 通过命令下发，不在前端硬编码** —— 见下方 TODO 说明。
 */

/** 任务运行「过长」提示阈值（ms）。
 *  Rust 侧 run 硬预算为 `WD_RUN_MAX_SECS`（默认 1800s = 30min），本值取其
 *  2/3 处提醒用户，留出余量让用户仍有余地取消而非已被强杀。 */
export const LONG_RUN_WARN_MS = 20 * 60_000

/** MCP 连接/调用默认超时（秒）。四处 `timeoutSec ?? 120` 的唯一来源。 */
export const MCP_TIMEOUT_SEC_DEFAULT = 120

/**
 * 把秒数格式化为人类可读的超时描述（用于错误文案）。
 * 之前「连接超时（>15s）」与实际 120s 不符，现由实参生成，文案不会与代码漂移。
 */
export function timeoutHint(sec: number): string {
  return sec >= 60 ? `>${Math.round(sec / 60)} 分钟` : `>${sec}s`
}

/**
 * TODO(跨端下发)：run 硬预算 / LLM 调用超时 / RPM 限流目前由 Rust 侧
 * `WD_RUN_MAX_SECS` / `WD_LLM_*` 独立定义，前端无法读取，等同两份定义。
 * 待Rust 侧提供 `get_runtime_limits` 命令返回这些数值后，此处改为运行时拉取，
 * 本文件仅保留纯前端展示常量（如 LONG_RUN_WARN_MS 的提醒比例）。
 */
