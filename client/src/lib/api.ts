import type { ApiError, AuthResponse, MeetingResponse } from './types'
import { getToken } from './auth'

function apiBase(): string {
  const fromEnv = import.meta.env.VITE_API_BASE as string | undefined
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.replace(/\/$/, '')
  return ''
}

async function readJsonOrText(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length === 0) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}

export class HttpError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

async function requestJson<T>(
  path: string,
  init?: RequestInit & { auth?: boolean },
): Promise<T> {
  const url = `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  if (init?.auth === true) {
    const token = getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
  }

  const res = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  })

  if (!res.ok) {
    const body = await readJsonOrText(res)
    throw new HttpError(res.status, body)
  }
  return (await readJsonOrText(res)) as T
}

export async function login(input: {
  email: string
  password: string
}): Promise<AuthResponse> {
  return await requestJson<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function register(input: {
  email: string
  password: string
  name: string
}): Promise<AuthResponse> {
  return await requestJson<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function getMeeting(code: string): Promise<MeetingResponse> {
  return await requestJson<MeetingResponse>(`/api/meetings/${encodeURIComponent(code)}`)
}

export async function createMeeting(input: { title?: string }): Promise<MeetingResponse> {
  return await requestJson<MeetingResponse>('/api/meetings', {
    method: 'POST',
    auth: true,
    body: JSON.stringify(input),
  })
}

export function errorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const maybe = (body as ApiError).error
      if (typeof maybe === 'string' && maybe.length > 0) return maybe
    }
    return `Request failed (${err.status}).`
  }
  return err instanceof Error ? err.message : 'Something went wrong.'
}

