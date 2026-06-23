// Cross-app navigation to the Runtime (goku-core) SPA.
//
// Studio is a separate SPA. Pages like /system/*, /org, /users, /audit/logs etc.
// live in the Runtime app, NOT in Studio's router. Using react-router's
// navigate() for those paths falls through to Studio's catch-all and lands on
// /agents — so always bridge with goToRuntime() instead.

export const RUNTIME_URL =
  (window as any).__APP_CONFIG__?.VITE_RUNTIME_URL ||
  ((import.meta as any).env?.VITE_RUNTIME_URL as string | undefined) ||
  'http://localhost:5106'

/**
 * Hard-navigate to a Runtime page, carrying the auth token so the user stays
 * logged in across the app boundary. `path` may include a `#hash` (e.g.
 * `/system/connectors#section-email`); the auth query string is inserted
 * before the hash so it survives the redirect.
 */
export function goToRuntime(path: string, token?: string | null, refreshToken?: string | null) {
  const [base, hash] = path.split('#')
  const params = new URLSearchParams()
  if (token) params.set('_token', token)
  if (refreshToken) params.set('_refresh_token', refreshToken)
  const qs = params.toString()
  window.location.href = `${RUNTIME_URL}${base}${qs ? `?${qs}` : ''}${hash ? `#${hash}` : ''}`
}
