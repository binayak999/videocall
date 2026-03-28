export type ApiError = {
  error: string
  detail?: string
}

export type User = {
  id: string
  email: string
  name: string
  createdAt: string
}

export type Meeting = {
  id: string
  code: string
  hostId: string
  title: string | null
  createdAt: string
  endsAt: string | null
  host: User
}

export type AuthResponse = {
  token: string
  user: User
}

export type MeetingResponse = {
  meeting: Meeting
}

export type MeetingRecordingItem = {
  id: string
  meetingId: string
  meetingCode: string
  meetingTitle: string | null
  mimeType: string
  durationSec: number | null
  sizeBytes: number | null
  createdAt: string
  playbackUrl: string
}

