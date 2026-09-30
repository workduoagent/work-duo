/**
 * Pixel Agent 外观类型字典 v3（64×64 写实像素）。
 *
 * 与 v2 的差异：
 *  - 画布升到 64×64，支持描边 + 三阶明暗，轮廓接近「真实小人」；
 *  - 表情（FaceExpression）与动作（BodyPose）拆开，可由外部独立动态控制；
 *  - AgentMotionState 保留为高层状态（兼容旧调用），内部映射到 expression+pose；
 *  - appearance schema 不变，旧配置无需迁移。
 */

export type GenderType = 'male' | 'female'

/** 男士发型池 */
export type MaleHairStyle = 'm-buzz' | 'm-short' | 'm-spiky' | 'm-undercut' | 'm-curly'
/** 女士发型池 */
export type FemaleHairStyle = 'f-long' | 'f-bob' | 'f-twin' | 'f-ponytail' | 'f-bun'
/** 发型（按性别二选一池；存储为联合字符串） */
export type HairStyle = MaleHairStyle | FemaleHairStyle

/** 帽子 */
export type HatType = 'none' | 'cap' | 'beanie' | 'beret'
/** 上衣（男/女池不同，见 constants 服饰池） */
export type TopStyle =
  | 'm-tshirt'
  | 'm-hoodie'
  | 'm-shirt'
  | 'm-suit'
  | 'f-tshirt'
  | 'f-hoodie'
  | 'f-blouse'
  | 'f-dress'
/** 下装（连衣裙时为 'none'） */
export type BottomStyle = 'none' | 'trousers' | 'jeans' | 'shorts' | 'skirt'
/** 鞋子 */
export type ShoesStyle = 'sneakers' | 'boots' | 'formal' | 'heels'
/** 配饰 */
export type AccessoryType =
  | 'none'
  | 'glasses-black'
  | 'glasses-round'
  | 'earrings'
  | 'scarf'
  | 'headset'
  | 'cigarette'
/** 手持道具 */
export type PropType = 'none' | 'laptop' | 'coffee-cup' | 'book'

/**
 * 面部表情：外部可动态控制（与身体动作解耦）。
 * 由 PixelAgent 的 `expression` 驱动；不传时从 state 推导。
 */
export type FaceExpression =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'thinking'
  | 'focused'
  | 'tired'
  | 'wink'
  | 'talk'
  | 'love'

/**
 * 身体动作：外部可动态控制（与表情解耦）。
 * 由 PixelAgent 的 `pose` 驱动；不传时从 state 推导。
 */
export type BodyPose =
  | 'idle'
  | 'working'
  | 'thinking'
  | 'error'
  | 'waiting'
  | 'speaking'
  | 'handoff'
  | 'cheer'

/**
 * 高层动作状态（兼容旧调用）。内部映射为 expression + pose。
 * 弹窗试玩 / 小分队舞台可继续只传 state。
 */
export type AgentMotionState =
  | 'idle'
  | 'working'
  | 'thinking'
  | 'error'
  | 'waiting'
  | 'speaking'
  | 'handoff'
  | 'cheer'

/**
 * 形象配置。颜色一律存 **palette key**（非 hex 裸色），渲染期 resolveColor 解析；
 * topAccent 可选（帽檐外服装的点缀：领口/门襟/帽带等）。
 */
export interface PixelAgentAppearance {
  gender: GenderType
  skinColor: string
  hairStyle: HairStyle
  hairColor: string
  hat: HatType
  hatColor: string
  top: TopStyle
  topColor: string
  /** 服装点缀色（领口/门襟/口袋描边等），可选 */
  topAccent?: string
  bottom: BottomStyle
  bottomColor: string
  shoes: ShoesStyle
  shoesColor: string
  accessory: AccessoryType
  heldProp: PropType
}

/** 高层状态 → 表情 */
export function stateToExpression(state: AgentMotionState): FaceExpression {
  switch (state) {
    case 'working':
      return 'focused'
    case 'thinking':
      return 'thinking'
    case 'error':
      return 'surprised'
    case 'waiting':
      return 'neutral'
    case 'speaking':
      return 'talk'
    case 'handoff':
      return 'focused'
    case 'cheer':
      return 'happy'
    default:
      return 'neutral'
  }
}

/** 高层状态 → 动作 */
export function stateToPose(state: AgentMotionState): BodyPose {
  switch (state) {
    case 'working':
      return 'working'
    case 'thinking':
      return 'thinking'
    case 'error':
      return 'error'
    case 'waiting':
      return 'waiting'
    case 'speaking':
      return 'speaking'
    case 'handoff':
      return 'handoff'
    case 'cheer':
      return 'cheer'
    default:
      return 'idle'
  }
}

export interface PixelRenderOptions {
  state?: AgentMotionState
  /** 外部动态控制表情；优先于 state 推导 */
  expression?: FaceExpression
  /** 外部动态控制动作；优先于 state 推导 */
  pose?: BodyPose
}

/** 解析最终 expression + pose（外部显式值优先） */
export function resolveExpressionPose(opts: PixelRenderOptions = {}): {
  expression: FaceExpression
  pose: BodyPose
} {
  const state = opts.state ?? 'idle'
  return {
    expression: opts.expression ?? stateToExpression(state),
    pose: opts.pose ?? stateToPose(state),
  }
}
