/**
 * Pixel Agent 调色板 / 性别服饰池 / 默认形象 / 场景预设（v2，32×32 游戏级）。
 *
 * - 配置只存 palette key，渲染期 resolveColor 解析成 hex（禁止 hex 裸色进库）；
 * - 发型/上衣/下装按性别级联（MALE/FEMALE 池），normalizeAppearance 负责钳制；
 * - SCENARIO_PRESETS 只描述「场景气质」（配色/道具/帽子），性别与发型由 seed 扰动。
 */
import type {
  AccessoryType,
  BottomStyle,
  GenderType,
  HairStyle,
  HatType,
  PixelAgentAppearance,
  PropType,
  ShoesStyle,
  TopStyle,
} from './types'

export const PIXEL_PALETTE = {
  skin: {
    'skin-fair-01': '#FBE8DC',
    'skin-warm-01': '#F6D7B0',
    'skin-warm-02': '#E8B88A',
    'skin-tan-01': '#D9A066',
    'skin-deep-01': '#C68642',
    'skin-deep-02': '#8D5524',
    'skin-cool-01': '#E0C3A0',
  },
  hair: {
    'ink-900': '#1E1B14',
    'ink-700': '#3D2B1F',
    'chestnut': '#8B5A2B',
    'accent-amber': '#C47B2C',
    'accent-indigo': '#3D4F8C',
    'accent-rose': '#A64D63',
    'silver': '#B8BEC4',
    'neutral-400': '#9AA0A6',
  },
  outfit: {
    'accent-indigo': '#3D4F8C',
    'accent-emerald': '#2F6B4F',
    'accent-amber': '#C47B2C',
    'accent-rose': '#A64D63',
    'accent-sky': '#4A90C4',
    'accent-wine': '#7B3B4B',
    'neutral-700': '#3C4043',
    'neutral-500': '#6B7075',
    'neutral-200': '#E8EAED',
    'ink-900': '#1E1B14',
  },
} as const

export type PaletteFamily = keyof typeof PIXEL_PALETTE

/** palette key → hex；未知 key 回落该族第一个色（normalizeAppearance 已保证合法，双保险）。 */
export function resolveColor(family: PaletteFamily, key: string): string {
  const fam = PIXEL_PALETTE[family] as Record<string, string>
  return fam[key] ?? Object.values(fam)[0]
}

/* ---------------- 性别级联服饰池 ---------------- */

export const GENDERS: GenderType[] = ['male', 'female']

export const MALE_HAIR: HairStyle[] = ['m-buzz', 'm-short', 'm-spiky', 'm-undercut', 'm-curly']
export const FEMALE_HAIR: HairStyle[] = ['f-long', 'f-bob', 'f-twin', 'f-ponytail', 'f-bun']

export const MALE_TOPS: TopStyle[] = ['m-tshirt', 'm-hoodie', 'm-shirt', 'm-suit']
export const FEMALE_TOPS: TopStyle[] = ['f-tshirt', 'f-hoodie', 'f-blouse', 'f-dress']

export const MALE_BOTTOMS: BottomStyle[] = ['trousers', 'jeans', 'shorts']
export const FEMALE_BOTTOMS: BottomStyle[] = ['skirt', 'jeans', 'shorts']

export const SHOES_MALE: ShoesStyle[] = ['sneakers', 'boots', 'formal']
export const SHOES_FEMALE: ShoesStyle[] = ['sneakers', 'boots', 'formal', 'heels']

export const HATS: HatType[] = ['none', 'cap', 'beanie', 'beret']
export const ACCESSORIES: AccessoryType[] = [
  'none',
  'glasses-black',
  'glasses-round',
  'earrings',
  'scarf',
  'headset',
  'cigarette',
]
export const PROPS: PropType[] = ['none', 'laptop', 'coffee-cup', 'book']

