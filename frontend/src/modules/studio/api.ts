/**
 * Studio module API client.
 *
 * All Studio pages must import from this file — never from @/api directly.
 * Base URL is configurable via VITE_STUDIO_API_URL so Studio can be pointed
 * at a separate goku-studio backend service when extracted.
 *
 * Deployment scenarios:
 *   Monorepo (default):  VITE_STUDIO_API_URL not set → uses shared /api/v1 client
 *   Split repos:         VITE_STUDIO_API_URL=https://studio.internal → own axios instance
 *
 * Phase progression:
 *   Phase 4 (current): both monorepo and standalone use /api/v1/* (sub-router prefix)
 *   Phase 5 follow-on: sub-routers stripped to /agents etc; standalone uses /api/studio/v1
 */
import axios, { AxiosInstance } from 'axios'
import { api } from '@/api'
import { useAuthStore } from '@/stores/auth'

const STUDIO_API_URL = import.meta.env.VITE_STUDIO_API_URL as string | undefined

/**
 * When VITE_STUDIO_API_URL is set, create a dedicated Axios instance that
 * points at the standalone goku-studio service.
 * When unset, fall back to the shared monorepo API client (zero overhead).
 */
function createStudioClient(): typeof api {
  if (!STUDIO_API_URL) {
    // Monorepo mode — reuse the shared authenticated client
    return api
  }

  // Standalone mode — own axios instance with the same JWT interceptor pattern
  const baseURL = STUDIO_API_URL.replace(/\/$/, '') // strip trailing slash
  const client: AxiosInstance = axios.create({
    baseURL,
    timeout: 30000,
    headers: { 'Content-Type': 'application/json' },
    paramsSerializer: { indexes: null },
  })

  client.interceptors.request.use((config) => {
    const token = useAuthStore.getState().token
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  })

  client.interceptors.response.use(
    (res) => res,
    (err) => {
      if (err.response?.status === 401) {
        // Let the shared auth store handle logout / token refresh
        useAuthStore.getState().logout?.()
      }
      return Promise.reject(err)
    }
  )

  // Wrap in a minimal shim that matches the shared api's .get/.post/.put/.delete/.patch
  // surface so all Studio callers can stay unmodified.
  return client as unknown as typeof api
}

export const studioApi = createStudioClient()

export default studioApi
