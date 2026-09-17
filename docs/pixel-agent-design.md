# 拟人化像素智能体（Pixel Agent）设计方案

> 版本：v1.2（形象设计弹窗 → logo 快照）  
> 范围：形象设计器弹窗、SVG→PNG 快照、向导接入。  
> 原则：零外部游戏引擎；纯 SVG 设计源；**展示链路完全复用现有 `logo`**；列表 / 聊天零改造。  
> DDL 边界：本方案只声明字段变更，不写具体 SQL。  
> 产品决策（已确认）：原先「Logo 头像上传」升级为「形象设计」；保存时生成 Base64 PNG 写入 `logo`。

---

## 0. 产品定位与边界

### 0.1 一句话定位

用户点开头像进入【形象设计】弹窗，捏一个像素小人；点保存时把当前形象**栅格化成 Base64 PNG，写入既有 `agent_info.logo`**。全站继续 `<img src={logo}>`，不需要改列表、聊天、antd Avatar。

### 0.2 信息流

```text
StepBasic 头像区（原「点击上传」）
        │ 点击
        ▼
┌──────────────────────────┐
│   形象设计 Modal          │
│  ┌────────┐  控件区       │
│  │实时预览 │  发型/眼/嘴…  │
│  │PixelAgent│ 色板/道具    │
│  └────────┘              │
│  [取消]  [保存形象]       │
└──────────────────────────┘
        │ 保存
        ├─（可选）appearance JSON → agent_info.appearance  // 再编辑源
        └─ SVG → Canvas → PNG dataURL → agent_info.logo   // 展示唯一来源
        │
        ▼
draft.logo / upsertAgent.logo
        │
        ▼
列表卡片、聊天头像等现有 <img> 消费点（零改造）
```

### 0.3 为什么这样做（相对上一稿）

| 方案 | DDL | 列表/聊天改造 | 动效 | 二次编辑 |
| --- | --- | --- | --- | --- |
| A. appearance 优先渲染 + logo 回退 | +1 列 | 必须改（AgentFace） | 可做 | 天然支持 |
| **B. 形象设计 → 快照写 logo（本方案）** | **0（或可选 +1）** | **不改** | 展示层无 live 动效 | 依赖可选 appearance 列 |
| C. 只写 logo，不存配置 | 0 | 不改 | 无 | **丢失手调结果** |

**结论：B 是对的。** 展示用静态快照足够；动效留给「设计弹窗预览」和未来画布，不塞进消息流。

### 0.4 二次编辑：强烈建议仍加 `appearance`

只写 logo 时，第二次打开形象设计只能从默认/场景预设重来，用户手调的发型颜色全丢。

**推荐：**

- **必做**：`logo` = 快照（展示）
- **建议**：`appearance` = 配置（再编辑源）；`NULL` 表示「从未用形象设计生成过」或「仅有历史上传图」

若你确定 v1 不需要二次编辑，可跳过 `appearance` 列与 mapper 改动，只做弹窗 + 快照写 logo；需要时再补列（见 §1.1 可选字段）。

### 0.5 非目标（v1 不做）

- 游戏引擎 / Sprite / 骨骼 / 物理
- 从已有 Base64 反推外观配置
- 用户上传任意 PNG 当装扮贴图
- 列表 / 聊天里的 live 状态动效（working/error 等）
- 小分队形象、画布拖拽、社交导出

---

## 1. 数据层

### 1.1 字段变更（DDL 你处理）

**表：`agent_info`**

| 操作 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| **继续使用** | `logo` | TEXT，可空 | **展示用快照**：形象设计生成的 PNG data URL，或历史用户上传图 |
| **建议新增（可选）** | `appearance` | TEXT，可空 | 形象配置 JSON；下次打开弹窗的编辑源；`NULL` = 无结构化配置 |

**明确：**

- **不删 `logo`**——它是唯一展示来源
- **不把 motion 状态写进库**——运行时态
- **不用 hex 裸色进库**——配置里存 palette key（仅当加了 `appearance`）
- 其它表 v1 不改

**若跳过可选列：** 只改前端（弹窗 + 快照），`upsertAgent` / Row 类型不动。

### 1.2 类型与代码落点

#### 必做（不依赖新列）

| 文件 | 变更 |
| --- | --- |
| `src/components/ui/pixel-agent/*` | 新建：types / constants / layers / PixelAgent / snapshot / AppearancePicker |
| `src/pages/agent-studio/components/StepBasic.tsx` | 移除 `file` 上传；改为形象预览 + 点击打开 Modal |
| 新建 `AppearanceModal.tsx`（或并入 pixel-agent） | 弹窗壳：预览 + Picker + 保存/取消 |
| `draft.ts` | 保存时 `logo` 来自快照，而不是 FileReader 上传 |