/** 按性别取发型池 */
export function hairPool(gender: GenderType): HairStyle[] {
  return gender === 'male' ? MALE_HAIR : FEMALE_HAIR
}
/** 按性别取上衣池 */
export function topPool(gender: GenderType): TopStyle[] {
  return gender === 'male' ? MALE_TOPS : FEMALE_TOPS
}
/** 按性别取下装池（上衣为连衣裙时下装强制 none） */
export function bottomPool(gender: GenderType, top?: TopStyle): BottomStyle[] {
  if (top === 'f-dress') return ['none']
  return gender === 'male' ? MALE_BOTTOMS : FEMALE_BOTTOMS
}
/** 按性别取鞋子池 */
export function shoesPool(gender: GenderType): ShoesStyle[] {
  return gender === 'male' ? SHOES_MALE : SHOES_FEMALE
}

/* ---------------- 默认与预设 ---------------- */

export const DEFAULT_APPEARANCE: PixelAgentAppearance = {
  gender: 'male',
  skinColor: 'skin-warm-02',
  hairStyle: 'm-short',
  hairColor: 'ink-900',
  hat: 'none',
  hatColor: 'neutral-700',
  top: 'm-hoodie',
  topColor: 'accent-indigo',
  topAccent: undefined,
  bottom: 'trousers',
  bottomColor: 'neutral-700',
  shoes: 'sneakers',
  shoesColor: 'ink-900',
  accessory: 'none',
  heldProp: 'none',
}

/** 女性默认形象（性别切换时的回落基准） */
export const DEFAULT_FEMALE: PixelAgentAppearance = {
  gender: 'female',
  skinColor: 'skin-warm-01',
  hairStyle: 'f-long',
  hairColor: 'ink-700',
  hat: 'none',
  hatColor: 'neutral-700',
  top: 'f-blouse',
  topColor: 'accent-rose',
  topAccent: undefined,
  bottom: 'skirt',
  bottomColor: 'neutral-700',
  shoes: 'heels',
  shoesColor: 'accent-wine',
  accessory: 'none',
  heldProp: 'none',
}

/**
 * 场景预设：只描述「场景气质」（配色 / 帽子 / 配饰 / 道具 / 上衣倾向），
 * 性别与发型由 generateAvatarByScenario 的 seed 扰动。
 * key 已与 init.sql scenario_category scope='AGENT' 的 7 个 value 对表（2026-09-17）。
 */
export interface ScenarioMood {
  topColor: string
  topAccent?: string
  bottomColor: string
  hat?: HatType
  hatColor?: string
  accessory?: AccessoryType
  heldProp?: PropType
  /** 上衣倾向：命中性别池里最靠前的匹配项 */
  topHint?: TopStyle
}

export const SCENARIO_MOODS: Record<string, ScenarioMood> = {
  'dev-programming': { topColor: 'neutral-700', bottomColor: 'ink-900', heldProp: 'laptop', topHint: 'm-hoodie' },
  'customer-service': { topColor: 'accent-emerald', bottomColor: 'neutral-700', accessory: 'headset', topHint: 'f-blouse' },
  'data-analysis': { topColor: 'neutral-200', topAccent: 'accent-sky', bottomColor: 'neutral-700', heldProp: 'coffee-cup', topHint: 'm-shirt' },
  'content-creation': { topColor: 'accent-rose', bottomColor: 'neutral-500', hat: 'beret', hatColor: 'ink-900', topHint: 'f-blouse' },
  'office-efficiency': { topColor: 'accent-indigo', bottomColor: 'neutral-700', heldProp: 'coffee-cup', topHint: 'm-shirt' },
  education: { topColor: 'accent-amber', bottomColor: 'neutral-500', topHint: 'f-blouse' },
  'life-service': { topColor: 'accent-emerald', bottomColor: 'neutral-500', topHint: 'f-tshirt' },
}

/** 稳定字符串 hash（djb2）——同一 seed 恒定产出同一扰动。 */
function stableHash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h
}

