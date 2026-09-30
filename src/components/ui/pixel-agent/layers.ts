/**
 * 像素图层构建 v3（64×64 写实像素）——**唯一几何事实源**。
 *
 * - 整数网格（禁 0.5）；React 渲染与 SVG 快照共用本函数；
 * - 三阶明暗 + 外描边：轮廓清晰，接近会议室场景图的精确度；
 * - 表情（FaceExpression）与动作（BodyPose）解耦，可由外部独立动态控制；
 * - 动画仍用「帧矩形 + opacity」（pa-fa/pa-fb 等），静帧时过滤 B 帧；
 * - 图层顺序：腿/鞋 → 躯干/四肢 → 头/颈 → 发 → 表情 → 帽 → 配饰 → 道具/姿态手。
 */
import {
  BLUSH,
  EYE_WHITE,
  INK,
  IRIS_DEFAULT,
  LIP,
  MOUTH_IN,
  OUTLINE,
  TEETH,
  lighten,
  mix,
  tone,
  type ToneSet,
} from './color'
import { PixelCanvas, type PixelRect } from './canvas'
import { resolveColor } from './constants'
import {
  resolveExpressionPose,
  type AgentMotionState,
  type BodyPose,
  type FaceExpression,
  type PixelAgentAppearance,
  type PixelRenderOptions,
} from './types'

export type { PixelRect } from './canvas'
/** 兼容旧导入：五官固定墨色 */
export const FEATURE_COLOR = INK

/** 64×64 网格边长 */
export const PIXEL_GRID = 64

interface Palette {
  skin: ToneSet
  hair: ToneSet
  top: ToneSet
  accent: ToneSet | null
  bottom: ToneSet
  shoes: ToneSet
  hat: ToneSet
}

function buildPalette(a: PixelAgentAppearance): Palette {
  return {
    skin: tone(resolveColor('skin', a.skinColor)),
    hair: tone(resolveColor('hair', a.hairColor)),
    top: tone(resolveColor('outfit', a.topColor)),
    accent: a.topAccent ? tone(resolveColor('outfit', a.topAccent)) : null,
    bottom: tone(resolveColor('outfit', a.bottomColor)),
    shoes: tone(resolveColor('outfit', a.shoesColor)),
    hat: tone(resolveColor('outfit', a.hatColor)),
  }
}

type Ctx = {
  c: PixelCanvas
  a: PixelAgentAppearance
  p: Palette
  expression: FaceExpression
  pose: BodyPose
  /** 动画帧矩形（附加在画布之后） */
  anim: PixelRect[]
}

function pushAnim(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  cls: string,
): void {
  ctx.anim.push({ x, y, w, h, fill, cls })
}

/* ============================================================
 * 1) 腿 + 鞋
 * ============================================================ */
function drawLegs(ctx: Ctx): void {
  const { c, a, p } = ctx
  const isDress = a.top === 'f-dress'
  const legY = 48
  const legH = isDress ? 11 : 12

  // 大腿/小腿（先肤色，再盖裤）
  c.rect(24, legY, 7, legH, p.skin.base)
  c.rect(33, legY, 7, legH, p.skin.base)
  // 腿内侧阴影
  c.rect(29, legY + 2, 1, legH - 2, p.skin.shade)
  c.rect(34, legY + 2, 1, legH - 2, p.skin.shade)
  // 腿左缘高光
  c.rect(24, legY + 1, 1, legH - 3, p.skin.light)
  c.rect(33, legY + 1, 1, legH - 3, p.skin.light)

  if (isDress) {
    // 裙摆已盖大腿，只留小腿
    c.rect(25, legY + 3, 5, legH - 3, p.skin.base)
    c.rect(34, legY + 3, 5, legH - 3, p.skin.base)
    c.rect(29, legY + 5, 1, legH - 5, p.skin.shade)
    c.rect(34, legY + 5, 1, legH - 5, p.skin.shade)
  } else if (a.bottom === 'shorts') {
    c.rect(23, legY, 9, 6, p.bottom.base)
    c.rect(32, legY, 9, 6, p.bottom.base)
    c.rect(23, legY, 1, 6, p.bottom.light)
    c.rect(32, legY, 1, 6, p.bottom.light)
    c.rect(30, legY, 1, 6, p.bottom.shade)
    c.rect(40, legY, 1, 6, p.bottom.shade)
    c.rect(23, legY + 5, 9, 1, p.bottom.deep)
    c.rect(32, legY + 5, 9, 1, p.bottom.deep)
  } else if (a.bottom === 'skirt') {
    c.rect(21, legY - 2, 22, 8, p.bottom.base)
    c.rect(21, legY - 2, 1, 8, p.bottom.light)
    c.rect(42, legY - 2, 1, 8, p.bottom.shade)
    // 裙褶
    c.rect(27, legY - 1, 1, 6, p.bottom.shade)
    c.rect(33, legY - 1, 1, 6, p.bottom.shade)
    c.rect(38, legY - 1, 1, 6, p.bottom.shade)
    c.rect(21, legY + 5, 22, 1, p.bottom.deep)
    c.rect(25, legY + 3, 5, 3, p.skin.base)
    c.rect(34, legY + 3, 5, 3, p.skin.base)
    c.rect(29, legY + 4, 1, 2, p.skin.shade)
    c.rect(34, legY + 4, 1, 2, p.skin.shade)
  } else {
    // trousers / jeans
    c.rect(23, legY, 9, legH, p.bottom.base)
    c.rect(32, legY, 9, legH, p.bottom.base)
    c.rect(23, legY, 1, legH, p.bottom.light)
    c.rect(32, legY, 1, legH, p.bottom.light)
    c.rect(30, legY, 1, legH, p.bottom.shade)
    c.rect(40, legY, 1, legH, p.bottom.shade)
    // 膝盖褶
    c.rect(24, legY + 5, 7, 1, p.bottom.shade)
    c.rect(33, legY + 5, 7, 1, p.bottom.shade)
    if (a.bottom === 'jeans') {
      // 口袋线
      c.rect(24, legY, 2, 3, p.bottom.shade)
      c.rect(38, legY, 2, 3, p.bottom.shade)
    }
  }

  // 鞋
  const sy = 59
  switch (a.shoes) {
    case 'boots':
      c.rect(22, sy - 2, 10, 6, p.shoes.base)
      c.rect(32, sy - 2, 10, 6, p.shoes.base)
      c.rect(22, sy - 2, 1, 6, p.shoes.light)
      c.rect(32, sy - 2, 1, 6, p.shoes.light)
      c.rect(31, sy - 2, 1, 6, p.shoes.shade)
      c.rect(41, sy - 2, 1, 6, p.shoes.shade)
      c.rect(22, sy + 3, 10, 1, p.shoes.deep)
      c.rect(32, sy + 3, 10, 1, p.shoes.deep)
      break
    case 'heels':
      c.rect(23, sy, 9, 2, p.shoes.base)
      c.rect(32, sy, 9, 2, p.shoes.base)
      c.rect(26, sy + 2, 2, 2, p.shoes.base)
      c.rect(37, sy + 2, 2, 2, p.shoes.base)
      c.rect(23, sy, 1, 2, p.shoes.light)
      c.rect(32, sy, 1, 2, p.shoes.light)
      c.rect(23, sy + 1, 9, 1, p.shoes.shade)
      c.rect(32, sy + 1, 9, 1, p.shoes.shade)
      break
    case 'formal':
      c.rect(22, sy, 10, 4, p.shoes.base)
      c.rect(32, sy, 10, 4, p.shoes.base)
      c.rect(22, sy, 10, 1, p.shoes.light)
      c.rect(32, sy, 10, 1, p.shoes.light)
      c.rect(22, sy + 3, 10, 1, p.shoes.deep)
      c.rect(32, sy + 3, 10, 1, p.shoes.deep)
      // 鞋带
      c.rect(25, sy + 1, 4, 1, p.shoes.shade)
      c.rect(35, sy + 1, 4, 1, p.shoes.shade)
      break
    default:
      // sneakers
      c.rect(22, sy, 10, 4, p.shoes.base)
      c.rect(32, sy, 10, 4, p.shoes.base)
      c.rect(22, sy, 1, 3, p.shoes.light)
      c.rect(32, sy, 1, 3, p.shoes.light)
      c.rect(22, sy + 3, 10, 1, '#F2F0EA')
      c.rect(32, sy + 3, 10, 1, '#F2F0EA')
      // 鞋带
      c.rect(25, sy + 1, 5, 1, p.shoes.shade)
      c.rect(35, sy + 1, 5, 1, p.shoes.shade)
      c.rect(26, sy + 2, 3, 1, p.shoes.shade)
      c.rect(36, sy + 2, 3, 1, p.shoes.shade)
      break
  }
}

