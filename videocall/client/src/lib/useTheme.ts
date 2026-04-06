import { useEffect, useState } from 'react'
import { applyThemePreference, getThemePreference, setThemePreference, type ThemePreference } from './theme'

export function useTheme(): {
  preference: ThemePreference
  setPreference: (p: ThemePreference) => void
} {
  const [preference, setPrefState] = useState<ThemePreference>(() => getThemePreference())

  useEffect(() => {
    applyThemePreference(preference)
  }, [preference])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'nexivo.theme') setPrefState(getThemePreference())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return {
    preference,
    setPreference: (p) => {
      setPrefState(p)
      setThemePreference(p)
    },
  }
}

