/**
 * SVG → Base64 PNG 快照（v2，32×32 网格）。
 *
 * 铁律：
 * - 禁止对屏幕 DOM 做 html2canvas——程序化重绘纯净 SVG 字符串（与 PixelAgent 共用
 *   buildPixelRects，几何单一事实源），内联全部 fill，无外部 CSS / 外链资源；
 * - outSize 必须是 32 的整数倍（默认 128 = 4×），避免缩放糊边；
 * - canvas imageSmoothingEnabled=false 保证像素锐利；快照固定 idle 姿态（展示语义）。
 */
import { buildPixelRects } from './layers'
import { normalizeAppearance } from './parse'
import type { PixelAgentAppearance } from './types'

export interface SnapshotOptions {
  /** 输出边长（32 的整数倍），默认 128 */
  outSize?: number
}

function clampOutSize(v: number | undefined): number {
  const n = Math.max(32, Math.min(256, Math.round(v ?? 128)))
  return Math.round(n / 32) * 32
}

/** 纯净 SVG 字符串（整数 rect 集合，crispEdges，idle 姿态）。 */
export function buildSvgString(appearance: PixelAgentAppearance, outSize: number): string {
  const rects = buildPixelRects(normalizeAppearance(appearance), 'idle')
  const body = rects
    .map((r) => {
      const c = r.cls ? ` class="${r.cls}"` : ''
      return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"${c}/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${outSize}" height="${outSize}" viewBox="0 0 32 32" shape-rendering="crispEdges">${body}</svg>`
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
