import { createContext, useContext, type ReactNode } from 'react'
import { useTheme } from '../lib/useTheme'

type ThemeContextValue = ReturnType<typeof useTheme>

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const value = useTheme()
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useAppTheme(): ThemeContextValue {
  const v = useContext(ThemeContext)
  if (!v) throw new Error('useAppTheme must be used within ThemeProvider')
  return v
}
