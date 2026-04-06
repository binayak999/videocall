import * as SecureStore from 'expo-secure-store'

const TOKEN_KEY = 'nexivo.token'

export const AUTH_CHANGE_EVENT = 'nexivo-auth-change'

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyAuthChange(): void {
  for (const l of listeners) l()
}

export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY)
  } catch {
    return null
  }
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token)
  notifyAuthChange()
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY)
  notifyAuthChange()
}
