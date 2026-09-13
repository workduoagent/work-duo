import { isTauri } from '@/core/config'
import { appDataDir, resourceDir } from '@tauri-apps/api/path'

/**
 * 解析存储路径中的 $APPDATA / $RESOURCE 占位为真实绝对目录。
 * 与 skillFs / kbFs 中 resolveReal*BasePath 同语义，集中在此供设置页复用。
 */
export async function resolveStorageBasePath(rawBase: string): Promise<string> {
  if (!isTauri) return rawBase
  let base = rawBase.trim()
  if (base.includes('$APPDATA')) {
    base = base.replace('$APPDATA', await appDataDir())
  } else if (base.includes('$RESOURCE')) {
    base = base.replace('$RESOURCE', await resourceDir())
  }
  return base
}
