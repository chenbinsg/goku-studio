import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  // Load from goku-studio/backend/.env (single source of truth for studio ports)
  const env = loadEnv(mode, path.resolve(__dirname, '../backend'), '')

  const backendPort  = env.VITE_STUDIO_BACKEND_PORT || env.BACKEND_PORT || '8107'
  const frontendPort = parseInt(env.VITE_STUDIO_PORT || env.VITE_PORT || '5107', 10)
  const backendHttp  = `http://127.0.0.1:${backendPort}`

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
      },
    },
  }
})
