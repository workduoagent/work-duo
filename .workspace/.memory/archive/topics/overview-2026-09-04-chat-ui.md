# chat 页面 UI/UX 优化

## 评估结论
5 点想法全部成熟可行，且与现有系统能力/权限兼容，已一次性实现。

## 改动内容

### 1. 左侧栏 UI 对齐系统风格
- `src/pages/agent-studio/chat.scss`：侧栏改为 220px 圆角卡片（`--color-background-subtle` + 细边框 + `--shadow-sm`）。
- 会话项 hover 平移、active 态带左侧品牌色指示条，与知识库/智能体首页侧栏一致。
- 移除会话行前的 `MessageSquare` 图标；分组头部改为小字 uppercase 标题，减轻视觉重量。

### 2. 文件路径内联卡片
- `src/pages/agent-studio/chat.tsx`：新增 `FilePathCards` / `FilePathCard`。
- 从 Agent 消息中自动识别 Windows（`C:\...`）、Unix（`/...`）、相对路径（`./...`、`../...`）。
- 按扩展名映射图标（表格/图片/文本/代码/通用），在消息气泡下方以卡片网格展示。
- 点击卡片调用 `tauri-plugin-opener` 的 `openPath`，用系统默认应用打开文件。
- `src-tauri/capabilities/default.json`：补 `opener:allow-open-path` 权限。

### 3. 输入框三条
- 移除 `agent-chat__input` 顶部 `border-top` 分割线。
- 输入框宽度改为 50% 并居中（`max-width: 720px`），窄屏（`<900px`）回退 90%。
- `textarea` 支持鼠标上下拖拽调整高度（`resize: vertical`），限制 `min-height: 48px / max-height: 320px`。

## 验证
- `npm run typecheck` exit 0。
- 需执行 `npm run tauri` 重编后端（capability 变更）。
