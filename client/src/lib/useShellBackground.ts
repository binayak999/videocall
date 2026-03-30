import { useCallback, useSyncExternalStore } from 'react'
import {
  getShellBackgroundSelection,
  readShellBackground,
  shellBackgroundStorageRevision,
  SHELL_BG_EVENT,
  type ResolvedShellBackground,
} from './shellBackground'

const SERVER_BG: ResolvedShellBackground = { kind: 'image', src: '/image.png' }
const SERVER_SELECTION = { mode: 'preset' as const, id: 'default' as const }

function subscribe(cb: () => void) {
  const on = () => cb()
  window.addEventListener(SHELL_BG_EVENT, on)
  window.addEventListener('storage', on)
  return () => {
    window.removeEventListener(SHELL_BG_EVENT, on)
    window.removeEventListener('storage', on)
  }
}

let bgRev = ''
let bgSnap: ResolvedShellBackground | undefined

function getSnapshot(): ResolvedShellBackground {
  const rev = shellBackgroundStorageRevision()
  if (rev === bgRev && bgSnap !== undefined) return bgSnap
  bgRev = rev
  bgSnap = readShellBackground()
  return bgSnap
}

let selRev = ''
let selSnap: ReturnType<typeof getShellBackgroundSelection> | undefined

function getSelectionSnapshot() {
  const rev = shellBackgroundStorageRevision()
  if (rev === selRev && selSnap !== undefined) return selSnap
  selRev = rev
  selSnap = getShellBackgroundSelection()
  return selSnap
}

export function useShellBackground(): ResolvedShellBackground {
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_BG)
}

export function useShellBackgroundRefresh() {
  return useCallback(() => {
    window.dispatchEvent(new Event(SHELL_BG_EVENT))
  }, [])
}

export function useShellBackgroundSelection() {
  return useSyncExternalStore(subscribe, getSelectionSnapshot, () => SERVER_SELECTION)
}
