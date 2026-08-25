export const ROUTES = {
  dashboard: '/',
  modelSettings: '/model-settings',
  knowledge: '/knowledge',
  agentStudio: '/agent-studio',
  squadsWorkspace: '/squads-workspace',
} as const

export const knowledgeDetailPath = (id: string): string => `/knowledge/${id}`
