import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = (env.VITE_API_PROXY_TARGET || 'https://localhost:4001').replace(/\/$/, '')
  const sigTarget = (env.VITE_SIGNALING_PROXY_TARGET || 'http://localhost:4002').replace(/\/$/, '')

  return {
    plugins: [react(), tailwindcss()],
    server: {
      allowedHosts: ['3468-2400-1a00-4b20-1fc2-18cb-f6da-2f0c-b76a.ngrok-free.app'],
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/health': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/socket.io': {
          target: sigTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  }
})