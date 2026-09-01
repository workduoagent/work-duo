export const ROUTES = {
  dashboard: '/',
  modelSettings: '/model-settings',
  knowledge: '/knowledge',
  agentStudio: '/agent-studio',
  squadsWorkspace: '/squads-workspace',
  skillHub: '/skill-hub',
  mcpHub: '/mcp-hub',
  sandbox: '/sandbox',
  sandboxPython: '/sandbox/python',
  settings: '/settings',
} as const

export const mcpDetailPath = (id: string): string => `/mcp-hub/${id}`

export const skillDetailPath = (id: string): string => `/skill-hub/${id}`

export const knowledgeDetailPath = (id: string): string => `/knowledge/${id}`

/** 新建智能体（4 步向导）。注意：必须注册在 'agent-studio/:id/*' 之前，否则会被当 id 吃掉 */
export const agentNewPath = '/agent-studio/new'

/** 编辑智能体（4 步向导，复用同一页面） */
export const agentEditPath = (id: string): string => `/agent-studio/${id}/edit`

/** 调试智能体（对话页） */
export const agentChatPath = (id: string): string => `/agent-studio/${id}/chat`
