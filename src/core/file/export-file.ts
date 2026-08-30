/**
 * 导出文件助手：弹出系统「保存文件」对话框让用户选择位置，再写入内容。
 *
 *  - Tauri 桌面端：@tauri-apps/plugin-dialog 的 save() 选路径 +
 *    @tauri-apps/plugin-fs 的 writeTextFile / writeFile 落盘；
 *  - 非 Tauri（浏览器 dev）：用 Blob + <a download> 触发浏览器下载，保证可调试。
 *
 * 返回 true 表示用户完成保存（或浏览器已触发下载）；用户取消对话框返回 false。
 */
import { isTauri } from '@/core/config'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile, writeFile } from '@tauri-apps/plugin-fs'

/** 文件过滤器（与 @tauri-apps/plugin-dialog 的 DialogFilter 一致）。 */
export interface FileFilter {
  name: string
  extensions: string[]
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 保存文本文件（如 models.json / mcpServers.json）。
 * @param defaultName 默认文件名（save 对话框预填）
 * @param content 文本内容
 * @param filters 文件类型过滤器（默认 JSON）
 */
export async function saveTextFile(
  defaultName: string,
  content: string,
  filters: FileFilter[] = [{ name: 'JSON', extensions: ['json'] }],
): Promise<boolean> {
  if (isTauri) {
    const path = await save({ defaultPath: defaultName, filters })
    if (!path) return false
    await writeTextFile(path, content)
    return true
  }
  downloadBlob(defaultName, new Blob([content], { type: 'application/json' }))
  return true
}

/**
 * 保存二进制文件（如技能导出 ZIP）。
 * @param defaultName 默认文件名
 * @param data 二进制内容
 * @param filters 文件类型过滤器（默认 ZIP）
 */
export async function saveBinaryFile(
  defaultName: string,
  data: Uint8Array,
  filters: FileFilter[] = [{ name: 'ZIP', extensions: ['zip'] }],
): Promise<boolean> {
  if (isTauri) {
    const path = await save({ defaultPath: defaultName, filters })
    if (!path) return false
    await writeFile(path, data)
    return true
  }
  downloadBlob(defaultName, new Blob([data as BlobPart], { type: 'application/zip' }))
  return true
}
