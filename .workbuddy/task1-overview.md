# 任务一 · 场景分类统一管理（scenario_category 字典）— 已完成

## 目标
用 `scenario_category` 字典表统一替代 LLM / MCP / Skill 三处前端硬编码枚举，支持：
- 搜索下拉 + **回车新建**分类（value 由 label 自动 slug，冲突追加 `-N`）
- **行内改名**（仅改 `label`，不改 `value`/`scope`）
- **删除**（按 `scope` 置空业务引用：`skill_info.scenario` / `mcp_info.scenario` → NULL，`models.category` → 空串）

## 本次完成（LLM 模块接入 —— 任务一最后一块）
- `src/pages/model-settings/index.tsx`：左侧 `CategoryTabs` 改从 `scenario_category(scope=LLM)` 加载 `options`+`counts`；分类 state 由 `ModelCategory` 改为 `string`；保存/导入后 `void loadScenarios()` 刷新左栏（新建自定义分类即时出现）。
- `src/pages/model-settings/components/ModelFormModal.tsx`：分类 `Radio.Group`(`MODEL_CATEGORY_OPTIONS`) → `<ScenarioSelect scope="LLM" />`；`changeCategory(next: string)`；移除 `Radio` 导入。
- `src/pages/model-settings/components/ModelList.tsx`：`categoryLabel` 改用 `getModelCategoryLabel`（DB 未命中兜底）；移除 `MODEL_CATEGORY_OPTIONS` 导入。
- `src/core/file/model-file.ts`：删除 `MODEL_CATEGORY_OPTIONS` 导出，新增 `getModelCategoryLabel`；`createEmptyModel` 补 `default: return base`（修复原 `switch` 无 default 导致**自定义分类返回 undefined 的崩溃隐患**）。
- `src/pages/model-settings/components/paramFields.ts`：`getParamFields` 补 `default: return []`（自定义分类参数区兜底为空，符合计划）。

## 顺带修复的隐含类型错误（全量 `typecheck` 暴露）
- `ScenarioCategory` 类型应来自 `@/types/core`（mcp / skill-hub / model-settings/index.tsx + ScenarioSelect 四处理应修正的导入路径）。
- `ModelConfig as Record<string,unknown>` 直转触发 TS2352 → 改 `as unknown as`（model-file.ts / model-mapper.ts / ModelFormModal.tsx）。
- `ScenarioSelect` 的 `ref={editRef as Ref<HTMLInputElement>}` 类型不匹配 → 改 `ref={editRef}` 并移除多余 `Ref` 导入。
- `ModelFormModal` 用 `string` 索引 `ModelConfig` 触发 TS7053 → 先 `as unknown as Record<string, unknown>` 再索引。

## 强警告
`ScenarioSelect` 删除 **LLM** 分类且引用数 > 0 时，提示「将置空 N 个模型的分类（参数结构保留，但模型变为未分类，需手动重新指定分类）」，避免误删丢失分类归口。

## 校验
- `npm run typecheck` EXIT 0（铁律：**未跑 `vite build`**，仅 `npm run tauri` 调试）。

## 状态
- 任务一（LLM / MCP / Skill 三模块统一）全量完成。旧数据 `value` 不变，删除字典仅置空引用。
- 任务二（知识库：菜单更名 + `knowledge_base`/`knowledge_asset` 表 + 首页/详情页 + MultiFileViewer + 依赖安装）待启动。
