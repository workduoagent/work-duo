/**
 * 像素图层构建 v2（32×32 游戏级）——**唯一几何事实源**。
 *
 * - 整数网格（禁 0.5），React 渲染与 SVG 快照共用本函数；
 * - 表情与姿态由动作状态（AgentMotionState）驱动：
 *     idle    平静表情，完全静止（不产生任何带 cls 的动画矩形）；
 *     working 笔记本 + 双手交替敲键（pa-fa/pa-fb 两帧）+ 屏幕代码行滚动；
 *     thinking 单手托腮 + 眼睛上瞟 + 头侧思考点（pa-dot* 闪烁）；
 *     error   X 眼 + 张嘴 + 头顶红色感叹号（pa-alert 闪烁）+ 汗滴；
 * - 动画全部用「两帧矩形 + opacity 切换」实现（无 transform），保证像素锐利；
 * - 图层顺序：腿/鞋 → 体 → 头 → 上衣 → 发 → 表情 → 帽 → 饰 → 道具/姿态 → 手。
 */
import { resolveColor } from './constants'
import type { AgentMotionState, PixelAgentAppearance } from './types'

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
  fill: string
  /** 动画标记（空格分隔）：pa-fa/pa-fb=交替帧、pa-dot1..3=思考点、pa-alert/pa-drop=出错闪烁 */
  cls?: string
}

/** 五官固定色（非调色板族） */
export const FEATURE_COLOR = '#2A2320'
const WHITE = '#FFFFFF'
const RED = '#E5484D'
const BLUE = '#5CA8E0'
const GREEN = '#7EE787'
const SCREEN = '#20242E'
const SCREEN_IN = '#171A21'
const LAPTOP = '#3C4043'

