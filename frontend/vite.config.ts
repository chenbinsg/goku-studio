import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '../backend'), '')

  // Studio has no separate backend — it shares goku-core's backend at :8106
  const coreBackendPort = env.VITE_BACKEND_PORT || env.VITE_STUDIO_CORE_PORT || '8106'
  const frontendPort = parseInt(env.VITE_STUDIO_PORT || '5107', 10)
  const backendHttp = `http://127.0.0.1:${coreBackendPort}`

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
        '/api': { target: backendHttp, changeOrigin: true },
        '/icons': { target: backendHttp, changeOrigin: true },
      },
    },
  }
})
