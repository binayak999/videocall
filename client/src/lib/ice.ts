const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

interface IceConfigResponse {
  iceServers?: unknown
}

function isIceServer(value: unknown): value is RTCIceServer {
  if (!value || typeof value !== 'object') return false
  const v = value as { urls?: unknown }
  return typeof v.urls === 'string' || Array.isArray(v.urls)
}

function apiBase(): string {
  const fromEnv = import.meta.env.VITE_API_BASE as string | undefined
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.replace(/\/$/, '')
  return ''
}

let iceCache: RTCIceServer[] | null = null

export async function getIceServers(): Promise<RTCIceServer[]> {
  if (iceCache) return iceCache
  try {
    const res = await fetch(`${apiBase()}/api/turn-credentials`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as IceConfigResponse
    const servers = Array.isArray(json.iceServers)
      ? json.iceServers.filter(isIceServer)
      : []
    if (servers.length > 0) {
      iceCache = servers
      return servers
    }
  } catch {
    // fall through to default STUN-only fallback
  }
  iceCache = DEFAULT_STUN_SERVERS
  return DEFAULT_STUN_SERVERS
}

