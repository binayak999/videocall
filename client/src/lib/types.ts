export type ApiError = {
  error: string
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