/* ============================================================
 * 2) 躯干 + 四肢（衣）
 * ============================================================ */
function drawArms(ctx: Ctx, sleeveColor: ToneSet, sleeveLen: number): void {
  const { c, p } = ctx
  // 左臂（画面左）
  c.rect(16, 31, 6, sleeveLen, sleeveColor.base)
  c.rect(16, 31, 1, sleeveLen, sleeveColor.light)
  c.rect(21, 31, 1, sleeveLen, sleeveColor.shade)
  // 右臂
  c.rect(42, 31, 6, sleeveLen, sleeveColor.base)
  c.rect(42, 31, 1, sleeveLen, sleeveColor.light)
  c.rect(47, 31, 1, sleeveLen, sleeveColor.shade)

  if (sleeveLen < 16) {
    // 短袖：露小臂
    c.rect(17, 31 + sleeveLen, 4, 16 - sleeveLen, p.skin.base)
    c.rect(43, 31 + sleeveLen, 4, 16 - sleeveLen, p.skin.base)
    c.rect(17, 31 + sleeveLen, 1, 16 - sleeveLen, p.skin.light)
    c.rect(43, 31 + sleeveLen, 1, 16 - sleeveLen, p.skin.light)
    c.rect(20, 31 + sleeveLen, 1, 16 - sleeveLen, p.skin.shade)
    c.rect(46, 31 + sleeveLen, 1, 16 - sleeveLen, p.skin.shade)
  }
}

