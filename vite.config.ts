import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api -> local express server. Reads PORT from the environment / .env
// (same source the server uses) so both sides always agree. Falls back to the
// server's own default (8787) when PORT is unset.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  const apiPort = env.PORT || '8787'
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true
        }
      }
    }
  }
})
