# chat.tsx 拆分施工方案（#20260915005 · 安全优先版）

> 版本 v2.0（2026-09-16 晚）。取代上午已回退的 v1 方案（useChatPageController + page 对象下钻）。
> 状态：**方案确认中，未开工**。用户拍板后按本文档逐步施工。

## 0. 上次回退根因（必须先读）

上午（2026-09-16 11:00）v1 拆分后**界面样式全部消失**，用户全量回退。

根因分析：
- `chat.scss`（4971 行）存在**两大段巨型嵌套块**（line 2 / line 2129 两个 `.agent-chat { ... }`），内部几千行样式**强依赖 DOM 层级**。
- v1 手法 =「`useChatPageController` 返回 182 字段 + 4 子组件经 `const {字段}=page` 消费」→ **重划组件边界、重排 DOM 包装层** → 嵌套级联选择器失配 → 嵌套块内样式整体失效。
- 结论：**样式层与 DOM 结构焊死。任何拆分不得改变 JSX 层级。**

## 1. 四条铁律（施工全程有效）

1. **JSX 一字不动**：className、嵌套层级、DOM 顺序、wrapper 数量全部原样。搬运 =「模块级声明原样剪切到新文件 + import 回原位」，渲染结果必须与原先完全一致。
2. **chat.scss 零改动**。
3. **不做 page 对象下钻、不抽巨型 hook**：子组件 props 显式列出。AgentChatPage 内部的 hooks/状态/事件逻辑**有意留在 chat.tsx**（集中不是病，强拆才是 v1 的病）。
4. **原子小步**：每步只搬 1 组声明，每步单独 commit（信息注明 Step N）。

## 2. 现状基线（2026-09-16 晚）

- `chat.tsx` = **3839 行**（含今天插件 @提及/PluginPill 新增代码）；`chat.scss` = 4971 行。
- v1 回退干净：`chat/` 子目录不存在，无残留文件。
- 模块级声明盘点（AgentChatPage 之外，line 86~1405，约 1300 行）：

| 声明 | 行号 | 性质 |
|---|---|---|
| ArtifactIcon / ArtifactGallery | 86 / 105 | 纯展示 |
| 类型：BoundMcpTool / BoundMcpServer / SuggestItem / SuggestState / ChatMessage / PendingAttachment / MenuItem / SpeechLike | 208~281, 1183, 3830 | 纯类型 |
| 常量：TEXT_EXT / MAX_INLINE_IMAGE / TEXT_INLINE_LIMIT / MAX_FILE / FILE_PATH_RE / FILE_*_EXTS / AVG_TOOL_TOKENS | 282~588 | 纯常量 |
| ThoughtPanel | 418 | 纯展示 |
| FilePathCard / FilePathCards | 506 / 546 | 纯展示 |
| TokenRing / LiveTokenCounter | 614 / 691 | 展示 |
| MessageActions | 720 | 展示（props 带回调） |
| SkillChip / PluginPill / McpPill / WorkspaceChip | 875 / 928 / 1069 / 1314 | 展示 |
| DropdownMenu | 1190 | 通用组件 |
| **AgentChatPage（主体）** | **1406~3829** | **留守不动** |

## 3. 六步拆解（每步 = 搬 → 验 → 点验 → commit）

| Step | 动作 | 新文件 | 预期 chat.tsx |
|---|---|---|---|
| 0 | git tag `pre-chat-split`；用户拍亮/暗两张界面截图作对照基线；确认工作区干净 | — | 3839 |
| 1 | 抽**纯类型**（8 个 interface） | `chat/types.ts` | ~3700 |
| 2 | 抽**纯常量**（TEXT_EXT/FILE_*/限额等，零 React 依赖） | `chat/file-helpers.ts` | ~3550 |
| 3 | 抽 ArtifactIcon + ArtifactGallery | `chat/artifact-ui.tsx` | ~3350 |
| 4 | 抽 ThoughtPanel + FilePathCard(s) + TokenRing + LiveTokenCounter + MessageActions | `chat/message-ui.tsx` | ~2700 |
| 5 | 抽 SkillChip + PluginPill + McpPill + WorkspaceChip | `chat/mention-ui.tsx` | ~2300 |
| 6 | 抽 DropdownMenu；收尾盘点（typecheck + 全量目检 + 行数汇报） | `chat/dropdown.tsx` | **~2250** |

- 每步只做「剪切 → 新文件 → import 回原位」；组件间相互引用（如 ArtifactGallery 用 ArtifactIcon）随组同搬。
- **分段点验约定**：Step 1-2 结束点验 1 次（零 UI 风险段）；Step 3-5 每步点验 1 次；Step 6 全量点验。

## 4. 每步验证清单（固定执行，不跳步）

1. `node node_modules/typescript/bin/tsc --noEmit` EXIT=0
2. 硬刷新/重启 dev（防 HMR stale 假象干扰判断）
3. 真机目检 6 项（对照 Step 0 基线截图）：
   - [ ] 左栏会话树（含归档琥珀态、运行 loading）
   - [ ] 消息流气泡（含 Markdown/代码块/文件路径卡/产物引用）
   - [ ] 输入区（@提及候选、附件、Skill/MCP/Plugin 胶囊）
   - [ ] 右栏三 Tab（图/过程/产物）+ 执行图节点角标
   - [ ] 亮色主题
   - [ ] 暗色主题
4. 用户确认 → `git commit`（信息注明 Step N）
5. **任何异常 → 立即停 → `git checkout` 回退该步 → 查根因，绝不带病前进**

## 5. 回退预案

- 每步 1 commit，最坏损失 = 1 步。
- Step 0 的 tag `pre-chat-split` 为总体回退点。
- 疑似 HMR 假象时：先整页刷新/重启 `npm run tauri` 再判断，不盲目改代码。

## 6. 边界声明（安全优先的诚实预期）

- 模块级 ~1300 行搬走后，chat.tsx 约 **2250 行**；剩余为 AgentChatPage 主体（hooks + JSX 编排）。
- 再往下压到 <1200 行必须动 hooks/内部 JSX（v1 翻车区），**本轮不做**。若未来要做，需另行立项、单独设计验证方案（如先补 Playwright 视觉回归基线）。
- 行数 KPI 让位于稳定性；2250 行且结构清晰 > 1200 行但断链风险高。

## 7. 已知搬运注意点（从 v1 教训与代码盘点提取）

- 子目录文件引用 session/types 必须 `../session/types`（写 `./session/types` 会让类型塌成 any）。
- ChatMessage 在 chat/types 统一定义，勿与 session/types 混淆；SessionTreeGroup 来自 `@/core/mapper/agent-session-mapper`。
- 同文件多处相似 Edit 必须逐一 grep 回读（Edit 工具静默丢弃坑）。
- 组件依赖的 `@/components/ui`、lucide 图标、`isTauri`/`formatTime` 等需在新文件补模块级 import（typecheck 兜底）。