function drawTorso(ctx: Ctx): void {
  const { c, a, p } = ctx
  const isDress = a.top === 'f-dress'

  // 先铺上衣主体（含肩）
  c.rect(19, 30, 26, 16, p.top.base)
  // 肩高光 / 侧影
  c.rect(19, 30, 26, 2, p.top.light)
  c.rect(19, 30, 2, 16, p.top.light)
  c.rect(43, 30, 2, 16, p.top.shade)
  c.rect(19, 44, 26, 2, p.top.shade)

  const sleeveLen = a.top === 'm-tshirt' || a.top === 'f-tshirt' || a.top === 'f-blouse' || isDress ? 5 : 16
  drawArms(ctx, p.top, sleeveLen)

  switch (a.top) {
    case 'm-tshirt':
    case 'f-tshirt': {
      // 圆领
      c.rect(27, 30, 10, 2, p.skin.base)
      c.rect(27, 31, 10, 1, p.skin.shade)
      c.rect(26, 30, 1, 2, p.top.shade)
      c.rect(37, 30, 1, 2, p.top.shade)
      // 袖口
      c.rect(16, 35, 6, 1, p.top.deep)
      c.rect(42, 35, 6, 1, p.top.deep)
      break
    }
    case 'm-hoodie':
    case 'f-hoodie': {
      // 帽沿堆在肩上
      c.rect(22, 28, 20, 3, p.top.base)
      c.rect(22, 28, 20, 1, p.top.light)
      c.rect(22, 30, 20, 1, p.top.shade)
      // 口袋
      c.rect(24, 38, 16, 5, p.accent ? p.accent.base : p.top.shade)
      c.rect(24, 38, 16, 1, p.accent ? p.accent.light : p.top.deep)
      c.rect(24, 42, 16, 1, p.accent ? p.accent.deep : p.top.deep)
      // 抽绳
      c.rect(29, 33, 1, 5, '#F2F0EA')
      c.rect(34, 33, 1, 5, '#F2F0EA')
      c.rect(29, 37, 1, 1, p.top.shade)
      c.rect(34, 37, 1, 1, p.top.shade)
      // 帽绳口
      c.rect(28, 32, 2, 2, p.top.deep)
      c.rect(34, 32, 2, 2, p.top.deep)
      break
    }
    case 'm-shirt': {
      // 门襟 + 纽扣
      c.rect(31, 32, 2, 13, '#F4F1EA')
      c.rect(31, 32, 1, 13, '#FFFFFF')
      c.rect(32, 32, 1, 13, '#E4DFD4')
      for (let i = 0; i < 4; i += 1) {
        c.rect(31, 34 + i * 3, 2, 1, p.top.deep)
      }
      // 衣领
      c.rect(26, 30, 5, 3, '#F4F1EA')
      c.rect(33, 30, 5, 3, '#F4F1EA')
      c.rect(26, 32, 5, 1, '#E4DFD4')
      c.rect(33, 32, 5, 1, '#E4DFD4')
      // 袖口
      c.rect(16, 44, 6, 2, '#F4F1EA')
      c.rect(42, 44, 6, 2, '#F4F1EA')
      break
    }
    case 'm-suit': {
      // 衬衫 V 区
      c.rect(28, 30, 8, 14, '#F4F1EA')
      c.rect(28, 30, 2, 14, '#E8E2D6')
      // 领带
      const tie = p.accent ?? tone('#8B2E3B')
      c.rect(31, 32, 2, 11, tie.base)
      c.rect(31, 32, 1, 11, tie.light)
      c.rect(32, 32, 1, 11, tie.shade)
      c.rect(30, 31, 4, 2, tie.base) // 结
      // 翻领
      c.rect(26, 30, 3, 10, p.top.shade)
      c.rect(35, 30, 3, 10, p.top.shade)
      c.rect(26, 30, 3, 1, p.top.light)
      c.rect(35, 30, 3, 1, p.top.light)
      // 袖口
      c.rect(16, 44, 6, 1, '#F4F1EA')
      c.rect(42, 44, 6, 1, '#F4F1EA')
      break
    }
    case 'f-blouse': {
      // 小翻领
      c.rect(26, 30, 6, 3, '#F8F4EC')
      c.rect(32, 30, 6, 3, '#F8F4EC')
      c.rect(26, 32, 6, 1, '#E8E0D4')
      c.rect(32, 32, 6, 1, '#E8E0D4')
      // 蝴蝶结
      const bow = p.accent ?? tone('#C45C6A')
      c.rect(29, 33, 6, 2, bow.base)
      c.rect(28, 33, 2, 3, bow.base)
      c.rect(34, 33, 2, 3, bow.base)
      c.rect(31, 33, 2, 2, bow.light)
      c.rect(28, 35, 2, 1, bow.shade)
      c.rect(34, 35, 2, 1, bow.shade)
      // 门襟扣
      for (let i = 0; i < 3; i += 1) c.rect(31, 36 + i * 3, 2, 1, p.top.shade)
      break
    }
    case 'f-dress': {
      // 腰线
      const beltRaw = p.accent ?? p.top.deep
      const belt = typeof beltRaw === 'string' ? {base: beltRaw, light: beltRaw, shade: beltRaw} : beltRaw
      c.rect(21, 42, 22, 2, belt.base)
      c.rect(21, 42, 22, 1, belt.light)
      // 裙摆（覆盖到大腿）
      c.rect(18, 44, 28, 10, p.top.base)
      c.rect(18, 44, 2, 10, p.top.light)
      c.rect(44, 44, 2, 10, p.top.shade)
      c.rect(26, 46, 1, 7, p.top.shade)
      c.rect(32, 46, 1, 7, p.top.shade)
      c.rect(38, 46, 1, 7, p.top.shade)
      c.rect(18, 53, 28, 1, p.top.deep)
      // 领口
      c.rect(27, 30, 10, 2, p.skin.base)
      c.rect(27, 31, 10, 1, p.skin.shade)
      break
    }
  }

  // 手臂与躯干接缝阴影
  c.rect(21, 31, 1, 12, p.top.shade)
  c.rect(42, 31, 1, 12, p.top.shade)
}

/* ============================================================
 * 3) 头 + 颈
 * ============================================================ */
function drawHead(ctx: Ctx): void {
  const { c, p } = ctx
  // 颈
  c.rect(28, 25, 8, 6, p.skin.base)
  c.rect(28, 25, 2, 6, p.skin.light)
  c.rect(34, 25, 2, 6, p.skin.shade)
  // 颈窝阴影
  c.rect(29, 25, 6, 1, p.skin.deep)

  // 头：椭圆 + 下颌
  c.ellipse(32, 15, 11, 12, p.skin.base)
  // 下巴收尖
  c.rect(26, 24, 12, 3, p.skin.base)
  c.rect(28, 26, 8, 1, p.skin.base)

  // 受光（左上）
  c.rect(22, 6, 4, 10, p.skin.light)
  c.rect(24, 5, 6, 3, p.skin.light)
  c.rect(23, 8, 3, 3, p.skin.gloss)
  // 背光（右侧 / 颧下）
  c.rect(40, 8, 3, 12, p.skin.shade)
  c.rect(38, 18, 5, 5, p.skin.shade)
  c.rect(28, 22, 10, 3, p.skin.shade)
  // 颧骨
  c.rect(24, 17, 3, 2, p.skin.light)
  c.rect(37, 17, 3, 2, p.skin.shade)

  // 耳
  c.rect(20, 13, 3, 6, p.skin.base)
  c.rect(41, 13, 3, 6, p.skin.base)
  c.rect(21, 14, 1, 4, p.skin.shade)
  c.rect(42, 14, 1, 4, p.skin.shade)
  c.rect(20, 13, 1, 2, p.skin.light)
  c.rect(41, 13, 1, 2, p.skin.light)
  // 耳内
  c.rect(21, 15, 1, 2, p.skin.deep)
  c.rect(42, 15, 1, 2, p.skin.deep)
}

/* ============================================================
 * 4) 发
 * ============================================================ */
