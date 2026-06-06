import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { useAuthStore } from '../stores/auth'

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1'

// Shared logout guard — prevents multiple simultaneous redirects to /login
let _loggingOut = false
export function resetLogoutGuard() { _loggingOut = false }

// Refresh mutex — prevents concurrent token refresh races (token rotation means
// only ONE refresh call can succeed; the second would get 401 on a revoked token
// and incorrectly trigger logout while the user is still active)
let _refreshPromise: Promise<string> | null = null

class ApiClient {
  private client: AxiosInstance

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
      paramsSerializer: {
        indexes: null,  // serialize arrays as key=v1&key=v2 (FastAPI style)
      },
    })

    this.client.interceptors.request.use(
      (config) => {
        const token = useAuthStore.getState().token
        if (token) {
          config.headers.Authorization = `Bearer ${token}`
        }
        return config
      },
      (error) => Promise.reject(error)
    )

    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        // Normalize FastAPI's structured error responses into a flat
        // string callers can hand straight to message.error. Two shapes
        // we encounter:
        //   1. {"detail": "human string"}            — most endpoints
        //   2. {"detail": {"code": ..., "message"}}  — MCP_CONNECTION_*
        //                                              etc. structured codes
        // Without this, dict detail → `[object Object]` on UI. Mutate the
        // payload in place so existing `e?.response?.data?.detail` accesses
        // keep working without touching every call site.
        //
        // We deliberately do NOT prepend the code (`[MCP_CONNECTION_REQUIRED] …`)
        // to the user-facing string — code is implementation-internal noise to
        // the admin. Code goes to console for developers; UI gets clean Chinese.
        try {
          const d = error.response?.data?.detail
          if (d && typeof d === 'object') {
            const code = (d as any).code
            const msg = (d as any).message
            if (code) {
              // eslint-disable-next-line no-console
              console.warn(`[api] ${code}:`, msg)
            }
            error.response.data._detailObject = d  // keep original for callers that want code/structure
            error.response.data.detail = msg || code || JSON.stringify(d)
          }
        } catch {
          // Defensive — never let normalization break the actual error path.
        }
        const originalRequest = error.config
        // Auto-refresh token on 401 (but not for login/refresh endpoints)
        if (
          error.response?.status === 401 &&
          !originalRequest._retry &&
          !originalRequest.url?.includes('/auth/login') &&
          !originalRequest.url?.includes('/auth/refresh')
        ) {
          originalRequest._retry = true
          const refreshToken = useAuthStore.getState().refreshToken
          if (refreshToken) {
            try {
              // Mutex: if a refresh is already in flight, wait for it instead of
              // firing a second one (which would fail because the token is rotated)
              if (!_refreshPromise) {
                _refreshPromise = this.client
                  .post('/auth/refresh', null, {
                    headers: { Authorization: `Bearer ${refreshToken}` },
                  })
                  .then((resp) => {
                    const { access_token, refresh_token } = resp.data as any
                    useAuthStore.getState().setTokens(access_token, refresh_token)
                    return access_token as string
                  })
                  .finally(() => { _refreshPromise = null })
              }
              const newAccessToken = await _refreshPromise
              originalRequest.headers.Authorization = `Bearer ${newAccessToken}`
              return this.client(originalRequest)
            } catch {
              // Refresh failed — fall through to logout
            }
          }
          if (!_loggingOut) {
            _loggingOut = true
            useAuthStore.getState().logout()
            window.location.replace('/login')
          }
        }
        return Promise.reject(error)
      }
    )
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.get(url, config)
    return response.data
  }

  async post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.post(url, data, config)
    return response.data
  }

  async put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.put(url, data, config)
    return response.data
  }

  async patch<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.patch(url, data, config)
    return response.data
  }

  async delete<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response: AxiosResponse<T> = await this.client.delete(url, config)
    return response.data
  }
}

export const api = new ApiClient()

// Auth API
export const authApi = {
  login: (username: string, password: string, mfaCode?: string) =>
    api.post<{ access_token: string; refresh_token: string; expires_in: number; user: any }>('/auth/login', {
      username,
      password,
      mfa_code: mfaCode,
    }),
  logout: () =>
    api.post<{ message: string; sso_logout_url?: string }>('/auth/logout'),
  refresh: (refreshToken: string) =>
    api.post<{ access_token: string; refresh_token: string; expires_in: number; user: any }>('/auth/refresh', null, {
      headers: { Authorization: `Bearer ${refreshToken}` },
    }),
  setupMfa: () =>
    api.post<{ secret: string; qr_code: string; backup_codes: string[] }>('/auth/mfa/setup'),
  ssoCallback: (code: string, state: string, provider: string) =>
    api.post<{ access_token: string; user: any }>('/auth/sso/callback', { code, state, provider }),
  getSsoProviders: () =>
    api.get<{ providers: Array<{ provider: string; label: string; available: boolean; mode: string }> }>('/auth/sso/providers'),
  getSsoLoginUrl: (provider: string, redirectUri: string) =>
    api.get<{ provider: string; authorization_url: string }>(`/auth/sso/login/${provider}`, {
      params: { redirect_uri: redirectUri },
    }),
  keycloakExchange: (keycloakToken: string) =>
    api.post<{ access_token: string; refresh_token: string; expires_in: number; user: any }>(
      '/auth/keycloak/exchange',
      { keycloak_token: keycloakToken },
    ),
  keycloakLogout: (kcRefreshToken: string) =>
    api.post('/auth/keycloak/logout', { keycloak_refresh_token: kcRefreshToken }),
}

