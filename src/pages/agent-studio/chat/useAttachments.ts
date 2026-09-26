/**
 * 附件处理（台账 S1 自 chat.tsx 抽出，§2.2 规划项）。
 *
 * 职责：图片/文本/二进制文件的分类装配（内联 vs 分片落盘）、粘贴捕获、
 * 整窗拖拽吸附状态机（depth 计数防冒泡闪烁 + dragend 兜底复位）。
 * 落盘复用后端 `begin/append/commit/abort_stage_attachment` 分片命令。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/core/config'
import type { PendingAttachment } from './types'
import {
  attId,
  isTextType,
  MAX_FILE,
  MAX_INLINE_IMAGE,
  readFileAsDataURL,
  readFileAsText,
  TEXT_INLINE_LIMIT,
} from './file-helpers'

export interface UseAttachmentsOptions {
  /** 工作空间目录（分片落盘目标，None = 仅内联）。 */
  workspaceDir: string | null
  /** 错误提示（useNotify 的 message）。 */
  notifyError: (msg: string) => void
}

/**
 * 附件状态与事件机。
 *
 * 返回：
 *  - pendingAttachments / setPendingAttachments  待发送附件（发送后由调用方清空）
 *  - windowDrag / dragHandlers                   整窗拖拽吸附遮罩（挂主容器）
 */
export function useAttachments({ workspaceDir, notifyError }: UseAttachmentsOptions) {
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  // 整窗拖拽吸附：dragDepth 计数嵌套 enter/leave，windowDrag 控制全窗遮罩。
  const [windowDrag, setWindowDrag] = useState(false)
  const dragDepth = useRef(0)

  // 兜底：任何拖拽真正结束时（dragend）复位整窗吸附状态。
  // 落在输入框内已在 onDrop 就地复位；此处再防其他边角（如 drop 命中未知落点 / 逻辑遗漏）导致遮罩卡死。
  useEffect(() => {
    const resetWindowDrag = () => {
      dragDepth.current = 0
      setWindowDrag(false)
    }
    window.addEventListener('dragend', resetWindowDrag)
    return () => window.removeEventListener('dragend', resetWindowDrag)
  }, [])

  /** 把文件分片上传到后端 `workspace/.attachments/`，返回落地路径（Tauri 环境）。
   *  非 Tauri（dev/mock）环境无原生落盘能力，回退为 base64 内联（仅小文件）。 */
  const stageFile = useCallback(
    async (file: File): Promise<string> => {
      if (!isTauri) {
        if (file.size > MAX_INLINE_IMAGE) throw new Error('非 Tauri 环境不支持超大文件')
        const dataUrl = await readFileAsDataURL(file)
        const comma = dataUrl.indexOf(',')
        return dataUrl.slice(comma + 1)
      }
      const CHUNK = 4 * 1024 * 1024
      const stageId = await invoke<string>('begin_stage_attachment', {
        name: file.name,
        mime: file.type || 'application/octet-stream',
      })
      try {
        for (let off = 0; off < file.size; off += CHUNK) {
          const slice = file.slice(off, Math.min(off + CHUNK, file.size))
          const buf = await slice.arrayBuffer()
          await invoke('append_stage_chunk', { stageId, data: new Uint8Array(buf) })
        }
        return await invoke<string>('commit_stage_attachment', {
          stageId,
          workspace: workspaceDir ?? null,
        })
      } catch (e) {
        await invoke('abort_stage_attachment', { stageId }).catch(() => {})
        throw e
      }
    },
    [workspaceDir],
  )

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      for (const file of list) {
        const size = file.size
        try {
          // 图片：≤20MB 多模态 dataUrl 内联；超大图片走分片落盘（file 类型，agent 用 native__read_file 看）。
          if (file.type.startsWith('image/') && size <= MAX_INLINE_IMAGE) {
            const dataUrl = await readFileAsDataURL(file)
            setPendingAttachments((prev) => [
              ...prev,
              { id: attId(), type: 'image', dataUrl, name: file.name, size },
            ])
            continue
          }
          if (size > MAX_FILE) {
            notifyError(`「${file.name}」超过 500MB，已忽略`)
            continue
          }
          // 文本（≤200KB）直接内联；其余（二进制 / 超大文本 / 超大图片）分片落盘。
          if (isTextType(file) && size <= TEXT_INLINE_LIMIT && !file.type.startsWith('image/')) {
            const text = await readFileAsText(file)
            setPendingAttachments((prev) => [
              ...prev,
              { id: attId(), type: 'text', content: text, name: file.name, mime: file.type || 'text/plain', size },
            ])
            continue
          }
          const path = await stageFile(file)
          setPendingAttachments((prev) => [
            ...prev,
            {
              id: attId(),
              type: 'file',
              name: file.name,
              mime: file.type || 'application/octet-stream',
              size,
              path,
            },
          ])
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          notifyError(`「${file.name}」处理失败：${msg}`)
        }
      }
    },
    [stageFile, notifyError],
  )

  /** 粘贴捕获：textarea 内 Ctrl+V 任意文件。 */
  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const it of Array.from(items)) {
        // 任意文件（不再仅限图片，也不再要求多模态模型）——文本/文件附件任意模型可用
        const file = it.getAsFile()
        if (file) files.push(file)
      }
      if (files.length) {
        e.preventDefault()
        addFiles(files)
      }
    },
    [addFiles],
  )

  /** 主容器拖拽事件（整窗吸附状态机 + drop 装配）。挂 AgentChatPage 根容器。 */
  const containerDragHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      // 整窗拖拽吸附：用 depth 计数嵌套 enter/leave，避免子元素冒泡导致遮罩闪烁。
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault()
        dragDepth.current += 1
        if (!windowDrag) setWindowDrag(true)
      }
    },
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    },
    onDragLeave: () => {
      // 不依赖 dataTransfer.types（部分浏览器在 dragleave 时清空 types），
      // 只要当前处于整窗拖拽吸附态就计数离开，避免遮罩卡死。
      if (!windowDrag) return
      dragDepth.current -= 1
      if (dragDepth.current <= 0) {
        dragDepth.current = 0
        setWindowDrag(false)
      }
    },
    onDrop: (e: React.DragEvent) => {
      // 仅处理落在输入框之外的拖放；输入框内的 drop 已被其自身 onDrop 阻止冒泡。
      if (!(e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files'))) return
      e.preventDefault()
      dragDepth.current = 0
      setWindowDrag(false)
      const files = Array.from(e.dataTransfer.files ?? [])
      if (files.length) addFiles(files)
    },
  }

  const clearAttachments = useCallback(() => setPendingAttachments([]), [])

  return {
    pendingAttachments,
    setPendingAttachments,
    clearAttachments,
    dragOver,
    setDragOver,
    windowDrag,
    setWindowDrag,
    dragDepth,
    containerDragHandlers,
    addFiles,
    onPaste,
  }
}
