# 拟人化像素智能体（Pixel Agent）任务规划与进度跟踪

> 依据：~~`docs/pixel-agent-design.md` v1.0~~ → **v1.2（形象设计弹窗 → logo 快照，2026-09-17 确认）**
> 状态：**✅ 已完结（v1.2 实现 + v2 重制 32×32 + 弹窗 v3，真机点验全部通过 2026-09-17，代码已提交 c2faa66）**
> 使用方式：按序认领，每完成一项勾选 ✅ 并补「验证记录」；发现设计偏差记入「偏差与决策」节。

---

## ⚠️ v1.2 设计变更（本文件 v1.0 规划已部分作废）

| v1.0 规划项 | v1.2 实际 |
|---|---|
| T6 AgentFace + motion.ts（回退链） | **取消**——列表/聊天零改造，继续 `<img src={logo}>` |
| T7 三处接入（列表/chat/向导） | **只改向导 StepBasic**；新增 `snapshot.ts`（SVG→PNG 快照写 logo）+ `AppearanceModal` |
| motion 进消息流 | motion 只在弹窗预览（试玩分段） |
| appearance 展示主源 | **logo 快照为展示主源**；appearance 仅编辑源（DDL 必做） |

## 0. 铁律与前置提醒（开工前必读）

1. **只跑 `node node_modules/typescript/bin/tsc --noEmit`**，禁 `vite build`；Rust 侧本次基本不涉及。
2. **DDL 双写**：`init.sql` 建表列 + `updater.sql` ALTER 同步；动了 DDL 必查 mapper 三要素。
3. **upsertAgent 三要素**：列清单 / `VALUES` 占位符 / 参数数组 **21→22 三处同步**，且 `ON CONFLICT` 子句必须写入 `appearance`——漏一条「更新时装扮不落库」。
4. **纯增量**：不重构既有逻辑；`chat/MessageList.tsx` 已随拆分回退**不存在**，对话头像实际改 `chat.tsx`（先定位消息气泡渲染点）。→ v1.2 下此项已不需要（列表/聊天零改造）。
5. **内部数据红线**：`.wd_mem/**` 与 `.workbuddy/memory/**` 不进用户可见 UI。
6. **SCENARIO_PRESETS 对表**：2026-09-17 核对 init.sql 种子——AGENT 域 7 值（customer-service / office-efficiency / dev-programming / content-creation / data-analysis / education / life-service）与设计稿 keys **完全一致**，无需调整。

---

## 1. 任务清单（依赖序）

### 阶段 0：DDL
- [x] **T0** `agent_info` 新增 `appearance TEXT NULL`（init.sql 建表列 + updater.sql ALTER 双写）；`logo` 保留不删。
  - 验收：新装/存量库均可读写该列。
  - 验证记录：

### 阶段 1：类型与字典（无 UI）
- [x] **T1** 新建 `src/components/ui/pixel-agent/`：`types.ts`（MVP 枚举：发 bald/buzz/short_neat/spiky；眼 normal/focused/sparkle；嘴 neutral/smile/open_talk；饰 none/glasses_black/headset；服 hoodie/tshirt/lab_coat；道具 none/laptop/coffee_cup；`AgentMotionState` = idle/working/thinking/inspecting/walking/error）+ `constants.ts`（PIXEL_PALETTE / DEFAULT_APPEARANCE / SCENARIO_PRESETS）+ `parse.ts`（normalizeAppearance：脏 JSON→默认，永不 throw）。
  - 验收：tsc 过；脏 JSON 手测归一化。
  - 验证记录：
- [x] **T2** 字段贯通：`database.d.ts`（AgentInfoRow.appearance: string | null）+ `core.d.ts`（AgentInfo / AgentUpsertInput.appearance?: PixelAgentAppearance）+ `draft.ts`（AgentDraft.appearance 进 draftFromAgent / draftToInput）。
  - 验收：tsc 过。
  - 验证记录：

### 阶段 2：持久化
- [x] **T3** `agent-mapper.ts`：`rowToAgent` 走既有 safeParse（坏 JSON→undefined 走 logo 回退）；`upsertAgent` **22/22/22** + `ON CONFLICT` 补 appearance + localStorage 分支同步；新流程**不再写 logo**（并且新建/编辑智能体表单不在提供Logo上传了，角色完成会话，生成快照填充这个logo字段-还是base64个头像，这个头不再由用户自己上传，而且由用户制定的像素任务作为头像）。
  - 验收：保存装扮→重启回显；旧 logo 智能体不受影响。
  - 验证记录：

