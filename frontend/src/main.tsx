<<<<<<< HEAD
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
=======
/**
 * Goku Studio — entry point.
 *
 * Auth bridge: when goku-core navigates to Studio it appends ?_token=<jwt>
 * to the URL.  We read that here, persist it into the auth store, then
 * strip the token from the address bar so it never appears in browser history.
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import jaJP from 'antd/locale/ja_JP'
import App from './App'
import { useThemeStore } from './stores/theme'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from './stores/auth'
import './i18n'
import './index.css'

// ── Auth bridge ────────────────────────────────────────────────────────────────
// Read _token from URL (set by goku-core when navigating to Studio).
// Also accept _refresh_token for full session hand-off.
>>>>>>> 1f8749159addca72722fdb94d3bf713a82b78b50
;(function bootstrapAuthBridge() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('_token')
  const refreshToken = params.get('_refresh_token')
  if (token) {
<<<<<<< HEAD
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
=======
    // Decode minimal user info from JWT payload (no signature check — server validates)
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      const user = {
        id: payload.user_id || payload.sub,
        username: payload.username || payload.sub,
        email: payload.email || '',
        roles: payload.roles || [],
        is_superuser: payload.is_superuser ?? false,
        is_active: true,
        department: payload.department,
        tenant_id: payload.tenant_id,
      }
      useAuthStore.getState().setAuth(user, token, refreshToken || undefined)
    } catch {
      // Malformed token — let the app's PrivateRoute redirect to login
    }
    // Strip the token params from the URL without triggering a page reload
    params.delete('_token')
    params.delete('_refresh_token')
    const qs = params.toString()
    const clean = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
    window.history.replaceState({}, '', clean)
  }
})()

const ANT_LOCALES: Record<string, any> = { zh: zhCN, en: enUS, ja: jaJP }

const Root: React.FC = () => {
  const { isDark } = useThemeStore()
  const { i18n } = useTranslation()
  const antLocale = ANT_LOCALES[i18n.language] ?? zhCN

  return (
    <ConfigProvider
      locale={antLocale}
      theme={{
        algorithm: isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
      }}
    >
      <App />
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Root />)
>>>>>>> 1f8749159addca72722fdb94d3bf713a82b78b50
