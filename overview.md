# Agent 后端日志与调用链收口概要

## 已完成
- 确认前端 attachments 链路完整：chat.tsx → useAgentSession → Tauri run_agent_task → Rust RunAgentTaskInput → AgentRuntimeConfig → context 多模态 user 消息。
- 修复 LLM 请求日志：普通/流式请求统一改为脱敏、截断预览，不再全量打印请求体，避免 base64 图片刷爆控制台；同时隐藏 API Key、Secret、Token、Authorization、Cookie、图片 URL 等敏感内容。
- MCP endpoint 日志隐藏 query 参数，避免 URL 内嵌 token 泄露。
- 增强 Agent 全链路日志：入口、配置、上下文 Slot、每轮 ReAct、LLM 返回、SSE 统计、工具参数与结果、审批、MCP 握手与 tools/call、原生工具、Skill、raw_messages 回填、压缩触发与摘要大小。
- 记录并验证 MCP / LLM 请求耗时、HTTP 状态、SSE chunk/line/解析错误数量，以及截断后的结果预览。
- 补充边界日志：最大 ReAct 循环熔断、工具调用格式异常、注册表缺工具、审批完成结果、MCP initialized 通知结果。

## 校验结果
- `npm run typecheck`：通过。
- `cargo check`：通过，0 错误、0 警告。
- `git diff --check`：通过。

## 运行验证
重启 Tauri 后端后，在控制台搜索 `[agent]` 或 `[Compactor]`。建议重点观察：每轮 LLM 请求次数、LLM 返回的 tool_calls 数量、工具实际执行结果、MCP initialize/tools/call 状态、SSE 聚合统计、压缩触发判定。