### 阶段 3：渲染
- [x] **T4** `layers.tsx` + `PixelAgent.tsx`：viewBox `0 0 16 16` **整数坐标**（禁 0.5/1.5）+ `shapeRendering="crispEdges"` + `image-rendering: pixelated`；图层顺序固定：脚→体→头→服→发→眼→嘴→饰→道具→手；`React.memo` + 渲染期解析 palette key→hex 直接作 fill（data-* 仅调试）；气泡 size>32 才渲染。
  - 验收：outfit/hair 等枚举切换正常显示。
  - 验证记录：
- [x] **T5** `PixelAgent.scss`：MVP 四态动效（idle 呼吸 / working 敲击 / thinking 侧头 / error 震颤，纯 CSS steps）+ `prefers-reduced-motion: reduce` 全关 + `transform-box: fill-box`（异常则 `<g>` 包裹降级）。
  - 验收：Windows WebView2 下按设计稿 §4.4 清单自测（crispEdges 无半像素糊边、状态切换无残影）。
  - 验证记录：

### 阶段 4：统一出口 + 接入
- [x] **T6** `AgentFace.tsx`（回退链：appearance 有效→PixelAgent；logo 非空→img；否则场景默认/DEFAULT）+ `motion.ts`（motionFromSession：v1 对话页先用现有 isRunning/status 映射，无则恒 idle，接口留好）。
  - 验收：AgentFace 三分支手测。
  - 验证记录：
- [x] **T7** 接入三处：① `agent-studio/index.tsx` 列表卡片头像（size=32、无气泡、无高频动画）；② **`chat.tsx`** 消息气泡助手头像（size=24；设计稿写 chat/MessageList.tsx 已不存在，以实际为准）；③ `StepBasic.tsx` 移除 Base64 上传，替换 AppearancePicker。
  - 验收：旧 logo 智能体仍显示；新配置走像素。
  - 验证记录：

### 阶段 5：选择器与场景
- [x] **T8** `AppearancePicker.tsx`（96px 预览 + 分段：发/眼/嘴/饰/服/道 + 肤/发/服/点缀四族色板 + 随机/重置默认/按场景推荐，选项 motion=false）+ `generateAvatarByScenario(scenario, seed)`（seed 稳定 hash 微调发型/肤色，不动 outfitType/accessory）+ ScenarioSelect 联动 dirty 逻辑（appearance 未手改时换场景自动套预设，手改不覆盖）。
  - **前置核对**：SCENARIO_PRESETS 的 key（dev-programming / customer-service / data-analysis / content-creation / office-efficiency / education / life-service）需与 `listByScope('AGENT')` 字典实际 value 对表，不一致按现状改 presets。
  - 验收：换场景有推荐、手改不覆盖、保存重启回显（设计稿 §10 DoD 全过）。
  - 验证记录：

### Phase 2（明确不做）
枚举扩容（curly_bob/cyber_visor 等）、walking/inspecting 完整动效、squad 像素形象、画布接入、导出 PNG、「清除旧头像」次要操作。

---

## 2. 依赖关系

```
T0 → T1/T2（可并行） → T3 → T4 → T5 → T6 → T7 → T8
```
- T0-T3 完成 → 可先真机验「存库回显」（纯数据，无视觉）。
- T4-T5 → 静态小人 + 动效可独立演示。
- T6-T8 → 完整体验（列表/对话/向导）。
- 每步独立可提交；建议 T3 后、T5 后各做一次阶段性提交。

## 3. 验收 DoD（设计稿 §10 摘录）

- [x] 存量库迁移后旧智能体列表/聊天头像不丢
- [x] 新建智能体可选装扮，保存后重启回显（用户真机点验 2026-09-17）
- [x] appearance 非法 JSON 时列表仍可打开（默认像素或 logo，normalizeAppearance 永不 throw）
- [x] 列表 size=32 无气泡、无高频动画（v1.2 零改造：静态 logo 快照）
- [x] 对话 working / error 视觉可区分（v1.2 变更：消息流为静态快照，四态动效试玩在形象设计弹窗内——原 v1.0 语义随设计变更转移，见 §偏差与决策）
- [x] 系统「减少动画」开启时无动画（prefers-reduced-motion 全关）
- [x] 向导不再引导上传 Base64；已有 logo 不被静默清空（覆盖提示）
- [x] upsertAgent 22=22=22 且 UPDATE 含 appearance
- [x] WebView2 下 crispEdges 无半像素糊边（v2 重制后用户认可效果）

## 4. 偏差与决策（开工后追加）

