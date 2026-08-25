import { invoke } from '@tauri-apps/api/core'
import { logger } from '@/utils/logger'

/**
 * Unified Tauri IPC wrapper. Every Rust command goes through here so we get a
 * single place for logging, error normalization and (later) auth/retry.
 */
export async function invokeCommand<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  logger.debug(`[IPC] invoke -> ${cmd}`, args ?? {})
  try {
    return await invoke<T>(cmd, args)
  } catch (error) {
    logger.error(`[IPC] command failed: ${cmd}`, error)
    throw error
  }
}
