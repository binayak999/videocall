export type ThemePreference = 'system' | 'light' | 'dark'

const KEY = 'nexivo.theme'

export function getThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // ignore
  }
  return 'system'
}

export function setThemePreference(pref: ThemePreference): void {
  localStorage.setItem(KEY, pref)
  applyThemePreference(pref)
}

export function applyThemePreference(pref: ThemePreference = getThemePreference()): void {
  const root = document.documentElement
  if (pref === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', pref)
  }
}

