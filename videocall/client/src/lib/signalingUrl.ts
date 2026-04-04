/**
 * Base URL for Socket.IO (engine.io handles `/socket.io` path).
 *
 * Default: `window.location.origin` (dev: traffic goes through Vite’s `/socket.io` proxy).
 * Set `VITE_SIGNALING_URL` (e.g. `http://127.0.0.1:4002`) to connect straight to the
 * signaling server and avoid Vite’s noisy ws-proxy logs on reconnects / tab close.
 */
export function defaultSignalingUrl(): string {
  const env = import.meta.env as Record<string, string | undefined>
  const direct = env.VITE_SIGNALING_URL?.trim()
  if (direct) return direct.replace(/\/$/, '')
  return typeof window !== 'undefined' ? window.location.origin : ''
}