#### 若加 `appearance` 列（建议）

| 文件 | 变更 |
| --- | --- |
| `src/types/database.d.ts` | `AgentInfoRow` + `appearance: string \| null` |
| `src/types/core.d.ts` | `AgentInfo` / `AgentUpsertInput` + `appearance?: PixelAgentAppearance` |
| `draft.ts` | `AgentDraft` + `appearance?`；`draftFromAgent` / `draftToInput` 带上 |
| `src/core/mapper/agent-mapper.ts` | `rowToAgent` 用 `safeParse`；`upsertAgent` 列 / `?` / 参数 **三者 +1（22=22=22），`ON CONFLICT` 必须更新 `appearance`**；`!isTauri` 分支同步 |

### 1.3 保存语义（向导）

```text
新建 / 编辑草稿（尚未提交 upsert）：
  打开形象设计
    初始配置 = draft.appearance
               ??（有 logo 且无 appearance → DEFAULT / scenario 预设，见 §6.4）
               ?? generateAvatarByScenario(scenario, identifier)
  用户调整 → 仅改弹窗内 local state
  点【保存形象】
    → snapshotAppearanceToLogo(cfg) 得到 dataURL
    → patch({ logo: dataURL, appearance: cfg })   // appearance 可选
  关闭弹窗；真正落库仍在向导最终「保存智能体」时 upsertAgent

取消：不 patch，草稿不变

历史智能体：
  有 logo、无 appearance → 预览用 img；点开设计从 DEFAULT/场景预设起（并提示「将生成新形象覆盖原头像」）
  有 appearance → 回读配置继续编辑，保存后同时更新 logo 快照
  仅 logo（用户曾上传的图）→ 同上；用户一旦保存形象设计，logo 被新快照覆盖
```

**不提供「保留上传图、并行存像素配置」的双头像。** 一个 agent 一个展示 logo。

### 1.4 `logo` 内容约定

- 形象设计产物：`data:image/png;base64,...`
- 历史上传：原样保留（可能是 jpeg/webp data URL）
- 列表 / 聊天 **不做** 类型判断，直接 `<img src={logo}>`

快照规格见 §5。

---

## 2. 核心数据结构与字典

### 2.1 目录

```text
src/components/ui/pixel-agent/
  types.ts
  constants.ts       # PIXEL_PALETTE / DEFAULT / SCENARIO_PRESETS
  parse.ts           # normalizeAppearance
  layers.tsx
  PixelAgent.tsx
  PixelAgent.scss
  snapshot.ts        # SVG → PNG dataURL
  AppearancePicker.tsx
  AppearanceModal.tsx
  index.ts
```

### 2.2 外观配置（仅设计期 + 可选落库）

```ts
export type HairType = 'bald' | 'buzz' | 'short_neat' | 'spiky'  // MVP；Phase2 再扩
export type EyesType = 'normal' | 'focused' | 'sparkle'
export type MouthType = 'neutral' | 'smile' | 'open_talk'
export type AccessoryType = 'none' | 'glasses_black' | 'headset'
export type OutfitType = 'hoodie' | 'tshirt' | 'lab_coat'
export type PropType = 'none' | 'laptop' | 'coffee_cup'

export interface PixelAgentAppearance {
  skinColor: string      // palette key
  hairType: HairType
  hairColor: string
  eyesType: EyesType
  mouthType: MouthType
  accessory: AccessoryType
  outfitType: OutfitType
  outfitColor: string
  outfitSubColor?: string
  heldProp: PropType
}
```

未加 `appearance` 列时，该类型**只活在弹窗 state**，不进 `AgentInfo`。

### 2.3 调色板

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

