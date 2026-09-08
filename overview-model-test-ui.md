# 模型测试 400 与卡片对齐修复概要

## 修复内容

### 1. 模型连通性测试报 HTTP 400（探测体格式不被接受）
- **问题**：模型设置页点击「测试」返回 `HTTP 400，探测请求体格式不被接受`，但同一模型在智能体模块可正常使用。
- **根因**：`src/utils/modelTest.ts` 的探针请求体手写死 `max_tokens: 1`（snake_case + 值 1），而智能体 `runtime.rs::call_llm_stream_once` 是从 DB `config` 列注入模型分类参数（`maxTokens:1000`/`temperature` 等 camelCase），且带 `Accept: text/event-stream`。二者请求体完全脱节，导致假阴性。
- **改动**：
  - `testModelConnection` 入参由 `ModelTestInput` 改为 `ModelConfig`。
  - `chatBody(model, config)` 从 `model[model.category]` 取选中分类参数对象并注入，跳过 `model`/`messages`/`stream`/`stream_options`，`reasoning` 归一化同 `runtime.rs`。
  - `buildHeaders` 补 `Accept: text/event-stream`。
  - 调用点 `ModelList.handleTest(m)` / `ModelFormModal.handleTest(draft)` 本就传 `ModelConfig`，无需修改。

### 2. 模型卡片测试结果行上下错位
- **问题**：两张模型卡片同时显示连通性结果后，测试结果行与底部操作栏出现上下未对齐（左侧「工具调用」标签换行导致 tags 区更高，连带压低下方元素）。
- **根因**：`.ant-card-body` 内 head/tags/desc 与 test/actions 混在同一 flex 列中，tags 高度变化直接推移 test 位置。
- **改动**：
  - `ModelList.tsx`：把 head/tags/desc 包进 `.model-card__body`。
  - `ModelList.scss`：给 `.model-card__body` 加 `flex: 1`，吸收卡片剩余高度，把 `.model-card__test` 与 `.model-card__actions` 一并推到卡片底部并保持跨卡片对齐。

## 校验结果
- `npm run typecheck`：通过，零错误。

## 后续注意
- 探测请求体必须与 `runtime.rs::call_llm_stream_once` 严格对齐，禁止再手拍固定参数值。