// Task API
export const taskApi = {
  create: (data: {
    prompt: string
    context?: object
    priority?: number
    timeout?: number
    agent_id?: string
    attachments?: Array<{ file_id: string; path: string; content_type: string; filename?: string }>
  }) =>
    api.post<{ task_id: string; status: string; created_at: string }>('/tasks', data),
  list: (params: { page: number; size: number; status?: string; user_id?: string }) =>
    api.get<{ total: number; items: any[] }>('/tasks', { params }),
  get: (id: string) => api.get<{ task: any; steps: any[]; logs: any[] }>(`/tasks/${id}`),
  cancel: (id: string, reason: string) => api.post<{ task_id: string; status: string; cancelled_at: string }>(`/tasks/${id}/cancel`, { reason }),
  retry: (id: string, data?: { from_step?: number; force?: boolean }) =>
    api.post<{ task_id: string; new_task_id: string; status: string }>(`/tasks/${id}/retry`, data),
  rollback: (id: string, toStep: number, reason: string) =>
    api.post<{ rollback_task_id: string; status: string }>(`/tasks/${id}/rollback`, { to_step: toStep, reason }),
  delete: (id: string) => api.delete<void>(`/tasks/${id}`),
  bulkDelete: (ids: string[]) => api.delete<{ deleted: number }>(`/tasks`, { data: ids }),
  board: () => api.get<{
    columns: Record<string, any[]>
    zombie_count: number
    total_active: number
  }>('/tasks/board'),
  zombies: () => api.get<{ zombies: any[]; count: number }>('/tasks/zombies'),
}

// Tool API
export const toolApi = {
  list: () => api.get<{ tools: any[] }>('/tools'),
  get: (name: string) => api.get<any>(`/tools/${name}`),
  register: (data: { name: string; description: string; handler: string; schema: object; permission_level: number }) =>
    api.post<{ tool_id: string; status: string }>('/tools', data),
  execute: (name: string, data: { parameters: object; timeout?: number; approval_token?: string }) =>
    api.post<{ result: object; exit_code: number; logs: any[] }>(`/tools/${name}/execute`, data),
}

// Approval API
export const approvalApi = {
  list: (params: { status?: string; role?: string; page: number; size: number }) =>
    api.get<{ total: number; items: any[] }>('/approvals', { params }),
  get: (id: string) => api.get<any>(`/approvals/${id}`),
  create: (data: { task_id: string; operation: string; risk_level: number; description: string }) =>
    api.post<{ approval_id: string; status: string; approvers: any[] }>('/approvals', data),
  action: (id: string, action: 'approve' | 'reject', comment: string, editedBody?: string) =>
    api.post<{ approval_id: string; status: string; executed_at?: string }>(
      `/approvals/${id}/action`,
      { action, comment, ...(editedBody !== undefined ? { edited_body: editedBody } : {}) },
    ),
  escalate: (id: string) =>
    api.post<{ approval_id: string; status: string }>(`/approvals/${id}/escalate`, {}),
  createStatefulDemo: () =>
    api.post<{ approval_id: string; status: string; approvers: any[] }>(`/approvals/demo/stateful`, {}),
  resetStatefulDemo: (id: string) =>
    api.post<{ approval_id: string; status: string; approvers: any[] }>(`/approvals/${id}/demo-reset`, {}),
  delete: (id: string) => api.delete<void>(`/approvals/${id}`),
  cleanupStale: (days = 7) =>
    api.post<{ deleted: number; email_reset: number; message: string }>(
      `/approvals/cleanup-stale`,
      null,
      { params: { days } },
    ),
}

export const statefulRuntimeApi = {
  getApprovalState: (approvalId: string) =>
    api.get<{ state: any; available_actions: any[] }>(`/stateful-runtime/approvals/${approvalId}/state`),
  simulateApproval: (approvalId: string) =>
    api.post<{ state: any; available_actions: any[] }>(`/stateful-runtime/approvals/${approvalId}/simulate`, {}),
  stepApproval: (
    approvalId: string,
    data: { action_name: string; payload?: Record<string, any>; reason?: string; bypass_policy?: boolean },
  ) =>
    api.post<{
      before_state: any
      available_actions: any[]
      decision: any
      execution: any
    }>(`/stateful-runtime/approvals/${approvalId}/step`, data),
  createDemoTicket: () =>
    api.post<{ ticket_id: string; status: string }>(`/stateful-runtime/tickets/demo`, {}),
  getTicketState: (ticketId: string) =>
    api.get<{ state: any; available_actions: any[] }>(`/stateful-runtime/tickets/${ticketId}/state`),
  simulateTicket: (ticketId: string) =>
    api.post<{ state: any; available_actions: any[] }>(`/stateful-runtime/tickets/${ticketId}/simulate`, {}),
  stepTicket: (
    ticketId: string,
    data: { action_name: string; payload?: Record<string, any>; reason?: string; bypass_policy?: boolean },
  ) =>
    api.post<{
      before_state: any
      available_actions: any[]
      decision: any
      execution: any
    }>(`/stateful-runtime/tickets/${ticketId}/step`, data),
}

