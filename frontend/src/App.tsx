/**
 * Goku Studio — Router
 *
 * Only Studio routes live here.  Runtime routes (chat, analytics, org, etc.)
 * remain in goku-core.  The StudioLayout's sidebar has a "Go to Runtime" link
 * that sends the user back to VITE_RUNTIME_URL with their JWT.
 */
import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/auth'
import ErrorBoundary from './components/ErrorBoundary'
import StudioLayout from './components/StudioLayout'

// ── Studio pages ────────────────────────────────────────────────────────────
import AgentList from './modules/studio/agents/AgentList'
import AgentRuntimeDashboard from './modules/studio/agents/AgentRuntimeDashboard'
import WorkflowList from './modules/studio/workflows/WorkflowList'
import WorkflowDesigner from './modules/studio/workflows/WorkflowDesigner'
import WorkflowMonitor from './modules/studio/workflows/WorkflowMonitor'
import ToolList from './modules/studio/tools/ToolList'
import ToolDetail from './modules/studio/tools/ToolDetail'
import McpServerList from './modules/studio/mcp/McpServerList'
import McpServerDetail from './modules/studio/mcp/McpServerDetail'
import McpExternalConnections from './modules/studio/mcp/McpExternalConnections'
import KnowledgeList from './modules/studio/knowledge/KnowledgeList'
import AgentKnowledgeHub from './modules/studio/knowledge/AgentKnowledgeHub'
import ExternalSources from './modules/studio/knowledge/ExternalSources'
import NotionCallback from './modules/studio/knowledge/NotionCallback'
import MemoryList from './modules/studio/memory/MemoryList'
import SkillList from './modules/studio/skills/SkillList'
import PluginList from './modules/studio/plugins/PluginList'
import ConnectorPage from './modules/studio/connectors/ConnectorPage'
import DocumentCenterPage from './modules/studio/docs/DocumentCenterPage'

// ── Login redirect ────────────────────────────────────────────────────────────
const RUNTIME_URL = (import.meta.env.VITE_RUNTIME_URL as string | undefined) || 'http://localhost:5106'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) {
    // Send the user to goku-core's login page.
    // ?next=/bridge/studio tells Core to redirect back to Studio (with JWT) after login.
    window.location.href = `${RUNTIME_URL}/login?next=/bridge/studio`
    return null
  }
  return <>{children}</>
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          {/* Default — redirect to agents */}
          <Route path="/" element={<Navigate to="/agents" replace />} />

          {/* All Studio routes share the StudioLayout */}
          <Route element={<PrivateRoute><StudioLayout /></PrivateRoute>}>
            <Route path="agents" element={<AgentList />} />
            <Route path="agents/runtime" element={<AgentRuntimeDashboard />} />

            <Route path="workflows" element={<WorkflowList />} />
            <Route path="workflows/designer/:id?" element={<ErrorBoundary><WorkflowDesigner /></ErrorBoundary>} />
            <Route path="workflows/:id/executions/:execId" element={<WorkflowMonitor />} />

            <Route path="tools" element={<ToolList />} />
            <Route path="tools/:name" element={<ToolDetail />} />

            <Route path="mcp" element={<McpServerList />} />
            <Route path="mcp/:id" element={<McpServerDetail />} />
            <Route path="mcp-connections" element={<McpExternalConnections />} />

            <Route path="knowledge" element={<KnowledgeList />} />
            <Route path="agent-knowledge" element={<AgentKnowledgeHub />} />
            <Route path="knowledge/external-sources" element={<ExternalSources />} />
            <Route path="knowledge/notion-callback" element={<NotionCallback />} />

            <Route path="memory" element={<MemoryList />} />
            <Route path="skills" element={<SkillList />} />
            <Route path="plugins" element={<PluginList />} />
            <Route path="connectors" element={<ConnectorPage />} />
            <Route path="docs" element={<DocumentCenterPage />} />
          </Route>

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/agents" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
