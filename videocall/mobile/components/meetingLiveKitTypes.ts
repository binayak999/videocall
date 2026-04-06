import type { Socket } from 'socket.io-client'
import type { ParsedJoinPayload } from '../lib/meetingJoinPayload'
import type { Meeting } from '../lib/types'

export type MeetingLiveKitProps = {
  serverUrl: string
  token: string
  authToken: string
  meeting: Meeting
  socket: Socket
  parsedJoin: ParsedJoinPayload
  meetingTitle: string | null
  meetingCode: string
  onLeave: () => void
}
