/**
 * Pixel Agent 形象设计模块（v3，64×64 写实像素）：
 * 清晰描边 + 三阶明暗 + 外部可控表情/动作 + 任意等比缩放。
 * 列表 / 聊天可继续 `<img src={logo}>`；舞台走 PixelAgent 实时渲染。
 */
export * from './types'
export * from './constants'
export * from './parse'
export {
  BLUSH,
  EYE_WHITE,
  INK,
  IRIS_DEFAULT,
  LIP,
  MOUTH_IN,
  OUTLINE,
  TEETH,
  darken,
  lighten,
  mix,
  tone,
  type ToneSet,
} from './color'
export { PixelCanvas } from './canvas'
export type { PixelRect } from './canvas'
export { buildPixelRects, FEATURE_COLOR, PIXEL_GRID } from './layers'
export { PixelAgent } from './PixelAgent'
export type { PixelAgentProps } from './PixelAgent'
export { buildSvgString, snapshotAppearanceToLogo } from './snapshot'
export type { SnapshotOptions } from './snapshot'
export { AppearancePicker } from './AppearancePicker'
export { AppearanceModal } from './AppearanceModal'
