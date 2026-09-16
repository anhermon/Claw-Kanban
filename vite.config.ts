import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Proxy /api -> local express server. Must match PORT in .env (default 8788;
// 8787 collides with an unrelated local process bound to 127.0.0.1:8787).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true
      }
    }
  }
})