export function resolveColor(family: 'skin' | 'hair' | 'outfit', key: string): string
```

### 2.4 默认与场景预设

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

/** 对齐 scenario_category scope=AGENT 的 value */
export const SCENARIO_PRESETS: Partial<Record<string, PixelAgentAppearance>> = {
  'dev-programming': { ...DEFAULT_APPEARANCE, outfitType: 'hoodie', outfitColor: 'neutral-700', heldProp: 'laptop', eyesType: 'focused' },
  'customer-service': { ...DEFAULT_APPEARANCE, mouthType: 'smile', outfitType: 'tshirt', outfitColor: 'accent-emerald', accessory: 'headset' },
  'data-analysis': { ...DEFAULT_APPEARANCE, outfitType: 'lab_coat', outfitColor: 'neutral-200', heldProp: 'coffee_cup', eyesType: 'focused' },
  'content-creation': { ...DEFAULT_APPEARANCE, outfitColor: 'accent-rose', mouthType: 'smile', hairType: 'spiky' },
  'office-efficiency': { ...DEFAULT_APPEARANCE, outfitType: 'tshirt', outfitColor: 'accent-indigo', heldProp: 'coffee_cup' },
  'education': { ...DEFAULT_APPEARANCE, mouthType: 'smile', outfitColor: 'accent-amber' },
  'life-service': { ...DEFAULT_APPEARANCE, outfitType: 'tshirt', outfitColor: 'accent-emerald', mouthType: 'smile' },
}

export function generateAvatarByScenario(scenario?: string, seed?: string): PixelAgentAppearance
```

seed（建议传 `identifier`）只扰动发型/肤色，保证同一 agent 可复现。

### 2.5 动作状态（仅设计弹窗预览用）

列表 / 聊天 **不再使用** motion state（它们只显示快照）。

```ts
export type AgentMotionState = 'idle' | 'working' | 'thinking' | 'error'
// 弹窗预览默认 idle；可放一个「试玩」分段切 working/error，纯前端，不落库
```

### 2.6 归一化

```ts
export function normalizeAppearance(raw: unknown): PixelAgentAppearance
```

脏配置合并 DEFAULT，保证 layers 只收合法枚举。

---

## 3. 纯 SVG 渲染（设计源）

### 3.1 网格硬约束

| 约定 | 值 |
| --- | --- |
| viewBox | `0 0 16 16` |
| 坐标 | **整数**；禁止 0.5 |
| shapeRendering | `crispEdges` |
| 外层 | `image-rendering: pixelated` |

### 3.2 组件

```tsx
export interface PixelAgentProps {
  appearance?: PixelAgentAppearance
  state?: AgentMotionState      // 默认 idle
  size?: number                 // 逻辑 px，默认 64（预览）
  motion?: boolean              // 默认 true；快照时必须 false
  bubbleText?: string
  /** 快照用：把当前 SVG 根节点暴露出去 */
  svgRef?: React.Ref<SVGSVGElement>
}
```

- 颜色：渲染期 `resolveColor` → 直接作 `fill` 属性（不要 CSS 变量 + ts-expect-error）
- 图层顺序：脚 → 体 → 头基座 → 服 → 发 → 眼 → 嘴 → 饰 → 道具 → 手
- `layers.tsx` 单文件 `switch`，不拆碎文件
- 预览区 `size=96`，无气泡；快照时 `size` 按导出像素（见 §5）

### 3.3 几何骨架（16×16）

```text
y= 0..2   发
y= 3..9   头 + 五官（x=5..10）
y= 8..12  躯干（x=4..11）
y=10..11  手
y=13..14  脚
```

阴影：容器 `::after` 硬边椭圆色块，不用 blur。

---

## 4. 快照：SVG → Base64 PNG（核心新模块）

### 4.1 API

```ts
// snapshot.ts
export interface SnapshotOptions {
  /** 输出边长（CSS px 语义下的像素宽高），默认 128 */
  outSize?: number
  /** 背景：默认透明，便于圆形容器裁切 */
  background?: string | 'transparent'
}

/**
 * 将 PixelAgent 在无头环境下渲染为 PNG data URL。
 * 不依赖 html2canvas；用「SVG 字符串 → Image → Canvas → toDataURL」。
 */
export async function snapshotAppearanceToLogo(
  appearance: PixelAgentAppearance,
  options?: SnapshotOptions,
): Promise<string>
```

### 4.2 实现要点（必须遵守）

1. **禁止**对「屏幕上的弹窗 DOM」做 `html2canvas` 截图——字体/主题/滚动区都会脏。  
2. **程序化重绘一份纯净 SVG 字符串**（与 `PixelAgent` 共用 layers 的纯函数，或 `renderToStaticMarkup`）：
   - 内联全部 `fill` / 几何，**不引用外部 CSS class**
   - `shapeRendering="crispEdges"`
   - `viewBox="0 0 16 16"`，`width/height` 设为 `outSize`
3. 序列化：