export const statefulPoliciesApi = {
  list: (params?: { entity_kind?: string; tenant_id?: string }) =>
    api.get<{ count: number; items: any[] }>('/stateful-policies', { params }),
  create: (data: {
    entity_kind: string
    action_name: string
    policy_mode: string
    reason?: string
    tenant_id?: string
    allow_idempotent_retry?: boolean
  }) => api.post<any>('/stateful-policies', data),
  update: (id: string, data: { policy_mode?: string; reason?: string; allow_idempotent_retry?: boolean }) =>
    api.put<any>(`/stateful-policies/${id}`, data),
  remove: (id: string) => api.delete<void>(`/stateful-policies/${id}`),
  listKinds: () => api.get<{ kinds: { kind: string; display_name: string; description: string }[] }>('/stateful-policies/meta/kinds'),
  resolvePolicy: (kind: string, action: string, tenantId?: string) =>
    api.get<any>(`/stateful-policies/meta/resolve/${kind}/${action}`, { params: { tenant_id: tenantId } }),
  listTransitions: (params?: {
    entity_kind?: string
    entity_id?: string
    task_id?: string
    needs_human_review?: boolean
    stop_reason?: string
    limit?: number
    offset?: number
  }) => api.get<{ total: number; offset: number; limit: number; items: any[] }>('/stateful-policies/audit/transitions', { params }),
}

// Memory API
export const memoryApi = {
  create: (data: { type: 'short' | 'long'; content: string; tags?: string[]; ttl?: number }) =>
    api.post<{ memory_id: string; vector_id: string; stored_at: string }>('/memory', data),
  search: (data: { query: string; type?: string; top_k?: number; filters?: object }) =>
    api.post<{ results: any[] }>('/memory/search', data),
  list: (params?: { type?: string; page?: number; size?: number }) =>
    api.get<{ total: number; items: any[] }>('/memory', { params }),
  delete: (id: string) => api.delete<void>(`/memory/${id}`),
  timeline: (params?: { page?: number; size?: number; domain?: string }) =>
    api.get<{ total: number; items: any[]; domain_counts: Record<string, number> }>('/memory/timeline', { params }),
  consolidate: () =>
    api.post<{ merged: number; expired: number; checked: number }>('/memory/consolidate'),
}

// Model API — Phase 2: AIOS delegates the catalog to Goku-Router.
// Only read paths + the AIOS-owned "set default" remain. Create/Update/Delete
// were removed; manage the catalog on the Router side.
export const modelApi = {
  list: () => api.get<{ models: any[]; source?: string }>('/models'),
  getDefault: () => api.get<{ model: string; provider: string }>('/models/default'),
  setDefault: (model: string, provider: string) =>
    api.post<{ model: string; provider: string }>('/models/set-default', { model, provider }),
}

// Cost API
export const costApi = {
  summary: (days = 1) =>
    api.get<{
      period_days: number
      totals: { count: number; input_tokens: number; output_tokens: number; total_cost: number }
      by_model: any[]
      daily: any[]
    }>(`/costs/summary?days=${days}`),
}

// Conversation API
export const conversationApi = {
  updateModel: (convId: string, model: string | null) =>
    api.put(`/conversations/${convId}/model`, { model }),
}

// Ollama API
export const ollamaApi = {
  listModels: () => api.get<{ models: any[] }>('/models/ollama'),
  healthCheck: () => api.get<any>('/models/health'),
}

// Role API
export const roleApi = {
  list: () => api.get<{ items: any[] }>('/roles'),
  get: (id: string) => api.get<any>(`/roles/${id}`),
  create: (data: { name: string; permissions: string[]; max_level: number; tools: string[] }) =>
    api.post<{ role_id: string; created_at: string }>('/roles', data),
  update: (id: string, data: { name: string; permissions: string[]; max_level: number; tools: string[] }) =>
    api.put<any>(`/roles/${id}`, data),
  delete: (id: string) => api.delete<void>(`/roles/${id}`),
  listPermissions: () => api.get<{ catalog: Record<string, Record<string, string>> }>('/roles/permissions'),
  assign: (userId: string, roleIds: string[], tenantId?: string) =>
    api.put<{ user_id: string; roles: string[]; updated_at: string }>(`/users/${userId}/roles`, { role_ids: roleIds, tenant_id: tenantId }),
  getUserRoles: (userId: string) =>
    api.get<{ user_id: string; roles: any[] }>(`/users/${userId}/roles`),
}

// User API
export const userApi = {
  list: (params?: { page?: number; size?: number; search?: string }) =>
    api.get<{ total: number; items: any[] }>('/users', { params }),
  get: (id: string) => api.get<any>(`/users/${id}`),
  create: (data: { username: string; email: string; password: string; is_superuser?: boolean; departments?: string[] }) =>
    api.post<{ id: string; username: string; email: string; departments: string[]; created_at: string }>('/users', data),
  update: (id: string, data: { email?: string; is_active?: boolean; is_superuser?: boolean; departments?: string[]; team_id?: string; full_name?: string; mobile?: string; employee_id?: string }) =>
    api.put<any>(`/users/${id}`, data),
  delete: (id: string) => api.delete<void>(`/users/${id}`),
  resetPassword: (id: string, newPassword: string) =>
    api.put<{ status: string }>(`/users/${id}/password`, { new_password: newPassword }),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    api.put<{ status: string }>('/users/me/password', { current_password: currentPassword, new_password: newPassword }),
}

