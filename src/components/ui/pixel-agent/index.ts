/**
 * Pixel Agent 形象设计模块（设计稿 v1.2）：
 * 16×16 纯 SVG 像素小人 + PNG 快照 + 设计弹窗。列表 / 聊天零改造（继续 `<img src={logo}>`）。
 */
export * from './types'
export * from './constants'
export * from './parse'
export { buildPixelRects, FEATURE_COLOR } from './layers'
export type { PixelRect } from './layers'
export { PixelAgent } from './PixelAgent'
export { buildSvgString, snapshotAppearanceToLogo } from './snapshot'
export type { SnapshotOptions } from './snapshot'
export { AppearancePicker } from './AppearancePicker'
export { AppearanceModal } from './AppearanceModal'