```ts
function serializeSvg(appearance: PixelAgentAppearance, outSize: number): string {
  const body = buildSvgBody(appearance) // 纯整数 rect 集合
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${outSize}" height="${outSize}" viewBox="0 0 16 16" shape-rendering="crispEdges">
${body}
</svg>`
}
```

4. 栅格化：

```ts
export async function snapshotAppearanceToLogo(appearance, { outSize = 128 } = {}) {
  const svg = serializeSvg(appearance, outSize)
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('snapshot svg load failed'))
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = outSize
  canvas.height = outSize
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  ctx.imageSmoothingEnabled = false // 像素锐利
  ctx.clearRect(0, 0, outSize, outSize)
  ctx.drawImage(img, 0, 0, outSize, outSize)
  return canvas.toDataURL('image/png')
}
```

5. **outSize 必须是 16 的整数倍**（16 / 32 / 64 / 128 / 256），避免缩放糊边。  
6. 默认 **128×128 PNG 透明底**——列表/聊天用 24–32px 缩放显示仍清晰；文件体积通常仅数 KB。  
7. `toDataURL` 在 Tauri WebView2 可用；若遇 taint，本方案无外链图片，不应触发。

### 4.3 与 UI 的衔接

```ts
// AppearanceModal 保存按钮
const logo = await snapshotAppearanceToLogo(draftAppearance, { outSize: 128 })
patch({ logo, appearance: draftAppearance })
onClose()
```

失败时 `message.error`，弹窗保持打开，不 patch。

---

## 5. 向导接入（StepBasic）

### 5.1 UI 替换

**移除：**

- `fileRef` / `<input type="file" accept="image/*">`
- `FileReader` / `pickLogo`
- 「点击上传」文案

**改为：**

```text
┌──────────────┐
│   头像预览    │  ← 有 logo： <img>
│   96×96      │  ← 无 logo： <PixelAgent size=96 情景预设 或 DEFAULT>
│  点击形象设计 │
└──────────────┘
可选：[重新设计] 小按钮（同开 Modal）
```

### 5.2 草稿字段

```ts
// draft.ts —— logo 已有；appearance 仅当加列时增加
export interface AgentDraft {
  // ...
  logo?: string
  appearance?: PixelAgentAppearance  // 可选列
}
```

`draftToInput`：

- `logo: draft.logo`（与现在一致）
- 有列时 `appearance: draft.appearance`

### 5.3 编辑已有智能体

| 库内状态 | 预览 | 打开弹窗初始值 | 保存形象后 |
| --- | --- | --- | --- |
| logo + appearance | img（或仍用 img） | appearance | 更新二者 |
| 仅 logo | img | DEFAULT 或场景预设 + 提示将覆盖 | 覆盖 logo；（有列则）写入 appearance |
| 皆空 | DEFAULT/场景像素 | 同上 | 生成 logo |

**覆盖确认：** 若当前是「仅 logo 且无 appearance」，打开弹窗时 toast/文案：「保存将生成新的像素形象并替换当前头像」。点保存即覆盖，不再二次确认（向导内可撤销成本低）；若你希望更保守，可加 Modal 内 checkbox「我确认替换」。

### 5.4 场景联动

`ScenarioSelect` 变更时：

- 若用户 **尚未** 打开过形象设计（`draft.appearance` 空且未手动保存过形象）→ 预览随 scenario 预设更新
- 已自定义过 → 不覆盖；提供「按场景推荐」按钮在弹窗内

### 5.5 列表 / 聊天

**零改动。** 继续：

```tsx
agent.logo ? <img src={agent.logo} /> : <Bot />
```

无 logo 的新智能体在未设计形象前仍是 Bot 图标；可选增强：无 logo 时列表用 `PixelAgent` 静帧 + scenario 预设（**不是必须**，且会多渲染 SVG）。v1 建议先不做，保持列表轻。

---

## 6. 形象设计弹窗

### 6.1 结构

```tsx
export interface AppearanceModalProps {
  open: boolean
  initial: PixelAgentAppearance
  scenario?: string
  seed?: string            // identifier
  onCancel: () => void
  /** 仅当快照成功后调用 */
  onSave: (next: PixelAgentAppearance, logoDataUrl: string) => void
}
```

内部：

```text
Modal
 ├─ 左/上：预览 PixelAgent size=96 motion（可 idle/working/error 试玩，不影响保存）
 ├─ 右/下：AppearancePicker（枚举 + 色板）
 └─ Footer：取消 | 保存形象（loading = 正在生成快照）
