/**
 * 像素图层构建 v4（96×96 写实像素）——**唯一几何事实源**。
 *
 * - 96×96 整数网格：面部有足够像素做鼻梁/唇峰/眼睑；
 * - 三阶以上明暗 + 外描边 + 软过渡影；
 * - 表情（FaceExpression）与动作（BodyPose）解耦，外部可动态控制；
 * - 动画仍用帧矩形 + opacity（pa-fa/pa-fb 等）。
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
export const FEATURE_COLOR = INK
/** 96×96 网格 */
export const PIXEL_GRID = 96

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
 * 1) 腿 + 鞋（y≈70–95）
 * ============================================================ */
function drawLegs(ctx: Ctx): void {
  const { c, a, p } = ctx
  const isDress = a.top === 'f-dress'
  const legY = 72
  const legH = isDress ? 14 : 16

  // 双腿
  c.rect(34, legY, 11, legH, p.skin.base)
  c.rect(51, legY, 11, legH, p.skin.base)
  c.rect(43, legY + 2, 2, legH - 2, p.skin.shade)
  c.rect(51, legY + 2, 2, legH - 2, p.skin.shade)
  c.rect(34, legY + 2, 2, legH - 4, p.skin.light)
  c.rect(51, legY + 2, 2, legH - 4, p.skin.light)
  // 膝
  c.rect(35, legY + 8, 9, 2, mix(p.skin.base, p.skin.shade, 0.35))
  c.rect(52, legY + 8, 9, 2, mix(p.skin.base, p.skin.shade, 0.35))

  if (isDress) {
    c.rect(36, legY + 4, 8, legH - 4, p.skin.base)
    c.rect(52, legY + 4, 8, legH - 4, p.skin.base)
    c.rect(42, legY + 6, 2, legH - 6, p.skin.shade)
    c.rect(52, legY + 6, 2, legH - 6, p.skin.shade)
  } else if (a.bottom === 'shorts') {
    c.rect(32, legY, 15, 10, p.bottom.base)
    c.rect(49, legY, 15, 10, p.bottom.base)
    c.rect(32, legY, 2, 10, p.bottom.light)
    c.rect(49, legY, 2, 10, p.bottom.light)
    c.rect(45, legY, 2, 10, p.bottom.shade)
    c.rect(62, legY, 2, 10, p.bottom.shade)
    c.rect(32, legY + 9, 15, 1, p.bottom.deep)
    c.rect(49, legY + 9, 15, 1, p.bottom.deep)
  } else if (a.bottom === 'skirt') {
    c.rect(30, legY - 4, 36, 14, p.bottom.base)
    c.rect(30, legY - 4, 2, 14, p.bottom.light)
    c.rect(64, legY - 4, 2, 14, p.bottom.shade)
    c.rect(40, legY - 2, 2, 11, p.bottom.shade)
    c.rect(50, legY - 2, 2, 11, p.bottom.shade)
    c.rect(58, legY - 2, 2, 11, p.bottom.shade)
    c.rect(30, legY + 9, 36, 1, p.bottom.deep)
    c.rect(36, legY + 4, 8, 5, p.skin.base)
    c.rect(52, legY + 4, 8, 5, p.skin.base)
    c.rect(42, legY + 5, 2, 4, p.skin.shade)
    c.rect(52, legY + 5, 2, 4, p.skin.shade)
  } else {
    c.rect(32, legY, 15, legH, p.bottom.base)
    c.rect(49, legY, 15, legH, p.bottom.base)
    c.rect(32, legY, 2, legH, p.bottom.light)
    c.rect(49, legY, 2, legH, p.bottom.light)
    c.rect(45, legY, 2, legH, p.bottom.shade)
    c.rect(62, legY, 2, legH, p.bottom.shade)
    c.rect(34, legY + 8, 11, 2, p.bottom.shade)
    c.rect(51, legY + 8, 11, 2, p.bottom.shade)
    if (a.bottom === 'jeans') {
      c.rect(34, legY + 1, 3, 5, p.bottom.shade)
      c.rect(59, legY + 1, 3, 5, p.bottom.shade)
    }
  }

  // 鞋
  const sy = 88
  switch (a.shoes) {
    case 'boots':
      c.rect(31, sy - 4, 17, 10, p.shoes.base)
      c.rect(48, sy - 4, 17, 10, p.shoes.base)
      c.rect(31, sy - 4, 2, 10, p.shoes.light)
      c.rect(48, sy - 4, 2, 10, p.shoes.light)
      c.rect(46, sy - 4, 2, 10, p.shoes.shade)
      c.rect(63, sy - 4, 2, 10, p.shoes.shade)
      c.rect(31, sy + 5, 17, 1, p.shoes.deep)
      c.rect(48, sy + 5, 17, 1, p.shoes.deep)
      break
    case 'heels':
      c.rect(33, sy, 15, 3, p.shoes.base)
      c.rect(48, sy, 15, 3, p.shoes.base)
      c.rect(38, sy + 3, 3, 3, p.shoes.base)
      c.rect(55, sy + 3, 3, 3, p.shoes.base)
      c.rect(33, sy, 2, 3, p.shoes.light)
      c.rect(48, sy, 2, 3, p.shoes.light)
      c.rect(33, sy + 2, 15, 1, p.shoes.shade)
      c.rect(48, sy + 2, 15, 1, p.shoes.shade)
      break
    case 'formal':
      c.rect(31, sy, 17, 7, p.shoes.base)
      c.rect(48, sy, 17, 7, p.shoes.base)
      c.rect(31, sy, 17, 2, p.shoes.light)
      c.rect(48, sy, 17, 2, p.shoes.light)
      c.rect(31, sy + 6, 17, 1, p.shoes.deep)
      c.rect(48, sy + 6, 17, 1, p.shoes.deep)
      c.rect(36, sy + 2, 7, 1, p.shoes.shade)
      c.rect(53, sy + 2, 7, 1, p.shoes.shade)
      break
    default:
      c.rect(31, sy, 17, 7, p.shoes.base)
      c.rect(48, sy, 17, 7, p.shoes.base)
      c.rect(31, sy, 2, 5, p.shoes.light)
      c.rect(48, sy, 2, 5, p.shoes.light)
      c.rect(31, sy + 5, 17, 2, '#F2F0EA')
      c.rect(48, sy + 5, 17, 2, '#F2F0EA')
      c.rect(36, sy + 2, 8, 1, p.shoes.shade)
      c.rect(53, sy + 2, 8, 1, p.shoes.shade)
      c.rect(37, sy + 3, 5, 1, p.shoes.shade)
      c.rect(54, sy + 3, 5, 1, p.shoes.shade)
      break
  }
}

/* ============================================================
 * 2) 躯干 + 四肢（y≈38–70）
 * ============================================================ */
