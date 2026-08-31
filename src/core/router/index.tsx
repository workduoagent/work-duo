import { createHashRouter } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import DashboardPage from '@/pages/dashboard'
import ModelSettingsPage from '@/pages/model-settings'
import KnowledgeListPage from '@/pages/knowledge'
import KnowledgeDetailPage from '@/pages/knowledge/components/detail.tsx'
import AgentStudioPage from '@/pages/agent-studio'
import SquadsWorkspacePage from '@/pages/squads-workspace'
import SkillHubPage from '@/pages/skill-hub'
import SkillDetailPage from '@/pages/skill-hub/detail'
import McpHubPage from '@/pages/mcp'
import McpDetailPage from '@/pages/mcp/detail'
import SettingsPage from '@/pages/settings'
import SandboxPythonPage from '@/pages/sandbox/python'

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
      { path: 'skill-hub/:id', element: <SkillDetailPage /> },
      { path: 'mcp-hub', element: <McpHubPage /> },
      { path: 'mcp-hub/:id', element: <McpDetailPage /> },
      { path: 'sandbox/python', element: <SandboxPythonPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
])