```

### 6.2 AppearancePicker

```tsx
export interface AppearancePickerProps {
  value: PixelAgentAppearance
  onChange: (next: PixelAgentAppearance) => void
  scenario?: string
  seed?: string
}
```

- 分段/页签：发型 | 眼 | 嘴 | 配饰 | 服装 | 道具
- 色板：肤色 / 发色 / 服色 /（可选点缀）
- 顶部操作：随机、按场景推荐、重置默认
- 选项缩略图一律 `motion={false}`，避免几十个动画实例

### 6.3 保存按钮状态

- 生成快照中：`loading`，防重复点
- 成功：`onSave` → 关窗 → 外层已 patch draft
- 失败：提示 + 保持弹窗

### 6.4 预览与列表显示关系

| 场景 | 显示 |
| --- | --- |
| 弹窗 | live SVG（可动） |
| 向导头像框 / 列表 / 聊天 | **静态 PNG（logo）** |

两套不一致只可能出现在「用户改了弹窗未保存」——属预期。

---

## 7. 完整落地顺序

| 序 | 任务 | 依赖 DDL？ | 验收 |
| --- | --- | --- | --- |
| 0 | （建议）你加 `appearance` 列；init + updater 同步 | 是（可选） | 库可读写该列 |
| 1 | `types` / `constants` / `parse` / `layers` / `PixelAgent` 静态 | 否 | 预览可切换枚举 |
| 2 | `snapshot.ts` | 否 | 128px PNG 锐利、透明底、体积小 |
| 3 | `AppearancePicker` + `AppearanceModal` | 否 | 保存回调带 logo |
| 4 | `StepBasic` 替换上传为形象设计 | 否 | 草稿 logo 被快照更新 |
| 5 | `draft` / types / mapper 贯通 appearance | 是 | 重启后弹窗回读配置 |
| 6 | 场景预设 + dirty 不覆盖 | 否 | 换场景推荐正确 |
| 7 | 手测：WebView2 快照、老 logo 编辑、新建无 logo | 否 | 见 §9 |

**最小可发布（无 DDL）：** 步骤 1–4 + 6。每次设计都是「从预设起手 + 导出快照」，不能回读手调细节。  
**完整可发布：** 再加 0、5。

---

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| SVG 栅格化失败 | 纯内联 SVG、无外链；失败不 patch；可重试 |
| 缩放糊边 | outSize ∈ {64,128,256}；`imageSmoothingEnabled=false`；整数网格 |
| 老用户上传头像被覆盖 | 仅在弹窗点「保存形象」时覆盖；预览仍显示原 logo |
| 二次编辑丢失 | 加 appearance 列（§1.1） |
| 快照与预览不一致 | 共用 `buildSvgBody` / layers，禁止两套几何 |
| 无 DDL 时 mapper 膨胀 | 不加列就不改 mapper |

**回滚：** StepBasic 恢复 file 上传即可；logo 语义未破坏。

---

## 9. 验收清单

- [ ] 原「点击上传」变为「形象设计」入口  
- [ ] 弹窗可改发型/颜色/道具，实时预览  
- [ ] 保存后 `draft.logo` 为 `data:image/png;base64,...`，向导提交后列表/聊天可见  
- [ ] 快照在 24/32px 显示下边缘仍锐利（无模糊、无半像素）  
- [ ] 取消不修改草稿  
- [ ] 历史智能体：无 appearance 时预览仍显示原 logo；保存形象后被替换  
- [ ] （若加列）二次打开弹窗，上次手调配置完整回读  
- [ ] （若加列）upsert 22=22=22 且 ON CONFLICT 含 appearance  
- [ ] Windows WebView2 下 `canvas.toDataURL` 正常  
- [ ] 弹窗生成快照失败时有提示且不关窗  

---

## 附录 A：字段变更速查（给 DDL）

```text
表 agent_info
  logo       继续使用（快照/历史上传）
  + appearance TEXT NULL   -- 可选但推荐：再编辑源

不改：其它一切表
```

## 附录 B：与 v1.1 及更早稿的差异

| 废弃 | 替代 |
| --- | --- |
| 列表/聊天强制走 AgentFace / live SVG | 继续 `<img src={logo}>` |
| appearance 作为展示主源 | logo 快照为展示主源；appearance 仅编辑源 |
| 全站 motion 状态映射 | motion 只在设计弹窗预览 |
| 必须 DDL 才能上线 | 无 DDL 可先上弹窗+快照 |

## 附录 C：关键实现伪代码汇总

```ts
// 保存
const logo = await snapshotAppearanceToLogo(cfg, { outSize: 128 })
patch({ logo, ...(hasAppearanceColumn ? { appearance: cfg } : {}) })

// 打开弹窗初始
const initial =
  draft.appearance ??
  generateAvatarByScenario(draft.scenario, draft.identifier)

// 展示（列表/聊天不动）
<img src={agent.logo} alt={agent.name} />
```