function drawArms(ctx: Ctx, sleeve: ToneSet, sleeveLen: number): void {
  const { c, p } = ctx
  // 左臂
  c.rect(24, 40, 10, sleeveLen, sleeve.base)
  c.rect(24, 40, 2, sleeveLen, sleeve.light)
  c.rect(32, 40, 2, sleeveLen, sleeve.shade)
  // 右臂
  c.rect(62, 40, 10, sleeveLen, sleeve.base)
  c.rect(62, 40, 2, sleeveLen, sleeve.light)
  c.rect(70, 40, 2, sleeveLen, sleeve.shade)

  if (sleeveLen < 22) {
    c.rect(26, 40 + sleeveLen, 6, 22 - sleeveLen, p.skin.base)
    c.rect(64, 40 + sleeveLen, 6, 22 - sleeveLen, p.skin.base)
    c.rect(26, 40 + sleeveLen, 1, 22 - sleeveLen, p.skin.light)
    c.rect(64, 40 + sleeveLen, 1, 22 - sleeveLen, p.skin.light)
    c.rect(31, 40 + sleeveLen, 1, 22 - sleeveLen, p.skin.shade)
    c.rect(69, 40 + sleeveLen, 1, 22 - sleeveLen, p.skin.shade)
  }
}

function drawTorso(ctx: Ctx): void {
  const { c, a, p } = ctx
  const isDress = a.top === 'f-dress'

  // 上衣主体
  c.rect(28, 38, 40, 26, p.top.base)
  c.rect(28, 38, 40, 3, p.top.light)
  c.rect(28, 38, 3, 26, p.top.light)
  c.rect(65, 38, 3, 26, p.top.shade)
  c.rect(28, 62, 40, 2, p.top.shade)
  // 胸侧影
  c.rect(32, 46, 4, 12, mix(p.top.base, p.top.shade, 0.35))
  c.rect(60, 46, 4, 12, mix(p.top.base, p.top.shade, 0.4))

  const sleeveLen = a.top === 'm-tshirt' || a.top === 'f-tshirt' || a.top === 'f-blouse' || isDress ? 8 : 22
  drawArms(ctx, p.top, sleeveLen)

  switch (a.top) {
    case 'm-tshirt':
    case 'f-tshirt': {
      c.rect(40, 38, 16, 3, p.skin.base)
      c.rect(40, 40, 16, 1, p.skin.shade)
      c.rect(38, 38, 2, 3, p.top.shade)
      c.rect(56, 38, 2, 3, p.top.shade)
      c.rect(24, 47, 10, 1, p.top.deep)
      c.rect(62, 47, 10, 1, p.top.deep)
      break
    }
    case 'm-hoodie':
    case 'f-hoodie': {
      c.rect(32, 35, 32, 5, p.top.base)
      c.rect(32, 35, 32, 2, p.top.light)
      c.rect(32, 39, 32, 1, p.top.shade)
      c.rect(36, 54, 24, 8, p.accent ? p.accent.base : p.top.shade)
      c.rect(36, 54, 24, 2, p.accent ? p.accent.light : p.top.deep)
      c.rect(36, 61, 24, 1, p.accent ? p.accent.deep : p.top.deep)
      c.rect(43, 45, 2, 8, '#F2F0EA')
      c.rect(51, 45, 2, 8, '#F2F0EA')
      c.rect(43, 52, 2, 1, p.top.shade)
      c.rect(51, 52, 2, 1, p.top.shade)
      c.rect(41, 43, 3, 3, p.top.deep)
      c.rect(52, 43, 3, 3, p.top.deep)
      break
    }
    case 'm-shirt': {
      c.rect(46, 41, 3, 20, '#F4F1EA')
      c.rect(46, 41, 2, 20, '#FFFFFF')
      c.rect(48, 41, 1, 20, '#E4DFD4')
      for (let i = 0; i < 5; i += 1) c.rect(46, 44 + i * 3, 3, 1, p.top.deep)
      c.rect(38, 38, 8, 5, '#F4F1EA')
      c.rect(50, 38, 8, 5, '#F4F1EA')
      c.rect(38, 42, 8, 1, '#E4DFD4')
      c.rect(50, 42, 8, 1, '#E4DFD4')
      c.rect(24, 58, 10, 3, '#F4F1EA')
      c.rect(62, 58, 10, 3, '#F4F1EA')
      break
    }
    case 'm-suit': {
      c.rect(41, 38, 14, 22, '#F4F1EA')
      c.rect(41, 38, 3, 22, '#E8E2D6')
      const tie = p.accent ?? tone('#8B2E3B')
      c.rect(46, 41, 4, 16, tie.base)
      c.rect(46, 41, 2, 16, tie.light)
      c.rect(48, 41, 2, 16, tie.shade)
      c.rect(44, 40, 8, 3, tie.base)
      c.rect(38, 38, 4, 16, p.top.shade)
      c.rect(54, 38, 4, 16, p.top.shade)
      c.rect(38, 38, 4, 2, p.top.light)
      c.rect(54, 38, 4, 2, p.top.light)
      c.rect(24, 58, 10, 2, '#F4F1EA')
      c.rect(62, 58, 10, 2, '#F4F1EA')
      break
    }
    case 'f-blouse': {
      c.rect(38, 38, 9, 4, '#F8F4EC')
      c.rect(49, 38, 9, 4, '#F8F4EC')
      c.rect(38, 41, 9, 1, '#E8E0D4')
      c.rect(49, 41, 9, 1, '#E8E0D4')
      const bow = p.accent ?? tone('#C45C6A')
      c.rect(43, 43, 10, 3, bow.base)
      c.rect(41, 43, 3, 5, bow.base)
      c.rect(52, 43, 3, 5, bow.base)
      c.rect(46, 43, 3, 3, bow.light)
      c.rect(41, 47, 3, 1, bow.shade)
      c.rect(52, 47, 3, 1, bow.shade)
      for (let i = 0; i < 4; i += 1) c.rect(46, 49 + i * 3, 3, 1, p.top.shade)
      break
    }
    case 'f-dress': {
      const belt = p.accent ?? tone(p.top.deep)
      c.rect(30, 58, 36, 3, belt.base)
      c.rect(30, 58, 36, 1, belt.light)
      c.rect(26, 61, 44, 16, p.top.base)
      c.rect(26, 61, 3, 16, p.top.light)
      c.rect(67, 61, 3, 16, p.top.shade)
      c.rect(38, 63, 2, 12, p.top.shade)
      c.rect(48, 63, 2, 12, p.top.shade)
      c.rect(58, 63, 2, 12, p.top.shade)
      c.rect(26, 76, 44, 1, p.top.deep)
      c.rect(40, 38, 16, 3, p.skin.base)
      c.rect(40, 40, 16, 1, p.skin.shade)
      break
    }
  }

  c.rect(32, 40, 2, 18, p.top.shade)
  c.rect(62, 40, 2, 18, p.top.shade)
}

