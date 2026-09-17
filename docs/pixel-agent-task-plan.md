# 拟人化像素智能体（Pixel Agent）任务规划与进度跟踪

> 依据：`docs/pixel-agent-design.md` v1.0（施工蓝本）
> 状态：**未开工**（2026-09-16 规划定稿）
> 使用方式：开工后按序认领，每完成一项勾选 ✅ 并补「验证记录」；发现设计偏差记入「偏差与决策」节。

---

## 0. 铁律与前置提醒（开工前必读）

1. **只跑 `node node_modules/typescript/bin/tsc --noEmit`**，禁 `vite build`；Rust 侧本次基本不涉及。
2. **DDL 双写**：`init.sql` 建表列 + `updater.sql` ALTER 同步；动了 DDL 必查 mapper 三要素。
3. **upsertAgent 三要素**：列清单 / `VALUES` 占位符 / 参数数组 **21→22 三处同步**，且 `ON CONFLICT` 子句必须写入 `appearance`——漏一条「更新时装扮不落库」。
4. **纯增量**：不重构既有逻辑；`chat/MessageList.tsx` 已随拆分回退**不存在**，对话头像实际改 `chat.tsx`（先定位消息气泡渲染点）。
5. **内部数据红线**：`.wd_mem/**` 与 `.workbuddy/memory/**` 不进用户可见 UI。

---

## 1. 任务清单（依赖序）

### 阶段 0：DDL
- [ ] **T0** `agent_info` 新增 `appearance TEXT NULL`（init.sql 建表列 + updater.sql ALTER 双写）；`logo` 保留不删。
  - 验收：新装/存量库均可读写该列。
  - 验证记录：

### 阶段 1：类型与字典（无 UI）
- [ ] **T1** 新建 `src/components/ui/pixel-agent/`：`types.ts`（MVP 枚举：发 bald/buzz/short_neat/spiky；眼 normal/focused/sparkle；嘴 neutral/smile/open_talk；饰 none/glasses_black/headset；服 hoodie/tshirt/lab_coat；道具 none/laptop/coffee_cup；`AgentMotionState` = idle/working/thinking/inspecting/walking/error）+ `constants.ts`（PIXEL_PALETTE / DEFAULT_APPEARANCE / SCENARIO_PRESETS）+ `parse.ts`（normalizeAppearance：脏 JSON→默认，永不 throw）。
  - 验收：tsc 过；脏 JSON 手测归一化。
  - 验证记录：
- [ ] **T2** 字段贯通：`database.d.ts`（AgentInfoRow.appearance: string | null）+ `core.d.ts`（AgentInfo / AgentUpsertInput.appearance?: PixelAgentAppearance）+ `draft.ts`（AgentDraft.appearance 进 draftFromAgent / draftToInput）。
  - 验收：tsc 过。
  - 验证记录：

### 阶段 2：持久化
- [ ] **T3** `agent-mapper.ts`：`rowToAgent` 走既有 safeParse（坏 JSON→undefined 走 logo 回退）；`upsertAgent` **22/22/22** + `ON CONFLICT` 补 appearance + localStorage 分支同步；新流程**不再写 logo**（并且新建/编辑智能体表单不在提供Logo上传了，角色完成会话，生成快照填充这个logo字段-还是base64个头像，这个头不再由用户自己上传，而且由用户制定的像素任务作为头像）。
  - 验收：保存装扮→重启回显；旧 logo 智能体不受影响。
  - 验证记录：

### 阶段 3：渲染
- [ ] **T4** `layers.tsx` + `PixelAgent.tsx`：viewBox `0 0 16 16` **整数坐标**（禁 0.5/1.5）+ `shapeRendering="crispEdges"` + `image-rendering: pixelated`；图层顺序固定：脚→体→头→服→发→眼→嘴→饰→道具→手；`React.memo` + 渲染期解析 palette key→hex 直接作 fill（data-* 仅调试）；气泡 size>32 才渲染。
  - 验收：outfit/hair 等枚举切换正常显示。
  - 验证记录：
- [ ] **T5** `PixelAgent.scss`：MVP 四态动效（idle 呼吸 / working 敲击 / thinking 侧头 / error 震颤，纯 CSS steps）+ `prefers-reduced-motion: reduce` 全关 + `transform-box: fill-box`（异常则 `<g>` 包裹降级）。
  - 验收：Windows WebView2 下按设计稿 §4.4 清单自测（crispEdges 无半像素糊边、状态切换无残影）。
  - 验证记录：

### 阶段 4：统一出口 + 接入
- [ ] **T6** `AgentFace.tsx`（回退链：appearance 有效→PixelAgent；logo 非空→img；否则场景默认/DEFAULT）+ `motion.ts`（motionFromSession：v1 对话页先用现有 isRunning/status 映射，无则恒 idle，接口留好）。
  - 验收：AgentFace 三分支手测。
  - 验证记录：
- [ ] **T7** 接入三处：① `agent-studio/index.tsx` 列表卡片头像（size=32、无气泡、无高频动画）；② **`chat.tsx`** 消息气泡助手头像（size=24；设计稿写 chat/MessageList.tsx 已不存在，以实际为准）；③ `StepBasic.tsx` 移除 Base64 上传，替换 AppearancePicker。
  - 验收：旧 logo 智能体仍显示；新配置走像素。
  - 验证记录：

### 阶段 5：选择器与场景
- [ ] **T8** `AppearancePicker.tsx`（96px 预览 + 分段：发/眼/嘴/饰/服/道 + 肤/发/服/点缀四族色板 + 随机/重置默认/按场景推荐，选项 motion=false）+ `generateAvatarByScenario(scenario, seed)`（seed 稳定 hash 微调发型/肤色，不动 outfitType/accessory）+ ScenarioSelect 联动 dirty 逻辑（appearance 未手改时换场景自动套预设，手改不覆盖）。
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

- [ ] 存量库迁移后旧智能体列表/聊天头像不丢
- [ ] 新建智能体可选装扮，保存后重启回显
- [ ] appearance 非法 JSON 时列表仍可打开（默认像素或 logo）
- [ ] 列表 size=32 无气泡、无高频动画
- [ ] 对话 working / error 视觉可区分
- [ ] 系统「减少动画」开启时无动画
- [ ] 向导不再引导上传 Base64；已有 logo 不被静默清空
- [ ] upsertAgent 22=22=22 且 UPDATE 含 appearance
- [ ] WebView2 下 crispEdges 无半像素糊边

## 4. 偏差与决策（开工后追加）

- （空）

## 5. 关联文件速查

- 设计蓝本：`docs/pixel-agent-design.md`
- 将新建：`src/components/ui/pixel-agent/*`（types/constants/parse/layers/PixelAgent/AgentFace/motion/AppearancePicker/index + PixelAgent.scss）
- 将修改：`init.sql` / `updater.sql` / `database.d.ts` / `core.d.ts` / `draft.ts` / `agent-mapper.ts` / `agent-studio/index.tsx` / `chat.tsx` / `StepBasic.tsx` / `wizard.tsx`（提交路径）
