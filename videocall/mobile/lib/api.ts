import type { ApiError, AuthResponse, MeetingRecordingItem, MeetingResponse } from './types'
import { getToken } from './auth'
import { getApiBase } from './config'

function apiBase(): string {
  return getApiBase()
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
    const token = await getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
  }

  const res = await fetch(url, {
    ...init,
    headers,
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
  recaptchaToken?: string
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
  recaptchaToken?: string
}): Promise<AuthResponse> {
  return await requestJson<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function getLiveKitJoinToken(
  meetingCode: string,
): Promise<{ url: string; token: string }> {
  return await requestJson<{ url: string; token: string }>(
    `/api/meetings/${encodeURIComponent(meetingCode)}/livekit/token`,
    { method: 'POST', auth: true },
  )
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

export async function listMyRecordings(): Promise<{ recordings: MeetingRecordingItem[] }> {
  return await requestJson<{ recordings: MeetingRecordingItem[] }>('/api/recordings', {
    auth: true,
  })
}

export function errorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const body = err.body
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const rec = body as ApiError
      const maybe = rec.error
      const detail = typeof rec.detail === 'string' && rec.detail.length > 0 ? rec.detail : null
      if (typeof maybe === 'string' && maybe.length > 0) {
        return detail ? `${maybe} — ${detail}` : maybe
      }
    }
    return `Request failed (${err.status}).`
  }
  return err instanceof Error ? err.message : 'Something went wrong.'
}

export type { MeetingResponse, MeetingRecordingItem, User } from './types'
