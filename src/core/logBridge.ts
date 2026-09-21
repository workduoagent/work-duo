/**
 * 前端 → 后端日志桥。
 *
 * 把前端（TS/Webview）的重要操作日志投递给 Rust 命令 `log_frontend`，
 * 后者以与后端 tracing 完全一致的格式（`[时间][模块][fe][web:0]-LEVEL-内容`）
 * 落盘到同一份 `workduo.log.YYYY-MM-DD` 每日滚动文件。
 *
 * 这样后端 `get_run_logs` 能一并回看「前端 KB 操作 / 索引钩子」等链路，便于跨端排错。
 * 关键设计：fire-and-forget —— 日志投递失败（命令未注册 / 后台未就绪）一律静默，
 * 绝不因为日志异常影响任何产品主流程。
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'

type FeLevel = 'info' | 'warn' | 'error' | 'debug'

function push(level: FeLevel, module: string, message: string): void {
  if (!isTauri) return
  void invoke('log_frontend', { level, module, message }).catch(() => {
    /* 日志投递失败静默，绝不抛错影响业务 */
  })
}

/** 前端日志投递器：模块名建议用代码归属（如 `kbFs` / `kb-index` / `mcpBridge.kb`）。 */
export const fe = {
  info: (module: string, msg: string) => push('info', module, msg),
  warn: (module: string, msg: string) => push('warn', module, msg),
  error: (module: string, msg: string) => push('error', module, msg),
  debug: (module: string, msg: string) => push('debug', module, msg),
}

export type { FeLevel }
