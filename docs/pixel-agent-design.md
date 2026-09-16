# 拟人化像素智能体（Pixel Agent）设计方案

> 版本：v1.0（完整设计稿）  
> 范围：数据模型、类型字典、纯 SVG 渲染、状态机动效、统一展示出口、向导接入。  
> 原则：零外部游戏引擎；纯 SVG + CSS steps；SQLite 为单一事实源；对齐 work-duo 现有 mapper / draft / UI 约定。  
> DDL 边界：**本方案只声明字段变更，不写具体 SQL**；`init.sql` 与 `updater.sql` 由落地时按项目约定双写同步。

---

## 0. 产品定位与边界

### 0.1 一句话定位

为多智能体桌面端提供**可持久化装扮 + 可运行时动效**的像素小人形象，作为列表卡片、对话头像、未来协作画布的统一视觉资产；配置进库、渲染零依赖、多实例可扛。

### 0.2 解决什么问题

| 现状问题 | 本方案 |
| --- | --- |
| `logo` 存 Base64 data URL，体积大、不可主题化、无法表达状态 | 结构化 `appearance` JSON（约百字节级） |
| 列表 / 聊天 / 向导头像逻辑各自为政 | 统一出口组件 `AgentFace` |
| 无「在干活 / 在思考 / 出错了」的视觉反馈 | 运行时 `AgentMotionState` 驱动 CSS 动效 |
| 未来画布缺少角色辨识度 | 发型 / 服色 / 道具组合出可区分小人 |

### 0.3 非目标（v1 不做）

- Sprite sheet / Canvas / WebGL / 任何游戏引擎
- 逐帧序列动画、骨骼动画、物理
- 用户上传任意 PNG 当像素装扮贴图
- 小分队（squad）专属像素形象（表结构可复用同一约定，v1 不接 UI）
- 画布拖拽、导出 PNG 快照（预留 API 形状，不实现）

### 0.4 与现有资产体系的边界

| 资产 | 用途 | 是否被本方案替代 |
| --- | --- | --- |
| `agent_info.logo` | 历史 Base64 头像 | **保留字段，兼容回退**；向导不再引导写入 |
| `agent_info.appearance` | 新像素装扮 JSON | **新增，优先于 logo** |
| Skill 根目录 `logo.*` | 技能卡片头像 | 不动 |
| `knowledge_base.logo` / `agent_squad.logo` | 知识库 / 分队 | v1 不动 |

---

## 1. 数据库与持久化层

### 1.1 字段变更（交由你自行处理 DDL）

**表：`agent_info`**

| 操作 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| **新增** | `appearance` | TEXT，可空 | 外观配置 JSON 字符串；`NULL` = 未配置像素形象 |
| **保留** | `logo` | TEXT，可空 | 历史 Base64；代码层「只读回退、新流程不写」 |

**明确不删 `logo` 的原因：** SQLite 对旧版无 `DROP COLUMN` 时迁移成本高；且存量数据必须可展示。废弃策略是「渲染优先级淘汰」，不是物理删列。

**不新增的字段：**

- 不加 `appearance_version` 列（版本内嵌在 JSON 的 `v` 字段，见 1.3）
- 不加 `motion_state`（运行时态，不进库）
- 不为发型/颜色拆列（横向扩表成本高，JSON 单列即可）

**其它表：** v1 不改。未来若 squad 要像素风，建议同样加 `agent_squad.appearance`，约定复用。

### 1.2 类型映射落点（实现时改这些文件）

| 文件 | 变更 |
| --- | --- |
| `src/types/database.d.ts` | `AgentInfoRow` 增加 `appearance: string \| null` |
| `src/types/core.d.ts` | `AgentInfo` / `AgentUpsertInput` 增加 `appearance?: PixelAgentAppearance` |
| `src/pages/agent-studio/draft.ts` | `AgentDraft` 增加 `appearance?: PixelAgentAppearance`；`draftFromAgent` / `draftToInput` 双向带上 |
| `src/core/mapper/agent-mapper.ts` | `rowToAgent` 用既有 `safeParse`；`upsertAgent` 的列清单 / `VALUES` 占位符 / 参数数组 **三者同步 +1**，且 **`ON CONFLICT` 子句必须写入 `appearance`** |
| 同 mapper 的 `!isTauri` 分支 | localStorage 路径同样读写 `appearance` |

