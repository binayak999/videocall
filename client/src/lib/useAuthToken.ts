import { useEffect, useState } from 'react'
import { getToken } from './auth'

export function useAuthToken(): string | null {
  const [token, setToken] = useState<string | null>(() => getToken())

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'nexivo.token') setToken(getToken())
    }
    window.addEventListener('storage', onStorage)

    const onFocus = () => setToken(getToken())
    window.addEventListener('focus', onFocus)

    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return token
}

