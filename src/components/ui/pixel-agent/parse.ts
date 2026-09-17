/**
 * 脏 appearance 归一化 / 旧版迁移（v2，32×32）。
 *
 * - 任何来源（DB JSON / 弹窗 state）先过这里，保证 layers 只收到合法枚举与
 *   合法 palette key——**永不 throw**；
 * - 旧版（16×16 时代）字段迁移：outfitType→top、hairType→hairStyle、
 *   eyesType/mouthType 丢弃（表情改由状态驱动）、coffee_cup→coffee-cup 等；
 * - 性别切换 / 非法组合按池钳制（连衣裙时下装强制 none）。
 */
import {
  ACCESSORIES,
  DEFAULT_APPEARANCE,
  DEFAULT_FEMALE,
  GENDERS,
  HATS,
  PIXEL_PALETTE,
  PROPS,
  bottomPool,
  hairPool,
  shoesPool,
  topPool,
} from './constants'
import type { PixelAgentAppearance } from './types'

function pickColor(family: keyof typeof PIXEL_PALETTE, v: unknown, fallback: string): string {
  return typeof v === 'string' && v in PIXEL_PALETTE[family] ? v : fallback
}

function pickFrom<T extends string>(pool: T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (pool as string[]).includes(v) ? (v as T) : fallback
}

/** 旧版（16×16）→ 新版字段的迁移映射 */
function migrateLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  const m = { ...raw }
  // hairType → hairStyle（旧枚举按性别就近映射）
  if (typeof m.hairType === 'string' && !m.hairStyle) {
    const t = m.hairType as string
    m.hairStyle =
      t === 'spiky' ? 'm-spiky' : t === 'buzz' ? 'm-buzz' : t === 'bald' ? 'm-buzz' : 'm-short'
  }
  // outfitType → top（lab_coat 就近映射衬衫；tshirt/hoodie 双性别池同名）
  if (typeof m.outfitType === 'string' && !m.top) {
    const t = m.outfitType as string
    m.top = t === 'lab_coat' ? 'm-shirt' : t
  }
  // 道具键下划线 → 连字符
  if (m.heldProp === 'coffee_cup') m.heldProp = 'coffee-cup'
  // 配饰：glasses_black → glasses-black；headset 保留
  if (m.accessory === 'glasses_black') m.accessory = 'glasses-black'
  // 旧 outfitSubColor → topAccent
  if (m.outfitSubColor && !m.topAccent) m.topAccent = m.outfitSubColor
  return m
}

export function normalizeAppearance(raw: unknown): PixelAgentAppearance {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const r = 'hairType' in src || 'outfitType' in src ? migrateLegacy(src) : src

  const gender = pickFrom(GENDERS, r.gender, DEFAULT_APPEARANCE.gender)
  const hairFallback = gender === 'male' ? DEFAULT_APPEARANCE.hairStyle : DEFAULT_FEMALE.hairStyle
  const topFallback = gender === 'male' ? DEFAULT_APPEARANCE.top : DEFAULT_FEMALE.top
  const bottomFallback = gender === 'male' ? DEFAULT_APPEARANCE.bottom : DEFAULT_FEMALE.bottom
  const shoesFallback = gender === 'male' ? DEFAULT_APPEARANCE.shoes : DEFAULT_FEMALE.shoes

  const hairStyle = pickFrom(hairPool(gender), r.hairStyle, hairFallback)
  const top = pickFrom(topPool(gender), r.top, topFallback)
  // 连衣裙接管下装：其余按下装池钳制
  const bottom =
    top === 'f-dress' ? 'none' : pickFrom(bottomPool(gender, top), r.bottom, bottomFallback)
  const shoes = pickFrom(shoesPool(gender), r.shoes, shoesFallback)

  const cfg: PixelAgentAppearance = {
    gender,
    skinColor: pickColor('skin', r.skinColor, DEFAULT_APPEARANCE.skinColor),
    hairStyle,
    hairColor: pickColor('hair', r.hairColor, DEFAULT_APPEARANCE.hairColor),
    hat: pickFrom(HATS, r.hat, 'none'),
    hatColor: pickColor('outfit', r.hatColor, DEFAULT_APPEARANCE.hatColor),
    top,
    topColor: pickColor('outfit', r.topColor, DEFAULT_APPEARANCE.topColor),
    topAccent:
      typeof r.topAccent === 'string' && r.topAccent in PIXEL_PALETTE.outfit
        ? r.topAccent
        : undefined,
    bottom,
    bottomColor: pickColor('outfit', r.bottomColor, DEFAULT_APPEARANCE.bottomColor),
    shoes,
    shoesColor: pickColor('outfit', r.shoesColor, DEFAULT_APPEARANCE.shoesColor),
    accessory: pickFrom(ACCESSORIES, r.accessory, 'none'),
    heldProp: pickFrom(PROPS, r.heldProp, 'none'),
  }
  return cfg
}
