import type { ChatMessage, RosterEntry } from './meetingTypes'
import type { MeetingJoinPayload } from './meetingSignaling'

export type ParsedJoinPayload = {
  roster: Record<string, RosterEntry>
  chatMessages: ChatMessage[]
  isHost: boolean
  hostPeerId: string | null
  roomRecordingActive: boolean
  handRaisedPeerIds: string[]
}

export function parseMeetingJoinPayload(
  payload: MeetingJoinPayload | null | undefined,
  opts: {
    mySocketId: string
    myUserId: string
    selfName: string
    selfEmail: string
  },
): ParsedJoinPayload {
  const roster: Record<string, RosterEntry> = {}

  const pr = payload?.peerRoster
  if (Array.isArray(pr)) {
    for (const row of pr) {
      if (!row || typeof row !== 'object') continue
      const r = row as { peerId?: unknown; userId?: unknown; userName?: unknown; userEmail?: unknown }
      if (typeof r.peerId !== 'string') continue
      const userEmail = typeof r.userEmail === 'string' ? r.userEmail : undefined
      roster[r.peerId] = {
        userId: typeof r.userId === 'string' ? r.userId : '',
        userName: typeof r.userName === 'string' ? r.userName : 'Guest',
        ...(userEmail ? { userEmail } : {}),
      }
    }
  }

  roster[opts.mySocketId] = {
    userName: opts.selfName,
    userId: opts.myUserId,
    ...(opts.selfEmail.trim() ? { userEmail: opts.selfEmail.trim() } : {}),
  }

  const chatMessages: ChatMessage[] = []
  const ch = payload?.chatHistory
  if (Array.isArray(ch)) {
    for (const item of ch) {
      if (!item || typeof item !== 'object') continue
      const row = item as {
        id?: unknown
        senderUserId?: unknown
        senderName?: unknown
        text?: unknown
        createdAt?: unknown
      }
      if (
        typeof row.id !== 'string' ||
        typeof row.senderUserId !== 'string' ||
        typeof row.senderName !== 'string' ||
        typeof row.text !== 'string' ||
        typeof row.createdAt !== 'string'
      ) {
        continue
      }
      chatMessages.push({
        id: row.id,
        senderId: row.senderUserId,
        senderUserId: row.senderUserId,
        senderName: row.senderName,
        text: row.text,
        createdAt: row.createdAt,
      })
    }
  }

  const isHost = payload?.isHost === true
  const hostPeerId =
    typeof payload?.hostPeerId === 'string'
      ? payload.hostPeerId
      : isHost
        ? opts.mySocketId
        : null

  const roomRecordingActive = payload?.meetingRecordingActive === true

  const handRaisedPeerIds: string[] = []
  const hr = payload?.handRaisedPeerIds
  if (Array.isArray(hr)) {
    for (const id of hr) {
      if (typeof id === 'string') handRaisedPeerIds.push(id)
    }
  }

  return {
    roster,
    chatMessages,
    isHost,
    hostPeerId,
    roomRecordingActive,
    handRaisedPeerIds,
  }
}