`upsertAgent` 当前为 21 列 / 21 个 `?` / 21 参；落地后必须为 **22 / 22 / 22**。只加列不加 `ON CONFLICT.excluded.appearance` 会导致「更新时装扮不落库」。

### 1.3 `appearance` JSON 形态

```ts
/** 库中 TEXT 的反序列化结果；v 为 schema 版本，便于未来演进 */
export interface PixelAgentAppearanceJson extends PixelAgentAppearance {
  /** schema 版本，当前固定 1；解析时未知字段忽略，缺字段用 DEFAULT 补齐 */
  v?: 1
}
```

序列化示例（实际很短）：

```json
{
  "v": 1,
  "skinColor": "skin-warm-02",
  "hairType": "short_neat",
  "hairColor": "ink-900",
  "eyesType": "normal",
  "mouthType": "neutral",
  "accessory": "none",
  "outfitType": "hoodie",
  "outfitColor": "accent-indigo",
  "outfitSubColor": "ink-700",
  "heldProp": "none"
}
```

**颜色一律存 palette key，不存裸 hex。** 理由：暗色主题描边可统一、色板可整体换肤、避免用户选出「糊在深底上看不见」的色。自由取色若必须支持，约定 `raw:#RRGGBB` 前缀作为 escape hatch（v1 不做 UI）。

### 1.4 Mapper 伪代码（对齐现有 `safeParse`）

```ts
// rowToAgent
appearance: safeParse<PixelAgentAppearanceJson | null>(r.appearance, null) ?? undefined,
// ↑ 坏 JSON / 空串 → undefined，UI 走 logo 或默认小人，绝不 throw

// upsertAgent 参数数组末尾附近
toJson(input.appearance as Record<string, unknown> | undefined), // 已有 toJson 可扩展入参类型
```

`toJson` 现签名是 `Record<string, unknown> | undefined`，`PixelAgentAppearance` 结构兼容；若要严格，可放宽为对象字面量类型。

### 1.5 兼容回退链（全站唯一约定）

```text
appearance 有效  →  渲染 <PixelAgent>
否则 logo 非空    →  渲染 <img src={logo}>（存量 Base64）
否则              →  <PixelAgent appearance={DEFAULT_APPEARANCE} /> 或 lucide Bot 图标（小尺寸列表可简）
```

「有效」定义：`safeParse` 成功且 `hairType` 等关键枚举落在字典内；否则视为 `undefined`，合并 `DEFAULT_APPEARANCE` 后仍可画，不阻断列表。

---

## 2. 核心数据结构与字典

### 2.1 文件布局

```text
src/components/ui/pixel-agent/
  types.ts           # 外观类型、动作状态、Props
  constants.ts       # PIXEL_PALETTE、DEFAULT_APPEARANCE、SCENARIO_PRESETS
  parse.ts           # normalizeAppearance(raw)：校验 + 缺省合并
  layers.tsx         # Hair / Eyes / Mouth / Accessory / Outfit / Prop 图层
  PixelAgent.tsx     # 渲染根组件（memo）
  PixelAgent.scss    # 布局 + 状态关键帧
  AgentFace.tsx      # 统一展示出口（appearance → logo → fallback）
  AppearancePicker.tsx
  index.ts           # barrel：AgentFace / PixelAgent / types / presets
```

页面与 mapper **只依赖 `@/components/ui/pixel-agent` 的 barrel**，不深挖内部路径。

### 2.2 静态外观

MVP 枚举刻意收窄（装扮空间够用，图元工作量可控）；括号内为 Phase 2 扩展。

```ts
export type HairType =
  | 'bald' | 'buzz' | 'short_neat' | 'spiky'   // MVP
  // Phase2: | 'curly_bob' | 'long_straight' | 'ponytail' | 'critic_wig' | 'cyber_cap' | 'beanie'
export type EyesType = 'normal' | 'focused' | 'sparkle'  // Phase2: 'squint' | 'cyber_visor' | 'sleepy'
export type MouthType = 'neutral' | 'smile' | 'open_talk' // Phase2: 'smug' | 'mustache'
export type AccessoryType = 'none' | 'glasses_black' | 'headset' // Phase2: gold / blush / eyepatch
export type OutfitType = 'hoodie' | 'tshirt' | 'lab_coat' // Phase2: suit_tie / plaid / overalls
export type PropType = 'none' | 'laptop' | 'coffee_cup'   // Phase2: magnifier / wrench / book

export interface PixelAgentAppearance {
  /** palette key，见 PIXEL_PALETTE */
  skinColor: string
  hairType: HairType
  hairColor: string
  eyesType: EyesType
  mouthType: MouthType
  accessory: AccessoryType
  outfitType: OutfitType
  outfitColor: string
  /** 可选点缀色（领口/袖口等）；缺省 = outfitColor 的邻近色或不绘 */
  outfitSubColor?: string
  heldProp: PropType
}
```

