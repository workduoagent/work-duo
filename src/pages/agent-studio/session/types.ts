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
  /** 所属规划步骤序号（前端按 step_started 标记，用于按步骤归组渲染；可选）。 */
  step?: number
  /** 操作类型（read/write/edit/create/delete/move/list/search/exec/http/mcp…），一行式工具行动词。 */
  op?: string
  /** 目标文件 / 路径（相对工作空间原文）。 */
  path?: string
  /** 本次变更新增行数（仅文件变更类工具，后端精确 diff）。 */
  linesAdded?: number
  /** 本次变更删除行数（仅文件变更类工具，后端精确 diff）。 */
  linesRemoved?: number
}

/** 对话流里的一段流式/完整文本（助手的最终回复）。 */
export interface StreamChunk {
  /** 增量文本片段（流式时逐步追加到已有内容后）。 */
  text: string
  /** 是否为首帧（true 时前端清空上一段承接区，另起新气泡）。 */
  done: boolean
  /** 思考分层标签（thinking_chunk 时携带）：plan=规划 / exec=执行 / selfcheck=自检。 */
  layer?: 'plan' | 'exec' | 'selfcheck'
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

/** 方案推荐：单个选项（Agent 调 `native__ask_user_choice` 时给出；前端渲染为 chip）。 */
export interface ChoiceOption {
  /** 选项唯一 id（前端回传时用）。 */
  id: string
  /** 展示文案。 */
  label: string
  /** 补充说明（可选）。 */
  description?: string
  /** 机器语义值（可选，如具体路径/模型名；回传时一并带回）。 */
  value?: string
}

/** 方案推荐请求（对应 Rust `agent-choice-needed` 事件，渲染选项列表弹窗）。 */
export interface ChoiceRequest {
  /** 本次询问唯一标识（oneshot 通道 key）。 */
  choiceId: string
  /** 向用户提出的问题。 */
  question: string
  /** 可选项列表（2–5 个）。 */
  options: ChoiceOption[]
}

/** 规划步骤状态（进度条渲染用）。 */
export type PlanStepStatus = 'pending' | 'running' | 'success' | 'failed'

/** 单个规划步骤（三层流水线：阶段二规划产物的进度条数据源）。 */
export interface PlanStep {
  step: number
  taskId?: string
  title: string
  description?: string
  status: PlanStepStatus
  /** 步骤产物摘要（step_finished 时回填）。 */
  summary?: string
  /** 前置依赖的步骤 task_id 列表（plan_generated 事件携带，驱动 §3.2 画布 DAG 连边）。 */
  dependsOn?: string[]
}

/** 规划/步骤视图（plan_generated / step_started / step_finished 事件携带）。 */
export interface PlanView {
  goalSummary?: string
  tasks?: PlanStep[]
  step?: number
  total?: number
  title?: string
  status?: PlanStepStatus
  summary?: string
}

/** 子任务文件产物引用（「产物画廊」数据源，对应 Rust `ArtifactRef` + `agent-artifact-created` 事件）。 */
export interface ArtifactRef {
  /** 产物唯一标识。 */
  artifactId: string
  /** 产生该产物的子任务 id。 */
  taskId?: string
  /** 子任务序号（1-based）。 */
  step: number
  /** 产物类型：file / image / document / spreadsheet / code / json / report / directory … */
  artifactType: string
  /** 产物绝对路径（已规范化、落于工作空间内）。 */
  path: string
  /** MIME 类型（由扩展名推导）。 */
  mimeType?: string
  /** 文件名 / 描述。 */
  description: string
  /** 字节大小（目录为 0）。 */
  size: number
  /** 创建时间（epoch 毫秒）。 */
  createdAt?: number
}

/** 步骤级恢复请求（对应 Rust `agent-recovery-needed` 事件，渲染恢复面板）。 */
export interface RecoveryRequest {
  /** 受阻子任务序号（1-based）。 */
  step: number
  /** 子任务 id（PlanSubTask.task_id）。 */
  taskId: string
  /** 子任务标题。 */
  title: string
  /** 受阻原因（最后一次失败摘要）。 */
  reason: string
  /** 受阻子任务已产出摘要（可能为空）。 */
  summary: string
  /** 异常分档：A=可恢复（3 键：跳过|重试|接管）/ B=高风险歧义（4 键，含改方案）。Phase 2a 恒为 "A"。 */
  tier?: string
  /** 失败命令（接管面板展示用，2a 可空）。 */
  failedCommand?: string
  /** 已改动文件（接管面板展示用，2b-2 起真实采集）。 */
  changedFiles?: string[]
  /** 工具栈快照（接管面板展示用，2b-2 新增）：原生工具 + MCP 工具 + 技能 + 沙箱开关。 */
  toolStack?: {
    nativeTools?: string[]
    mcpTools?: string[]
    skills?: string[]
    sandboxEnabled?: boolean
  }
}

/** 计划审批请求中的单个步骤（对应 Rust `agent-plan-approval-needed` 事件载荷中的 tasks 项）。 */
export interface PlanApprovalStep {
  step: number
  taskId?: string
  title: string
  description?: string
  /** 前置依赖的步骤 task_id 列表。 */
  dependsOn?: string[]
}

/** 计划审批请求（对应 Rust `agent-plan-approval-needed` 事件，渲染「计划确认」弹窗）。 */
export interface PlanApprovalRequest {
  /** 任务一句话目标。 */
  goalSummary: string
  /** DAG 步骤清单。 */
  tasks: PlanApprovalStep[]
}

/** 意图分类结果（intent_classified 事件携带，对应 Rust `IntentProfile` 经 camelCase 序列化）。 */
export interface IntentClassified {
  /** SIMPLE_CHAT | COMPOSITE_TASK */
  intentType: string
  reason: string
  requiresPlanning: boolean
  requiresTool: boolean
  /** low | medium | high | critical */
  riskLevel: string
  requiresApproval: boolean
  requiresArtifact: boolean
}

/** 分层思考片段（thinking_chunk 事件携带）。 */
export interface ThinkingChunk {
  /** plan=规划 / exec=执行 / selfcheck=自检 */
  layer: 'plan' | 'exec' | 'selfcheck'
  text: string
  done: boolean
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
    | 'plan_generated' // 三层流水线：阶段二规划生成（渲染步骤进度条）
    | 'step_started' // 子任务开始（对应步骤置 running）
    | 'step_finished' // 子任务结束（对应步骤置 success/failed，带产物摘要）
    | 'intent_classified' // 阶段一意图分流结果（轨迹视图首节点）
    | 'thinking_chunk' // 分层思考片段（plan/exec/selfcheck）
    | 'plan_branch_generated' // §3.2 分支重规划结果（双分支对比）
  /** 工具步骤（tool_started / tool_finished 时使用）。 */
  step?: ToolStep
  /** 文本片段（text_chunk / thinking_chunk 时使用）。 */
  chunk?: StreamChunk
  /** 状态/错误信息（status / error 时使用）。 */
  message?: string
  /** 事件序号（Rust 自增，前端可用于去重/排序，可选）。 */
  seq?: number
  /** 规划/步骤视图（plan_generated / step_started / step_finished 时使用）。 */
  plan?: PlanView
  /** 意图分类结果（intent_classified 时使用）。 */
  intent?: IntentClassified
  /** 分支重规划结果（plan_branch_generated 时使用）。 */
  branch?: PlanBranchGenerated
}

/** Tauri 侧的审批结果回传（前端调用 `submit_approval_decision` 时携带）。 */
export interface ApprovalDecision {
  approvalId: string
  /** 决策：approve=授权执行 / skip=跳过本次调用（不执行、不重试，按原计划继续） / takeover=授权+注入补充指示。 */
  decision: 'approve' | 'skip' | 'takeover'
  /** 接管时携带的用户补充指示（takeover 时有效，空等价于 approve）。 */
  guidance?: string
}

/** 消息附件（图片等），随 prompt 一起交给后端组装多模态 content。 */
export interface ChatAttachmentInput {
  /** 附件类型：image 多模态图片 / text 已提取文本 / file 二进制（落盘引用）。 */
  type: 'image' | 'text' | 'file'
  name?: string
  /** 多模态图片的 data URL（type=image）。 */
  dataUrl?: string
  /** 文本内容（type=text）或 base64 数据（type=file）。 */
  content?: string
  /** MIME 类型（type=text/file）。 */
  mime?: string
  /** 字节大小。 */
  size?: number
  /** 已分片落盘后的本地绝对路径（type=file，由 stage_attachment 命令返回）；存在时后端直接复用，不重复写盘，气泡也据此显示落盘路径。 */
  path?: string
}

/** 运行一轮任务的前端入参（对应 Rust `run_agent_task` 命令）。 */
export interface RunAgentTaskInput {
  agentId: string
  prompt: string
  /** 工作空间本地目录（沙箱工具的相对路径以此为基准）。 */
  workspace?: string | null
  /** 用户消息附件（多模态图片）。 */
  attachments?: ChatAttachmentInput[]
  /** 历史消息（可选，首轮通常不带，由 Rust 侧从最近 session 读取）。 */
  history?: Array<{ role: 'user' | 'assistant' | 'agent'; content: string }>
  /** 当前会话 id（前端建好的 agent_conversation_session.id），用于后端累计 input_token 与上下文压缩。 */
  sessionId?: string
  /** 当前轮次 id（前端建好的 agent_conversation_round.id），ReAct 循环结束后由 Rust 回填 raw_messages_json。 */
  roundId?: string
  /** 本轮临时禁用的技能 id 列表（仅会话内有效，不写库）。Rust 侧据此从工具集中剔除对应 Skill。 */
  disabledSkillIds?: string[]
  /** 本轮临时禁用的 MCP 服务 id 列表（仅会话内有效，不写库）。Rust 侧据此剔除该服务下全部工具。 */
  disabledMcpIds?: string[]
  /** 本轮临时禁用的单个 MCP 工具 id 列表（仅会话内有效，不写库）。键为 mcp_tool_definition.id。 */
  disabledMcpToolIds?: string[]
  /** 本轮临时启用的技能 id 列表（`@` 提及触发，仅会话内有效，不写库）。可包含智能体未绑定的技能，Rust 侧据此临时并入工具集。 */
  enabledSkillIds?: string[]
  /** 本轮临时启用的 MCP 服务 id 列表（`@` 提及触发，仅会话内有效，不写库）。可包含智能体未绑定的服务，Rust 侧据此把其全部工具临时并入工具集。 */
  enabledMcpIds?: string[]
  /** §3.2 分支重跑：直接采用前端合并好的完整计划（head + 新分支 tail），跳过 LLM 规划。字段名用 snake_case 以匹配 Rust `PlanDAG` 反序列化。 */
  planOverride?: PlanDAG
  /** 分支起点之前的已完成 head 步骤 task_id（流水线跳过执行，沿用其结果）。 */
  preCompleted?: string[]
  /** 产物管道初始上下文（head 步骤的已完成摘要），供 tail 步骤续接。 */
  initialContext?: string
}

/** §3.2 分支重跑直接采用的计划（对应 Rust `PlanDAG`，snake_case 字段）。 */
export interface PlanDAG {
  /** 任务目标摘要。 */
  goal_summary: string
  /** 原子子任务（head + 新分支 tail 合并，step 连续编号）。 */
  tasks: PlanSubTaskInput[]
}

/** §3.2 分支重跑的单个子任务（对应 Rust `PlanSubTask`，snake_case 字段）。 */
export interface PlanSubTaskInput {
  step: number
  task_id: string
  title: string
  description: string
  depends_on?: string[]
}

// ── §3.2 产物画布后半段：read_artifact 预览 + branch_from_step 分支重规划 ──

/** read_artifact 命令返回的产物预览结果（对应 Rust `ReadArtifactResult`）。 */
export interface ReadArtifactResult {
  path: string
  name: string
  /** text | image | directory | binary | not_found | error */
  kind: string
  size: number
  /** 文本内容（kind=text/binary/error/not_found 时携带，已截断）。 */
  content?: string
  /** 图片 data URL（kind=image 时携带，前端直接 <img> 渲染）。 */
  dataUrl?: string
  /** MIME 类型。 */
  mime?: string
  /** 目录子项名称列表（kind=directory 时携带）。 */
  entries?: string[]
  /** 文本是否被截断。 */
  truncated: boolean
}

/** 分支重规划的单步（from_step 之后的替代方案，已重编号续接原步骤序号）。 */
export interface BranchStep {
  step: number
  taskId: string
  title: string
  description: string
  dependsOn: string[]
}

/** 分支重规划结果（从 fromStep 起的「原尾段 vs 新分支」双分支对比）。 */
export interface PlanBranchGenerated {
  /** 分支起点步骤序号（从此步骤之后重新规划）。 */
  fromStep: number
  /** 原方案的尾部步骤（step > fromStep），供对比。 */
  originalTail: BranchStep[]
  /** 新生成的替代分支步骤（已从 fromStep+1 起重编号）。 */
  branchTasks: BranchStep[]
  /** 用户触发分支时的目标/原因摘要。 */
  goalSummary: string
}

/** branch_from_step 命令的前端入参。 */
export interface BranchFromStepInput {
  agentId: string
  workspace?: string | null
  fromStep: number
  goalSummary: string
  priorContext?: string
  originalTail?: BranchStep[]
  guidance?: string
}

// ── §3.3 记忆宫殿（Memory Palace）──

/** 记忆分类（与 Rust `MEMORY_CATEGORIES` 保持一致）。 */
export type MemoryCategory =
  | 'decision'
  | 'code_pattern'
  | 'user_pref'
  | 'architecture'
  | 'fix'
  | 'other'

/** 单条记忆（对应 Rust `MemoryItem`，经 camelCase 序列化）。 */
export interface MemoryItem {
  id: string
  agentId?: string | null
  sessionId?: string | null
  /** 短标题 / 关键词。 */
  key: string
  /** 记忆正文。 */
  content: string
  category: MemoryCategory
  /** 引用次数（召回埋点累计，驱动热力图与权重排序）。 */
  refCount: number
  /** 是否显式锚定（用户/智能体刻意沉淀）。 */
  anchored: boolean
  /** 最近一次召回时间（epoch 毫秒，可空）。 */
  lastRecalledAt?: number | null
  createdAt: number
  updatedAt: number
}

/** 热力图单点（按日聚合的召回次数）。 */
export interface HeatmapPoint {
  /** UTC 日期字符串 YYYY-MM-DD。 */
  date: string
  count: number
}

/** 锚定记忆入参（anchor_memory 命令）。 */
export interface AnchorMemoryInput {
  agentId?: string | null
  sessionId?: string | null
  key: string
  content: string
  category?: MemoryCategory
  /** true=手动锚定（钉住）；省略/false=仅沉淀（参与 ref_count 排序但不钉）。原生工具 native__anchor_memory 传 false。 */
  anchored?: boolean
}

/** 更新记忆入参（update_memory 命令）。 */
export interface UpdateMemoryInput {
  id: string
  key?: string
  content?: string
  category?: MemoryCategory
}

/** 记忆召回事件载荷（agent-memory-recalled 事件）。 */
export interface MemoryRecalledPayload {
  item: MemoryItem
}

/** 记忆锚定事件载荷（agent-memory-anchored 事件）：手动锚定或智能体自动沉淀后推送，供卡片实时刷新。 */
export interface MemoryAnchoredPayload {
  item: MemoryItem
}

/** 上下文压缩完成事件载荷（agent-context-compacted 事件）。 */
export interface ContextCompactedPayload {
  compactedRounds: number
  summaryLength: number
  tokensSaved: number
  success: boolean
}
