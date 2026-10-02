/**
 * 图片预览器（气泡内联图片点击后的全屏 Lightbox）。
 *
 * 底部工具条：下载 / 目录资源 / 旋转 / 放大 / 缩小（附重置、关闭）；
 * 交互：滚轮缩放、拖拽平移、Esc 关闭。图片字节由缩略图通道预载
 * （fs readFile → data URL），这里只做展示与变换，不再读盘。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Download, Expand, FolderOpen, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { useNotify } from '@/components/ui/notify'
import { isTauri } from '@/core/config'
import { saveBinaryFile } from '@/core/file/export-file'

export interface LightboxImage {
  /** 「目录资源」定位用的绝对路径 */
  path: string
  name: string
  dataUrl: string
  bytes: Uint8Array
}

const MIN_SCALE = 0.2
const MAX_SCALE = 8

export function ImageLightbox({ image, onClose }: { image: LightboxImage; onClose: () => void }) {
  const { message } = useNotify()
  const [scale, setScale] = useState(1)
  const [rotate, setRotate] = useState(0)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  // 换图重置视图
  useEffect(() => {
    setScale(1)
    setRotate(0)
    setOffset({ x: 0, y: 0 })
  }, [image.path])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const zoomIn = useCallback(() => setScale((s) => Math.min(MAX_SCALE, +(s * 1.25).toFixed(3))), [])
  const zoomOut = useCallback(() => setScale((s) => Math.max(MIN_SCALE, +(s / 1.25).toFixed(3))), [])

  // 滚轮缩放：手动挂非被动监听才能 preventDefault 阻止页面滚动
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.deltaY < 0) zoomIn()
      else zoomOut()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomIn, zoomOut])

  const onMouseDown = (e: ReactMouseEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
    setDragging(true)
  }
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) })
    }
    const onUp = () => {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  const handleDownload = useCallback(async () => {
    try {
      const ext = (image.name.split('.').pop() ?? 'png').toLowerCase()
      const ok = await saveBinaryFile(image.name, image.bytes, [{ name: '图片', extensions: [ext] }])
      if (ok) message.success('图片已保存')
    } catch (e) {
      message.error(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [image, message])

  const handleReveal = useCallback(async () => {
    if (!isTauri) {
      message.info('浏览器环境无法打开本地目录')
      return
    }
    try {
      await revealItemInDir(image.path)
    } catch {
      // opener 能力不足时退化为打开所在目录
      const slash = Math.max(image.path.lastIndexOf('/'), image.path.lastIndexOf('\\'))
      const dir = slash > 0 ? image.path.slice(0, slash) : image.path
      try {
        await openPath(dir)
      } catch (e2) {
        message.error(`打开目录失败：${e2 instanceof Error ? e2.message : String(e2)}`)
      }
    }
  }, [image.path, message])

  return (
    <div className="agent-chat__lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        ref={stageRef}
        className="agent-chat__lightbox-stage"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={image.dataUrl}
          alt={image.name}
          className={`agent-chat__lightbox-img${dragging ? ' is-dragging' : ''}`}
          draggable={false}
          onMouseDown={onMouseDown}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) rotate(${rotate}deg) scale(${scale})` }}
        />
        <button
          type="button"
          className="agent-chat__lightbox-close"
          title="关闭（Esc）"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="agent-chat__lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <span className="agent-chat__lightbox-title" title={image.path}>
          {image.name}
        </span>
        <span className="agent-chat__lightbox-zoom">{Math.round(scale * 100)}%</span>
        <button type="button" title="下载" onClick={handleDownload}>
          <Download size={16} />
        </button>
        <button type="button" title="目录资源" onClick={handleReveal}>
          <FolderOpen size={16} />
        </button>
        <button type="button" title="旋转" onClick={() => setRotate((r) => (r + 90) % 360)}>
          <RotateCw size={16} />
        </button>
        <button type="button" title="放大" onClick={zoomIn}>
          <ZoomIn size={16} />
        </button>
        <button type="button" title="缩小" onClick={zoomOut}>
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          title="重置视图"
          onClick={() => {
            setScale(1)
            setRotate(0)
            setOffset({ x: 0, y: 0 })
          }}
        >
          <Expand size={16} />
        </button>
      </div>
    </div>
  )
}