### 2.3 调色板（`constants.ts`）

```ts
export const PIXEL_PALETTE = {
  skin: {
    'skin-warm-01': '#F6D7B0',
    'skin-warm-02': '#E8B88A',
    'skin-deep-01': '#C68642',
    'skin-deep-02': '#8D5524',
    'skin-cool-01': '#E0C3A0',
  },
  hair: {
    'ink-900': '#1E1B14',
    'ink-700': '#3D2B1F',
    'accent-amber': '#C47B2C',
    'accent-indigo': '#3D4F8C',
    'accent-rose': '#A64D63',
    'neutral-400': '#9AA0A6',
  },
  outfit: {
    'accent-indigo': '#3D4F8C',
    'accent-emerald': '#2F6B4F',
    'accent-amber': '#C47B2C',
    'accent-rose': '#A64D63',
    'neutral-700': '#3C4043',
    'neutral-200': '#E8EAED',
    'ink-900': '#1E1B14',
  },
} as const

export type PaletteFamily = keyof typeof PIXEL_PALETTE
/** 解析：palette key → hex；raw:#RRGGBB 直通；未知 key → 该家族默认色 */
export function resolveColor(family: PaletteFamily, key: string | undefined): string
```

### 2.4 默认外观与场景预设

```ts
export const DEFAULT_APPEARANCE: PixelAgentAppearance = {
  skinColor: 'skin-warm-02',
  hairType: 'short_neat',
  hairColor: 'ink-900',
  eyesType: 'normal',
  mouthType: 'neutral',
  accessory: 'none',
  outfitType: 'hoodie',
  outfitColor: 'accent-indigo',
  heldProp: 'none',
}

/**
 * 按 agent_info.scenario（scope=AGENT 字典 value）给默认装扮。
 * 优先级：用户已保存 appearance > scenario 预设 > DEFAULT。
 * 不用「名字关键词猜人设」——与 scenario 字典重复且脆。
 */
export const SCENARIO_PRESETS: Partial<Record<string, PixelAgentAppearance>> = {
  'dev-programming': { ...DEFAULT_APPEARANCE, outfitType: 'hoodie', outfitColor: 'neutral-700', heldProp: 'laptop', eyesType: 'focused' },
  'customer-service': { ...DEFAULT_APPEARANCE, mouthType: 'smile', outfitType: 'tshirt', outfitColor: 'accent-emerald', accessory: 'headset' },
  'data-analysis': { ...DEFAULT_APPEARANCE, outfitType: 'lab_coat', outfitColor: 'neutral-200', heldProp: 'coffee_cup', eyesType: 'focused' },
  'content-creation': { ...DEFAULT_APPEARANCE, outfitColor: 'accent-rose', mouthType: 'smile', hairType: 'spiky' },
  'office-efficiency': { ...DEFAULT_APPEARANCE, outfitType: 'tshirt', outfitColor: 'accent-indigo', heldProp: 'coffee_cup' },
  'education': { ...DEFAULT_APPEARANCE, mouthType: 'smile', outfitColor: 'accent-amber' },
  'life-service': { ...DEFAULT_APPEARANCE, outfitType: 'tshirt', outfitColor: 'accent-emerald', mouthType: 'smile' },
}

/** 新建向导用：scenario 有预设则用预设，否则 DEFAULT；再按 identifier 稳定微调（避免每次进页乱跳） */
export function generateAvatarByScenario(scenario?: string, seed?: string): PixelAgentAppearance
```

**稳定微调规则（seed 有值时）：** 对 seed 做简易 hash，在「发型枚举」与「皮肤 palette」上做有限扰动；**不改** `outfitType` / `accessory`（保持场景语义）。同一 `identifier` 永远得到同一结果。

### 2.5 运行时动作状态

