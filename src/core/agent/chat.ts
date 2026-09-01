/**
 * 智能体调试对话的「调用层」。
 *
 * 当前状态：**UI 原型**。这一版不真正发起模型请求，只返回一段模拟回复并做打字机式流式输出，
 * 目的是先把调试页的交互与布局跑通（用户对调试页的设计还在考虑中）。
 *
 * 后续接真实 LLM 时的落点（就改本文件，页面不用动）：
 *  1. 由 agent.llmId 取 models 行（model-mapper.getModel），拿到 base_url / api_key / model_name；
 *  2. 用 agent.llmConfig（智能体私有参数副本）覆盖默认参数（temperature / maxTokens / stream …）；
 *  3. 请求体拼装：messages = [{ role:'system', content: agent.systemPrompt }, ...history]，
 *     tools = 由 agent_mcp_ref 关联的 mcp_tool_definition 转成 OpenAI function-calling 的 tools 数组；
 *  4. 发请求必须走 @tauri-apps/plugin-http 的 fetch（绕过 WebView 的 CORS，见 src/utils/modelTest.ts 的说明），
 *     非 Tauri 环境才用原生 fetch 回退；
 *  5. 流式（SSE）读取时把每个 chunk 的 delta 交给 onChunk；非流式则一次性 onChunk 整段。
 */

/** 调试页的单条消息。 */
export interface AgentChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  createdAt: number
  /** 该条是否还在生成中（用于显示「思考中」） */
  pending?: boolean
}

/**
 * 生成模拟回复的文案。
 * 真实实现里这里应是「调用模型」的结果，此处只做占位，把智能体的配置回显出来，
 * 方便在调试页确认绑定关系是否正确。
 */
export function buildMockReply(params: {
  agentName: string
  modelName?: string
  toolCount: number
  skillCount: number
  userText: string
}): string {
  const { agentName, modelName, toolCount, skillCount, userText } = params
  return [
    `我是 **${agentName}**，当前处于调试模式，暂时还没有接入真实模型，下面是一条模拟回复。`,
    '',
    `- 大脑模型：${modelName ?? '未绑定'}`,
    `- 已挂载 MCP 工具：${toolCount} 个`,
    `- 已编排技能：${skillCount} 个`,
    '',
    '你刚才说的是：',
    '',
    `> ${userText}`,
    '',
    '接入真实模型后，这里会输出模型的流式回答，并可在需要时调用已挂载的工具。',
  ].join('\n')
}

/**
 * 打字机式流式输出（模拟）。
 * 每 18ms 追加 2 个字符，返回取消函数（组件卸载 / 清空会话时调用，避免 setState 泄漏）。
 */
export function streamText(
  full: string,
  onChunk: (partial: string) => void,
  onDone: () => void,
): () => void {
  let i = 0
  const timer = setInterval(() => {
    i = Math.min(full.length, i + 2)
    onChunk(full.slice(0, i))
    if (i >= full.length) {
      clearInterval(timer)
      onDone()
    }
  }, 18)
  return () => clearInterval(timer)
}