/** 32×32 骨架：头 (9,4)-(22,15) / 颈 y16..17 / 身 (10,18)-(21,25) / 臂 x8·x23 / 腿 y26..29 / 鞋 y30..31 */
export function buildPixelRects(
  a: PixelAgentAppearance,
  state: AgentMotionState = 'idle',
): PixelRect[] {
  const skin = resolveColor('skin', a.skinColor)
  const hair = resolveColor('hair', a.hairColor)
  const top = resolveColor('outfit', a.topColor)
  const accent = a.topAccent ? resolveColor('outfit', a.topAccent) : null
  const bottom = resolveColor('outfit', a.bottomColor)
  const shoes = resolveColor('outfit', a.shoesColor)
  const hatC = resolveColor('outfit', a.hatColor)
  const R: PixelRect[] = []
  const add = (x: number, y: number, w: number, h: number, fill: string, cls?: string) => {
    R.push({ x, y, w, h, fill, cls })
  }
  const isDress = a.top === 'f-dress'

  /* ---------------- 1) 腿 + 鞋 ---------------- */
  if (isDress) {
    // 连衣裙裙摆覆盖到大腿，只露小腿
    add(12, 29, 3, 1, skin)
    add(17, 29, 3, 1, skin)
  } else if (a.bottom === 'shorts') {
    add(11, 26, 4, 2, bottom)
    add(17, 26, 4, 2, bottom)
    add(11, 28, 4, 2, skin)
    add(17, 28, 4, 2, skin)
  } else if (a.bottom === 'skirt') {
    add(10, 26, 12, 3, bottom)
    add(12, 29, 3, 1, skin)
    add(17, 29, 3, 1, skin)
  } else {
    // trousers / jeans
    add(11, 26, 4, 4, bottom)
    add(17, 26, 4, 4, bottom)
  }
  switch (a.shoes) {
    case 'boots':
      add(10, 29, 5, 3, shoes)
      add(17, 29, 5, 3, shoes)
      break
    case 'heels':
      add(11, 30, 4, 1, shoes)
      add(13, 31, 1, 1, shoes)
      add(18, 30, 4, 1, shoes)
      add(20, 31, 1, 1, shoes)
      break
    default: // sneakers / formal
      add(10, 30, 5, 2, shoes)
      add(17, 30, 5, 2, shoes)
      if (a.shoes === 'sneakers') {
        add(10, 31, 5, 1, WHITE)
        add(17, 31, 5, 1, WHITE)
      }
      break
  }

  /* ---------------- 2) 体（内衬皮肤） ---------------- */
  add(10, 18, 12, 8, skin)
  add(14, 16, 4, 2, skin) // 颈

  /* ---------------- 3) 头 ---------------- */
  add(10, 3, 12, 1, skin)
  add(9, 4, 14, 12, skin)
  add(10, 16, 12, 1, skin)
  add(8, 10, 1, 3, skin) // 左耳
  add(23, 10, 1, 3, skin) // 右耳

  /* ---------------- 4) 上衣（含袖） ---------------- */
  const armLong = (color: string) => {
    add(8, 18, 2, 7, color)
    add(22, 18, 2, 7, color)
  }
  const armShort = (color: string) => {
    add(8, 18, 2, 3, color)
    add(22, 18, 2, 3, color)
  }
  switch (a.top) {
    case 'm-tshirt':
    case 'f-tshirt':
      add(10, 18, 12, 8, top)
      add(14, 18, 4, 1, skin) // 领口
      armShort(top)
      break
    case 'm-hoodie':
    case 'f-hoodie':
      add(10, 18, 12, 8, top)
      add(11, 17, 10, 1, top) // 帽沿
      add(12, 22, 8, 3, accent ?? FEATURE_COLOR) // 口袋
      add(14, 19, 1, 2, WHITE) // 抽绳
      add(17, 19, 1, 2, WHITE)
      armLong(top)
      break
    case 'm-shirt':
      add(10, 18, 12, 8, top)
      add(16, 18, 1, 8, WHITE) // 门襟
      add(13, 17, 7, 2, WHITE) // 衣领
      armLong(top)
      break
    case 'm-suit':
      add(10, 18, 12, 8, top)
      add(14, 18, 4, 6, WHITE) // 衬衫
      add(16, 18, 1, 4, accent ?? resolveColor('outfit', 'accent-wine')) // 领带
      armLong(top)
      break
    case 'f-blouse':
      add(10, 18, 12, 8, top)
      add(15, 18, 3, 2, accent ?? WHITE) // 蝴蝶结
      armShort(top)
      break
    case 'f-dress':
      add(10, 18, 12, 6, top)
      add(9, 24, 14, 5, top) // 裙摆
      add(10, 23, 12, 1, accent ?? FEATURE_COLOR) // 腰带
      armShort(top)
      break
  }

  /* ---------------- 5) 发 ---------------- */
  switch (a.hairStyle) {
    case 'm-buzz':
      add(10, 3, 12, 2, hair)
      add(9, 5, 1, 3, hair)
      add(22, 5, 1, 3, hair)
      break
    case 'm-short':
      add(9, 2, 14, 3, hair)
      add(9, 5, 5, 1, hair)
      add(16, 5, 7, 1, hair)
      add(9, 6, 1, 4, hair)
      add(22, 6, 1, 4, hair)
      break
    case 'm-spiky':
      add(9, 2, 14, 3, hair)
      add(10, 1, 2, 1, hair)
      add(14, 0, 2, 2, hair)
      add(18, 1, 2, 1, hair)
      add(9, 5, 1, 2, hair)
      add(22, 5, 1, 2, hair)
      break
    case 'm-undercut':
      add(9, 1, 14, 4, hair)
      add(10, 5, 11, 1, hair)
      break
    case 'm-curly':
      add(9, 2, 14, 3, hair)
      add(8, 3, 2, 2, hair)
      add(11, 1, 4, 2, hair)
      add(16, 1, 4, 2, hair)
      add(21, 2, 3, 2, hair)
      add(9, 5, 1, 3, hair)
      add(22, 5, 1, 3, hair)
      break
    case 'f-long':
      add(9, 2, 14, 4, hair)
      add(10, 6, 3, 1, hair)
      add(19, 6, 3, 1, hair)
      add(7, 4, 2, 15, hair)
      add(23, 4, 2, 15, hair)
      break
    case 'f-bob':
      add(9, 2, 14, 4, hair)
      add(9, 6, 14, 1, hair)
      add(7, 5, 2, 9, hair)
      add(23, 5, 2, 9, hair)
      break
    case 'f-twin':
      add(9, 2, 14, 4, hair)
      add(9, 6, 5, 1, hair)
      add(17, 6, 6, 1, hair)
      add(5, 6, 3, 9, hair)
      add(24, 6, 3, 9, hair)
      break
    case 'f-ponytail':
      add(9, 2, 14, 4, hair)
      add(9, 6, 4, 1, hair)
      add(16, 6, 7, 1, hair)
      add(23, 3, 3, 12, hair)
      add(22, 6, 2, 2, hair)
      break
    case 'f-bun':
      add(9, 2, 14, 4, hair)
      add(13, 0, 6, 3, hair)
      add(9, 6, 14, 1, hair)
      break
  }

  /* ---------------- 6) 表情（状态驱动） ---------------- */
  const eyeWhite = () => {
    add(12, 11, 3, 3, WHITE)
    add(18, 11, 3, 3, WHITE)
  }
  switch (state) {
    case 'working': {
      // 专注下视：眼白压扁 + 虹膜贴底
      add(12, 11, 3, 2, WHITE)
      add(18, 11, 3, 2, WHITE)
      add(13, 12, 2, 1, FEATURE_COLOR)
      add(18, 12, 2, 1, FEATURE_COLOR)
      add(14, 15, 4, 1, FEATURE_COLOR)
      break
    }
    case 'thinking': {
      eyeWhite()
      // 虹膜上瞟（看左上）
      add(12, 11, 2, 2, FEATURE_COLOR)
      add(18, 11, 2, 2, FEATURE_COLOR)
      add(14, 15, 3, 1, FEATURE_COLOR)
      // 挑眉
      add(12, 8, 3, 1, hair)
      add(18, 8, 3, 1, hair)
      break
    }
    case 'error': {
      // X 眼
      for (const dx of [0, 6]) {
        add(12 + dx, 11, 1, 1, FEATURE_COLOR)
        add(14 + dx, 11, 1, 1, FEATURE_COLOR)
        add(13 + dx, 12, 1, 1, FEATURE_COLOR)
        add(12 + dx, 13, 1, 1, FEATURE_COLOR)
        add(14 + dx, 13, 1, 1, FEATURE_COLOR)
      }
      add(13, 15, 6, 2, FEATURE_COLOR) // 张嘴
      break
    }
    case 'waiting': {
      eyeWhite()
      // 虹膜左右张望（两帧交替）
      add(12, 12, 2, 2, FEATURE_COLOR, 'pa-fa') // 左
      add(14, 12, 1, 1, WHITE, 'pa-fa')
      add(19, 12, 2, 2, FEATURE_COLOR, 'pa-fb') // 右
      add(19, 12, 1, 1, WHITE, 'pa-fb')
      add(14, 15, 4, 1, FEATURE_COLOR)
      break
    }
    case 'speaking': {
      eyeWhite()
      add(13, 12, 2, 2, FEATURE_COLOR)
      add(18, 12, 2, 2, FEATURE_COLOR)
      // 嘴部两帧开合：A 帧微张 / B 帧大张（表达"正在说话"）
      add(14, 15, 4, 1, FEATURE_COLOR, 'pa-fa')
      add(14, 15, 4, 2, FEATURE_COLOR, 'pa-fb')
      break
    }
    case 'handoff': {
      // 专注递出：下视（同 working 简版）+ 微笑
      add(12, 11, 3, 2, WHITE)
      add(18, 11, 3, 2, WHITE)
      add(13, 12, 2, 1, FEATURE_COLOR)
      add(18, 12, 2, 1, FEATURE_COLOR)
      add(14, 15, 4, 1, FEATURE_COLOR)
      break
    }
    case 'cheer': {
      // 眯眼笑（下弯线）
      add(12, 12, 3, 1, FEATURE_COLOR)
      add(18, 12, 3, 1, FEATURE_COLOR)
      // 大张嘴笑
      add(13, 14, 6, 2, FEATURE_COLOR)
      add(14, 14, 4, 1, WHITE) // 牙
      break
    }
    default: {
      // idle：平静
      eyeWhite()
      add(13, 12, 2, 2, FEATURE_COLOR)
      add(18, 12, 2, 2, FEATURE_COLOR)
      add(14, 12, 1, 1, WHITE) // 高光
      add(19, 12, 1, 1, WHITE)
      add(14, 15, 4, 1, FEATURE_COLOR)
      break
    }
  }

  /* ---------------- 7) 帽 ---------------- */
  switch (a.hat) {
    case 'cap':
      add(9, 0, 14, 3, hatC)
      add(7, 3, 18, 1, hatC)
      break
    case 'beanie':
      add(9, 0, 14, 3, hatC)
      add(9, 3, 14, 2, hatC)
      break
    case 'beret':
      add(10, 0, 13, 3, hatC)
      add(15, 0, 2, 1, hatC)
      break
  }

  /* ---------------- 8) 配饰 ---------------- */
  switch (a.accessory) {
    case 'glasses-black':
      add(11, 11, 4, 3, FEATURE_COLOR)
      add(17, 11, 4, 3, FEATURE_COLOR)
      add(15, 12, 2, 1, FEATURE_COLOR)
      add(9, 12, 2, 1, FEATURE_COLOR)
      add(21, 12, 2, 1, FEATURE_COLOR)
      add(12, 12, 1, 1, WHITE)
      add(18, 12, 1, 1, WHITE)
      break
    case 'glasses-round':
      add(11, 11, 3, 3, FEATURE_COLOR)
      add(18, 11, 3, 3, FEATURE_COLOR)
      add(14, 12, 4, 1, FEATURE_COLOR)
      add(12, 12, 1, 1, WHITE)
      add(19, 12, 1, 1, WHITE)
      break
    case 'earrings':
      add(8, 13, 1, 2, resolveColor('hair', 'accent-amber'))
      add(23, 13, 1, 2, resolveColor('hair', 'accent-amber'))
      break
    case 'scarf':
      add(11, 17, 10, 3, accent ?? resolveColor('outfit', 'accent-wine'))
      add(11, 20, 2, 4, accent ?? resolveColor('outfit', 'accent-wine'))
      break
    case 'headset':
      add(9, 1, 14, 2, FEATURE_COLOR)
      add(8, 10, 2, 4, FEATURE_COLOR)
      add(22, 10, 2, 4, FEATURE_COLOR)
      add(8, 14, 2, 3, FEATURE_COLOR)
      add(10, 16, 3, 1, FEATURE_COLOR)
      break
    case 'cigarette':
      add(19, 16, 4, 1, WHITE)
      add(23, 16, 1, 1, RED)
      break
  }

  /* ---------------- 9) 姿态 / 道具 ---------------- */
  if (state === 'working') {
    // 笔记本电脑（画在身前）
    add(11, 17, 10, 7, SCREEN)
    add(12, 18, 8, 5, SCREEN_IN)
    // 代码行（两帧滚动）
    add(13, 19, 4, 1, GREEN)
    add(13, 21, 5, 1, GREEN)
    add(18, 19, 2, 1, GREEN)
    add(13, 19, 5, 1, GREEN)
    add(14, 21, 4, 1, GREEN)
    add(18, 21, 2, 1, GREEN)
    add(10, 25, 12, 2, LAPTOP) // 键盘座
    // 双手交替敲键（两帧）
    add(12, 24, 3, 2, skin, 'pa-fa')
    add(12, 25, 3, 2, skin, 'pa-fb')
    add(17, 25, 3, 2, skin, 'pa-fa')
    add(17, 24, 3, 2, skin, 'pa-fb')
  } else if (state === 'thinking') {
    // 右臂托腮：肩 → 肘 → 手（阶梯式）
    add(22, 18, 2, 3, top)
    add(21, 16, 2, 2, skin)
    add(19, 15, 3, 2, skin)
    add(14, 14, 4, 2, skin) // 手背贴腮
    // 思考点（闪烁）
    add(24, 4, 2, 2, BLUE, 'pa-dot1')
    add(26, 7, 2, 2, BLUE, 'pa-dot2')
    add(28, 10, 2, 2, BLUE, 'pa-dot3')
  } else if (state === 'error') {
    // 头顶感叹号 + 汗滴（闪烁）
    add(15, 0, 2, 5, RED, 'pa-alert')
    add(15, 6, 2, 2, RED, 'pa-alert')
    add(24, 5, 1, 1, BLUE, 'pa-drop')
    add(24, 6, 2, 2, BLUE, 'pa-drop')
  } else if (state === 'waiting') {
    // 右臂举手挥动（两帧上下交替）
    add(24, 12, 2, 6, top, 'pa-fa')
    add(24, 10, 2, 2, skin, 'pa-fa') // 手（高）
    add(24, 14, 2, 6, top, 'pa-fb')
    add(24, 12, 2, 2, skin, 'pa-fb') // 手（低）
    // 头顶问号点（闪烁）
    add(26, 1, 2, 1, BLUE, 'pa-dot1')
    add(27, 3, 2, 1, BLUE, 'pa-dot2')
    add(28, 5, 1, 1, BLUE, 'pa-dot3')
  } else if (state === 'handoff') {
    // 双臂前伸托物 + 物品两帧前后推（递出动感）
    add(9, 20, 4, 2, top) // 左臂前伸
    add(19, 20, 4, 2, top) // 右臂前伸
    add(11, 19, 10, 5, LAPTOP, 'pa-fa') // 箱子（近身）
    add(12, 18, 10, 5, LAPTOP, 'pa-fb') // 箱子（推出）
  } else if (state === 'cheer') {
    // 双臂上举 V 字
    add(7, 12, 2, 6, top)
    add(6, 10, 2, 2, skin) // 左手（高）
    add(23, 12, 2, 6, top)
    add(24, 10, 2, 2, skin) // 右手（高）
    // 头顶彩纸（错峰闪烁）
    add(9, 2, 2, 2, GREEN, 'pa-dot1')
    add(15, 0, 2, 2, RED, 'pa-dot2')
    add(21, 3, 2, 2, BLUE, 'pa-dot3')
    // 脚下影子两帧（有影=腾空 / 无影=落地，表达跳跃）
    add(10, 29, 12, 1, resolveColor('outfit', 'ink-700'), 'pa-fa')
  } else {
    // idle：静态持物
    switch (a.heldProp) {
      case 'laptop':
        add(6, 20, 3, 5, LAPTOP)
        add(6, 20, 1, 5, resolveColor('outfit', 'neutral-500'))
        break
      case 'coffee-cup':
        add(22, 23, 3, 3, resolveColor('outfit', 'neutral-200'))
        add(22, 24, 3, 1, resolveColor('hair', 'ink-700'))
        break
      case 'book':
        add(6, 22, 4, 5, accent ?? resolveColor('outfit', 'accent-rose'))
        add(7, 23, 2, 3, WHITE)
        break
    }
  }

  /* ---------------- 10) 手（最后画） ---------------- */
  if (state === 'working') {
    // 打字手已在姿态层带帧标记，这里不重复画
  } else if (state === 'thinking') {
    add(8, 25, 2, 2, skin) // 仅左手自然下垂
  } else if (state === 'waiting' || state === 'handoff' || state === 'cheer') {
    // 手已画在姿态层（举手/托物/上举），不重复画
  } else {
    add(8, 25, 2, 2, skin)
    add(22, 25, 2, 2, skin)
  }

  return R
}
