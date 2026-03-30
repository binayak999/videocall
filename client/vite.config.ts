import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = (env.VITE_API_PROXY_TARGET || 'http://localhost:4001').replace(/\/$/, '')
  const sigTarget = (env.VITE_SIGNALING_PROXY_TARGET || 'http://localhost:4002').replace(/\/$/, '')

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        {
          find: /^@mediapipe\/selfie_segmentation$/,
          replacement: path.resolve(__dirname, 'src/shims/mediapipe-selfie-segmentation.ts'),
        },
        { find: 'buffer', replacement: path.resolve(__dirname, 'node_modules/buffer') },
      ],
    },
    optimizeDeps: {
      include: [
        'buffer',
        'nsfwjs',
        '@tensorflow/tfjs',
        '@tensorflow-models/body-segmentation',
        '@mediapipe/tasks-vision',
      ],
    },
    server: {
      allowedHosts: ['e82b-2400-1a00-4b46-41bf-fd4f-ad41-9b8d-d3cf.ngrok-free.app'],
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
          /** Dev-only: HMR / tab close often tears down the browser side first → EPIPE on the proxy pipe. Harmless. */
          configure(proxy) {
            proxy.on('error', (err: NodeJS.ErrnoException) => {
              if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return
              console.error('[vite proxy]', err)
            })
            proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
              socket.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return
                console.error('[vite proxy ws]', err)
              })
            })
          },
        },
      },
    },
  }
})