function clampToPool<T>(pool: T[], v: T | undefined, fallback: T): T {
  return v && pool.includes(v) ? v : fallback
}

/**
 * 按场景生成形象：性别/发型/肤色由 seed 扰动（同一 agent 可复现），
 * 配色/帽子/配饰/道具取场景气质；未命中场景回落默认形象。
 */
export function generateAvatarByScenario(scenario?: string, seed?: string): PixelAgentAppearance {
  const mood = (scenario && SCENARIO_MOODS[scenario]) || undefined
  const base = mood ? DEFAULT_APPEARANCE : { ...DEFAULT_APPEARANCE }
  if (!seed) {
    return mood
      ? {
          ...base,
          topColor: mood.topColor,
          topAccent: mood.topAccent,
          bottomColor: mood.bottomColor,
          hat: mood.hat ?? 'none',
          hatColor: mood.hatColor ?? base.hatColor,
          accessory: mood.accessory ?? 'none',
          heldProp: mood.heldProp ?? 'none',
          top: clampToPool(topPool(base.gender), mood.topHint, base.top),
        }
      : base
  }
  const h = stableHash(seed)
  const gender: GenderType = h % 2 === 0 ? 'male' : 'female'
  const hair = hairPool(gender)
  const skinKeys = Object.keys(PIXEL_PALETTE.skin)
  const top = clampToPool(topPool(gender), mood?.topHint, topPool(gender)[h % topPool(gender).length])
  return {
    gender,
    skinColor: skinKeys[Math.floor(h / 11) % skinKeys.length],
    hairStyle: hair[Math.floor(h / 3) % hair.length],
    hairColor: base.hairColor,
    hat: mood?.hat ?? 'none',
    hatColor: mood?.hatColor ?? base.hatColor,
    top,
    topColor: mood?.topColor ?? base.topColor,
    topAccent: mood?.topAccent,
    bottom: top === 'f-dress' ? 'none' : bottomPool(gender, top)[Math.floor(h / 5) % bottomPool(gender, top).length],
    bottomColor: mood?.bottomColor ?? base.bottomColor,
    shoes: shoesPool(gender)[Math.floor(h / 13) % shoesPool(gender).length],
    shoesColor: base.shoesColor,
    accessory: mood?.accessory ?? 'none',
    heldProp: mood?.heldProp ?? 'none',
  }
}

/**
 * S3（小分队设计方案 §4.12.4）：小分队五角色换装预设——
 * 「同一模板形象一致又可改」，role 名与 SquadToolProfile/模板体系的角色键一致。
 * 应用方式：与现有 appearance 做 {...current, ...preset} 浅合并（只覆盖形象意向字段，
 * 保留用户已调的性别/肤色/发型等个体特征）。
 */
export const SQUAD_APPEARANCE_PRESETS: Record<string, Partial<PixelAgentAppearance>> = {
  RESEARCHER: {
    accessory: 'glasses-black',
    heldProp: 'book',
    topColor: 'accent-sky',
    top: 'm-shirt',
  },
  WORKER: {
    heldProp: 'laptop',
    topColor: 'neutral-700',
    top: 'm-hoodie',
  },
  CRITIC: {
    hat: 'beret',
    hatColor: 'ink-900',
    accessory: 'glasses-round',
    heldProp: 'coffee-cup',
    topColor: 'accent-rose',
  },
  INTEGRATOR: {
    accessory: 'headset',
    topColor: 'accent-indigo',
    top: 'm-shirt',
  },
  MODERATOR: {
    topColor: 'neutral-200',
    topAccent: 'accent-amber',
    top: 'f-blouse',
  },
}

/** 应用角色预设：浅合并覆盖形象意向字段，返回新 appearance（不改传入值）。 */
export function applySquadAppearancePreset(
  current: PixelAgentAppearance,
  role: string,
): PixelAgentAppearance {
  const preset = SQUAD_APPEARANCE_PRESETS[role?.toUpperCase()]
  return preset ? { ...current, ...preset } : current
}
