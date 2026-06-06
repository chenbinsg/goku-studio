import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

interface User {
  id: string
  username: string
  email: string
  roles: string[]
  avatar?: string
  is_superuser?: boolean   // set by login/refresh/SSO responses; drives the instant admin-menu shortcut
  is_active?: boolean
  department?: string
  tenant_id?: string | null   // null/undefined for global superusers; required for tenant-scoped writes
}

interface AuthState {
  user: User | null
  token: string | null
  refreshToken: string | null
  isAuthenticated: boolean
  setAuth: (user: User, token: string, refreshToken?: string) => void
  setTokens: (token: string, refreshToken: string) => void
  logout: () => void
}

const AUTH_STORAGE_KEY = 'auth-storage'

// P1 hardening: stop persisting auth tokens to long-lived localStorage.
// We keep auth only for the current browser session and proactively clear any
// legacy localStorage copy left by older builds.
try {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(AUTH_STORAGE_KEY)
  }
} catch {
  // ignore storage access errors
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      refreshToken: null,
      isAuthenticated: false,
      setAuth: (user, token, refreshToken) =>
        set({ user, token, refreshToken: refreshToken || null, isAuthenticated: true }),
      setTokens: (token, refreshToken) =>
        set({ token, refreshToken }),
      logout: () => {
        // End Keycloak session via backend (server-to-server, no browser cookies needed)
        import('../services/keycloak').then(({ getKeycloakRefreshToken, clearKeycloakRefreshToken }) => {
          const kcToken = getKeycloakRefreshToken()
          if (kcToken) {
            import('../api').then(({ authApi }) => {
              authApi.keycloakLogout(kcToken).catch(() => {})
            })
            clearKeycloakRefreshToken()
          }
        })
        set({ user: null, token: null, refreshToken: null, isAuthenticated: false })
        import('../stores/chat').then(({ useChatStore }) => {
          ;(useChatStore.getState() as any).resetAll?.()
        })
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      storage: createJSONStorage(() => sessionStorage),
    }
  )
)