// Department API
export const departmentApi = {
  list: () => api.get<{ items: any[]; total: number }>('/departments'),
  create: (data: { name: string; description?: string }) =>
    api.post<any>('/departments', data),
  update: (id: string, data: { name?: string; description?: string }) =>
    api.put<any>(`/departments/${id}`, data),
  delete: (id: string) => api.delete<void>(`/departments/${id}`),
}

// Audit API
export const auditApi = {
  logs: (params: { start_time: string; end_time: string; user_id?: string; action?: string; resource_type?: string; page: number; size: number }) =>
    api.get<{ total: number; items: any[] }>('/audit/logs', { params }),
  export: (data: { start_time: string; end_time: string; format: 'pdf' | 'csv'; filters?: object }) =>
    api.post<{ download_url: string; expires_at: string }>('/audit/export', data),
  replay: (taskId: string) => api.get<{ steps: any[] }>(`/audit/replay/${taskId}`),
}

// Tenant API
export const tenantApi = {
  list: (page = 1, size = 50) => api.get<{ items: any[]; total: number }>('/tenants', { params: { page, size } }),
  create: (data: { name: string; admin_email: string; quota?: object; settings?: object }) =>
    api.post<{ tenant_id: string; api_key: string; created_at: string }>('/tenants', data),
  update: (id: string, data: object) => api.patch<any>(`/tenants/${id}`, data),
  delete: (id: string) => api.delete(`/tenants/${id}`),
  getQuota: (id: string) => api.get<{ quota: object; usage: object; remaining: object }>(`/tenants/${id}/quota`),
  updateQuota: (id: string, data: { cpu: number; memory: number; tokens_per_day: number; max_concurrent_tasks: number }) =>
    api.put<{ tenant_id: string; updated_quota: object; effective_at: string }>(`/tenants/${id}/quota`, data),
}

// Workflow API
export const workflowApi = {
  list: (page = 1, size = 100) =>
    api.get<{ items: any[] }>('/workflows', { params: { page, size } }),
  get: (id: string) => api.get<any>(`/workflows/${id}`),
  create: (data: { name: string; description?: string; dag: object; triggers?: any[]; variables?: object }) =>
    api.post<{ workflow_id: string; version: string; created_at: string }>('/workflows', data),
  update: (id: string, data: { name?: string; description?: string; dag?: object; triggers?: any[]; variables?: object }) =>
    api.put<{ workflow_id: string; version: string; updated_at: string }>(`/workflows/${id}`, data),
  execute: (id: string, data?: { variables?: object; dry_run?: boolean }) =>
    api.post<{ execution_id: string; status: string; started_at: string }>(`/workflows/${id}/execute`, data),
  delete: (id: string) => api.delete<void>(`/workflows/${id}`),
  getExecution: (workflowId: string, executionId: string) =>
    api.get<any>(`/workflows/${workflowId}/executions/${executionId}`),
  listExecutions: (workflowId: string, page = 1, size = 20) =>
    api.get<{ items: any[]; total: number }>(`/workflows/${workflowId}/executions`, { params: { page, size } }),
  cancelExecution: (workflowId: string, executionId: string) =>
    api.post<any>(`/workflows/${workflowId}/executions/${executionId}/cancel`),
  retryFromLayer: (workflowId: string, executionId: string, layer: number) =>
    api.post<{ new_execution_id: string }>(`/workflows/${workflowId}/executions/${executionId}/retry-from-layer`, { layer }),
}

// Notification API
export const notificationApi = {
  list: (params?: { unread_only?: boolean; page?: number; size?: number }) =>
    api.get<{ total: number; items: any[] }>('/notifications', { params }),
  markRead: (id: string) => api.post(`/notifications/${id}/read`),
  markAllRead: () => api.post('/notifications/read-all'),
  pullEmail: (id: string) =>
    api.post<{ conversation_id: string; title: string }>(`/notifications/${id}/pull-email`),
}

// Email Watch API
export interface RoutingRule { source_type?: string; inbox: string; agent: string; label?: string }
export interface TriageConfig {
  routing: RoutingRule[]
  subject_blocklist: string[]
  subject_allowlist: string[]
  sender_blocklist: string[]
  auto_header_filter: boolean
  llm_triage_enabled: boolean
}
export const emailWatchApi = {
  getRules: () =>
    api.get<{ rules: Array<{ keyword: string; enabled: boolean }> }>('/email-watch/rules'),
  updateRules: (rules: Array<{ keyword: string; enabled: boolean }>) =>
    api.put<{ rules: Array<{ keyword: string; enabled: boolean }> }>('/email-watch/rules', { rules }),
  pollNow: () =>
    api.post<{ new_emails: number }>('/email-watch/poll-now'),
  getTriageConfig: () =>
    api.get<TriageConfig>('/email-watch/triage-config'),
  updateTriageConfig: (data: TriageConfig) =>
    api.put<TriageConfig>('/email-watch/triage-config', data),
}

