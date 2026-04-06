export type RtcMode = 'mesh' | 'livekit'

const STORAGE_KEY = 'bandr:rtcMode'

/** Server default from GET /api/system/rtc-mode (set by Layout after fetch). */
let serverRtcDefault: RtcMode | null = null

export function setServerRtcDefault(mode: RtcMode | null): void {
  serverRtcDefault = mode
}

export function readRtcModeFromStorage(): RtcMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'mesh' || raw === 'livekit') return raw
    return null
  } catch {
    return null
  }
}

export function writeRtcModeToStorage(mode: RtcMode | null): void {
  try {
    if (mode === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // ignore
  }
}

export function defaultRtcModeFromEnv(): RtcMode {
  const v = (import.meta.env.VITE_USE_LIVEKIT ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' ? 'livekit' : 'mesh'
}

export function resolvedRtcMode(): RtcMode {
  return readRtcModeFromStorage() ?? serverRtcDefault ?? defaultRtcModeFromEnv()
}

