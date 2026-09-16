export const ROUTES = {
  dashboard: '/',
  modelSettings: '/model-settings',
  knowledge: '/knowledge',
  agentStudio: '/agent-studio',
  squadsWorkspace: '/squads-workspace',
  skillHub: '/skill-hub',
  mcpHub: '/mcp-hub',
  pluginHub: '/plugin-hub',
  sandbox: '/sandbox',
  sandboxPython: '/sandbox/python',
  settings: '/settings',
} as const

export const mcpDetailPath = (id: string): string => `/mcp-hub/${id}`

export const pluginDetailPath = (id: string): string => `/plugin-hub/${id}`

export const skillDetailPath = (id: string): string => `/skill-hub/${id}`

export const knowledgeDetailPath = (id: string): string => `/knowledge/${id}`

/** 新建智能体（4 步向导）。注意：必须注册在 'agent-studio/:id/*' 之前，否则会被当 id 吃掉 */
export const agentNewPath = '/agent-studio/new'

/** 编辑智能体（4 步向导，复用同一页面） */
export const agentEditPath = (id: string): string => `/agent-studio/${id}/edit`

/** 进入智能体（对话/运行页，原「调试」语义升级为「进入会话」） */
export const agentChatPath = (id: string): string => `/agent-studio/${id}/chat`
