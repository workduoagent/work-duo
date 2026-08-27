export const ROUTES = {
  dashboard: '/',
  modelSettings: '/model-settings',
  knowledge: '/knowledge',
  agentStudio: '/agent-studio',
  squadsWorkspace: '/squads-workspace',
  skillHub: '/skill-hub',
  mcpHub: '/mcp-hub',
  settings: '/settings',
} as const

export const knowledgeDetailPath = (id: string): string => `/knowledge/${id}`
