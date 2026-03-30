// STUN-only: works for direct connections but fails on strict NAT / bad networks
const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

// Free public TURN relay — provides a guaranteed fallback path on restrictive networks.
// openrelay.metered.ca is a community-run open relay, suitable for dev/testing.
// For production, replace with your own TURN server (coturn, Metered, Xirsys, Twilio, etc.)
const FREE_TURN_SERVERS: RTCIceServer[] = [
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:80?transport=tcp',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

// Combined fallback: STUN for fast direct paths + TURN for relay when direct fails
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  ...DEFAULT_STUN_SERVERS,
  ...FREE_TURN_SERVERS,
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
    // fall through to default fallback
  }
  iceCache = DEFAULT_ICE_SERVERS
  return DEFAULT_ICE_SERVERS
}

export function clearIceCache() {
  iceCache = null
}