/* ============================================================
 * 3) 头 + 颈（写实卵圆颅 + 颧/颌结构）
 * ============================================================ */
function drawHead(ctx: Ctx): void {
  const { c, p } = ctx
  const S = p.skin

  // 颈
  c.rect(42, 32, 12, 8, S.base)
  c.rect(42, 32, 2, 8, S.light)
  c.rect(52, 32, 2, 8, S.shade)
  c.rect(40, 32, 2, 6, S.shade)
  c.rect(54, 32, 2, 6, S.shade)
  c.rect(42, 32, 12, 1, S.deep)
  c.rect(43, 33, 10, 1, mix(S.deep, S.base, 0.4))

  // 颅骨：上宽下窄
  c.ellipse(48, 18, 13, 15, S.base)
  c.rect(36, 12, 2, 10, S.base)
  c.rect(58, 12, 2, 10, S.base)
  // 下颌 → 下巴
  c.rect(38, 26, 20, 4, S.base)
  c.rect(41, 30, 14, 2, S.base)
  c.rect(44, 32, 8, 1, S.base)
  // 下颌线
  c.rect(38, 28, 3, 4, S.shade)
  c.rect(55, 28, 3, 4, S.shade)
  c.rect(42, 31, 12, 1, mix(S.shade, S.base, 0.35))

  // 受光：左上额 → 颞
  c.rect(37, 6, 8, 12, S.light)
  c.rect(40, 5, 10, 4, S.light)
  c.rect(39, 8, 5, 6, S.gloss)
  c.rect(44, 6, 8, 3, mix(S.light, S.base, 0.4))
  // 背光：右颅 + 颧下（保持肤色相，不发灰）
  c.rect(57, 8, 5, 16, mix(S.base, S.shade, 0.55))
  c.rect(59, 12, 3, 10, mix(S.base, S.shade, 0.7))
  c.rect(54, 24, 8, 6, mix(S.base, S.shade, 0.5))
  c.rect(52, 26, 8, 4, mix(S.base, S.shade, 0.4))
  // 眼窝（极轻）
  c.rect(37, 15, 10, 3, mix(S.base, S.shade, 0.1))
  c.rect(49, 15, 10, 3, mix(S.base, S.shade, 0.13))
  // 颧骨高光 / 颊侧影
  c.rect(38, 21, 5, 3, S.light)
  c.rect(36, 22, 3, 3, mix(S.light, S.base, 0.55))
  c.rect(35, 24, 3, 4, mix(S.base, S.shade, 0.22))
  c.rect(54, 21, 5, 3, mix(S.base, S.shade, 0.35))
  c.rect(57, 23, 4, 5, mix(S.base, S.shade, 0.38))
  // 颌下
  c.rect(40, 29, 16, 2, mix(S.base, S.shade, 0.18))

  // 耳
  c.rect(33, 16, 5, 10, S.base)
  c.rect(58, 16, 5, 10, S.base)
  c.rect(33, 16, 2, 3, S.light)
  c.rect(61, 16, 2, 3, S.light)
  c.rect(35, 18, 2, 6, S.shade)
  c.rect(59, 18, 2, 6, S.shade)
  c.rect(35, 20, 2, 3, S.deep)
  c.rect(59, 20, 2, 3, S.deep)
  c.rect(33, 25, 3, 2, mix(S.base, S.shade, 0.45))
  c.rect(60, 25, 3, 2, mix(S.base, S.shade, 0.5))
}

/* ============================================================
 * 4) 发
 * ============================================================ */
