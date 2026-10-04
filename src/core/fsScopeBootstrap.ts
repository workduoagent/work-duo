/**
 * 启动期 fs scope 恢复（F003 follow-up，凭据化）。
 *
 * 用户经 Tauri 原生 dialog 选择的文件/目录会由 tauri-plugin-dialog 自动授予当前窗口 scope；
 * 需要「跨重启保留」的持久目录（settings 数据目录 / Agent 工程根 / 小分队工作区）在确认选择后
 * 由 record_fs_scope_grant 签发 HMAC 凭据落 fs_scope_grant 表（密钥在 OS 凭据管理器）。
 * 重启后 restore_fs_scope 验签恢复——渲染层改库无法伪造凭据，签发也仅限本次会话已可见路径。
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'
import { fe } from '@/core/logBridge'

/** 带重试恢复持久目录 scope，规避启动早期 SQLite 尚未就绪。 */
export async function ensureDataDirFsScope(): Promise<void> {
  if (!isTauri) return
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const count = await invoke<number>('restore_fs_scope')
      fe.info('fsScope', `已恢复 ${count} 个持久目录的 fs scope`)
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (attempt < maxAttempts) {
        fe.warn('fsScope', `第${attempt}次恢复 fs scope 失败，重试: ${msg}`)
        await new Promise((r) => setTimeout(r, 600))
        continue
      }
      fe.warn('fsScope', `恢复持久 fs scope 失败（部分目录可能受 ACL 限制）: ${msg}`)
    }
  }
}