function drawHair(ctx: Ctx): void {
  const { c, a, p } = ctx
  const H = p.hair

  /** 发顶盖 + 侧发通用底 */
  const cap = () => {
    c.rect(21, 3, 22, 6, H.base)
    c.rect(20, 6, 24, 4, H.base)
    c.rect(20, 9, 24, 2, H.base)
    // 顶光
    c.rect(22, 3, 12, 2, H.light)
    c.rect(24, 4, 6, 1, H.gloss)
    // 右侧暗部
    c.rect(40, 5, 4, 8, H.shade)
  }

  switch (a.hairStyle) {
    case 'm-buzz': {
      c.rect(22, 4, 20, 4, H.base)
      c.rect(21, 7, 22, 3, H.base)
      c.rect(23, 3, 14, 2, H.light)
      c.rect(38, 5, 5, 5, H.shade)
      // 鬓角
      c.rect(21, 10, 2, 3, H.shade)
      c.rect(41, 10, 2, 3, H.shade)
      break
    }
    case 'm-short': {
      cap()
      c.rect(21, 10, 3, 4, H.base) // 左鬓
      c.rect(40, 10, 3, 4, H.base)
      c.rect(21, 13, 2, 2, H.shade)
      c.rect(41, 13, 2, 2, H.shade)
      // 刘海分缝
      c.rect(30, 8, 2, 3, H.shade)
      break
    }
    case 'm-spiky': {
      cap()
      // 刺
      c.rect(23, 1, 3, 3, H.base)
      c.rect(28, 0, 3, 4, H.base)
      c.rect(33, 1, 3, 3, H.base)
      c.rect(37, 0, 3, 3, H.base)
      c.rect(23, 1, 1, 2, H.gloss)
      c.rect(28, 0, 1, 3, H.gloss)
      c.rect(22, 10, 2, 3, H.base)
      c.rect(40, 10, 2, 3, H.base)
      break
    }
    case 'm-undercut': {
      // 顶部厚、两侧短
      c.rect(21, 2, 22, 8, H.base)
      c.rect(20, 5, 24, 5, H.base)
      c.rect(23, 1, 14, 3, H.base)
      c.rect(24, 2, 8, 2, H.gloss)
      c.rect(21, 9, 3, 3, H.shade)
      c.rect(40, 9, 3, 3, H.shade)
      // 梳向一侧的分缝
      c.rect(28, 4, 12, 1, H.shade)
      break
    }
    case 'm-curly': {
      c.rect(21, 3, 22, 7, H.base)
      // 卷团
      c.rect(19, 5, 4, 4, H.base)
      c.rect(41, 5, 4, 4, H.base)
      c.rect(23, 2, 5, 4, H.base)
      c.rect(29, 1, 6, 4, H.base)
      c.rect(36, 2, 5, 4, H.base)
      c.rect(23, 2, 2, 2, H.gloss)
      c.rect(30, 1, 2, 2, H.gloss)
      c.rect(41, 5, 2, 2, H.shade)
      c.rect(21, 9, 3, 3, H.base)
      c.rect(40, 9, 3, 3, H.base)
      break
    }
    case 'f-long': {
      cap()
      // 两侧长发
      c.rect(18, 8, 4, 20, H.base)
      c.rect(42, 8, 4, 20, H.base)
      c.rect(18, 8, 1, 18, H.light)
      c.rect(45, 8, 1, 18, H.shade)
      // 发尾
      c.rect(18, 26, 4, 3, H.shade)
      c.rect(42, 26, 4, 3, H.shade)
      // 刘海
      c.rect(23, 8, 18, 3, H.base)
      c.rect(23, 10, 6, 2, H.base)
      c.rect(35, 10, 6, 2, H.base)
      c.rect(28, 8, 8, 1, H.shade)
      // 光泽
      c.rect(20, 10, 2, 12, H.gloss)
      c.rect(43, 12, 2, 10, H.shade)
      break
    }
    case 'f-bob': {
      cap()
      c.rect(18, 9, 4, 14, H.base)
      c.rect(42, 9, 4, 14, H.base)
      c.rect(18, 9, 1, 12, H.light)
      c.rect(45, 9, 1, 12, H.shade)
      c.rect(18, 21, 28, 3, H.base) // 发尾齐颚
      c.rect(18, 23, 28, 1, H.shade)
      c.rect(23, 8, 18, 3, H.base)
      c.rect(23, 10, 5, 2, H.base)
      c.rect(36, 10, 5, 2, H.base)
      c.rect(21, 11, 2, 8, H.gloss)
      break
    }
    case 'f-twin': {
      cap()
      // 双马尾
      c.rect(14, 10, 5, 16, H.base)
      c.rect(45, 10, 5, 16, H.base)
      c.rect(14, 10, 1, 14, H.light)
      c.rect(49, 10, 1, 14, H.shade)
      // 发圈
      c.rect(15, 12, 3, 2, p.accent ? p.accent.base : H.deep)
      c.rect(46, 12, 3, 2, p.accent ? p.accent.base : H.deep)
      // 尾端
      c.rect(14, 24, 5, 3, H.shade)
      c.rect(45, 24, 5, 3, H.shade)
      // 刘海
      c.rect(23, 8, 18, 3, H.base)
      c.rect(24, 10, 6, 2, H.base)
      c.rect(34, 10, 6, 2, H.base)
      c.rect(22, 4, 6, 2, H.gloss)
      break
    }
    case 'f-ponytail': {
      cap()
      // 马尾（右侧后）
      c.rect(43, 8, 5, 18, H.base)
      c.rect(43, 8, 1, 16, H.light)
      c.rect(47, 8, 1, 18, H.shade)
      c.rect(43, 24, 5, 3, H.shade)
      // 发圈
      c.rect(43, 10, 4, 2, H.deep)
      // 刘海
      c.rect(23, 8, 18, 3, H.base)
      c.rect(23, 10, 7, 2, H.base)
      c.rect(35, 10, 6, 2, H.base)
      c.rect(24, 3, 10, 2, H.gloss)
      c.rect(21, 10, 2, 3, H.base)
      break
    }
    case 'f-bun': {
      cap()
      // 丸子
      c.circle(32, 2, 4, H.base)
      c.circle(31, 1, 2, H.gloss)
      c.rect(28, 5, 8, 2, H.shade)
      // 刘海
      c.rect(23, 8, 18, 3, H.base)
      c.rect(23, 10, 6, 2, H.base)
      c.rect(35, 10, 6, 2, H.base)
      c.rect(21, 9, 2, 4, H.base)
      c.rect(41, 9, 2, 4, H.base)
      break
    }
  }
}

/* ============================================================
 * 5) 表情
 * ============================================================ */
function drawEyesBase(ctx: Ctx, openY = 14, openH = 4): void {
  const { c } = ctx
  // 眼眶外缘阴影
  c.rect(23, openY - 1, 7, openH + 2, mix(EYE_WHITE, '#000000', 0.12))
  c.rect(34, openY - 1, 7, openH + 2, mix(EYE_WHITE, '#000000', 0.12))
  // 眼白
  c.rect(24, openY, 5, openH, EYE_WHITE)
  c.rect(35, openY, 5, openH, EYE_WHITE)
}

function drawIris(ctx: Ctx, cx: number, cy: number, iris = IRIS_DEFAULT): void {
  const { c } = ctx
  c.rect(cx - 1, cy - 1, 3, 3, iris)
  c.rect(cx - 1, cy - 1, 3, 1, mix(iris, '#FFFFFF', 0.15))
  c.rect(cx, cy, 1, 1, INK) // 瞳
  c.rect(cx - 1, cy - 1, 1, 1, '#FFFFFF') // 高光
}