```ts
export type AgentMotionState =
  | 'idle'        // 待命：微弱呼吸
  | 'working'     // 执行中：敲击 / 轻微起伏
  | 'thinking'    // 推理：侧头 + 托腮
  | 'inspecting'  // 审计/挑刺：举放大镜（Phase2 完整）
  | 'walking'     // 巡检/遍历：双腿交替（Phase2 完整）
  | 'error'       // 阻断/失败：抱头震颤
```

**状态从哪来（数据源约定）：**

| 场景 | 状态映射 |
| --- | --- |
| 调试对话页 | 会话执行中 → `working`；等待用户/空闲 → `idle`；模型思考事件 → `thinking`；会话失败 → `error` |
| 列表卡片 | 默认 `idle`（或不带动效，见 3.5 尺寸策略） |
| 未来协作画布 | 由节点 runtime 状态机写入，本方案只定义枚举与视觉 |

v1 **不要求**后端新事件；调试页可先用现有会话 `status` / 请求 pending 标志映射。映射函数单独放 `motion.ts`，避免散落 if-else。

```ts
// motion.ts — 调试页 / 未来画布共用
export function motionFromSession(s: {
  status?: string
  isStreaming?: boolean
  isThinking?: boolean
  hasError?: boolean
}): AgentMotionState
```

### 2.6 归一化

```ts
// parse.ts
export function normalizeAppearance(raw: unknown): PixelAgentAppearance {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<PixelAgentAppearance>
  return {
    skinColor: pickColor('skin', o.skinColor, DEFAULT_APPEARANCE.skinColor),
    hairType: pickEnum(HAIR_SET, o.hairType, DEFAULT_APPEARANCE.hairType),
    // ...每字段：非法 → DEFAULT
  }
}
```

所有从库、从 localStorage、从向导回来的值必须先过 `normalizeAppearance`，保证 SVG 层永远收到合法枚举。

---

## 3. 纯 SVG 多图层渲染

### 3.1 网格硬约束（修订上一稿）

| 约定 | 值 |
| --- | --- |
| `viewBox` | `0 0 16 16` |
| 坐标 | **必须为整数**；禁止 `0.5` / `1.5` |
| 手 / 脚 | 1×1 或 2×2 整数方块 |
| `shapeRendering` | `crispEdges` |
| 外层 | `image-rendering: pixelated` |
| 缩放 | 仅靠 CSS 容器宽高（48px / 32px / 24px），内部不改 viewBox |

半像素会破坏 crispEdges，上一稿 `width="1.5"` 写法废弃。

### 3.2 组件结构

```tsx
export interface PixelAgentProps {
  state?: AgentMotionState
  appearance?: PixelAgentAppearance
  /** 逻辑像素边长，默认 48；仅影响外层盒子 */
  size?: number
  /** 自定义气泡文案；不传则按 state 显示图标气泡；size≤32 强制无气泡 */
  bubbleText?: string
  /** 关闭动画（列表密集场景 / reduced-motion） */
  motion?: boolean
}

export const PixelAgent = memo(function PixelAgent(props: PixelAgentProps) {
  const cfg = normalizeAppearance(props.appearance)
  const skin = resolveColor('skin', cfg.skinColor)
  const hair = resolveColor('hair', cfg.hairColor)
  const outfit = resolveColor('outfit', cfg.outfitColor)
  const sub = cfg.outfitSubColor
    ? resolveColor('outfit', cfg.outfitSubColor)
    : outfit
  const showBubble = (props.bubbleText || props.state) && props.size > 32
  const animate = props.motion !== false

  return (
    <div
      className={cx(
        'pixel-agent',
        `pixel-agent--${props.state ?? 'idle'}`,
        animate && 'pixel-agent--anim',
      )}
      style={{ width: props.size, height: props.size }}
      data-skin={skin}
      data-hair={hair}
      data-outfit={outfit}
      data-sub={sub}
    >
      {showBubble && (
        <div className="pixel-agent__bubble">
          {props.bubbleText ?? <MotionBubbleIcon state={props.state ?? 'idle'} />}
        </div>
      )}
      <svg className="pixel-agent__svg" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden>
        {/* 脚 → 身体/头 → 服装 → 五官/发 → 道具 → 手（手在最前便于动） */}
        <FootLayer fill="#0f172a" />
        <BodyLayer skin={skin} />
        <HeadBase skin={skin} />
        <OutfitLayer type={cfg.outfitType} fill={outfit} sub={sub} />
        <HairLayer type={cfg.hairType} fill={hair} />
        <EyesLayer type={cfg.eyesType} />
        <MouthLayer type={cfg.mouthType} />
        <AccessoryLayer type={cfg.accessory} />
        <PropLayer type={cfg.heldProp} className="p-prop" />
        <Hands skin={skin} />
      </svg>
      <div className="pixel-agent__shadow" />
    </div>
  )
})
```

