import { createHashRouter } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import DashboardPage from '@/pages/dashboard'
import ModelSettingsPage from '@/pages/model-settings'
import KnowledgeListPage from '@/pages/knowledge'
import KnowledgeDetailPage from '@/pages/knowledge/detail'
import AgentStudioPage from '@/pages/agent-studio'
import SquadsWorkspacePage from '@/pages/squads-workspace'
import SkillHubPage from '@/pages/skill-hub'
import McpHubPage from '@/pages/mcp'
import SettingsPage from '@/pages/settings'

// HashRouter is used so deep links survive reloads inside the Tauri custom
// protocol (no SPA fallback on tauri://). Swap to createBrowserRouter if the
// app is ever served from a web host with history fallback.
export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'model-settings', element: <ModelSettingsPage /> },
      { path: 'knowledge', element: <KnowledgeListPage /> },
      { path: 'knowledge/:id', element: <KnowledgeDetailPage /> },
      { path: 'agent-studio', element: <AgentStudioPage /> },
      { path: 'squads-workspace', element: <SquadsWorkspacePage /> },
      { path: 'skill-hub', element: <SkillHubPage /> },
      { path: 'mcp-hub', element: <McpHubPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])