function drawHair(ctx: Ctx): void {
  const { c, a, p } = ctx
  const H = p.hair

  const cap = () => {
    c.rect(35, 4, 26, 8, H.base)
    c.rect(34, 9, 28, 6, H.base)
    c.rect(34, 14, 28, 3, H.base)
    // 顶光 + 发丝
    c.rect(37, 4, 14, 3, H.light)
    c.rect(40, 5, 10, 2, H.gloss)
    c.rect(42, 6, 5, 2, mix(H.gloss, H.light, 0.5))
    c.rect(36, 9, 3, 6, H.light)
    c.rect(37, 10, 2, 4, H.gloss)
    // 侧影 + 发丝阴影
    c.rect(58, 6, 6, 12, H.shade)
    c.rect(55, 8, 3, 9, mix(H.base, H.shade, 0.55))
    c.rect(42, 10, 2, 5, H.shade)
    c.rect(50, 9, 2, 3, mix(H.base, H.shade, 0.4))
    c.rect(34, 15, 28, 2, mix(H.base, H.shade, 0.35))
  }

  switch (a.hairStyle) {
    case 'm-buzz': {
      c.rect(36, 5, 24, 6, H.base)
      c.rect(35, 9, 26, 4, H.base)
      c.rect(38, 4, 16, 3, H.light)
      c.rect(56, 7, 6, 7, H.shade)
      c.rect(35, 12, 3, 4, H.shade)
      c.rect(58, 12, 3, 4, H.shade)
      break
    }
    case 'm-short': {
      cap()
      c.rect(35, 14, 4, 6, H.base)
      c.rect(57, 14, 4, 6, H.base)
      c.rect(35, 18, 3, 3, H.shade)
      c.rect(58, 18, 3, 3, H.shade)
      c.rect(46, 11, 3, 5, H.shade)
      break
    }
    case 'm-spiky': {
      cap()
      c.rect(38, 1, 5, 5, H.base)
      c.rect(45, 0, 5, 6, H.base)
      c.rect(52, 1, 5, 4, H.base)
      c.rect(58, 0, 4, 4, H.base)
      c.rect(38, 1, 2, 3, H.gloss)
      c.rect(45, 0, 2, 4, H.gloss)
      c.rect(35, 13, 3, 5, H.base)
      c.rect(58, 13, 3, 5, H.base)
      break
    }
    case 'm-undercut': {
      c.rect(35, 3, 26, 10, H.base)
      c.rect(34, 7, 28, 7, H.base)
      c.rect(38, 2, 18, 4, H.base)
      c.rect(40, 3, 12, 3, H.gloss)
      c.rect(35, 13, 4, 4, H.shade)
      c.rect(57, 13, 4, 4, H.shade)
      c.rect(43, 6, 16, 2, H.shade)
      break
    }
    case 'm-curly': {
      c.rect(35, 4, 26, 9, H.base)
      c.rect(32, 7, 5, 6, H.base)
      c.rect(59, 7, 5, 6, H.base)
      c.rect(37, 2, 7, 5, H.base)
      c.rect(45, 1, 9, 5, H.base)
      c.rect(53, 2, 7, 5, H.base)
      c.rect(37, 2, 3, 3, H.gloss)
      c.rect(47, 1, 3, 3, H.gloss)
      c.rect(59, 7, 3, 3, H.shade)
      c.rect(35, 13, 4, 5, H.base)
      c.rect(57, 13, 4, 5, H.base)
      break
    }
    case 'f-long': {
      cap()
      c.rect(31, 10, 6, 28, H.base)
      c.rect(59, 10, 6, 28, H.base)
      c.rect(31, 10, 2, 24, H.light)
      c.rect(63, 10, 2, 24, H.shade)
      c.rect(31, 35, 6, 4, H.shade)
      c.rect(59, 35, 6, 4, H.shade)
      c.rect(37, 13, 22, 4, H.base)
      c.rect(37, 16, 8, 3, H.base)
      c.rect(51, 16, 8, 3, H.base)
      c.rect(44, 13, 10, 2, H.shade)
      c.rect(33, 14, 3, 16, H.gloss)
      c.rect(61, 16, 3, 14, H.shade)
      break
    }
    case 'f-bob': {
      cap()
      c.rect(31, 12, 6, 18, H.base)
      c.rect(59, 12, 6, 18, H.base)
      c.rect(31, 12, 2, 16, H.light)
      c.rect(63, 12, 2, 16, H.shade)
      c.rect(31, 28, 34, 5, H.base)
      c.rect(31, 32, 34, 2, H.shade)
      c.rect(37, 13, 22, 4, H.base)
      c.rect(37, 16, 7, 3, H.base)
      c.rect(52, 16, 7, 3, H.base)
      c.rect(33, 15, 3, 12, H.gloss)
      break
    }
    case 'f-twin': {
      cap()
      c.rect(24, 13, 8, 22, H.base)
      c.rect(64, 13, 8, 22, H.base)
      c.rect(24, 13, 2, 18, H.light)
      c.rect(70, 13, 2, 18, H.shade)
      c.rect(25, 16, 5, 3, p.accent ? p.accent.base : H.deep)
      c.rect(66, 16, 5, 3, p.accent ? p.accent.base : H.deep)
      c.rect(24, 32, 8, 5, H.shade)
      c.rect(64, 32, 8, 5, H.shade)
      c.rect(37, 13, 22, 4, H.base)
      c.rect(38, 16, 8, 3, H.base)
      c.rect(50, 16, 8, 3, H.base)
      c.rect(36, 5, 10, 3, H.gloss)
      break
    }
    case 'f-ponytail': {
      cap()
      c.rect(62, 10, 8, 26, H.base)
      c.rect(62, 10, 2, 22, H.light)
      c.rect(68, 10, 2, 26, H.shade)
      c.rect(62, 33, 8, 5, H.shade)
      c.rect(62, 14, 7, 3, H.deep)
      c.rect(37, 13, 22, 4, H.base)
      c.rect(37, 16, 9, 3, H.base)
      c.rect(52, 16, 7, 3, H.base)
      c.rect(40, 5, 14, 3, H.gloss)
      c.rect(35, 14, 3, 5, H.base)
      break
    }
    case 'f-bun': {
      cap()
      c.circle(48, 3, 6, H.base)
      c.circle(46, 2, 3, H.gloss)
      c.rect(42, 8, 12, 3, H.shade)
      c.rect(37, 13, 22, 4, H.base)
      c.rect(37, 16, 8, 3, H.base)
      c.rect(51, 16, 8, 3, H.base)
      c.rect(35, 13, 3, 6, H.base)
      c.rect(58, 13, 3, 6, H.base)
      break
    }
  }
}

/* ============================================================
 * 5) 表情（杏仁眼 + 立体鼻唇）
 * ============================================================ */
function drawOneEye(
  ctx: Ctx,
  ox: number,
  oy: number,
  openH = 3,
  irisY?: number,
  irisCol?: string,
): void {
  const { c, a, p } = ctx
  const S = p.skin
  const iy = irisY ?? oy
  // 眼眶皮肤影
  c.rect(ox - 1, oy - 2, 8, openH + 4, mix(S.base, S.shade, 0.12))
  // 上睑折痕
  c.rect(ox - 1, oy - 1, 8, 1, mix(S.shade, S.base, 0.4))
  // 眼裂
  c.rect(ox, oy, 6, openH, EYE_WHITE)
  c.rect(ox + 1, oy - 1, 4, 1, EYE_WHITE)
  c.rect(ox, oy, 1, 1, mix(EYE_WHITE, '#C09080', 0.55))
  c.rect(ox + 5, oy + openH - 1, 1, 1, mix(EYE_WHITE, S.shade, 0.35))
  // 上睑线
  c.rect(ox - 1, oy - 1, 8, 1, mix(INK, '#2A211C', 0.38))
  c.rect(ox + 5, oy - 2, 1, 1, mix(INK, '#2A211C', 0.5))
  // 下睑细影
  c.rect(ox + 1, oy + openH, 4, 1, mix(S.shade, S.base, 0.35))
  // 虹膜填满眼高
  const iris = irisCol ?? IRIS_DEFAULT
  const ih = openH
  c.rect(ox + 1, iy, 4, ih, iris)
  c.rect(ox + 1, iy, 4, 1, mix(iris, '#FFFFFF', 0.18))
  c.rect(ox + 1, iy + ih - 1, 4, 1, mix(iris, '#000000', 0.32))
  c.rect(ox + 2, iy, 2, ih, INK) // 瞳
  c.rect(ox + 1, iy, 1, 1, '#FFFFFF')
  c.rect(ox + 4, iy + 1, 1, 1, mix('#FFFFFF', iris, 0.35))
  // 睫毛
  if (a.gender === 'female') {
    c.rect(ox, oy - 2, 6, 1, mix(INK, '#2A211C', 0.22))
    c.rect(ox + 5, oy - 3, 1, 1, INK)
    c.rect(ox + 1, oy - 2, 1, 1, mix(INK, '#2A211C', 0.35))
  }
}

function drawBrow(ctx: Ctx, y: number, left = true, angry = false, sad = false): void {
  const { c, p } = ctx
  const col = mix(p.hair.deep, '#2A211C', 0.2)
  const soft = mix(p.hair.deep, p.skin.base, 0.4)
  const thin = ctx.a.gender === 'female'
  if (left) {
    if (angry) {
      c.rect(36, y + 1, 3, 1, col)
      c.rect(39, y, 5, 1, col)
      c.rect(44, y - 1, 2, 1, col)
      c.rect(36, y + 2, 3, 1, soft)
    } else if (sad) {
      c.rect(36, y - 1, 3, 1, col)
      c.rect(39, y, 5, 1, col)
      c.rect(44, y + 1, 2, 1, col)
    } else {
      c.rect(36, y, 3, 1, col)
      c.rect(39, y - 1, 5, 1, col)
      c.rect(44, y, 2, 1, col)
      if (!thin) c.rect(38, y + 1, 6, 1, soft)
    }
  } else if (angry) {
    c.rect(57, y + 1, 2, 1, col)
    c.rect(52, y, 5, 1, col)
    c.rect(50, y - 1, 2, 1, col)
    c.rect(57, y + 2, 3, 1, soft)
  } else if (sad) {
    c.rect(57, y - 1, 2, 1, col)
    c.rect(52, y, 5, 1, col)
    c.rect(50, y + 1, 2, 1, col)
  } else {
    c.rect(57, y, 2, 1, col)
    c.rect(52, y - 1, 5, 1, col)
    c.rect(50, y, 2, 1, col)
    if (!thin) c.rect(52, y + 1, 6, 1, soft)
  }
}

