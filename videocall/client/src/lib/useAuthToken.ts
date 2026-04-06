import { useEffect, useState } from 'react'
import { AUTH_CHANGE_EVENT, getToken } from './auth'

export function useAuthToken(): string | null {
  const [token, setTokenState] = useState<string | null>(() => getToken())

  useEffect(() => {
    const sync = () => setTokenState(getToken())

    const onStorage = (e: StorageEvent) => {
      if (e.key === 'nexivo.token' || e.key === null) sync()
    }
    window.addEventListener(AUTH_CHANGE_EVENT, sync)
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', sync)

    return () => {
      window.removeEventListener(AUTH_CHANGE_EVENT, sync)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', sync)
    }
  }, [])

  return token
}

