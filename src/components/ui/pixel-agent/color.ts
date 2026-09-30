/**
 * 像素调色工具：从基色派生描边 / 阴影 / 高光，支撑写实三阶明暗。
 * 纯 hex 运算，不依赖 CSS 滤镜，SVG / 快照结果一致。
 */

/** 解析 #RGB / #RRGGBB → [r,g,b] */
function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** 变暗 amount∈(0,1]；往黑色收 */
export function darken(hex: string, amount = 0.22): string {
  const [r, g, b] = parseHex(hex)
  const t = 1 - Math.max(0, Math.min(1, amount))
  return toHex(r * t, g * t, b * t)
}

/** 变亮 amount∈(0,1]；往白色收 */
export function lighten(hex: string, amount = 0.18): string {
  const [r, g, b] = parseHex(hex)
  const t = Math.max(0, Math.min(1, amount))
  return toHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t)
}

/** 混色：a 向 b 靠 ratio */
export function mix(a: string, b: string, ratio = 0.5): string {
  const [r1, g1, b1] = parseHex(a)
  const [r2, g2, b2] = parseHex(b)
  const t = Math.max(0, Math.min(1, ratio))
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
}

export interface ToneSet {
  /** 基色（填充主体） */
  base: string
  /** 阴影（背光 / 褶皱） */
  shade: string
  /** 深阴影（交界、内侧） */
  deep: string
  /** 高光（受光面） */
  light: string
  /** 强高光（发丝光泽、金属点） */
  gloss: string
  /** 外轮廓（描边） */
  outline: string
}

/** 由基色派生完整五阶 + 描边 */
export function tone(hex: string): ToneSet {
  return {
    base: hex,
    shade: darken(hex, 0.22),
    deep: darken(hex, 0.38),
    light: lighten(hex, 0.18),
    gloss: lighten(hex, 0.34),
    outline: darken(hex, 0.62),
  }
}

/** 全局轮廓色（肤色/服装以外的统一描边，偏暖黑） */
export const OUTLINE = '#2A211C'

/** 五官墨色（眉、瞳、线稿） */
export const INK = '#1C1612'
/** 眼白 */
export const EYE_WHITE = '#F7F2EC'
/** 瞳孔 */
export const IRIS_DEFAULT = '#3B2A1E'
/** 唇色 */
export const LIP = '#C47A72'
/** 腮红 */
export const BLUSH = '#E8A090'
/** 舌/口腔 */
export const MOUTH_IN = '#6B3030'
/** 牙 */
export const TEETH = '#F5F0E8'