**与上一稿的差异：**

1. 颜色经 `data-*` 注入，避免 `@ts-expect-error` 与 CSS 变量类型问题；SCSS 用 `attr()` 不可靠，改为 **渲染期解析 hex 直接作 `fill`**，`data-*` 仅作调试/测试。真正 fill 在 SVG 属性上传入，最稳。
2. 图层顺序显式固定：脚 → 体 → 头基座 → 服 → 发 → 眼 → 嘴 → 饰 → 道具 → 手。
3. `memo` + `normalizeAppearance`：父级传入不稳定引用时，内部以解析后配置渲染；父级建议用 store 保持引用稳定（见 3.6）。

### 3.3 几何骨架（16×16，整数）

```text
y= 0..2   发区（按 hairType）
y= 3..9   头（x=5..10 皮肤）+ 五官
y= 8..12  躯干（按 outfitType，x=4..11）
y=10..11  手（左右各 1..2 格）
y=13..14  脚（x=5..6 与 9..10）
y=15      阴影可用（也可用外层 div 硬边椭圆，见下）
```

`layers.tsx` 内每个图层用 `switch (type)` 返回一组 `<rect>`；**不要**拆成十几文件。

Outfit 示意：

- `hoodie`：躯干主色 + 连帽后脑块（用 sub 色）+ 前襟中线
- `tshirt`：躯干主色，无帽
- `lab_coat`：偏白主色 + 中线 + 可选口袋 1 格

Prop：

- `laptop`：手前 3×2 深色块 + 1px 亮色屏
- `coffee_cup`：2×2 杯 + 1px 口
- `none`：不绘制

### 3.4 气泡与阴影

- **气泡**：绝对定位在容器上方；`size≤32` 不渲染（列表密度优先）。文案超长截断一行 + title。
- **阴影**：不用 `filter: blur`。用容器 `::after` 画 **硬边椭圆色块**（圆角 rect 或两圆叠加），颜色 `rgba(15,23,42,0.18)`，与主题无关。

### 3.5 尺寸档位

| size | 气泡 | 动效默认 | 典型位置 |
| --- | --- | --- | --- |
| 64–96 | 开 | 全量 | 向导预览、画布节点 |
| 48 | 开 | 全量 | 对话头像（若有空间） |
| 32 | 关 | 仅 idle 呼吸或静帧 | 列表卡片 |
| 24 | 关 | 静帧 | 消息流小头像 |

`AgentFace` 按 size 自动套档，调用方不必记规则。

### 3.6 性能

- `React.memo` + 父级稳定 appearance 引用（draft 用局部 patch，避免每次 `={...}` 新对象；列表从 mapper 读，勿在 render 里 `normalize` 后当 prop）。
- 画布未来若 10+ 实例：折叠节点传 `motion={false}`；或 CSS `animation-play-state: paused`。
- 不引入 RAF；状态切换只换 class，动画全在 CSS。

---

## 4. 状态机与 CSS 步进动画

### 4.1 文件与原则

- 全部在 `PixelAgent.scss`
- 纯 CSS，无 JS 补间
- 步进用 `steps(n)`，连续缓动仅用于呼吸类
- **必须**响应 `prefers-reduced-motion`

### 4.2 关键帧总表

| 状态 | 作用对象 | 动画 | 备注 |
| --- | --- | --- | --- |
| `idle` | head+body | `p-breathe` 2.4s ease-in-out infinite alternate | `scaleY(1 → 1.03)`，微弱 |
| `working` | svg | `p-work-bob` 0.28s steps(2) infinite alternate | 身体轻起伏 |
| `working` | hands | `p-type-l` / `p-type-r` 0.16s steps(2) infinite alternate | 交替抬落 |
| `thinking` | head | `p-head-tilt` 1.2s ease-in-out infinite alternate | 旋转 4° 左右 |
| `thinking` | hand-right | 静态 `translate(-1px,-2px)` | 托腮 |
| `inspecting` | prop / hand | Phase2：放大镜轻微上下 | v1 可先静态举手 |
| `walking` | feet | Phase2：`p-step` 0.3s steps(2) | v1 仅枚举预留 |
| `error` | svg | `p-shake` 0.16s steps(2) infinite | ±1.5px 水平 |
| `error` | hands | 静态抬至头侧 | 抱头 |

