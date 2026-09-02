/**
 * 智能体运行时的前后端事件契约类型。
 *
 * 这些类型与 Rust 端 `src-tauri/src/agent/events.rs` 通过 Tauri 事件
 * （`app.emit`）推送给前端的负载一一对应；前端 `useAgentSession` 只消费
 * 事件流，不直接调用工具执行逻辑（工具执行在 Rust 的 ReAct 循环里完成）。
 *
 * 事件总览（Rust 侧 emit 的事件名 → 本文件类型）：
 *  - `agent-event`：工具调用/文本片段/状态变化等常规事件（见 {@link AgentEvent}）；
 *  - `agent-awaiting-approval`：需要用户审批的高危操作挂起（见 {@link ApprovalRequest}）；
 *  - `agent-task-done`：整轮任务结束；
 *  - `agent-task-error`：整轮任务异常终止。
 */

/** 工具调用步骤的生命周期阶段。 */
export type ToolCallStatus = 'running' | 'success' | 'failed'

/** 单条工具调用步骤（折叠卡片的数据源）。 */
export interface ToolStep {
  /** 调用唯一标识（Rust 侧生成的 call_id）。 */
  callId: string
  /** 工具名（含命名空间，如 `mcp__mineru__parse`、`native__edit_file`）。 */
  toolName: string
  /** 友好展示名（去掉命名空间前缀）。 */
  toolLabel: string
  status: ToolCallStatus
  /** 调用入参（已序列化 JSON 字符串，展示时按需解析）。 */
  args?: string
  /** 执行结果或错误信息（已序列化文本）。 */
  result?: string
  /** 是否高危（需要审批）。 */
  sensitive: boolean
  /** 该步骤的耗时（ms，可选，Rust 侧统计后回填）。 */
  durationMs?: number
  /** 步骤创建时间戳（epoch ms）。 */
  createdAt: number
}

/** 对话流里的一段流式/完整文本（助手的最终回复）。 */
export interface StreamChunk {
  /** 增量文本片段（流式时逐步追加到已有内容后）。 */
  text: string
  /** 是否为首帧（true 时前端清空上一段承接区，另起新气泡）。 */
  done: boolean
}

/** 审批请求（高危操作挂起）。 */
export interface ApprovalRequest {
  /** 本次审批唯一标识（Rust 侧 oneshot 通道 key）。 */
  approvalId: string
  /** 触发审批的工具名。 */
  toolName: string
  /** 友好描述（一句话说明要做什么）。 */
  description: string
  /** 结构化入参（JSON 字符串；edit_file 含 old_str/new_str，execute_command 含 command）。 */
  args: string
  /** 工具类别：`edit_file` 走双列 Diff，`execute_command` / 其它走参数 JSON。 */
  kind: 'edit_file' | 'execute_command' | 'other'
  /** 等待审批时 Rust 已给出的提示信息。 */
  hint?: string
}

/** `agent-event` 的负载（按 `type` 区分具体事件）。 */
export interface AgentEvent {
  type:
    | 'tool_started' // 工具开始调用（前端新增折叠卡片 running）
    | 'tool_finished' // 工具结束（running→success/failed，回填 result）
    | 'text_chunk' // 模型流式文本片段
    | 'text_done' // 模型一段完整回复结束
    | 'status' // 运行状态文本（如「正在规划…」「正在检索知识库」）
    | 'error' // 单步错误（非致命，记入气泡）
  /** 工具步骤（tool_started / tool_finished 时使用）。 */
  step?: ToolStep
  /** 文本片段（text_chunk 时使用）。 */
  chunk?: StreamChunk
  /** 状态/错误信息（status / error 时使用）。 */
  message?: string
  /** 事件序号（Rust 自增，前端可用于去重/排序，可选）。 */
  seq?: number
}

/** Tauri 侧的审批结果回传（前端调用 `submit_approval_decision` 时携带）。 */
export interface ApprovalDecision {
  approvalId: string
  approved: boolean
  /** 拒绝原因（approved=false 时回填给模型以引导纠偏，可选）。 */
  reason?: string
}

/** 运行一轮任务的前端入参（对应 Rust `run_agent_task` 命令）。 */
export interface RunAgentTaskInput {
  agentId: string
  prompt: string
  /** 工作空间本地目录（沙箱工具的相对路径以此为基准）。 */
  workspace?: string | null
  /** 历史消息（可选，首轮通常不带，由 Rust 侧从最近 session 读取）。 */
  history?: Array<{ role: 'user' | 'assistant' | 'agent'; content: string }>
}
