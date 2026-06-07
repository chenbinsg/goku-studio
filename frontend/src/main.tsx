import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App'
import { useAuthStore } from './stores/auth'

// ── Auth Bridge ───────────────────────────────────────────────────────────────
// When goku-core redirects here it appends ?_token=<jwt>&_refresh_token=<rt>.
// Read, hydrate the auth store, then strip the params from the URL so they
// never appear in browser history or get leaked via the Referer header.
;(function bootstrapAuthBridge() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('_token')
  const refreshToken = params.get('_refresh_token')
  if (token) {
    try {
      const payload = JSON.parse(
        atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
      )
      const user = {
        id:           payload.user_id || payload.sub,
        username:     payload.username || payload.sub,
        email:        payload.email || '',
        roles:        payload.roles || [],
        is_superuser: payload.is_superuser ?? false,
        is_active:    true,
        department:   payload.department,
        tenant_id:    payload.tenant_id,
      }
      useAuthStore.getState().setAuth(user, token, refreshToken || undefined)
    } catch {
      // Malformed token — PrivateRoute will redirect to login
    }
    params.delete('_token')
    params.delete('_refresh_token')
    const qs = params.toString()
    window.history.replaceState(
      {},
      '',
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
    )
  }
})()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