// Email Queue API
export interface IncomingEmailItem {
  id: string
  message_id: string | null
  recipient_to: string | null
  sender_from: string | null
  sender_name: string | null
  subject: string | null
  received_at: string | null
  assigned_agent: string | null
  status: string | null
  draft_subject: string | null
  draft_summary: string | null
  approval_id: string | null
  error_message: string | null
  created_at: string | null
  updated_at: string | null
}

export interface IncomingEmailDetail extends IncomingEmailItem {
  body_text: string | null
  body_html: string | null
}

export interface EmailQueueStats {
  new: number
  processing: number
  draft_ready: number
  sent: number
  rejected: number
  error: number
}

export const emailQueueApi = {
  list: (params?: { status?: string; assigned_agent?: string; page?: number; size?: number }) =>
    api.get<{ total: number; items: IncomingEmailItem[] }>('/email-queue', { params }),
  get: (id: string) =>
    api.get<IncomingEmailDetail>(`/email-queue/${id}`),
  dispatch: (id: string, agentSlug: string) =>
    api.post<{ task_id: string; email_id: string; agent_slug: string; status: string }>(
      `/email-queue/${id}/dispatch`,
      { agent_slug: agentSlug },
    ),
  assign: (id: string, agentSlug: string | null) =>
    api.patch<{ id: string; assigned_agent: string | null }>(`/email-queue/${id}/assign`, { agent_slug: agentSlug }),
  discard: (id: string) =>
    api.delete<{ discarded: string; status: string }>(`/email-queue/${id}`),
  stats: () =>
    api.get<EmailQueueStats>('/email-queue/stats/summary'),
}

// Metrics API
export const metricsApi = {
  get: (params: { metric_names: string[]; start_time: string; end_time: string; granularity: string }) =>
    api.get<{ metrics: any[] }>('/metrics', { params }),
  createAlert: (data: { name: string; metric: string; condition: string; threshold: number; channels: any[] }) =>
    api.post<{ rule_id: string; status: string; created_at: string }>('/alerts/rules', data),
  listAlerts: () => api.get<{ items: any[] }>('/alerts/rules'),
}

// Plugin / Skills Marketplace API
export const pluginApi = {
  list: () => api.get<{ items: any[] }>('/plugins'),
  marketplace: (params?: { query?: string; category?: string; page?: number; size?: number }) =>
    api.get<{ items: any[]; total: number; categories: string[] }>('/plugins/marketplace', { params }),
  install: (data: { plugin_id: string; version: string; config?: object }) =>
    api.post<{ installation_id: string; status: string; installed_at: string }>('/plugins/install', data),
  uninstall: (id: string) => api.delete<{ status: string; name: string }>(`/plugins/${id}`),
  upgrade: (id: string, data: { version: string }) =>
    api.put<{ status: string; previous_version: string; new_version: string }>(`/plugins/${id}/upgrade`, data),
  audit: (id: string, version?: string) =>
    api.get<any>(`/plugins/${id}/audit`, { params: { version } }),
}

// Doctor / Diagnostics API
export const doctorApi = {
  check: () => api.get<any>('/doctor'),
}

// Heartbeat API
export const heartbeatApi = {
  list: (params?: { page?: number; size?: number }) =>
    api.get<{ total: number; items: any[] }>('/heartbeats', { params }),
  get: (id: string) => api.get<any>(`/heartbeats/${id}`),
  create: (data: { name: string; cron_expression: string; prompt: string; description?: string; agent_id?: string; enabled?: boolean }) =>
    api.post<any>('/heartbeats', data),
  update: (id: string, data: { name?: string; cron_expression?: string; prompt?: string; description?: string; agent_id?: string; enabled?: boolean }) =>
    api.put<any>(`/heartbeats/${id}`, data),
  delete: (id: string) => api.delete<void>(`/heartbeats/${id}`),
  run: (id: string) => api.post<any>(`/heartbeats/${id}/run`),
}

// Connector API
export const connectorApi = {
  list: () => api.get<{ connectors: any[] }>('/connectors'),
  test: (data: { connector: string; target?: string; message?: string }) =>
    api.post<{ success: boolean; error?: string }>('/connectors/test', data),
  send: (connector: string, data: { target?: string; content: string; msg_type?: string }) =>
    api.post<{ success: boolean; error?: string }>(`/connectors/${connector}/send`, data),
  getConfig: () => api.get<{ email: any; feishu: any; teams: any }>('/connectors/config'),
  saveConfig: (data: { email?: any; feishu?: any; teams?: any }) =>
    api.put<{ status: string }>('/connectors/config', data),
  testChannel: (type: 'email' | 'feishu' | 'teams') =>
    api.post<{ ok: boolean; message?: string; error?: string }>(`/connectors/test/${type}`, {}),
}

// Instructions / Agent Soul API
export const instructionsApi = {
  get: () => api.get<{ instructions: string; rules: any[] }>('/instructions'),
  save: (content: string) => api.put<{ status: string }>('/instructions', { content }),
  exportSoul: () => api.get<string>('/instructions/export', { responseType: 'text' } as any),
  importSoul: (content: string) =>
    api.post<{ status: string; summary: Record<string, string>; sections_imported: number }>(
      '/instructions/import-soul',
      { content },
    ),
}

