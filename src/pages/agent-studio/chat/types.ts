/**
 * chat 页模块级纯类型（#20260915005 Step 1 自 chat.tsx 原样抽出）。
 *
 * 搬运原则（docs/chat-split-plan.md）：声明、字段、注释一律原样，仅加 export；
 * 渲染层 JSX 零改动。子目录引用 session/types 必须用 `../session/types`。
 */
import type * as React from 'react'
import type { ChatAttachmentInput, PlanStep, ToolStep } from '../session/types'

/** 输入框底部工具条里展示的「单个 MCP 服务」及其绑定工具（用于临时移除 / 工具开关）。 */
export interface BoundMcpTool {
  /** mcp_tool_definition.id（Rust 过滤键）。 */
  toolId: string
  /** 工具代码 / 展示名。 */
  toolCode: string
  displayName?: string
  description?: string
}
export interface BoundMcpServer {
  mcpId: string
  name: string
  tools: BoundMcpTool[]
}

/** 输入框 @提及 / /指令 浮层的候选条目。 */
export interface SuggestItem {
  /** 唯一键（用于 React 列表与选中判定）。 */
  key: string
  /** 插入文本框的 token（@ 或 / 之后的实际文本，通常无空格）。 */
  token: string
  /** 展示名。 */
  label: string
  /** 补充说明（技能描述 / 服务类型 / 指令说明）。 */
  sub?: string
  /** 分组标题（决定浮层渲染时的分组头）。 */
  group: '技能' | 'MCP 服务' | '插件' | '指令'
}

/** 输入框建议浮层状态（@提及 与 /指令 共用同一套触发/渲染逻辑）。 */
export interface SuggestState {
  mode: 'mention' | 'command'
  /** 触发符（@ 或 /）之后的查询串。 */
  query: string
  /** 触发符在 input 中的起始下标（含 @ 或 /）。 */
  start: number
  /** 当前光标位置（触发词尾部）。 */
  end: number
  /** 按查询过滤后的候选列表（渲染与键盘导航共用）。 */
  items: SuggestItem[]
  /** 当前高亮项下标（仅在触发词签名变化时归零，避免方向键被光标微调重置）。 */
  index: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  createdAt: number
  /** 该轮的深度思考/状态文本（绑定到消息，多轮互不串台）。 */
  thought?: string[]
  /** 该轮的工具调用步骤（绑定到消息，多轮互不串台）。 */
  toolSteps?: ToolStep[]
  /** 该轮的规划步骤结构（绑定到消息，历史回显时重建「步骤 → 工具」嵌套视图；live 轮用运行时 planSteps）。 */
  planSteps?: PlanStep[]
  /** 回复完成时间戳（用于计算对话时长与本条耗时）。 */
  completedAt?: number
  /** 本条回复耗时（ms）。 */
  durationMs?: number
  /** 预估消耗 token 数。 */
  tokenCount?: number
  /** 用户消息附带的图片（多模态）。 */
  images?: ChatAttachmentInput[]
  /** 用户消息附带的全部附件（image/text/file），用于气泡回显。 */
  attachments?: ChatAttachmentInput[]
  /** 该轮任务异常信息（由 `agent-task-error` 写入），用于渲染「错误诊断面板」。 */
  error?: { message: string; at: number }
}

/** 输入框暂存附件：在 ChatAttachmentInput 基础上加前端 id，用于列表 key 与移除。 */
export interface PendingAttachment extends ChatAttachmentInput {
  id: string
}

/** 通用点击外部关闭的下拉菜单的条目。 */
export interface MenuItem {
  label: string
  onClick: () => void
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
}

/** Web Speech API 的最小类型（浏览器原生，未包含在 DOM lib 的完整定义时兜底）。 */
export interface SpeechLike {
  lang: string
  interimResults: boolean
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}
