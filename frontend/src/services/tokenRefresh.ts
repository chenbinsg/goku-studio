/**
 * Proactive token refresh — schedules a refresh N minutes before JWT expiry
 * so users don't get silently logged out when idle or when only using WS/SSE
 * connections (which don't trigger HTTP 401 paths).
 */
import axios from 'axios'
import { useAuthStore } from '../stores/auth'

// Refresh this many seconds before the token actually expires
const REFRESH_BUFFER_SECONDS = 5 * 60

let refreshTimer: ReturnType<typeof setTimeout> | null = null

function decodeExp(token: string): number | null {
  try {
    const payloadB64 = token.split('.')[1]
    const json = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))
    const payload = JSON.parse(json)
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}

async function doRefresh() {
  const { refreshToken } = useAuthStore.getState()
  if (!refreshToken) return
  try {
    const resp = await axios.post(
      '/api/v1/auth/refresh',
      null,
      { headers: { Authorization: `Bearer ${refreshToken}` } },
    )
    const { access_token, refresh_token } = resp.data
    useAuthStore.getState().setTokens(access_token, refresh_token)
    // setTokens will trigger the auth-store subscriber below, which reschedules.
  } catch (err) {
    // Refresh failed — don't force-logout here; let the next HTTP 401 path
    // handle it. Just stop scheduling so we don't loop.
    console.warn('Proactive token refresh failed:', err)
  }
}

function schedule(token: string | null) {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  if (!token) return
  const exp = decodeExp(token)
  if (!exp) return
  const now = Math.floor(Date.now() / 1000)
  const secondsUntilRefresh = Math.max(10, exp - now - REFRESH_BUFFER_SECONDS)
  refreshTimer = setTimeout(() => { void doRefresh() }, secondsUntilRefresh * 1000)
}

export function startTokenRefresher() {
  // Schedule for the token that's already in the store (e.g. after page reload)
  schedule(useAuthStore.getState().token)
  // Reschedule whenever the token changes (login, refresh, logout)
  useAuthStore.subscribe((state, prev) => {
    if (state.token !== prev.token) {
      schedule(state.token)
    }
  })
}