function drawBrow(ctx: Ctx, y: number, left = true, angry = false, sad = false): void {
  const { c, p } = ctx
  const col = p.hair.deep
  if (left) {
    if (angry) {
      c.rect(23, y + 1, 2, 1, col)
      c.rect(25, y, 3, 1, col)
      c.rect(28, y - 1, 1, 1, col)
    } else if (sad) {
      c.rect(23, y - 1, 2, 1, col)
      c.rect(25, y, 3, 1, col)
      c.rect(28, y + 1, 1, 1, col)
    } else {
      c.rect(23, y, 2, 1, col)
      c.rect(25, y - 1, 3, 1, col)
      c.rect(28, y, 1, 1, col)
    }
  } else if (angry) {
    c.rect(35, y - 1, 1, 1, col)
    c.rect(36, y, 3, 1, col)
    c.rect(39, y + 1, 2, 1, col)
  } else if (sad) {
    c.rect(35, y + 1, 1, 1, col)
    c.rect(36, y, 3, 1, col)
    c.rect(39, y - 1, 2, 1, col)
  } else {
    c.rect(35, y, 1, 1, col)
    c.rect(36, y - 1, 3, 1, col)
    c.rect(39, y, 2, 1, col)
  }
}

function drawNose(ctx: Ctx): void {
  const { c, p } = ctx
  c.rect(31, 18, 1, 3, p.skin.shade)
  c.rect(30, 21, 3, 1, p.skin.shade)
  c.rect(31, 21, 1, 1, p.skin.deep)
  c.rect(33, 20, 1, 1, p.skin.light)
}

function drawMouthNeutral(ctx: Ctx): void {
  const { c } = ctx
  c.rect(29, 23, 6, 1, mix(LIP, INK, 0.35))
  c.rect(30, 24, 4, 1, LIP)
  c.rect(30, 23, 2, 1, lighten(LIP, 0.2))
}

function drawBlush(ctx: Ctx): void {
  const { c } = ctx
  c.rect(23, 19, 3, 2, BLUSH)
  c.rect(38, 19, 3, 2, BLUSH)
  c.rect(23, 19, 1, 1, lighten(BLUSH, 0.25))
}

function drawFace(ctx: Ctx): void {
  const { c, expression } = ctx
  drawNose(ctx)

  switch (expression) {
    case 'happy': {
      // 眯眼笑弧
      c.rect(24, 16, 5, 1, INK)
      c.rect(24, 15, 1, 1, INK)
      c.rect(28, 15, 1, 1, INK)
      c.rect(35, 16, 5, 1, INK)
      c.rect(35, 15, 1, 1, INK)
      c.rect(39, 15, 1, 1, INK)
      drawBrow(ctx, 12, true)
      drawBrow(ctx, 12, false)
      // 露齿笑
      c.rect(29, 22, 6, 3, MOUTH_IN)
      c.rect(30, 22, 4, 1, TEETH)
      c.rect(30, 24, 4, 1, LIP)
      drawBlush(ctx)
      break
    }
    case 'sad': {
      drawEyesBase(ctx, 14, 3)
      drawIris(ctx, 26, 15)
      drawIris(ctx, 37, 15)
      drawBrow(ctx, 12, true, false, true)
      drawBrow(ctx, 12, false, false, true)
      c.rect(30, 24, 4, 1, mix(LIP, INK, 0.4))
      c.rect(31, 23, 2, 1, LIP)
      // 眼角泪光
      c.rect(23, 17, 1, 1, '#A8D4F0')
      c.rect(40, 17, 1, 1, '#A8D4F0')
      break
    }
    case 'angry': {
      drawEyesBase(ctx, 15, 3)
      drawIris(ctx, 26, 16, '#5A2018')
      drawIris(ctx, 37, 16, '#5A2018')
      drawBrow(ctx, 11, true, true)
      drawBrow(ctx, 11, false, true)
      c.rect(29, 23, 6, 2, MOUTH_IN)
      c.rect(30, 23, 4, 1, mix(LIP, INK, 0.5))
      break
    }
    case 'surprised': {
      drawEyesBase(ctx, 13, 5)
      drawIris(ctx, 26, 15)
      drawIris(ctx, 37, 15)
      drawBrow(ctx, 10, true)
      drawBrow(ctx, 10, false)
      c.circle(32, 24, 2, MOUTH_IN)
      c.circle(32, 24, 1, '#8B4040')
      break
    }
    case 'thinking': {
      drawEyesBase(ctx, 14, 4)
      // 瞳孔上瞟
      drawIris(ctx, 26, 14)
      drawIris(ctx, 37, 14)
      drawBrow(ctx, 11, true)
      drawBrow(ctx, 11, false)
      c.rect(30, 23, 3, 1, mix(LIP, INK, 0.35))
      c.rect(32, 22, 2, 1, mix(LIP, INK, 0.35))
      break
    }
    case 'focused': {
      drawEyesBase(ctx, 15, 3)
      drawIris(ctx, 26, 16)
      drawIris(ctx, 37, 16)
      drawBrow(ctx, 12, true, true)
      drawBrow(ctx, 12, false, true)
      c.rect(30, 23, 5, 1, mix(LIP, INK, 0.4))
      break
    }
    case 'tired': {
      // 半垂眼
      c.rect(24, 15, 5, 2, EYE_WHITE)
      c.rect(35, 15, 5, 2, EYE_WHITE)
      c.rect(25, 16, 3, 1, IRIS_DEFAULT)
      c.rect(36, 16, 3, 1, IRIS_DEFAULT)
      c.rect(24, 14, 5, 1, mix(EYE_WHITE, INK, 0.25))
      c.rect(35, 14, 5, 1, mix(EYE_WHITE, INK, 0.25))
      drawBrow(ctx, 12, true, false, true)
      drawBrow(ctx, 12, false, false, true)
      c.rect(30, 23, 4, 1, mix(LIP, INK, 0.45))
      // 眼袋
      c.rect(24, 18, 5, 1, mix(LIP, '#8090A0', 0.35))
      c.rect(35, 18, 5, 1, mix(LIP, '#8090A0', 0.35))
      break
    }
    case 'wink': {
      // 右眼睁开
      c.rect(34, 13, 7, 6, mix(EYE_WHITE, '#000000', 0.12))
      c.rect(35, 14, 5, 4, EYE_WHITE)
      drawIris(ctx, 37, 15)
      // 左眼眨（眯眼弧）
      c.rect(24, 16, 5, 1, INK)
      c.rect(24, 15, 1, 1, INK)
      c.rect(28, 15, 1, 1, INK)
      drawBrow(ctx, 12, true)
      drawBrow(ctx, 12, false)
      c.rect(30, 23, 5, 1, mix(LIP, INK, 0.3))
      c.rect(31, 22, 3, 1, LIP)
      drawBlush(ctx)
      break
    }
    case 'love': {
      // 心形眼（简化为两颗心）
      const heart = (cx: number, cy: number) => {
        c.rect(cx - 1, cy, 2, 1, '#E2556A')
        c.rect(cx - 2, cy + 1, 4, 1, '#E2556A')
        c.rect(cx - 1, cy + 2, 2, 1, '#E2556A')
        c.rect(cx, cy + 3, 1, 1, '#E2556A')
        c.rect(cx - 1, cy, 1, 1, '#F090A0')
      }
      heart(26, 14)
      heart(37, 14)
      drawBrow(ctx, 11, true)
      drawBrow(ctx, 11, false)
      c.rect(29, 23, 6, 2, MOUTH_IN)
      c.rect(30, 23, 4, 1, TEETH)
      drawBlush(ctx)
      break
    }
    case 'talk': {
      drawEyesBase(ctx, 14, 4)
      drawIris(ctx, 26, 15)
      drawIris(ctx, 37, 15)
      drawBrow(ctx, 12, true)
      drawBrow(ctx, 12, false)
      // 嘴两帧开合
      pushAnim(ctx, 29, 23, 6, 1, mix(LIP, INK, 0.35), 'pa-fa')
      pushAnim(ctx, 30, 23, 4, 1, LIP, 'pa-fa')
      pushAnim(ctx, 29, 23, 6, 3, MOUTH_IN, 'pa-fb')
      pushAnim(ctx, 30, 23, 4, 1, TEETH, 'pa-fb')
      pushAnim(ctx, 30, 25, 4, 1, LIP, 'pa-fb')
      break
    }
    default: {
      // neutral
      drawEyesBase(ctx, 14, 4)
      drawIris(ctx, 26, 15)
      drawIris(ctx, 37, 15)
      drawBrow(ctx, 12, true)
      drawBrow(ctx, 12, false)
      drawMouthNeutral(ctx)
      break
    }
  }
}

