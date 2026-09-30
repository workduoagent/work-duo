/**
 * SVG → Base64 PNG 快照（v3，64×64 网格）。
 *
 * 铁律：
 * - 禁止对屏幕 DOM 做 html2canvas——程序化重绘纯净 SVG 字符串（与 PixelAgent 共用
 *   buildPixelRects，几何单一事实源），内联全部 fill，无外部 CSS / 外链资源；
 * - outSize 建议 ≥64，任意正数可缩放（内部按整数网格绘制后拉伸）；
 * - canvas imageSmoothingEnabled=false 保证像素锐利；快照固定 idle 姿态 + neutral 表情。
 */
import { buildPixelRects, PIXEL_GRID } from './layers'
import { normalizeAppearance } from './parse'
import type { PixelAgentAppearance } from './types'

export interface SnapshotOptions {
  /** 输出边长（px），默认 128 */
  outSize?: number
}

function clampOutSize(v: number | undefined): number {
  const n = Math.max(PIXEL_GRID, Math.min(512, Math.round(v ?? 128)))
  return n
}

/** 纯净 SVG 字符串（整数 rect 集合，crispEdges，idle 姿态）。 */
export function buildSvgString(appearance: PixelAgentAppearance, outSize: number): string {
  const rects = buildPixelRects(normalizeAppearance(appearance), { state: 'idle' })
  const body = rects
    .filter((r) => !r.cls) // 快照不要动画帧
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${outSize}" height="${outSize}" viewBox="0 0 ${PIXEL_GRID} ${PIXEL_GRID}" shape-rendering="crispEdges">${body}</svg>`
}

/**
 * 将形象渲染为透明底 PNG data URL（`data:image/png;base64,...`），
 * 失败时 throw（调用方 message.error 并保持弹窗打开，不 patch 草稿）。
 */
export async function snapshotAppearanceToLogo(
  appearance: PixelAgentAppearance,
  { outSize: rawSize }: SnapshotOptions = {},
): Promise<string> {
  const outSize = clampOutSize(rawSize)
  const svg = buildSvgString(appearance, outSize)
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('snapshot svg load failed'))
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = outSize
  canvas.height = outSize
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, outSize, outSize)
  ctx.drawImage(img, 0, 0, outSize, outSize)
  return canvas.toDataURL('image/png')
}