### 4.3 SCSS 骨架

```scss
.pixel-agent {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  user-select: none;

  &__svg {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    overflow: visible;
  }

  &__shadow {
    position: absolute;
    left: 15%;
    right: 15%;
    bottom: -2px;
    height: 3px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.18);
  }

  // SVG 内可动节点
  .p-head, .p-body, .p-hand, .p-foot, .p-prop {
    transform-box: fill-box;
    transform-origin: center bottom;
  }
}

.pixel-agent--anim.pixel-agent--idle {
  .p-head, .p-body { animation: p-breathe 2.4s infinite ease-in-out alternate; }
}
.pixel-agent--anim.pixel-agent--working {
  .pixel-agent__svg { animation: p-work-bob 0.28s infinite alternate steps(2); }
  .p-hand--left  { animation: p-type-l 0.16s infinite alternate steps(2); }
  .p-hand--right { animation: p-type-r 0.16s infinite alternate steps(2); }
}
.pixel-agent--anim.pixel-agent--thinking {
  .p-head { animation: p-head-tilt 1.2s infinite alternate ease-in-out; }
  .p-hand--right { transform: translate(-1px, -2px); }
}
.pixel-agent--anim.pixel-agent--error {
  .pixel-agent__svg { animation: p-shake 0.16s infinite steps(2); }
  .p-hand--left  { transform: translate(1px, -3px); }
  .p-hand--right { transform: translate(-1px, -3px); }
}

@keyframes p-breathe {
  from { transform: scaleY(1); }
  to   { transform: scaleY(1.03); }
}
@keyframes p-work-bob {
  from { transform: translateY(0); }
  to   { transform: translateY(-1px); }
}
@keyframes p-type-l {
  from { transform: translateY(0); }
  to   { transform: translateY(-1px); }
}
@keyframes p-type-r {
  from { transform: translateY(-1px); }
  to   { transform: translateY(0); }
}
@keyframes p-head-tilt {
  from { transform: rotate(-4deg); }
  to   { transform: rotate(4deg); }
}
@keyframes p-shake {
  0%   { transform: translateX(0); }
  50%  { transform: translateX(-1px); }
  100% { transform: translateX(1px); }
}

@media (prefers-reduced-motion: reduce) {
  .pixel-agent--anim,
  .pixel-agent--anim * {
    animation: none !important;
  }
}
```

### 4.4 WebView 兼容验证项（落地自测清单）

在 **Windows WebView2**（Tauri 默认）与若有的 macOS WKWebView 上验证：

1. `transform-box: fill-box` 对 `<rect>` / `<g>` 是否生效  
2. `crispEdges` 在整数坐标下是否无半像素糊边  
3. 从 `idle` → `working` → `error` 切换是否无残影（必要时给非目标类显式 `animation: none`）

若 `fill-box` 异常：改为给可动部件外包一层 `<g class="p-head">`，对 `<g>` 做 transform（兼容面更好）。

---

## 5. 统一展示出口 `AgentFace`

### 5.1 为什么必须有

现消费点：

| 位置 | 文件 |
| --- | --- |
| 列表卡片头像 | `src/pages/agent-studio/index.tsx`（约 209 行） |
| 聊天消息头像 | `src/pages/agent-studio/chat/MessageList.tsx` |
| 向导预览 | `StepBasic` 替换上传后 |

项目还包了 antd `Avatar` / `AvatarGroup`。自定义 SVG 塞不进 antd Avatar 的 `src` 体系，**不要**试图「把 SVG 序列化成 data URL 再喂给 antd」——会丢动效且增大字符串。正确做法：这些展示点改为自有组件。

### 5.2 API

