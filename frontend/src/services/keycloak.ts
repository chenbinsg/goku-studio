import Keycloak, { type KeycloakConfig } from 'keycloak-js'

const KEYCLOAK_URL =
  (import.meta.env.VITE_KEYCLOAK_URL as string | undefined) ||
  'https://qa-keycloak.nsstest.com/auth/'
const KEYCLOAK_REALM =
  (import.meta.env.VITE_KEYCLOAK_REALM as string | undefined) || 'netstars'
const KEYCLOAK_CLIENT_ID =
  (import.meta.env.VITE_KEYCLOAK_CLIENT_ID as string | undefined) || 'goku-aios'

const config: KeycloakConfig = {
  url: KEYCLOAK_URL,
  realm: KEYCLOAK_REALM,
  clientId: KEYCLOAK_CLIENT_ID,
}

export function hasKeycloakCallback(): boolean {
  const h = window.location.hash
  return h.includes('state=') && (h.includes('code=') || h.includes('error='))
}

export async function handleKeycloakCallback(): Promise<{ token: string; refreshToken: string }> {
  const kc = new Keycloak(config)
  const authenticated = await kc.init({
    pkceMethod: 'S256',
    checkLoginIframe: false,
  })
  window.history.replaceState({}, '', window.location.pathname + window.location.search)
  if (!authenticated || !kc.token) {
    throw new Error('Keycloak callback: not authenticated')
  }
  return { token: kc.token, refreshToken: kc.refreshToken || '' }
}

export async function redirectToKeycloak(): Promise<void> {
  const kc = new Keycloak(config)
  await kc.init({ pkceMethod: 'S256', checkLoginIframe: false })
  await kc.login({ redirectUri: window.location.origin + '/login' })
}

export function storeKeycloakRefreshToken(token: string): void {
  sessionStorage.setItem('kc_refresh_token', token)
}

export function getKeycloakRefreshToken(): string | null {
  return sessionStorage.getItem('kc_refresh_token')
}

export function clearKeycloakRefreshToken(): void {
  sessionStorage.removeItem('kc_refresh_token')
}