- **2026-09-17 设计 v1.0 → v1.2 切换**：采用「形象设计弹窗 → logo 快照」方案（见设计稿 v1.2 附录 B）。v1.0 的 T6（AgentFace/motion.ts）与 T7 的列表/chat 接入取消；新增 snapshot 模块与 AppearanceModal；appearance 列从「可选」转必做（再编辑源）。
- **执行记录（T0–T6 全绿，tsc 0E）**：
  - ✅ T0 DDL：init.sql `agent_info` 建表加 `appearance TEXT` + updater.sql 追加 **v24** `ALTER TABLE agent_info ADD COLUMN appearance TEXT`；
  - ✅ T1 字典：`src/components/ui/pixel-agent/{types,constants,parse}.ts`（枚举/调色板/DEFAULT/SCENARIO_PRESETS/generateAvatarByScenario 稳定 hash 扰动发型肤色/normalizeAppearance 永不 throw）；
  - ✅ T4 渲染：`layers.ts`（buildPixelRects 唯一几何事实源，图层序 脚→体→头→服→发→眼→嘴→饰→道具→手）+ `PixelAgent.tsx`（16×16 整数网格 crispEdges + memo）+ `PixelAgent.scss`（四态 steps() 动效 + prefers-reduced-motion 全关）；
  - ✅ T2 快照：`snapshot.ts`（buildSvgString 纯净内联 SVG → data URL → canvas `imageSmoothingEnabled=false` → PNG dataURL；outSize 16 倍数钳制，默认 128 透明底）；
  - ✅ T3 弹窗：`AppearancePicker.tsx`（六页签 chip + 分族色板 + 随机/按场景推荐/重置默认）+ `AppearanceModal.tsx`（192 预览 + 四态试玩 Segmented + 快照 loading/失败不关窗）+ `index.ts` barrel；
  - ✅ T5 贯通：database.d.ts / core.d.ts（AgentInfo/AgentUpsertInput.appearance）/ draft.ts 三件套；
  - ✅ T6 mapper：`rowToAgent` 走 normalizeAppearance（NULL→undefined 走 logo 回退）；`upsertAgent` **22/22/22** + ON CONFLICT 含 appearance + LS 分支同步；
  - ✅ T7 向导：StepBasic 移除 file 上传（fileRef/FileReader/ImagePlus/Trash2 全清），改为形象预览（有 logo=img，无 logo=场景预设静帧）+ 点击打开 AppearanceModal；「仅历史 logo 无 appearance」时显示覆盖提示；场景联动=未定制时预览随 scenario 预设。
- **验证**：`tsc` 0 error；DDL 待应用重启后真机点验（见设计稿 §9 清单）。
- **2026-09-17 晚 v2 重制（用户反馈：16×16 效果差、状态动效简陋）**：
  - 画布 16×16 → **32×32 游戏级**（snapshot outSize 改 32 倍数）；
  - 外观模型 v2：新增 **性别**（男/女级联发型池 男5/女5、上衣池 男4/女4、下装池、鞋子池）、**帽子**（鸭舌帽/毛线帽/贝雷帽，独立配色）、上衣/下装/鞋子四层独立配色、配饰扩充（黑框/圆框眼镜、耳环、围巾、耳机、香烟）；眼/嘴不再手动选——**表情由状态驱动**；
  - 状态动效重做（全部 opacity 两帧交替，无 transform 不糊边）：**idle 完全静止**；working=笔记本+双手交替敲键+屏幕代码行滚动（pa-fa/pa-fb）；thinking=单手托腮+眼睛上瞟+头顶思考点错峰闪烁（pa-dot1..3）；error=X 眼+张嘴+头顶红感叹号+汗滴闪烁（pa-alert/pa-drop）；
  - parse.ts 兼容旧版 JSON 迁移（hairType/outfitType/outfitSubColor/coffee_cup/glasses_black → v2 字段），旧数据不丢；
  - Picker 页签改 8 个：基础(性别+肤色)/发型/帽子/上衣/下装/鞋子/配饰/道具；性别切换按池钳制；连衣裙自动接管下装页签。

- **真机点验（2026-09-17 晚·用户确认）**：v1.2 弹窗流程 / v2 32×32 像素效果 / v3 三栏设计器 / 快照写 logo 重启回显 / 旧 logo 兼容——全部通过，任务完结。Phase 2（枚举扩容、walking/inspecting 完整动效、squad 形象、画布接入、导出 PNG）按规划明确不做，需要时另行立项。

## 5. 关联文件速查

- 设计蓝本：`docs/pixel-agent-design.md`
- 将新建：`src/components/ui/pixel-agent/*`（types/constants/parse/layers/PixelAgent/AgentFace/motion/AppearancePicker/index + PixelAgent.scss）
- 将修改：`init.sql` / `updater.sql` / `database.d.ts` / `core.d.ts` / `draft.ts` / `agent-mapper.ts` / `agent-studio/index.tsx` / `chat.tsx` / `StepBasic.tsx` / `wizard.tsx`（提交路径）
