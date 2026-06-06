/**
 * Raw axios instance for pages that need direct access to response.data.
 * Used by ChatPage and other pages that call full paths like '/api/v1/...'
 */
import axios from 'axios'
import { useAuthStore } from '../stores/auth'

const request = axios.create({
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

request.interceptors.request.use(
  (config) => {
    const token = useAuthStore.getState().token
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Mutex: prevents concurrent refresh races (same pattern as api/index.ts)
let _refreshPromise: Promise<string> | null = null
// Shared flag to prevent multiple simultaneous logout redirects
let _loggingOut = false

request.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config
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
          // Use shared promise so concurrent 401s don't each start their own refresh
          if (!_refreshPromise) {
            _refreshPromise = request
              .post('/api/v1/auth/refresh', null, {
                headers: { Authorization: `Bearer ${refreshToken}` },
              })
              .then((resp) => {
                const { access_token, refresh_token } = resp.data
                useAuthStore.getState().setTokens(access_token, refresh_token)
                _loggingOut = false
                return access_token as string
              })
              .finally(() => { _refreshPromise = null })
          }
          const newToken = await _refreshPromise
          originalRequest.headers.Authorization = `Bearer ${newToken}`
          return request(originalRequest)
        } catch {
          // refresh failed — fall through to logout
        }
      }
      if (!_loggingOut) {
        _loggingOut = true
        useAuthStore.getState().logout()
        // Use replace so back button doesn't re-trigger the protected route
        window.location.replace('/login')
      }
    }
    return Promise.reject(error)
  }
)

export default request
