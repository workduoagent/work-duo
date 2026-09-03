/**
 * 第二轨物理记忆（`.wd_mem/`）访问层。
 *
 * 对应《双轨持久化与分层记忆》规范的第二轨：直接调用 Rust 命令读写用户已绑定工程
 * 根目录下的 `.wd_mem/` 文件（`project_memory.md` / `sessions/{id}.summary.md`）。
 * 非 Tauri（浏览器 dev）无文件系统，读取返回 null、写入静默跳过。
 */
import { isTauri } from '@/core/config'
import { invoke } from '@tauri-apps/api/core'

/** 读取工程根目录下 `.wd_mem/project_memory.md`（不存在返回 null）。 */
export async function readProjectMemory(rootPath: string): Promise<string | null> {
  if (!isTauri) return null
  try {
    return (await invoke<string | null>('wd_mem_read_project_memory', { projectRoot: rootPath })) ?? null
  } catch (e) {
    console.warn('[wd-mem] readProjectMemory 失败:', e)
    return null
  }
}

/** 覆盖写入工程根目录下 `.wd_mem/project_memory.md`。 */
export async function writeProjectMemory(rootPath: string, content: string): Promise<void> {
  if (!isTauri) return
  await invoke('wd_mem_write_project_memory', { projectRoot: rootPath, content })
}