```tsx
export interface AgentFaceProps {
  /** 有 appearance / logo 即可 */
  agent: Pick<AgentInfo, 'name' | 'logo' | 'appearance'> & { scenario?: string }
  size?: number
  state?: AgentMotionState
  /** 无 appearance 时是否按 scenario 生成默认像素形象（新建预览 true；存量列表 true 也可） */
  fallbackToScenario?: boolean
  bubbleText?: string
  className?: string
}

export function AgentFace({ agent, size = 32, state = 'idle', ... }: AgentFaceProps) {
  // 1) appearance → PixelAgent
  // 2) logo → <img className="agent-face__img" />
  // 3) fallbackToScenario && scenario → PixelAgent(generateAvatarByScenario)
  // 4) else PixelAgent(DEFAULT) 或 size 很小时 Bot 图标（可选，保持像素统一更好都用 DEFAULT）
}
```

### 5.3 接入改造清单（只列行为，不改 DDL）

| 文件 | 改动 |
| --- | --- |
| `agent-studio/index.tsx` | 卡片头像改为 `<AgentFace agent={agent} size={32} motion={false 走 size 档} />` |
| `chat/MessageList.tsx` | 助手头像改为 `<AgentFace size={24} state={…或 idle} />` |
| `StepBasic.tsx` | 移除 file input 上传；替换为 `<AppearancePicker />`，预览即 AgentFace |
| `draft.ts` | 增加 `appearance` 字段与映射 |
| `wizard.tsx` / 提交路径 | `draftToInput` 带上 appearance；**新流程不再写入 logo**（已有 logo 的编辑保存时保留原值，不清空） |

**logo 写入策略（重要）：**

- 新建：不写 logo  
- 编辑：若 draft 来源已有 logo，保留；用户在向导里配置了 appearance 后，**仍保留旧 logo**（回退链用），不在 v1 做「一键清除 logo」  
- 需要时可加次要操作「清除旧头像」，属 Phase2

---

## 6. 外观选择器 `AppearancePicker`

### 6.1 布局

```text
┌─────────────────────────────────────────────┐
│  [ 预览区 96px：PixelAgent state=idle ]     │
│  [ 随机 ] [ 重置默认 ]                      │
├─────────────────────────────────────────────┤
│ 分段：发型 | 眼 | 嘴 | 配饰 | 服装 | 道具   │
│  （图标或小图预览按钮，点选切换）            │
├─────────────────────────────────────────────┤
│ 肤色色板    发色色板    服色色板    点缀色板 │
│  （circle/swatch，只列当前 family）          │
└─────────────────────────────────────────────┘
```

### 6.2 Props

```tsx
export interface AppearancePickerProps {
  value: PixelAgentAppearance
  onChange: (next: PixelAgentAppearance) => void
  /** 有则显示「按场景推荐」按钮 */
  scenario?: string
  previewState?: AgentMotionState // 默认 idle
}
```

### 6.3 交互规则

- 任一变更 → `onChange` 下一帧完整对象（不可变更新）
- 「按场景推荐」→ `generateAvatarByScenario(scenario, draft.identifier)`  
- 「随机」→ 在 MVP 枚举内均匀抽样，肤色/发色/服色从对应 palette 抽  
- 预览区 `size=96`，始终开气泡关（预览不需要）  
- 选项按钮用小型静态 `PixelAgent` 局部或纯图标 + 文案；避免每个选项都挂全套动画（`motion={false}`）

### 6.4 向导集成

`StepBasic` 身份区：

```text
[ AppearancePicker 占左侧或整行 ]
[ 名称 / 标识 / 场景 / 欢迎消息 仍在右侧或下方 ]
```

场景 `ScenarioSelect` 的 `onChange` 在 **appearance 仍等于「进入时的值」或「空」** 时，自动套用新 scenario 预设；若用户已手动改过装扮，不覆盖（本地 `dirty` 标志）。

---

## 7. 与运行时状态的接线（v1 最小）

### 7.1 调试对话页

在聊天页已有 agent 对象处：

```tsx
const state = motionFromSession({
  status: session?.status,
  isStreaming,
  isThinking,
  hasError: !!session?.errorMessage,
})
<AgentFace agent={agent} size={32} state={state} />
```

`isStreaming` / `isThinking` 来自现有请求层状态；无则 v1 可先恒 `idle`，接口先留好。

### 7.2 列表

恒 `idle` 或静帧（size=32 档）。不接事件，避免列表无谓重绘。

### 7.3 未来画布（预留，不实现）

