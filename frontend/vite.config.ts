import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
<<<<<<< HEAD
  const env = loadEnv(mode, path.resolve(__dirname, '../backend'), '')

  // Studio has no separate backend — it shares goku-core's backend at :8106
  const coreBackendPort = env.VITE_BACKEND_PORT || env.VITE_STUDIO_CORE_PORT || '8106'
  const frontendPort = parseInt(env.VITE_STUDIO_PORT || '5107', 10)
  const backendHttp = `http://127.0.0.1:${coreBackendPort}`
=======
  // Load from goku-studio/backend/.env (single source of truth for studio ports)
  const env = loadEnv(mode, path.resolve(__dirname, '../backend'), '')

  const backendPort  = env.VITE_STUDIO_BACKEND_PORT || env.BACKEND_PORT || '8107'
  const frontendPort = parseInt(env.VITE_STUDIO_PORT || env.VITE_PORT || '5107', 10)
  const backendHttp  = `http://127.0.0.1:${backendPort}`
>>>>>>> 1f8749159addca72722fdb94d3bf713a82b78b50

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: frontendPort,
      host: '0.0.0.0',
      strictPort: true,
      proxy: {
<<<<<<< HEAD
        '/api': { target: backendHttp, changeOrigin: true },
        '/icons': { target: backendHttp, changeOrigin: true },
=======
        // Studio API calls — proxied to goku-studio backend
        '/api': {
          target: backendHttp,
          changeOrigin: true,
        },
        // Agent icons — proxied to goku-studio backend
        '/icons': {
          target: backendHttp,
          changeOrigin: true,
        },
>>>>>>> 1f8749159addca72722fdb94d3bf713a82b78b50
      },
    },
  }
})