function drawNose(ctx: Ctx): void {
  const { c, p } = ctx
  const S = p.skin
  // 鼻梁：只留两侧轻影 + 中间微亮
  c.rect(45, 17, 1, 5, mix(S.base, S.shade, 0.22))
  c.rect(50, 17, 1, 5, mix(S.base, S.shade, 0.18))
  c.rect(47, 18, 2, 3, mix(S.light, S.base, 0.25))
  // 鼻头
  c.rect(45, 22, 6, 2, mix(S.base, S.light, 0.15))
  c.rect(46, 21, 3, 1, S.light)
  // 鼻翼 + 鼻孔
  c.rect(43, 23, 2, 2, mix(S.base, S.shade, 0.28))
  c.rect(51, 23, 2, 2, mix(S.base, S.shade, 0.32))
  c.rect(44, 25, 2, 1, mix(S.shade, S.deep, 0.65))
  c.rect(50, 25, 2, 1, mix(S.shade, S.deep, 0.7))
  // 鼻底 + 人中
  c.rect(45, 26, 6, 1, mix(S.base, S.shade, 0.28))
  c.rect(47, 27, 1, 2, mix(S.base, S.shade, 0.15))
}

function drawMouthNeutral(ctx: Ctx): void {
  const { c, p } = ctx
  const S = p.skin
  // 上唇（唇峰 + 唇珠）
  c.rect(44, 28, 1, 1, mix(LIP, INK, 0.3))
  c.rect(45, 27, 2, 1, mix(LIP, INK, 0.24))
  c.rect(47, 28, 1, 1, mix(LIP, INK, 0.18)) // 唇珠
  c.rect(48, 27, 2, 1, mix(LIP, INK, 0.24))
  c.rect(51, 28, 1, 1, mix(LIP, INK, 0.3))
  c.rect(45, 28, 6, 1, mix(LIP, INK, 0.45))
  // 下唇（饱满 + 高光）
  c.rect(44, 29, 8, 2, LIP)
  c.rect(45, 29, 5, 1, lighten(LIP, 0.28))
  c.rect(46, 30, 3, 1, lighten(LIP, 0.12))
  c.rect(44, 31, 8, 1, mix(LIP, S.shade, 0.48))
  // 唇角窝
  c.rect(43, 28, 1, 2, mix(LIP, S.shade, 0.5))
  c.rect(52, 28, 1, 2, mix(LIP, S.shade, 0.55))
  c.rect(43, 30, 1, 1, mix(S.base, S.shade, 0.25))
  c.rect(52, 30, 1, 1, mix(S.base, S.shade, 0.28))
}

function drawBlush(ctx: Ctx): void {
  const { c } = ctx
  c.rect(36, 22, 5, 3, BLUSH)
  c.rect(55, 22, 5, 3, BLUSH)
  c.rect(35, 23, 1, 2, mix(BLUSH, '#FFFFFF', 0.4))
  c.rect(60, 23, 1, 2, mix(BLUSH, '#FFFFFF', 0.4))
  c.rect(37, 25, 4, 1, mix(BLUSH, '#FFFFFF', 0.5))
  c.rect(55, 25, 4, 1, mix(BLUSH, '#FFFFFF', 0.5))
}