- 节点组件收 `runtimeState: AgentMotionState`
- 节点 ID ↔ `agent.id`；外观从列表已加载的 `AgentInfo` 取，不另查库
- 折叠 / 视口外：`motion={false}`

---

## 8. 完整落地顺序（工程任务拆解）

> 每步可单独 PR/自检；DDL 两步由你按 1.1 字段说明自行写入 `init.sql` + `updater.sql`。

| 序 | 任务 | 验收 |
| --- | --- | --- |
| 0 | 你完成 DDL：`agent_info.appearance`；`init.sql` 建表含列 + `updater.sql` ALTER | 新装/存量库均可选可写该列 |
| 1 | `types.ts` + `constants.ts` + `parse.ts` | 单测或手动：脏 JSON → 默认配置 |
| 2 | `database.d.ts` / `core.d.ts` / `draft.ts` 字段贯通 | 类型检查通过 |
| 3 | `agent-mapper` 读写 + localStorage 分支 + 22 列三要素 + ON CONFLICT | 装扮保存后重启仍在 |
| 4 | `layers.tsx` + `PixelAgent` 静态渲染（整数网格） | 6 种 outfit 枚举可切换 |
| 5 | `PixelAgent.scss` 动效 idle/working/thinking/error + reduced-motion | WebView2 下动作正确 |
| 6 | `AgentFace` + 列表/聊天接入 | 老 logo 智能体仍显示；新配置走像素 |
| 7 | `AppearancePicker` + StepBasic 替换上传 | 向导可编辑并落库 |
| 8 | `generateAvatarByScenario` + 场景切换 dirty 逻辑 | 换场景有推荐、手改不覆盖 |
| 9 | Phase2：枚举扩容、walking/inspecting、squad、导出 | 另开方案 |

---

## 9. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 库中 appearance 损坏 | `safeParse` + `normalizeAppearance` 双层；永不 throw |
| 与 logo 双轨混乱 | 固定回退链；文档写死；UI 只用 `AgentFace` |
| 动效在 WebView 异常 | 4.4 清单；异常则 `<g>` 包裹降级 |
| 列表性能 | size 档位关气泡关动画 |
| 枚举演进 | JSON `v` 字段 + normalize 忽略未知 |
| upsert 三要素不一致 | code review 强制对照 22/22/22 与 ON CONFLICT |

**回滚：** 字段与读路径保持兼容；出问题可让 `AgentFace` 短暂强制走 logo 分支（feature 开关一行），无需回滚 DDL。

---

## 10. 验收清单（Definition of Done）

- [ ] 存量库迁移后，旧智能体列表/聊天头像不丢  
- [ ] 新建智能体可选发型/服色/道具，保存后重启回显  
- [ ] `appearance` 非法 JSON 时列表仍可打开，显示默认像素或 logo  
- [ ] 列表 size=32 无气泡、无高频动画  
- [ ] 对话中 `working` / 失败 `error` 视觉可区分  
- [ ] 系统「减少动画」开启时无 shake/呼吸  
- [ ] 向导不再强制引导上传 Base64；已有 logo 不被静默清空  
- [ ] `upsertAgent` 列/占位符/参数 22=22=22，且 UPDATE 含 appearance  
- [ ] Windows WebView2 下 crispEdges 无半像素糊边  

---

## 附录 A：上一稿明确废弃的点

| 废弃 | 替代 |
| --- | --- |
| `width="1.5"` / 半像素坐标 | 全整数 16 网格 |
| CSS 变量 `@ts-expect-error` 注入 | 渲染期解析 hex 作 `fill` |
| `JSON.parse` 裸调用 | `safeParse` + `normalizeAppearance` |
| `generateAvatarByName` 关键词猜人设 | `generateAvatarByScenario` + seed 微调 |
| 只改向导一处 | `AgentFace` 覆盖列表/聊天/向导 |
| 6 状态 CSS 一次做完 | MVP 四态，walking/inspecting Phase2 |
| 大枚举一次上齐 | MVP 3–4 发型 / 3 眼 / 3 服 等 |

## 附录 B：字段变更速查（给 DDL）

```text
表 agent_info
  + appearance TEXT NULL     -- 外观 JSON
  （logo 保留，不删）

不改：agent_mcp_ref / agent_skill_ref / agent_squad* / 其它表
```
