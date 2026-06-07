import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useAuthStore } from './stores/auth'
import ErrorBoundary from './components/ErrorBoundary'
import StudioLayout from './components/StudioLayout'

// Studio pages
import AgentList              from './modules/studio/agents/AgentList'
import AgentRuntimeDashboard  from './modules/studio/agents/AgentRuntimeDashboard'
import WorkflowList           from './modules/studio/workflows/WorkflowList'
import WorkflowDesigner       from './modules/studio/workflows/WorkflowDesigner'
import WorkflowMonitor        from './modules/studio/workflows/WorkflowMonitor'
import ToolList               from './modules/studio/tools/ToolList'
import ToolDetail             from './modules/studio/tools/ToolDetail'
import McpServerList          from './modules/studio/mcp/McpServerList'
import McpServerDetail        from './modules/studio/mcp/McpServerDetail'
import McpExternalConnections from './modules/studio/mcp/McpExternalConnections'
import KnowledgeList          from './modules/studio/knowledge/KnowledgeList'
import AgentKnowledgeHub      from './modules/studio/knowledge/AgentKnowledgeHub'
import ExternalSources        from './modules/studio/knowledge/ExternalSources'
import NotionCallback         from './modules/studio/knowledge/NotionCallback'
import MemoryList             from './modules/studio/memory/MemoryList'
import SkillList              from './modules/studio/skills/SkillList'
import PluginList             from './modules/studio/plugins/PluginList'
import ConnectorPage          from './modules/studio/connectors/ConnectorPage'
import DocumentCenterPage     from './modules/studio/docs/DocumentCenterPage'

// Agent config pages (migrated from goku-core admin)
import AgentSoul              from './modules/admin/system/AgentSoul'
import ImprovementProposals   from './modules/admin/system/ImprovementProposals'
import StatefulPolicyAdmin     from './modules/admin/StatefulPolicyAdmin'
import StatefulTransitionAudit  from './modules/admin/StatefulTransitionAudit'

const RUNTIME_URL = (import.meta.env.VITE_RUNTIME_URL as string | undefined) || 'http://localhost:5106'

// Redirect unauthenticated users via core's bridge route.
// /bridge/studio checks auth at core — if already logged in it hands off the JWT
// straight back to studio; if not, core shows the login page first.
function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuthStore()
  if (!token) {
    window.location.href = `${RUNTIME_URL}/bridge/studio`
    return null
  }
  return <>{children}</>
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<PrivateRoute><StudioLayout /></PrivateRoute>}>
            <Route index element={<Navigate to="/agents" replace />} />
            <Route path="agents"                        element={<AgentList />} />
            <Route path="agents/runtime"                element={<AgentRuntimeDashboard />} />
            <Route path="workflows"                     element={<WorkflowList />} />
            <Route path="workflows/designer/*"          element={<WorkflowDesigner />} />
            <Route path="workflows/:id/executions/:eid" element={<WorkflowMonitor />} />
            <Route path="tools"                         element={<ToolList />} />
            <Route path="tools/:name"                   element={<ToolDetail />} />
            <Route path="mcp"                           element={<McpServerList />} />
            <Route path="mcp/:id"                       element={<McpServerDetail />} />
            <Route path="mcp-connections"               element={<McpExternalConnections />} />
            <Route path="knowledge"                     element={<KnowledgeList />} />
            <Route path="agent-knowledge"               element={<AgentKnowledgeHub />} />
            <Route path="knowledge/external-sources"    element={<ExternalSources />} />
            <Route path="knowledge/notion-callback"     element={<NotionCallback />} />
            <Route path="memory"                        element={<MemoryList />} />
            <Route path="skills"                        element={<SkillList />} />
            <Route path="plugins"                       element={<PluginList />} />
            <Route path="connectors"                    element={<ConnectorPage />} />
            <Route path="docs"                          element={<DocumentCenterPage />} />
            {/* Agent config — migrated from goku-core */}
            <Route path="system/soul"                   element={<AgentSoul />} />
            <Route path="system/proposals"              element={<ImprovementProposals />} />
            <Route path="admin/stateful-policies"       element={<StatefulPolicyAdmin />} />
            <Route path="admin/stateful-audit"          element={<StatefulTransitionAudit />} />
            <Route path="*"                             element={<Navigate to="/agents" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