/* ============================================================
 * 6) 帽
 * ============================================================ */
function drawHat(ctx: Ctx): void {
  const { c, a, p } = ctx
  if (a.hat === 'none') return
  const H = p.hat
  switch (a.hat) {
    case 'cap':
      c.rect(21, 2, 22, 6, H.base)
      c.rect(20, 7, 24, 2, H.base)
      c.rect(16, 8, 32, 2, H.base) // 帽檐
      c.rect(22, 2, 10, 2, H.light)
      c.rect(40, 3, 3, 5, H.shade)
      c.rect(16, 9, 32, 1, H.shade)
      c.rect(30, 3, 4, 3, H.shade) // 帽钮
      break
    case 'beanie':
      c.rect(21, 1, 22, 8, H.base)
      c.rect(20, 8, 24, 3, H.base) // 翻边
      c.rect(21, 1, 10, 2, H.light)
      c.rect(40, 2, 3, 7, H.shade)
      c.rect(20, 10, 24, 1, H.shade)
      c.rect(20, 8, 24, 1, H.light)
      // 纹理
      for (let x = 22; x < 42; x += 3) c.rect(x, 3, 1, 6, H.shade)
      break
    case 'beret':
      c.ellipse(32, 4, 12, 5, H.base)
      c.rect(21, 6, 22, 3, H.base)
      c.rect(30, 1, 3, 2, H.base) // 帽蒂
      c.rect(24, 2, 8, 2, H.light)
      c.rect(40, 4, 4, 4, H.shade)
      break
  }
}

/* ============================================================
 * 7) 配饰（高清晰度）
 * ============================================================ */