// System API
export const systemApi = {
  getConfig: () => api.get<{ config: object; version: string; updated_at: string }>('/system/config'),
  updateConfig: (data: { config: object; force_restart?: boolean }) =>
    api.put<{ status: string; applied_at: string; requires_restart: boolean }>('/system/config', data),
  health: () => api.get<{ status: string; components: any[]; version: string }>('/health'),
}

// Agent Definition API
export const agentApi = {
  list: (params?: { page?: number; size?: number; is_active?: boolean; favorites_only?: boolean }) =>
    api.get<{ total: number; items: any[] }>('/agents', { params }),
  get: (id: string) => api.get<any>(`/agents/${id}`),
  exportBatch: (agentIds: string[]) =>
    api.post<{ download_url?: string }>('/agents/export', { agent_ids: agentIds }),
  create: (data: {
    name: string
    agent_type: string
    description?: string
    department?: string
    figure_url?: string
    system_prompt_override?: string
    skills?: string[]
    allowed_tools?: string[]
    model_override?: string
    max_steps?: number
    icon?: string
    color?: string
    visibility?: string
    allowed_roles?: string[]
  }) => api.post<any>('/agents', data),
  update: (id: string, data: Partial<{
    name: string
    description: string
    department: string
    figure_url: string
    system_prompt_override: string
    skills: string[]
    allowed_tools: string[]
    model_override: string
    max_steps: number
    icon: string
    color: string
    is_active: boolean
    visibility: string
    allowed_roles: string[]
    notification_channels: { type: string; target: string }[]
    escalation_contact: { type: string; target: string } | null
    allowed_channels: string[]
    channel_configs: Record<string, { webhook_url?: string }>
  }>) => api.put<any>(`/agents/${id}`, data),
  delete: (id: string) => api.delete<{ success: boolean }>(`/agents/${id}`),
  baseTypes: () => api.get<{ agent_types: any[] }>('/agents/base-types'),
  skills: () => api.get<{ root: string; skills: any[] }>('/agents/skills'),
  // Favorites
  toggleFavorite: (agentId: string) =>
    api.post<{ favorited: boolean; agent_id: string }>(`/agents/${agentId}/favorite`),
  listFavorites: () => api.get<{ items: any[] }>('/agents/favorites'),
  getEmailConfig: (id: string) => api.get<{ slug: string; config: AgentEmailConfig }>(`/agents/${id}/email-config`),
  updateEmailConfig: (id: string, config: AgentEmailConfig) =>
    api.put<{ slug: string; config: AgentEmailConfig }>(`/agents/${id}/email-config`, config),
  emailPendingCounts: () => api.get<{ counts: Record<string, number> }>('/agents/email-pending-counts'),
}

export interface AgentEmailConfig {
  enabled: boolean
  monitored_addresses: string[]
  reply_from: string
  poll_interval_minutes: number
  subject_blocklist: string[]
  sender_blocklist: string[]
}

// Cross-Agent Knowledge Relay API
export const agentKnowledgeApi = {
  list: (params?: { agent_type?: string; limit?: number }) =>
    api.get<{ items: any[]; total: number }>('/agents/knowledge', { params }),
  create: (data: { content: string; agent_type: string; domain: string }) =>
    api.post<any>('/agents/knowledge', data),
  delete: (id: string) => api.delete<{ success: boolean }>(`/agents/knowledge/${id}`),
}

// Knowledge base (RAG) API
export const knowledgeApi = {
  list: (params?: { page?: number; size?: number; search?: string }) =>
    api.get<{ total: number; items: any[] }>('/knowledge', { params }),
  get: (id: string) => api.get<any>(`/knowledge/${id}`),
  create: (data: { title: string; content: string; source?: string; tags?: string[] }) =>
    api.post<{ id: string; title: string; chunks: number; created_at: string }>('/knowledge', data),
  upload: (formData: FormData) =>
    api.post<{ id: string; title: string; format: string; characters: number; chunks: number }>(
      '/knowledge/upload', formData,
      {
        timeout: 300_000,
        headers: { 'Content-Type': null },  // remove application/json default so browser sets multipart boundary
      },
    ),
  search: (data: { query: string; top_k?: number; min_similarity?: number }) =>
    api.post<{ results: any[]; query: string; total: number }>('/knowledge/search', data),
  delete: (id: string) => api.delete<void>(`/knowledge/${id}`),
}

// External Memory Sources API (Notion / Obsidian)
export const externalMemoryApi = {
  list: () =>
    api.get<any[]>('/external-memory/sources'),
  createObsidian: (data: { vault_path: string; name?: string }) =>
    api.post<any>('/external-memory/sources', data),
  delete: (id: string) =>
    api.delete<void>(`/external-memory/sources/${id}`),
  sync: (id: string) =>
    api.post<{ status: string }>(`/external-memory/sources/${id}/sync`),
  getNotionAuthUrl: (redirectUri: string) =>
    api.get<{ authorization_url: string; state: string }>(
      '/external-memory/notion/auth-url', { params: { redirect_uri: redirectUri } }
    ),
  notionCallback: (data: { code: string; redirect_uri: string }) =>
    api.post<any>('/external-memory/notion/callback', data),
}

