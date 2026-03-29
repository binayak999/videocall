export const SHELL_BG_EVENT = 'nexivo:shell-background'

const STORAGE_KEY = 'nexivo.shellBackground.v1'
/** ~20 MiB raw image; data URLs are longer (base64 + `data:image/...;base64,` prefix). */
const MAX_CUSTOM_DATA_URL_CHARS = 30_000_000

export type ShellBackgroundPresetId =
  | 'default'
  | 'gradient-aurora'
  | 'gradient-sunset'
  | 'gradient-ocean'
  | 'gradient-slate'
  | 'gradient-mist'

export type ShellBackgroundPreset = {
  id: ShellBackgroundPresetId
  label: string
  description: string
} & (
  | { kind: 'image'; src: string }
  | { kind: 'gradient'; css: string }
)

export const SHELL_BACKGROUND_PRESETS: ShellBackgroundPreset[] = [
  {
    id: 'default',
    kind: 'image',
    src: '/image.png',
    label: 'Nexivo default',
    description: 'Original app artwork',
  },
  {
    id: 'gradient-aurora',
    kind: 'gradient',
    css: 'linear-gradient(135deg, #1e1b4b 0%, #4c1d95 40%, #7c3aed 70%, #c084fc 100%)',
    label: 'Aurora',
    description: 'Deep violet glow',
  },
  {
    id: 'gradient-sunset',
    kind: 'gradient',
    css: 'linear-gradient(145deg, #431407 0%, #9a3412 35%, #ea580c 65%, #fbbf24 100%)',
    label: 'Sunset',
    description: 'Warm amber ember',
  },
  {
    id: 'gradient-ocean',
    kind: 'gradient',
    css: 'linear-gradient(160deg, #0c4a6e 0%, #0369a1 45%, #0ea5e9 80%, #7dd3fc 100%)',
    label: 'Ocean',
    description: 'Cool blue depth',
  },
  {
    id: 'gradient-slate',
    kind: 'gradient',
    css: 'linear-gradient(165deg, #020617 0%, #0f172a 40%, #1e293b 100%)',
    label: 'Slate',
    description: 'Neutral dark metal',
  },
  {
    id: 'gradient-mist',
    kind: 'gradient',
    css: 'linear-gradient(180deg, #f8fafc 0%, #e2e8f0 45%, #cbd5e1 100%)',
    label: 'Mist',
    description: 'Soft light gray',
  },
]

type Stored =
  | { v: 1; preset: ShellBackgroundPresetId }
  | { v: 1; custom: string }

export type ResolvedShellBackground =
  | { kind: 'image'; src: string }
  | { kind: 'gradient'; css: string }

function presetById(id: ShellBackgroundPresetId): ShellBackgroundPreset | undefined {
  return SHELL_BACKGROUND_PRESETS.find(p => p.id === id)
}

function presetToResolved(p: ShellBackgroundPreset): ResolvedShellBackground {
  if (p.kind === 'image') return { kind: 'image', src: p.src }
  return { kind: 'gradient', css: p.css }
}

function parseStored(raw: string | null): Stored | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as unknown
    if (!o || typeof o !== 'object') return null
    const rec = o as Record<string, unknown>
    if (rec.v !== 1) return null
    if (typeof rec.custom === 'string' && rec.custom.startsWith('data:image/')) return { v: 1, custom: rec.custom }
    if (typeof rec.preset === 'string') {
      const id = rec.preset as ShellBackgroundPresetId
      if (presetById(id)) return { v: 1, preset: id }
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Raw storage value; changes iff shell background changed (for useSyncExternalStore snapshot caching). */
export function shellBackgroundStorageRevision(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function readShellBackground(): ResolvedShellBackground {
  try {
    const s = parseStored(localStorage.getItem(STORAGE_KEY))
    if (!s) return presetToResolved(SHELL_BACKGROUND_PRESETS[0]!)
    if ('custom' in s) return { kind: 'image', src: s.custom }
    const preset = presetById(s.preset)
    if (!preset) return presetToResolved(SHELL_BACKGROUND_PRESETS[0]!)
    return presetToResolved(preset)
  } catch {
    return presetToResolved(SHELL_BACKGROUND_PRESETS[0]!)
  }
}

export function getShellBackgroundSelection(): { mode: 'preset'; id: ShellBackgroundPresetId } | { mode: 'custom' } {
  try {
    const s = parseStored(localStorage.getItem(STORAGE_KEY))
    if (!s) return { mode: 'preset', id: 'default' }
    if ('custom' in s) return { mode: 'custom' }
    return { mode: 'preset', id: s.preset }
  } catch {
    return { mode: 'preset', id: 'default' }
  }
}

function writeAndEmit(stored: Stored | null) {
  try {
    if (stored == null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(SHELL_BG_EVENT))
}

export function setShellBackgroundPreset(id: ShellBackgroundPresetId) {
  if (!presetById(id)) return
  writeAndEmit({ v: 1, preset: id })
}

export function setShellBackgroundCustomDataUrl(dataUrl: string | null) {
  if (dataUrl == null) {
    writeAndEmit({ v: 1, preset: 'default' })
    return
  }
  if (!dataUrl.startsWith('data:image/')) return
  if (dataUrl.length > MAX_CUSTOM_DATA_URL_CHARS) {
    throw new Error('Image is too large. Try a smaller file or lower resolution (max ~20 MB).')
  }
  writeAndEmit({ v: 1, custom: dataUrl })
}

export function clearCustomShellBackground() {
  writeAndEmit({ v: 1, preset: 'default' })
}
