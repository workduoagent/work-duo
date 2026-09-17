/**
 * 形象编辑面板 v3（游戏角色创建器式）。
 *
 * 按大分类渲染面板（section 由弹窗左侧导航下发）：
 *  - base      性别（卡片直接预览异性形象）+ 肤色块
 *  - hair      发型卡片（每项渲染对应像素小人）+ 发色块
 *  - outfit    小分类（帽子/上衣/下装/鞋子）级联 + 选项卡片 + 分层色块
 *  - accessory 配饰卡片
 *  - prop      道具卡片
 * 纯受控组件，不持有外观状态。
 */
import { useState, type ReactNode } from 'react'
import { Dices, RotateCcw, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui'
import {
  ACCESSORIES,
  DEFAULT_APPEARANCE,
  DEFAULT_FEMALE,
  GENDERS,
  HATS,
  PIXEL_PALETTE,
  PROPS,
  bottomPool,
  generateAvatarByScenario,
  hairPool,
  resolveColor,
  shoesPool,
  topPool,
} from './constants'
import { PixelAgent } from './PixelAgent'
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

export type DesignerSection = 'base' | 'hair' | 'outfit' | 'accessory' | 'prop'

const GENDER_LABELS: Record<GenderType, string> = { male: '男性', female: '女性' }

const HAIR_LABELS: Record<string, string> = {
  'm-buzz': '寸头',
  'm-short': '短发',
  'm-spiky': '刺猬头',
  'm-undercut': '背头',
  'm-curly': '卷发',
  'f-long': '长直发',
  'f-bob': '波波头',
  'f-twin': '双马尾',
  'f-ponytail': '马尾',
  'f-bun': '丸子头',
}

const TOP_LABELS: Record<string, string> = {
  'm-tshirt': 'T 恤',
  'm-hoodie': '连帽衫',
  'm-shirt': '衬衫',
  'm-suit': '西装',
  'f-tshirt': 'T 恤',
  'f-hoodie': '连帽衫',
  'f-blouse': '衬衫',
  'f-dress': '连衣裙',
}

const BOTTOM_LABELS: Record<string, string> = {
  none: '（连衣裙含）',
  trousers: '长裤',
  jeans: '牛仔裤',
  shorts: '短裤',
  skirt: '半身裙',
}

const SHOES_LABELS: Record<string, string> = {
  sneakers: '运动鞋',
  boots: '靴子',
  formal: '皮鞋',
  heels: '高跟鞋',
}

const HAT_LABELS: Record<string, string> = {
  none: '不戴',
  cap: '鸭舌帽',
  beanie: '毛线帽',
  beret: '贝雷帽',
}

const ACCESSORY_LABELS: Record<string, string> = {
  none: '无',
  'glasses-black': '黑框眼镜',
  'glasses-round': '圆框眼镜',
  earrings: '耳环',
  scarf: '围巾',
  headset: '耳机',
  cigarette: '香烟',
}

const PROP_LABELS: Record<string, string> = {
  none: '无',
  laptop: '笔记本',
  'coffee-cup': '咖啡',
  book: '书',
}

export interface AppearancePickerProps {
  section: DesignerSection
  value: PixelAgentAppearance
  onChange: (next: PixelAgentAppearance) => void
  scenario?: string
  seed?: string
}

/** 选项卡片：直接渲染施加该选项后的像素小人 */
function StyleCard({
  active,
  label,
  appearance,
  onClick,
  disabled,
}: {
  active: boolean
  label: string
  appearance: PixelAgentAppearance
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`pixel-style-card${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      <PixelAgent appearance={appearance} size={64} motion={false} />
      <span className="pixel-style-card__label">{label}</span>
    </button>
  )
}

/** 色块网格（游戏式色板，7 列；active 描边 + 对勾） */
function ColorGrid({
  family,
  current,
  onPick,
  allowNone,
  noneLabel,
}: {
  family: 'skin' | 'hair' | 'outfit'
  current: string | undefined
  onPick: (key: string) => void
  allowNone?: boolean
  noneLabel?: string
}) {
  return (
    <div className="pixel-colors">
      {allowNone && (
        <button
          type="button"
          className={`pixel-colors__none${!current ? ' is-active' : ''}`}
          title={noneLabel ?? '无'}
          onClick={() => onPick('')}
        >
          ×
        </button>
      )}
      {Object.keys(PIXEL_PALETTE[family]).map((key) => (
        <button
          key={key}
          type="button"
          className={`pixel-colors__block${current === key ? ' is-active' : ''}`}
          style={{ background: resolveColor(family, key) }}
          title={key}
          onClick={() => onPick(key)}
        />
      ))}
    </div>
  )
}

const RowLabel = ({ children }: { children: ReactNode }) => (
  <div className="pixel-picker__row-label">{children}</div>
)

export function AppearancePicker({
  section,
  value,
  onChange,
  scenario,
  seed,
}: AppearancePickerProps) {
  const [outfitSub, setOutfitSub] = useState<'hat' | 'top' | 'bottom' | 'shoes'>('top')
  const patch = (p: Partial<PixelAgentAppearance>) => onChange({ ...value, ...p })

  const switchGender = (g: GenderType) => {
    if (g === value.gender) return
    const base = g === 'male' ? DEFAULT_APPEARANCE : DEFAULT_FEMALE
    onChange({
      ...value,
      gender: g,
      hairStyle: base.hairStyle,
      top: base.top,
      topAccent: base.topAccent,
      bottom: base.bottom,
      shoes: base.shoes,
    })
  }

  const randomize = () => {
    const pickOf = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
    const top = pickOf(topPool(value.gender))
    onChange({
      ...value,
      skinColor: pickOf(Object.keys(PIXEL_PALETTE.skin)),
      hairStyle: pickOf(hairPool(value.gender)),
      hairColor: pickOf(Object.keys(PIXEL_PALETTE.hair)),
      hat: pickOf(HATS),
      hatColor: pickOf(Object.keys(PIXEL_PALETTE.outfit)),
      top,
      topColor: pickOf(Object.keys(PIXEL_PALETTE.outfit)),
      topAccent: Math.random() < 0.5 ? undefined : pickOf(Object.keys(PIXEL_PALETTE.outfit)),
      bottom: top === 'f-dress' ? 'none' : pickOf(bottomPool(value.gender, top)),
      bottomColor: pickOf(Object.keys(PIXEL_PALETTE.outfit)),
      shoes: pickOf(shoesPool(value.gender)),
      shoesColor: pickOf(Object.keys(PIXEL_PALETTE.outfit)),
      accessory: pickOf(ACCESSORIES),
      heldProp: pickOf(PROPS),
    })
  }

  return (
    <div className="pixel-picker">
      <div className="pixel-picker__actions">
        <Button variant="ghost" size="sm" icon={<Dices size={14} />} onClick={randomize}>
          随机
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Wand2 size={14} />}
          onClick={() => onChange(generateAvatarByScenario(scenario, seed))}
        >
          按场景推荐
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw size={14} />}
          onClick={() =>
            onChange(value.gender === 'female' ? { ...DEFAULT_FEMALE } : { ...DEFAULT_APPEARANCE })
          }
        >
          重置默认
        </Button>
      </div>

      {/* ---------------- 形象基础：性别 + 肤色 ---------------- */}
      {section === 'base' && (
        <>
          <RowLabel>性别（切换后发型与服饰按性别池重新钳制）</RowLabel>
          <div className="pixel-picker__cards">
            {GENDERS.map((g) => (
              <StyleCard
                key={g}
                active={value.gender === g}
                label={GENDER_LABELS[g]}
                appearance={{ ...value, gender: g }}
                onClick={() => switchGender(g)}
              />
            ))}
          </div>
          <RowLabel>肤色</RowLabel>
          <ColorGrid family="skin" current={value.skinColor} onPick={(k) => patch({ skinColor: k })} />
        </>
      )}

      {/* ---------------- 发型 + 发色 ---------------- */}
      {section === 'hair' && (
        <>
          <RowLabel>发型（{value.gender === 'male' ? '男性' : '女性'}款式）</RowLabel>
          <div className="pixel-picker__cards">
            {hairPool(value.gender).map((h) => (
              <StyleCard
                key={h}
                active={value.hairStyle === h}
                label={HAIR_LABELS[h]}
                appearance={{ ...value, hairStyle: h as HairStyle }}
                onClick={() => patch({ hairStyle: h as HairStyle })}
              />
            ))}
          </div>
          <RowLabel>发色</RowLabel>
          <ColorGrid family="hair" current={value.hairColor} onPick={(k) => patch({ hairColor: k })} />
        </>
      )}

      {/* ---------------- 服饰：帽子 / 上衣 / 下装 / 鞋子（级联） ---------------- */}
      {section === 'outfit' && (
        <>
          <div className="pixel-picker__sub">
            {(
              [
                ['hat', '帽子'],
                ['top', '上衣'],
                ['bottom', '下装'],
                ['shoes', '鞋子'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`pixel-picker__sub-tab${outfitSub === k ? ' is-active' : ''}`}
                onClick={() => setOutfitSub(k)}
              >
                {label}
              </button>
            ))}
          </div>

          {outfitSub === 'hat' && (
            <>
              <div className="pixel-picker__cards">
                {HATS.map((h) => (
                  <StyleCard
                    key={h}
                    active={value.hat === h}
                    label={HAT_LABELS[h]}
                    appearance={{ ...value, hat: h as HatType }}
                    onClick={() => patch({ hat: h as HatType })}
                  />
                ))}
              </div>
              {value.hat !== 'none' && (
                <>
                  <RowLabel>帽子颜色</RowLabel>
                  <ColorGrid
                    family="outfit"
                    current={value.hatColor}
                    onPick={(k) => patch({ hatColor: k })}
                  />
                </>
              )}
            </>
          )}

          {outfitSub === 'top' && (
            <>
              <div className="pixel-picker__cards">
                {topPool(value.gender).map((t) => (
                  <StyleCard
                    key={t}
                    active={value.top === t}
                    label={TOP_LABELS[t]}
                    appearance={{ ...value, top: t as TopStyle }}
                    onClick={() => {
                      const next = t as TopStyle
                      patch({
                        top: next,
                        bottom:
                          next === 'f-dress'
                            ? 'none'
                            : value.bottom === 'none'
                              ? 'skirt'
                              : value.bottom,
                      })
                    }}
                  />
                ))}
              </div>
              <RowLabel>上衣颜色</RowLabel>
              <ColorGrid family="outfit" current={value.topColor} onPick={(k) => patch({ topColor: k })} />
              <RowLabel>点缀色（领口 / 门襟 / 腰带）</RowLabel>
              <ColorGrid
                family="outfit"
                current={value.topAccent}
                onPick={(k) => patch({ topAccent: k || undefined })}
                allowNone
                noneLabel="无点缀"
              />
            </>
          )}

          {outfitSub === 'bottom' &&
            (value.top === 'f-dress' ? (
              <div className="pixel-picker__row-label">
                当前为连衣裙（自带裙摆），如需单独下装请先在「上衣」切换其他款式
              </div>
            ) : (
              <>
                <div className="pixel-picker__cards">
                  {bottomPool(value.gender, value.top).map((b) => (
                    <StyleCard
                      key={b}
                      active={value.bottom === b}
                      label={BOTTOM_LABELS[b]}
                      appearance={{ ...value, bottom: b as BottomStyle }}
                      onClick={() => patch({ bottom: b as BottomStyle })}
                    />
                  ))}
                </div>
                {value.bottom !== 'none' && (
                  <>
                    <RowLabel>下装颜色</RowLabel>
                    <ColorGrid
                      family="outfit"
                      current={value.bottomColor}
                      onPick={(k) => patch({ bottomColor: k })}
                    />
                  </>
                )}
              </>
            ))}

          {outfitSub === 'shoes' && (
            <>
              <div className="pixel-picker__cards">
                {shoesPool(value.gender).map((s) => (
                  <StyleCard
                    key={s}
                    active={value.shoes === s}
                    label={SHOES_LABELS[s]}
                    appearance={{ ...value, shoes: s as ShoesStyle }}
                    onClick={() => patch({ shoes: s as ShoesStyle })}
                  />
                ))}
              </div>
              <RowLabel>鞋子颜色</RowLabel>
              <ColorGrid family="outfit" current={value.shoesColor} onPick={(k) => patch({ shoesColor: k })} />
            </>
          )}
        </>
      )}

      {/* ---------------- 配饰 ---------------- */}
      {section === 'accessory' && (
        <div className="pixel-picker__cards">
          {ACCESSORIES.map((ac) => (
            <StyleCard
              key={ac}
              active={value.accessory === ac}
              label={ACCESSORY_LABELS[ac]}
              appearance={{ ...value, accessory: ac as AccessoryType }}
              onClick={() => patch({ accessory: ac as AccessoryType })}
            />
          ))}
        </div>
      )}

      {/* ---------------- 道具 ---------------- */}
      {section === 'prop' && (
        <>
          <div className="pixel-picker__cards">
            {PROPS.map((p) => (
              <StyleCard
                key={p}
                active={value.heldProp === p}
                label={PROP_LABELS[p]}
                appearance={{ ...value, heldProp: p as PropType }}
                onClick={() => patch({ heldProp: p as PropType })}
              />
            ))}
          </div>
          <div className="pixel-picker__row-label">
            提示：笔记本 / 咖啡 / 书在「待机」姿态下展示于手部；进入「工作」试玩时会切换为打字姿态
          </div>
        </>
      )}
    </div>
  )
}