// Dashboard API
export const dashboardApi = {
  getStats: () =>
    api.get<{
      system: {
        cpu_percent: number
        memory_percent: number
        memory_used_gb: number
        memory_total_gb: number
        disk_percent: number
        disk_used_gb: number
        disk_total_gb: number
        thread_count: number
        uptime_seconds: number
      }
      users: {
        total: number
        active_today: number
        currently_active: number
        new_today: number
      }
      platform: {
        tools: number
        agents: number
        models: number
        workflows: number
        knowledge_docs: number
        auto_skills: number
      }
      tasks: {
        total_today: number
        running: number
        pending: number
        completed_today: number
        failed_today: number
        success_rate_today: number
        workflow_executions_today: number
      }
      costs: {
        today: { cost: number; calls: number; input_tokens: number; output_tokens: number }
        week: { cost: number; calls: number; input_tokens: number; output_tokens: number }
        month: { cost: number; calls: number; input_tokens: number; output_tokens: number }
        top_models_today: Array<{ model: string; cost: number; calls: number }>
      }
      alerts: {
        pending_approvals: number
        unread_notifications: number
      }
      generated_at: string
    }>('/dashboard/stats'),
}

// Agent Instances API (Wukong)
export interface AgentInstanceSlot {
  slot_id: string
  status: 'idle' | 'busy'
  session_id: string | null
  task_id: string | null
  caller_id: string | null
  channel: string | null
  duration_sec: number
}

export interface AgentTypeStatus {
  agent_type: string
  total_slots: number
  busy: number
  idle: number
  queued: number
  instances: AgentInstanceSlot[]
  queue: Array<{ request_id: string; caller_id: string | null; channel: string | null; waited_sec: number }>
}

export const agentInstanceApi = {
  allStatus: () =>
    api.get<AgentTypeStatus[]>('/agent-instances/status'),
  typeStatus: (agentType: string) =>
    api.get<AgentTypeStatus>(`/agent-instances/status/${agentType}`),
  cancelQueued: (agentType: string, requestId: string) =>
    api.delete<{ removed: boolean; request_id: string }>(`/agent-instances/queue/${agentType}/${requestId}`),
  scale: (agentType: string, maxConcurrent: number) =>
    api.post<{ agent_type: string; new_count: number }>(`/agent-instances/scale/${agentType}`, { max_concurrent: maxConcurrent }),
  getSlot: (slotId: string) =>
    api.get<AgentInstanceSlot>(`/agent-instances/slot/${encodeURIComponent(slotId)}`),
}

// Auto Skills API
export const autoSkillApi = {
  list: (params?: { page?: number; size?: number; approval_status?: string }) =>
    api.get<{ items: any[]; total: number }>('/auto-skills', { params }),
  get: (id: string) => api.get<any>(`/auto-skills/${id}`),
  update: (id: string, data: { name?: string; description?: string; trigger_pattern?: string; approval_status?: string }) =>
    api.patch<any>(`/auto-skills/${id}`, data),
  approve: (id: string) => api.post<any>(`/auto-skills/${id}/approve`),
  delete: (id: string) => api.delete<{ success: boolean }>(`/auto-skills/${id}`),
  search: (data: { query: string; top_k?: number }) =>
    api.post<{ items: any[] }>('/auto-skills/search', data),
}

// Analytics API
export const analyticsApi = {
  overview: (days = 30, department_id?: string, team_id?: string) =>
    api.get<any>('/analytics/overview', { params: { days, department_id, team_id } }),
  dau: (days = 30, period: 'day' | 'week' | 'month' = 'day', department_id?: string, team_id?: string) =>
    api.get<any[]>('/analytics/dau', { params: { days, period, department_id, team_id } }),
  agents: (days = 30, department_id?: string, team_id?: string) =>
    api.get<any[]>('/analytics/agents', { params: { days, department_id, team_id } }),
  tools: (days = 30, department_id?: string, team_id?: string) =>
    api.get<any[]>('/analytics/tools', { params: { days, department_id, team_id } }),
  users: (days = 30, department_id?: string, team_id?: string) =>
    api.get<any[]>('/analytics/users', { params: { days, department_id, team_id } }),
  retention: (weeks = 8) => api.get<any[]>('/analytics/retention', { params: { weeks } }),
}

// External API Keys
export const externalKeyApi = {
  list: () => api.get<any[]>('/external-keys'),
  create: (data: {
    name: string
    qps_limit?: number
    monthly_quota?: number
    webhook_url?: string
    expires_days?: number
  }) => api.post<any>('/external-keys', data),
  update: (id: string, data: Partial<{ name: string; qps_limit: number; monthly_quota: number; webhook_url: string; is_active: boolean }>) =>
    api.patch<any>(`/external-keys/${id}`, data),
  revoke: (id: string) => api.delete<void>(`/external-keys/${id}`),
}

