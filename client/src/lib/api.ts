import type {
  AgendaCheckResult,
  ApiError,
  AuthResponse,
  MeetingPollSaved,
  MeetingRecordingItem,
  MeetingResponse,
} from './types'
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

export type MeetingCaptionRow = {
  id: string
  speakerUserId: string
  speakerName: string
  text: string
  createdAt: string
}

export async function fetchMeetingCaptions(meetingCode: string): Promise<{ captions: MeetingCaptionRow[] }> {
  return await requestJson<{ captions: MeetingCaptionRow[] }>(
    `/api/meetings/${encodeURIComponent(meetingCode)}/captions`,
    { auth: true },
  )
}

export async function getMeeting(code: string): Promise<MeetingResponse> {
  return await requestJson<MeetingResponse>(`/api/meetings/${encodeURIComponent(code)}`)
}

/** Host-only: persisted thumbs up/down polls for this meeting. */
export async function fetchMeetingPolls(meetingCode: string): Promise<{ polls: MeetingPollSaved[] }> {
  return await requestJson<{ polls: MeetingPollSaved[] }>(
    `/api/meetings/${encodeURIComponent(meetingCode)}/polls`,
    { auth: true },
  )
}

export async function createMeeting(input: { title?: string }): Promise<MeetingResponse> {
  return await requestJson<MeetingResponse>('/api/meetings', {
    method: 'POST',
    auth: true,
    body: JSON.stringify(input),
  })
}

export type PresignRecordingResponse = {
  uploadUrl: string
  key: string
  contentType: string
  headers: Record<string, string>
}

export async function presignMeetingRecording(
  meetingCode: string,
  contentType?: string,
): Promise<PresignRecordingResponse> {
  return await requestJson<PresignRecordingResponse>(
    `/api/meetings/${encodeURIComponent(meetingCode)}/recordings/presign`,
    {
      method: 'POST',
      auth: true,
      body: JSON.stringify({ contentType: contentType ?? 'video/webm' }),
    },
  )
}

export async function uploadRecordingToPresignedUrl(
  uploadUrl: string,
  blob: Blob,
  headers: Record<string, string>,
): Promise<void> {
  const h = new Headers()
  for (const [k, v] of Object.entries(headers)) {
    h.set(k, v)
  }
  const res = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: h })
  if (!res.ok) {
    throw new HttpError(res.status, { error: `Upload failed (${res.status})` })
  }
}

/** Uploads recording bytes through the API (server → R2). Avoids browser CORS and custom-domain S3 issues. */
export async function uploadMeetingRecordingViaApi(
  meetingCode: string,
  blob: Blob,
): Promise<{ key: string; contentType: string }> {
  const url = `${apiBase()}/api/meetings/${encodeURIComponent(meetingCode)}/recordings/upload`
  const token = getToken()
  if (!token) {
    throw new HttpError(401, { error: 'Not signed in' })
  }
  const rawType = blob.type && blob.type.length > 0 ? blob.type : 'video/webm'
  const ct = rawType.split(';')[0]!.trim()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': ct,
      Accept: 'application/json',
    },
    body: blob,
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await readJsonOrText(res)
    throw new HttpError(res.status, body)
  }
  return (await readJsonOrText(res)) as { key: string; contentType: string }
}

export async function completeMeetingRecording(
  meetingCode: string,
  body: { key: string; sizeBytes: number; durationSec: number; mimeType?: string },
): Promise<{ recording: MeetingRecordingItem }> {
  return await requestJson<{ recording: MeetingRecordingItem }>(
    `/api/meetings/${encodeURIComponent(meetingCode)}/recordings/complete`,
    {
      method: 'POST',
      auth: true,
      body: JSON.stringify(body),
    },
  )
}

export async function listMyRecordings(): Promise<{ recordings: MeetingRecordingItem[] }> {
  return await requestJson<{ recordings: MeetingRecordingItem[] }>('/api/recordings', {
    auth: true,
  })
}

/** Authenticated; server uses same AI credentials as agenda (HF or OpenAI). */
export async function translateText(body: {
  text: string
  targetLanguage: string
  sourceLanguage?: string
}): Promise<{ translated: string }> {
  return await requestJson<{ translated: string }>('/api/translate', {
    method: 'POST',
    auth: true,
    body: JSON.stringify(body),
  })
}

/** Host only — server returns 403 for non-hosts. API needs HUGGINGFACE_API_TOKEN (preferred) or OPENAI_API_KEY. */
export async function analyzeMeetingAgenda(
  meetingCode: string,
  body: { agenda: string; transcript: string },
): Promise<AgendaCheckResult> {
  return await requestJson<AgendaCheckResult>(
    `/api/meetings/${encodeURIComponent(meetingCode)}/agenda/analyze`,
    {
      method: 'POST',
      auth: true,
      body: JSON.stringify(body),
    },
  )
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

