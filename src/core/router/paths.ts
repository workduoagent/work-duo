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