// Org Teams API (TASK 1.9.8.1)
export const orgTeamsApi = {
  list: (params?: { department_id?: string; active_only?: boolean }) =>
    api.get<{ items: any[]; total: number }>('/org/teams', { params }),
  get: (id: string) => api.get<any>(`/org/teams/${id}`),
  create: (data: { name: string; slug?: string; description?: string; department_id?: string }) =>
    api.post<any>('/org/teams', data),
  update: (id: string, data: Partial<{ name: string; slug: string; description: string; department_id: string; is_active: boolean }>) =>
    api.put<any>(`/org/teams/${id}`, data),
  delete: (id: string) => api.delete<void>(`/org/teams/${id}`),
  members: (id: string) => api.get<any>(`/org/teams/${id}/members`),
  assignUser: (userId: string, teamId: string) =>
    api.post<any>(`/users/${userId}/team`, null, { params: { team_id: teamId } }),
  removeUser: (userId: string) => api.delete<void>(`/users/${userId}/team`),
  userTree: () => api.get<any>('/org/user-tree'),
}

// Agent Policies API (TASK 1.9.8.2)
export const agentPoliciesApi = {
  list: (agentId: string) => api.get<any>(`/agents/${agentId}/policies`),
  grant: (agentId: string, data: {
    principal_type: 'user' | 'team' | 'department' | 'tenant'
    principal_id: string
    can_view?: boolean
    can_use?: boolean
    can_config?: boolean
    expires_at?: string | null
  }) => api.post<any>(`/agents/${agentId}/policies`, data),
  update: (agentId: string, policyId: string, data: Partial<{
    can_view: boolean; can_use: boolean; can_config: boolean; expires_at: string | null
  }>) => api.put<any>(`/agents/${agentId}/policies/${policyId}`, data),
  revoke: (agentId: string, policyId: string) =>
    api.delete<void>(`/agents/${agentId}/policies/${policyId}`),
  myAccessibleAgents: (permission?: 'can_view' | 'can_use' | 'can_config') =>
    api.get<{ agent_ids: string[]; count: number }>('/me/accessible-agents', { params: { permission } }),
}

// UniCall API
export const unicallApi = {
  channels: () => api.get<{ channels: string[]; mvp_channels: string[] }>('/unicall/channels'),
  listAccounts: (params?: { user_id?: string; channel?: string }) =>
    api.get<{ items: any[] }>('/unicall/accounts', { params }),
  bind: (data: { channel: string; external_user_id: string; external_display_name?: string; metadata?: any }) =>
    api.post<{ id: string; status: string }>('/unicall/bind', data),
  disableAccount: (id: string) => api.delete<{ id: string; status: string }>(`/unicall/accounts/${id}`),
  listMessages: (params?: { channel?: string; status?: string; page?: number; size?: number }) =>
    api.get<{ total: number; items: any[] }>('/unicall/messages', { params }),
  listDeliveries: (params?: { channel?: string; status?: string; page?: number; size?: number }) =>
    api.get<{ total: number; items: any[] }>('/unicall/deliveries', { params }),
  testSend: (data: { channel: string; target: string; title?: string; body?: string }) =>
    api.post<{ success: boolean; error?: string; delivery_id: string }>('/unicall/test-send', data),
  generateBindCode: (channelHint?: string) =>
    api.post<{ code: string; expires_in: number }>('/unicall/bind-codes', channelHint ? { channel_hint: channelHint } : {}),
  redeemBindCode: (data: { code: string; channel: string; external_user_id: string; external_display_name?: string }) =>
    api.post<{ status: string; channel: string; user_id: string; account_id: string }>('/unicall/bind-codes/redeem', data),
  health: () => api.get<{ channels: any[]; window_hours: number }>('/unicall/health'),
  retryDelivery: (id: string) => api.post<{ success: boolean; retry_count: number; error?: string }>(`/unicall/deliveries/${id}/retry`),
}

// Mobile API
export const mobileApi = {
  summary: () => api.get<any>('/mobile/summary'),
  getPreferences: () => api.get<any>('/mobile/preferences'),
  updatePreferences: (data: { default_channels?: string[]; quiet_hours?: any }) =>
    api.put<any>('/mobile/preferences', data),
}

// Improvement Proposals API
export const proposalsApi = {
  list: (params?: { status?: string; risk_level?: string; agent_id?: string; page?: number; size?: number }) =>
    api.get<{ total: number; page: number; size: number; items: any[] }>('/improvement-proposals', { params }),
  stats: (days?: number) =>
    api.get<any>('/improvement-proposals/stats', { params: days ? { days } : undefined }),
  get: (id: string) => api.get<any>(`/improvement-proposals/${id}`),
  apply: (id: string) => api.post<{ id: string; status: string }>(`/improvement-proposals/${id}/apply`),
  reject: (id: string, reason?: string) =>
    api.post<{ id: string; status: string }>(`/improvement-proposals/${id}/reject`, { reason }),
}

// Billing API
export const billingApi = {
  overview: () => api.get<any>('/billing/overview'),
  history: (months = 6) => api.get<any[]>('/billing/history', { params: { months } }),
  agents: () => api.get<any[]>('/billing/agents'),
  getQuota: () => api.get<any>('/billing/quota'),
  updateQuota: (data: {
    tenant_id?: string
    monthly_token_limit?: number | null
    alert_threshold_pct?: number
    throttle_on_exceed?: boolean
    router_tenant_id?: string
  }) => api.put<any>('/billing/quota', data),
  syncRouter: () => api.post<any>('/billing/sync-router'),
  pullFromRouter: (month?: string) =>
    api.post<any>('/billing/pull-from-router', null, { params: month ? { month } : undefined }),
}