function drawAccessory(ctx: Ctx): void {
  const { c, a, p } = ctx
  const gold = tone('#D4A84B')
  switch (a.accessory) {
    case 'glasses-black': {
      // 镜片
      c.rect(23, 13, 7, 6, mix(EYE_WHITE, '#A8C8E0', 0.22))
      c.rect(34, 13, 7, 6, mix(EYE_WHITE, '#A8C8E0', 0.22))
      // 镜框（粗黑）
      c.rect(22, 12, 9, 1, INK)
      c.rect(22, 18, 9, 1, INK)
      c.rect(22, 12, 1, 7, INK)
      c.rect(30, 12, 1, 7, INK)
      c.rect(33, 12, 9, 1, INK)
      c.rect(33, 18, 9, 1, INK)
      c.rect(33, 12, 1, 7, INK)
      c.rect(41, 12, 1, 7, INK)
      // 鼻梁
      c.rect(30, 14, 4, 1, INK)
      // 镜腿
      c.rect(20, 13, 2, 1, INK)
      c.rect(42, 13, 2, 1, INK)
      // 镜片高光
      c.rect(24, 14, 2, 2, '#FFFFFF')
      c.rect(35, 14, 2, 2, '#FFFFFF')
      c.rect(26, 16, 1, 1, '#FFFFFF')
      break
    }
    case 'glasses-round': {
      c.rect(23, 13, 6, 5, mix(EYE_WHITE, '#A8C8E0', 0.22))
      c.rect(35, 13, 6, 5, mix(EYE_WHITE, '#A8C8E0', 0.22))
      // 圆框近似
      c.rect(23, 12, 6, 1, INK)
      c.rect(23, 17, 6, 1, INK)
      c.rect(22, 13, 1, 5, INK)
      c.rect(29, 13, 1, 5, INK)
      c.rect(35, 12, 6, 1, INK)
      c.rect(35, 17, 6, 1, INK)
      c.rect(34, 13, 1, 5, INK)
      c.rect(41, 13, 1, 5, INK)
      c.rect(29, 14, 6, 1, INK)
      c.rect(20, 13, 2, 1, INK)
      c.rect(42, 13, 2, 1, INK)
      c.rect(24, 13, 2, 2, '#FFFFFF')
      c.rect(36, 13, 2, 2, '#FFFFFF')
      break
    }
    case 'earrings': {
      // 垂坠耳环
      c.rect(20, 18, 2, 1, gold.base)
      c.rect(20, 19, 1, 3, gold.base)
      c.rect(21, 20, 1, 2, gold.base)
      c.rect(20, 19, 1, 1, gold.gloss)
      c.rect(42, 18, 2, 1, gold.base)
      c.rect(43, 19, 1, 3, gold.base)
      c.rect(42, 20, 1, 2, gold.base)
      c.rect(42, 19, 1, 1, gold.shade)
      // 耳钉点
      c.rect(20, 17, 1, 1, gold.gloss)
      c.rect(43, 17, 1, 1, gold.gloss)
      break
    }
    case 'scarf': {
      const S = p.accent ?? tone('#B84A4A')
      c.rect(22, 27, 20, 5, S.base)
      c.rect(22, 27, 20, 1, S.light)
      c.rect(22, 31, 20, 1, S.deep)
      // 围巾褶
      c.rect(25, 28, 1, 4, S.shade)
      c.rect(31, 28, 1, 4, S.shade)
      c.rect(37, 28, 1, 4, S.shade)
      // 垂下的尾巴
      c.rect(22, 31, 4, 10, S.base)
      c.rect(22, 31, 1, 10, S.light)
      c.rect(25, 31, 1, 10, S.shade)
      c.rect(22, 40, 4, 1, S.deep)
      break
    }
    case 'headset': {
      const M = tone('#2F3540')
      // 头梁
      c.rect(21, 3, 22, 2, M.base)
      c.rect(21, 3, 22, 1, M.light)
      c.rect(22, 2, 20, 1, M.base)
      // 耳罩
      c.rect(17, 11, 5, 10, M.base)
      c.rect(42, 11, 5, 10, M.base)
      c.rect(17, 11, 5, 2, M.light)
      c.rect(42, 11, 5, 2, M.light)
      c.rect(17, 19, 5, 2, M.shade)
      c.rect(42, 19, 5, 2, M.shade)
      // 耳垫
      c.rect(18, 13, 3, 6, mix(M.base, '#000000', 0.35))
      c.rect(43, 13, 3, 6, mix(M.base, '#000000', 0.35))
      // 麦克风杆
      c.rect(20, 18, 1, 6, M.base)
      c.rect(21, 23, 5, 1, M.base)
      c.rect(25, 22, 2, 2, M.base)
      c.rect(25, 22, 2, 1, '#6EC8E8')
      break
    }
    case 'cigarette': {
      c.rect(38, 24, 6, 1, '#F2EFE8')
      c.rect(43, 24, 2, 1, '#E8A060')
      c.rect(45, 24, 1, 1, '#E2554A')
      c.rect(46, 23, 1, 1, '#C8C8C8') // 烟雾
      c.rect(47, 22, 1, 1, '#D8D8D8')
      break
    }
  }
}

/* ============================================================
 * 8) 姿态 / 道具 / 动画手
 * ============================================================ */
