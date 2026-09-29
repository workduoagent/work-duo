/**
 * Pixel Agent 外观类型字典 v2（游戏级 32×32 重制）。
 *
 * 与 v1 的差异：
 *  - 新增性别（男/女），级联发型池与服饰池（帽子/上衣/下装/鞋子四层独立配色）；
 *  - 眼睛/嘴巴不再手动选——表情由动作状态（AgentMotionState）驱动；
 *  - 配饰扩充（眼镜×2 / 耳环 / 围巾 / 耳机 / 香烟）；
 *  - normalizeAppearance 负责旧版（16×16 时代）配置的迁移。
 *
 * appearance 只有两处消费：① 形象设计弹窗编辑态；② 可选落库列 agent_info.appearance
 * （再编辑源 JSON）。列表 / 聊天展示走 logo 快照（`<img>`），不消费本模块。
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
 * 动作状态：**仅形象设计弹窗预览用**（试玩分段），不落库、不进列表 / 聊天。
 * 表情（眼/嘴/姿态）由状态驱动：idle 平静静止 / working 打字 / thinking 托腮思考 / error 惊恐。
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
