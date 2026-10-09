# §3.3 记忆宫殿（Memory Palace）— 完成总览

## 交付内容

### 后端（Rust / Tauri）
- **Schema**：`init.sql` + `updater.sql`(v16) 新增 `agent_memories`（6 字段 + 引用计数 + 锚定标志 + 2 索引）与 `agent_memory_events`（FK ON DELETE CASCADE 级联清理）。
- **`src-tauri/src/agent/memory.rs`**（新建）：列出 / 热力图 / 锚定（新建或更新）/ 更新 / 删除 / 显式召回 / 运行时自动召回 top-K 注入系统提示。引用计数驱动热度排序与热力图。
- **事件**：`agent-memory-recalled`（引用计数实时刷新）、`agent-context-compacted`（压缩结构化事件，替代原纯字符串 `emit_status`）。
- **命令**：`list_memories` / `get_memory_heatmap` / `anchor_memory` / `update_memory` / `delete_memory` / `recall_memory`，全部注册进 `generate_handler!`。
- **`load_config` 自动召回注入**：每次任务运行时把 top-5 记忆拼入系统提示，自然累积引用计数。

### 前端（React / TS）
- **`src/pages/memory-palace/MemoryPalace.tsx`** + `memory-palace.scss`：卡片网格（锚定/分类/引用数/最近召回 + 引用/编辑/删除）、搜索 + Segmented 分类过滤、GitHub 式召回热力图（18 周、5 级品牌色阶）、上下文压缩事件列表、锚定 Modal、详情 Drawer、实时事件订阅、非 Tauri mock 回退。
- **路由/导航**：`router/index.tsx` 注册 `/memory-palace`；`TopBar.tsx` 加「记忆宫殿」一级菜单（Brain 图标）。
- **类型**：`session/types.ts` 新增 7 个记忆相关类型。

## 校验结果
- `cargo check`：✅ 零错误、零警告。
- `npm run typecheck`：✅ 零错误。
- 顺带修复 §3.2 遗留的两个阻塞 typecheck 的既有错误（`chat.tsx` 的 `session` TDZ、未用 import）与路由默认导出不匹配。

## 后续建议
- 真机 `npm run tauri` 目测热力图渲染、锚定/详情抽屉交互、运行时自动召回是否注入上下文。
- `handleApplyBranch` 仍只 log 未实际重跑（需后端支持用新分支步骤重跑任务）。