function drawPose(ctx: Ctx): void {
  const { c, a, p, pose } = ctx
  const skin = p.skin
  const top = p.top

  if (pose === 'working') {
    // 笔记本
    c.rect(22, 36, 20, 12, '#2A2E36')
    c.rect(23, 37, 18, 9, '#1A1E26')
    // 代码行两帧
    pushAnim(ctx, 25, 39, 8, 1, '#6BCB77', 'pa-fa')
    pushAnim(ctx, 25, 41, 12, 1, '#6BCB77', 'pa-fa')
    pushAnim(ctx, 25, 43, 6, 1, '#4A90C4', 'pa-fa')
    pushAnim(ctx, 25, 39, 12, 1, '#6BCB77', 'pa-fb')
    pushAnim(ctx, 25, 41, 6, 1, '#4A90C4', 'pa-fb')
    pushAnim(ctx, 25, 43, 10, 1, '#6BCB77', 'pa-fb')
    // 键盘座
    c.rect(20, 47, 24, 4, '#3C4043')
    c.rect(20, 47, 24, 1, '#5A6066')
    c.rect(20, 50, 24, 1, '#2A2E32')
    // 双手交替敲键
    pushAnim(ctx, 24, 45, 5, 3, skin.base, 'pa-fa')
    pushAnim(ctx, 24, 45, 5, 1, skin.light, 'pa-fa')
    pushAnim(ctx, 35, 45, 5, 3, skin.base, 'pa-fb')
    pushAnim(ctx, 35, 45, 5, 1, skin.light, 'pa-fb')
    pushAnim(ctx, 35, 45, 5, 3, skin.shade, 'pa-fa')
    pushAnim(ctx, 24, 45, 5, 3, skin.shade, 'pa-fb')
  } else if (pose === 'thinking') {
    // 右臂托腮
    c.rect(42, 31, 6, 10, top.base)
    c.rect(42, 31, 1, 10, top.light)
    c.rect(47, 31, 1, 10, top.shade)
    c.rect(39, 22, 5, 10, skin.base) // 前臂上抬
    c.rect(39, 22, 1, 10, skin.light)
    c.rect(43, 22, 1, 10, skin.shade)
    c.rect(35, 20, 5, 4, skin.base) // 手贴腮
    c.rect(35, 20, 5, 1, skin.light)
    c.rect(35, 23, 5, 1, skin.shade)
    // 思考点
    pushAnim(ctx, 48, 6, 3, 3, '#6BA8E8', 'pa-dot1')
    pushAnim(ctx, 52, 10, 3, 3, '#6BA8E8', 'pa-dot2')
    pushAnim(ctx, 55, 14, 3, 3, '#6BA8E8', 'pa-dot3')
  } else if (pose === 'error') {
    // 惊叹号
    pushAnim(ctx, 30, 0, 4, 10, '#E24B4B', 'pa-alert')
    pushAnim(ctx, 30, 11, 4, 3, '#E24B4B', 'pa-alert')
    pushAnim(ctx, 31, 1, 2, 7, lighten('#E24B4B', 0.2), 'pa-alert')
    // 汗滴
    pushAnim(ctx, 46, 8, 2, 2, '#7EC8F0', 'pa-drop')
    pushAnim(ctx, 46, 10, 3, 3, '#7EC8F0', 'pa-drop')
    // 抱头
    c.rect(16, 14, 5, 8, skin.base)
    c.rect(43, 14, 5, 8, skin.base)
    c.rect(16, 14, 5, 1, skin.light)
    c.rect(43, 14, 5, 1, skin.light)
  } else if (pose === 'waiting') {
    // 举手挥动
    pushAnim(ctx, 44, 18, 6, 14, top.base, 'pa-fa')
    pushAnim(ctx, 46, 14, 5, 5, skin.base, 'pa-fa')
    pushAnim(ctx, 46, 14, 5, 1, skin.light, 'pa-fa')
    pushAnim(ctx, 44, 22, 6, 14, top.base, 'pa-fb')
    pushAnim(ctx, 46, 18, 5, 5, skin.base, 'pa-fb')
    pushAnim(ctx, 46, 18, 5, 1, skin.light, 'pa-fb')
    // 问号点
    pushAnim(ctx, 50, 4, 4, 2, '#6BA8E8', 'pa-dot1')
    pushAnim(ctx, 53, 6, 2, 2, '#6BA8E8', 'pa-dot1')
    pushAnim(ctx, 51, 9, 2, 2, '#6BA8E8', 'pa-dot2')
    pushAnim(ctx, 51, 12, 2, 2, '#6BA8E8', 'pa-dot3')
  } else if (pose === 'speaking') {
    // 摊手
    c.rect(12, 36, 7, 3, skin.base)
    c.rect(12, 36, 7, 1, skin.light)
    c.rect(45, 36, 7, 3, skin.base)
    c.rect(45, 36, 7, 1, skin.light)
    c.rect(12, 38, 7, 1, skin.shade)
    c.rect(45, 38, 7, 1, skin.shade)
  } else if (pose === 'handoff') {
    // 托箱推出
    c.rect(18, 34, 28, 10, '#4A5560')
    pushAnim(ctx, 18, 34, 28, 10, '#4A5560', 'pa-fa')
    pushAnim(ctx, 20, 32, 28, 10, '#4A5560', 'pa-fb')
    pushAnim(ctx, 20, 32, 28, 2, '#6A7580', 'pa-fb')
    c.rect(18, 34, 28, 2, '#6A7580')
    c.rect(30, 37, 4, 4, '#D4A84B') // 锁扣
    // 前伸手臂
    c.rect(14, 33, 6, 4, top.base)
    c.rect(44, 33, 6, 4, top.base)
    c.rect(14, 33, 6, 1, top.light)
    c.rect(44, 33, 6, 1, top.light)
    c.rect(12, 36, 4, 3, skin.base)
    c.rect(48, 36, 4, 3, skin.base)
  } else if (pose === 'cheer') {
    // V 字举手
    c.rect(12, 18, 5, 14, top.base)
    c.rect(10, 14, 5, 5, skin.base)
    c.rect(10, 14, 5, 1, skin.light)
    c.rect(47, 18, 5, 14, top.base)
    c.rect(49, 14, 5, 5, skin.base)
    c.rect(49, 14, 5, 1, skin.light)
    // 彩纸
    pushAnim(ctx, 14, 4, 3, 3, '#6BCB77', 'pa-dot1')
    pushAnim(ctx, 28, 1, 3, 3, '#E2556A', 'pa-dot2')
    pushAnim(ctx, 42, 3, 3, 3, '#6BA8E8', 'pa-dot3')
    pushAnim(ctx, 18, 8, 2, 2, '#D4A84B', 'pa-dot2')
    pushAnim(ctx, 48, 7, 2, 2, '#D4A84B', 'pa-dot1')
  } else {
    // idle：自然垂手已在躯干绘制；手持道具
    switch (a.heldProp) {
      case 'laptop': {
        c.rect(11, 38, 8, 10, '#3C4043')
        c.rect(12, 39, 6, 7, '#1A1E26')
        c.rect(12, 39, 6, 1, '#5A90C4')
        c.rect(11, 47, 8, 2, '#2A2E32')
        break
      }
      case 'coffee-cup': {
        c.rect(46, 38, 6, 8, '#F2EFE8')
        c.rect(46, 38, 6, 1, '#FFFFFF')
        c.rect(51, 40, 2, 3, '#E0DCD4') // 杯柄
        c.rect(46, 41, 6, 1, '#8B5A3C') // 咖啡
        c.rect(46, 45, 6, 1, '#D4D0C8')
        // 热气
        pushAnim(ctx, 48, 34, 1, 2, '#D8D8D8', 'pa-dot1')
        pushAnim(ctx, 50, 33, 1, 2, '#D8D8D8', 'pa-dot2')
        break
      }
      case 'book': {
        c.rect(11, 36, 8, 12, p.accent ? p.accent.base : '#8B3A4A')
        c.rect(11, 36, 8, 1, p.accent ? p.accent.light : '#A84A5A')
        c.rect(11, 47, 8, 1, p.accent ? p.accent.deep : '#5A2530')
        c.rect(18, 36, 1, 12, '#F2EFE8') // 书页
        c.rect(13, 39, 4, 1, '#F2EFE8')
        c.rect(13, 41, 3, 1, '#F2EFE8')
        break
      }
    }
    // 静态双手
    c.rect(16, 46, 5, 5, skin.base)
    c.rect(16, 46, 5, 1, skin.light)
    c.rect(16, 50, 5, 1, skin.shade)
    c.rect(43, 46, 5, 5, skin.base)
    c.rect(43, 46, 5, 1, skin.light)
    c.rect(43, 50, 5, 1, skin.shade)
  }
}

/* ============================================================
 * 入口
 * ============================================================ */

/**
 * 构建像素矩形。
 * 第二参可传 `AgentMotionState`（兼容）或 `{ state, expression, pose }`（精细控制）。
 */
export function buildPixelRects(
  a: PixelAgentAppearance,
  opts?: AgentMotionStateCompat | PixelRenderOptions,
): PixelRect[] {
  const options: PixelRenderOptions =
    typeof opts === 'string' ? { state: opts } : (opts ?? {})
  const { expression, pose } = resolveExpressionPose(options)
  const p = buildPalette(a)
  const c = new PixelCanvas(PIXEL_GRID)
  const ctx: Ctx = { c, a, p, expression, pose, anim: [] }

  drawLegs(ctx)
  drawTorso(ctx)
  drawHead(ctx)
  drawHair(ctx)
  // 描边包住身体剪影（表情/配饰后画，避免被描边吃掉）
  c.outline(OUTLINE)
  drawFace(ctx)
  drawHat(ctx)
  drawAccessory(ctx)
  drawPose(ctx)

  return [...c.toRects(), ...ctx.anim]
}

type AgentMotionStateCompat = AgentMotionState
