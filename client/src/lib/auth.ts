const TOKEN_KEY = 'nexivo.token'

/** Same-tab localStorage writes do not fire `storage`; hooks listen for this instead. */
export const AUTH_CHANGE_EVENT = 'nexivo-auth-change'

function notifyAuthChange(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(AUTH_CHANGE_EVENT))
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  notifyAuthChange()
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  notifyAuthChange()
}