function drawFace(ctx: Ctx): void {
  const { c, expression } = ctx
  drawNose(ctx)

  switch (expression) {
    case 'happy': {
      c.rect(38, 18, 6, 1, INK)
      c.rect(38, 17, 1, 1, INK)
      c.rect(43, 17, 1, 1, INK)
      c.rect(52, 18, 6, 1, INK)
      c.rect(52, 17, 1, 1, INK)
      c.rect(57, 17, 1, 1, INK)
      c.rect(39, 19, 4, 1, mix(INK, '#2A211C', 0.4))
      c.rect(53, 19, 4, 1, mix(INK, '#2A211C', 0.4))
      drawBrow(ctx, 14, true)
      drawBrow(ctx, 14, false)
      c.rect(43, 27, 10, 4, MOUTH_IN)
      c.rect(44, 27, 8, 1, TEETH)
      c.rect(44, 28, 8, 1, mix(TEETH, '#E8E0D4', 0.4))
      c.rect(44, 29, 8, 1, LIP)
      c.rect(42, 28, 1, 2, mix(LIP, INK, 0.28))
      c.rect(53, 28, 1, 2, mix(LIP, INK, 0.28))
      drawBlush(ctx)
      break
    }
    case 'sad': {
      drawOneEye(ctx, 38, 16, 2, 16)
      drawOneEye(ctx, 52, 16, 2, 16)
      drawBrow(ctx, 14, true, false, true)
      drawBrow(ctx, 14, false, false, true)
      c.rect(45, 30, 1, 1, mix(LIP, INK, 0.48))
      c.rect(50, 30, 1, 1, mix(LIP, INK, 0.48))
      c.rect(46, 28, 4, 1, mix(LIP, INK, 0.42))
      c.rect(46, 29, 4, 1, LIP)
      c.rect(36, 20, 1, 1, '#A8D4F0')
      c.rect(59, 20, 1, 1, '#A8D4F0')
      break
    }
    case 'angry': {
      drawOneEye(ctx, 38, 16, 2, 16, '#5A2018')
      drawOneEye(ctx, 52, 16, 2, 16, '#5A2018')
      drawBrow(ctx, 13, true, true)
      drawBrow(ctx, 13, false, true)
      c.rect(43, 28, 10, 3, MOUTH_IN)
      c.rect(44, 28, 8, 1, mix(LIP, INK, 0.5))
      c.rect(43, 27, 1, 1, mix(LIP, INK, 0.32))
      c.rect(52, 27, 1, 1, mix(LIP, INK, 0.32))
      break
    }
    case 'surprised': {
      drawOneEye(ctx, 38, 15, 3, 15)
      drawOneEye(ctx, 52, 15, 3, 15)
      drawBrow(ctx, 12, true)
      drawBrow(ctx, 12, false)
      c.circle(48, 30, 3, MOUTH_IN)
      c.circle(48, 29, 2, '#8B4040')
      c.rect(45, 33, 6, 1, mix(LIP, INK, 0.28))
      break
    }
    case 'thinking': {
      drawOneEye(ctx, 38, 16, 2, 15)
      drawOneEye(ctx, 52, 16, 2, 15)
      drawBrow(ctx, 14, true)
      drawBrow(ctx, 14, false)
      c.rect(44, 28, 6, 1, mix(LIP, INK, 0.35))
      c.rect(48, 29, 5, 1, LIP)
      c.rect(51, 27, 1, 1, mix(LIP, INK, 0.28))
      break
    }
    case 'focused': {
      drawOneEye(ctx, 38, 16, 2, 16)
      drawOneEye(ctx, 52, 16, 2, 16)
      drawBrow(ctx, 14, true, true)
      drawBrow(ctx, 14, false, true)
      c.rect(44, 28, 8, 1, mix(LIP, INK, 0.42))
      c.rect(44, 29, 8, 1, mix(LIP, INK, 0.22))
      break
    }
    case 'tired': {
      c.rect(38, 16, 6, 2, EYE_WHITE)
      c.rect(52, 16, 6, 2, EYE_WHITE)
      c.rect(38, 15, 6, 1, mix(EYE_WHITE, INK, 0.28))
      c.rect(52, 15, 6, 1, mix(EYE_WHITE, INK, 0.28))
      c.rect(39, 16, 4, 2, IRIS_DEFAULT)
      c.rect(53, 16, 4, 2, IRIS_DEFAULT)
      c.rect(40, 16, 2, 1, INK)
      c.rect(54, 16, 2, 1, INK)
      drawBrow(ctx, 14, true, false, true)
      drawBrow(ctx, 14, false, false, true)
      c.rect(44, 28, 7, 1, mix(LIP, INK, 0.45))
      c.rect(38, 21, 7, 1, mix(LIP, '#8090A0', 0.32))
      c.rect(51, 21, 7, 1, mix(LIP, '#8090A0', 0.32))
      break
    }
    case 'wink': {
      drawOneEye(ctx, 52, 16, 2, 16)
      c.rect(38, 18, 6, 1, INK)
      c.rect(38, 17, 1, 1, INK)
      c.rect(43, 17, 1, 1, INK)
      c.rect(37, 18, 1, 1, mix(INK, '#2A211C', 0.5))
      drawBrow(ctx, 14, true)
      drawBrow(ctx, 14, false)
      c.rect(44, 28, 8, 1, mix(LIP, INK, 0.3))
      c.rect(45, 27, 5, 1, LIP)
      c.rect(45, 29, 5, 1, lighten(LIP, 0.2))
      drawBlush(ctx)
      break
    }
    case 'love': {
      const heart = (cx: number, cy: number) => {
        c.rect(cx - 1, cy, 2, 1, '#E2556A')
        c.rect(cx - 3, cy + 1, 6, 1, '#E2556A')
        c.rect(cx - 2, cy + 2, 4, 1, '#E2556A')
        c.rect(cx - 1, cy + 3, 2, 1, '#E2556A')
        c.rect(cx, cy + 4, 1, 1, '#E2556A')
        c.rect(cx - 1, cy, 1, 1, '#F090A0')
      }
      heart(41, 16)
      heart(54, 16)
      drawBrow(ctx, 13, true)
      drawBrow(ctx, 13, false)
      c.rect(43, 27, 10, 4, MOUTH_IN)
      c.rect(44, 27, 8, 1, TEETH)
      c.rect(44, 29, 8, 1, LIP)
      drawBlush(ctx)
      break
    }
    case 'talk': {
      drawOneEye(ctx, 38, 16, 2, 16)
      drawOneEye(ctx, 52, 16, 2, 16)
      drawBrow(ctx, 14, true)
      drawBrow(ctx, 14, false)
      pushAnim(ctx, 44, 28, 8, 1, mix(LIP, INK, 0.35), 'pa-fa')
      pushAnim(ctx, 45, 28, 6, 1, LIP, 'pa-fa')
      pushAnim(ctx, 43, 27, 10, 4, MOUTH_IN, 'pa-fb')
      pushAnim(ctx, 44, 27, 8, 1, TEETH, 'pa-fb')
      pushAnim(ctx, 44, 29, 8, 1, LIP, 'pa-fb')
      break
    }
    default: {
      drawOneEye(ctx, 38, 16, 2, 16)
      drawOneEye(ctx, 52, 16, 2, 16)
      drawBrow(ctx, 14, true)
      drawBrow(ctx, 14, false)
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
      c.rect(35, 3, 26, 7, H.base)
      c.rect(34, 8, 28, 4, H.base)
      c.rect(28, 11, 40, 3, H.base)
      c.rect(37, 3, 12, 2, H.light)
      c.rect(56, 4, 5, 7, H.shade)
      c.rect(28, 13, 40, 1, H.shade)
      c.rect(45, 3, 6, 3, H.shade)
      break
    case 'beanie':
      c.rect(35, 2, 26, 8, H.base)
      c.rect(34, 9, 28, 4, H.base)
      c.rect(37, 2, 12, 2, H.light)
      c.rect(56, 3, 5, 8, H.shade)
      c.rect(34, 12, 28, 1, H.shade)
      c.rect(34, 9, 28, 1, H.light)
      for (let x = 37; x < 60; x += 4) c.rect(x, 3, 1, 7, H.shade)
      break
    case 'beret':
      c.ellipse(45, 5, 13, 5, H.base)
      c.rect(33, 7, 24, 4, H.base)
      c.rect(42, 1, 4, 3, H.base)
      c.rect(37, 3, 10, 2, H.light)
      c.rect(54, 4, 5, 5, H.shade)
      c.rect(33, 10, 24, 1, H.shade)
      break
  }
}

/* ============================================================
 * 7) 配饰
 * ============================================================ */
function drawAccessory(ctx: Ctx): void {
  const { c, a } = ctx
  const gold = tone('#D4A84B')
  switch (a.accessory) {
    case 'glasses-black': {
      c.rect(36, 14, 11, 8, mix(EYE_WHITE, '#A8C8E0', 0.16))
      c.rect(49, 14, 11, 8, mix(EYE_WHITE, '#A8C8E0', 0.16))
      c.rect(35, 13, 13, 1, INK)
      c.rect(35, 21, 13, 1, INK)
      c.rect(35, 13, 1, 9, INK)
      c.rect(46, 13, 1, 9, INK)
      c.rect(48, 13, 13, 1, INK)
      c.rect(48, 21, 13, 1, INK)
      c.rect(48, 13, 1, 9, INK)
      c.rect(60, 13, 1, 9, INK)
      c.rect(46, 15, 4, 1, INK)
      c.rect(33, 15, 2, 1, INK)
      c.rect(61, 15, 2, 1, INK)
      c.rect(37, 15, 4, 1, '#FFFFFF')
      c.rect(37, 16, 2, 1, '#FFFFFF')
      c.rect(50, 15, 4, 1, '#FFFFFF')
      c.rect(50, 16, 2, 1, '#FFFFFF')
      c.rect(43, 18, 1, 1, '#FFFFFF')
      c.rect(57, 18, 1, 1, '#FFFFFF')
      break
    }
    case 'glasses-round': {
      c.rect(36, 14, 10, 7, mix(EYE_WHITE, '#A8C8E0', 0.16))
      c.rect(50, 14, 10, 7, mix(EYE_WHITE, '#A8C8E0', 0.16))
      c.rect(36, 13, 10, 1, INK)
      c.rect(36, 20, 10, 1, INK)
      c.rect(35, 14, 1, 7, INK)
      c.rect(45, 14, 1, 7, INK)
      c.rect(50, 13, 10, 1, INK)
      c.rect(50, 20, 10, 1, INK)
      c.rect(49, 14, 1, 7, INK)
      c.rect(60, 14, 1, 7, INK)
      c.rect(45, 16, 6, 1, INK)
      c.rect(33, 15, 2, 1, INK)
      c.rect(61, 15, 2, 1, INK)
      c.rect(37, 14, 4, 1, '#FFFFFF')
      c.rect(37, 15, 2, 1, '#FFFFFF')
      c.rect(51, 14, 4, 1, '#FFFFFF')
      c.rect(51, 15, 2, 1, '#FFFFFF')
      break
    }
    case 'earrings': {
      c.rect(33, 26, 3, 1, gold.base)
      c.rect(33, 27, 2, 5, gold.base)
      c.rect(35, 28, 1, 3, gold.base)
      c.rect(33, 27, 1, 2, gold.gloss)
      c.rect(60, 26, 3, 1, gold.base)
      c.rect(61, 27, 2, 5, gold.base)
      c.rect(60, 28, 1, 3, gold.base)
      c.rect(60, 27, 1, 2, gold.shade)
      c.rect(33, 25, 1, 1, gold.gloss)
      c.rect(62, 25, 1, 1, gold.gloss)
      break
    }
    case 'scarf': {
      const S = a.topAccent ? tone(resolveColor('outfit', a.topAccent)) : tone('#B84A4A')
      c.rect(34, 34, 28, 7, S.base)
      c.rect(34, 34, 28, 2, S.light)
      c.rect(34, 40, 28, 1, S.deep)
      c.rect(38, 35, 2, 6, S.shade)
      c.rect(48, 35, 2, 6, S.shade)
      c.rect(58, 35, 2, 6, S.shade)
      c.rect(34, 40, 6, 14, S.base)
      c.rect(34, 40, 2, 14, S.light)
      c.rect(38, 40, 2, 14, S.shade)
      c.rect(34, 53, 6, 1, S.deep)
      break
    }
    case 'headset': {
      const M = tone('#2F3540')
      c.rect(35, 3, 26, 3, M.base)
      c.rect(35, 3, 26, 1, M.light)
      c.rect(37, 2, 22, 1, M.base)
      c.rect(29, 14, 7, 14, M.base)
      c.rect(60, 14, 7, 14, M.base)
      c.rect(29, 14, 7, 3, M.light)
      c.rect(60, 14, 7, 3, M.light)
      c.rect(29, 25, 7, 3, M.shade)
      c.rect(60, 25, 7, 3, M.shade)
      c.rect(31, 17, 4, 8, mix(M.base, '#000000', 0.35))
      c.rect(61, 17, 4, 8, mix(M.base, '#000000', 0.35))
      c.rect(30, 24, 2, 8, M.base)
      c.rect(32, 31, 7, 1, M.base)
      c.rect(37, 30, 3, 2, M.base)
      c.rect(37, 30, 3, 1, '#6EC8E8')
      break
    }
    case 'cigarette': {
      c.rect(54, 30, 9, 1, '#F2EFE8')
      c.rect(61, 30, 3, 1, '#E8A060')
      c.rect(63, 30, 1, 1, '#E2554A')
      c.rect(65, 29, 1, 1, '#C8C8C8')
      c.rect(66, 28, 1, 1, '#D8D8D8')
      break
    }
  }
}

/* ============================================================
 * 8) 姿态 / 道具
 * ============================================================ */
function drawPose(ctx: Ctx): void {
  const { c, a, p, pose } = ctx
  const skin = p.skin
  const top = p.top

  if (pose === 'working') {
    c.rect(32, 52, 32, 18, '#2A2E36')
    c.rect(33, 53, 30, 14, '#1A1E26')
    pushAnim(ctx, 36, 56, 12, 1, '#6BCB77', 'pa-fa')
    pushAnim(ctx, 36, 59, 18, 1, '#6BCB77', 'pa-fa')
    pushAnim(ctx, 36, 62, 10, 1, '#4A90C4', 'pa-fa')
    pushAnim(ctx, 36, 56, 18, 1, '#6BCB77', 'pa-fb')
    pushAnim(ctx, 36, 59, 10, 1, '#4A90C4', 'pa-fb')
    pushAnim(ctx, 36, 62, 16, 1, '#6BCB77', 'pa-fb')
    c.rect(30, 69, 36, 6, '#3C4043')
    c.rect(30, 69, 36, 2, '#5A6066')
    c.rect(30, 74, 36, 1, '#2A2E32')
    pushAnim(ctx, 36, 66, 8, 4, skin.base, 'pa-fa')
    pushAnim(ctx, 36, 66, 8, 1, skin.light, 'pa-fa')
    pushAnim(ctx, 52, 66, 8, 4, skin.base, 'pa-fb')
    pushAnim(ctx, 52, 66, 8, 1, skin.light, 'pa-fb')
    pushAnim(ctx, 52, 66, 8, 4, skin.shade, 'pa-fa')
    pushAnim(ctx, 36, 66, 8, 4, skin.shade, 'pa-fb')
  } else if (pose === 'thinking') {
    c.rect(62, 40, 10, 16, top.base)
    c.rect(62, 40, 2, 16, top.light)
    c.rect(70, 40, 2, 16, top.shade)
    c.rect(56, 28, 8, 16, skin.base)
    c.rect(56, 28, 2, 16, skin.light)
    c.rect(63, 28, 1, 16, skin.shade)
    c.rect(50, 25, 8, 6, skin.base)
    c.rect(50, 25, 8, 1, skin.light)
    c.rect(50, 30, 8, 1, skin.shade)
    pushAnim(ctx, 72, 8, 4, 4, '#6BA8E8', 'pa-dot1')
    pushAnim(ctx, 78, 14, 4, 4, '#6BA8E8', 'pa-dot2')
    pushAnim(ctx, 82, 20, 4, 4, '#6BA8E8', 'pa-dot3')
  } else if (pose === 'error') {
    pushAnim(ctx, 45, 0, 6, 14, '#E24B4B', 'pa-alert')
    pushAnim(ctx, 45, 15, 6, 4, '#E24B4B', 'pa-alert')
    pushAnim(ctx, 46, 1, 3, 10, lighten('#E24B4B', 0.2), 'pa-alert')
    pushAnim(ctx, 68, 10, 3, 3, '#7EC8F0', 'pa-drop')
    pushAnim(ctx, 68, 13, 4, 4, '#7EC8F0', 'pa-drop')
    c.rect(26, 18, 8, 12, skin.base)
    c.rect(62, 18, 8, 12, skin.base)
    c.rect(26, 18, 8, 2, skin.light)
    c.rect(62, 18, 8, 2, skin.light)
  } else if (pose === 'waiting') {
    pushAnim(ctx, 64, 24, 10, 22, top.base, 'pa-fa')
    pushAnim(ctx, 66, 18, 8, 8, skin.base, 'pa-fa')
    pushAnim(ctx, 66, 18, 8, 2, skin.light, 'pa-fa')
    pushAnim(ctx, 64, 30, 10, 22, top.base, 'pa-fb')
    pushAnim(ctx, 66, 24, 8, 8, skin.base, 'pa-fb')
    pushAnim(ctx, 66, 24, 8, 2, skin.light, 'pa-fb')
    pushAnim(ctx, 74, 5, 6, 3, '#6BA8E8', 'pa-dot1')
    pushAnim(ctx, 78, 9, 3, 3, '#6BA8E8', 'pa-dot1')
    pushAnim(ctx, 76, 13, 3, 3, '#6BA8E8', 'pa-dot2')
    pushAnim(ctx, 76, 18, 3, 3, '#6BA8E8', 'pa-dot3')
  } else if (pose === 'speaking') {
    c.rect(18, 54, 10, 4, skin.base)
    c.rect(18, 54, 10, 1, skin.light)
    c.rect(68, 54, 10, 4, skin.base)
    c.rect(68, 54, 10, 1, skin.light)
    c.rect(18, 57, 10, 1, skin.shade)
    c.rect(68, 57, 10, 1, skin.shade)
  } else if (pose === 'handoff') {
    c.rect(28, 50, 40, 14, '#4A5560')
    pushAnim(ctx, 28, 50, 40, 14, '#4A5560', 'pa-fa')
    pushAnim(ctx, 30, 47, 40, 14, '#4A5560', 'pa-fb')
    pushAnim(ctx, 30, 47, 40, 3, '#6A7580', 'pa-fb')
    c.rect(28, 50, 40, 3, '#6A7580')
    c.rect(45, 54, 6, 6, '#D4A84B')
    c.rect(22, 48, 10, 5, top.base)
    c.rect(64, 48, 10, 5, top.base)
    c.rect(22, 48, 10, 2, top.light)
    c.rect(64, 48, 10, 2, top.light)
    c.rect(18, 54, 6, 4, skin.base)
    c.rect(72, 54, 6, 4, skin.base)
  } else if (pose === 'cheer') {
    c.rect(18, 26, 8, 22, top.base)
    c.rect(15, 20, 8, 8, skin.base)
    c.rect(15, 20, 8, 2, skin.light)
    c.rect(70, 26, 8, 22, top.base)
    c.rect(73, 20, 8, 8, skin.base)
    c.rect(73, 20, 8, 2, skin.light)
    pushAnim(ctx, 22, 5, 4, 4, '#6BCB77', 'pa-dot1')
    pushAnim(ctx, 42, 1, 4, 4, '#E2556A', 'pa-dot2')
    pushAnim(ctx, 62, 4, 4, 4, '#6BA8E8', 'pa-dot3')
    pushAnim(ctx, 28, 11, 3, 3, '#D4A84B', 'pa-dot2')
    pushAnim(ctx, 72, 10, 3, 3, '#D4A84B', 'pa-dot1')
  } else {
    switch (a.heldProp) {
      case 'laptop': {
        c.rect(16, 56, 12, 15, '#3C4043')
        c.rect(17, 57, 10, 11, '#1A1E26')
        c.rect(17, 57, 10, 1, '#5A90C4')
        c.rect(16, 70, 12, 2, '#2A2E32')
        break
      }
      case 'coffee-cup': {
        c.rect(68, 56, 9, 12, '#F2EFE8')
        c.rect(68, 56, 9, 1, '#FFFFFF')
        c.rect(76, 59, 3, 5, '#E0DCD4')
        c.rect(68, 61, 9, 1, '#8B5A3C')
        c.rect(68, 67, 9, 1, '#D4D0C8')
        pushAnim(ctx, 71, 50, 1, 3, '#D8D8D8', 'pa-dot1')
        pushAnim(ctx, 74, 48, 1, 3, '#D8D8D8', 'pa-dot2')
        break
      }
      case 'book': {
        c.rect(16, 52, 12, 18, a.topAccent ? tone(resolveColor('outfit', a.topAccent)).base : '#8B3A4A')
        c.rect(16, 52, 12, 2, a.topAccent ? tone(resolveColor('outfit', a.topAccent)).light : '#A84A5A')
        c.rect(16, 69, 12, 1, a.topAccent ? tone(resolveColor('outfit', a.topAccent)).deep : '#5A2530')
        c.rect(27, 52, 1, 18, '#F2EFE8')
        c.rect(19, 56, 6, 1, '#F2EFE8')
        c.rect(19, 59, 5, 1, '#F2EFE8')
        break
      }
    }
    c.rect(24, 62, 8, 7, skin.base)
    c.rect(24, 62, 8, 1, skin.light)
    c.rect(24, 68, 8, 1, skin.shade)
    c.rect(64, 62, 8, 7, skin.base)
    c.rect(64, 62, 8, 1, skin.light)
    c.rect(64, 68, 8, 1, skin.shade)
  }
}

/* ============================================================
 * 入口
 * ============================================================ */
export function buildPixelRects(
  a: PixelAgentAppearance,
  opts?: AgentMotionState | PixelRenderOptions,
): PixelRect[] {
  const options: PixelRenderOptions = typeof opts === 'string' ? { state: opts } : (opts ?? {})
  const { expression, pose } = resolveExpressionPose(options)
  const p = buildPalette(a)
  const c = new PixelCanvas(PIXEL_GRID)
  const ctx: Ctx = { c, a, p, expression, pose, anim: [] }

  drawLegs(ctx)
  drawTorso(ctx)
  drawHead(ctx)
  drawHair(ctx)
  c.outline(OUTLINE)
  drawFace(ctx)
  drawHat(ctx)
  drawAccessory(ctx)
  drawPose(ctx)

  return [...c.toRects(), ...ctx.anim]
}
