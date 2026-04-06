import { io, type Socket } from 'socket.io-client'
import { defaultSignalingUrl } from './signalingUrl'

const CONNECT_MS = 45_000

/**
 * Same flow as web MeetingPage: connect to signaling with JWT, then `meeting:join`.
 * Without this, other clients never get `meeting:peer-joined` (roster / "X joined" toasts).
 */
export type MeetingJoinPayload = Record<string, unknown>

export async function connectAndJoinMeetingRoom(
  jwt: string,
  meetingCode: string,
  opts?: { onWaitingForHost?: () => void },
): Promise<{ socket: Socket; joinPayload: MeetingJoinPayload }> {
  const trimmed = meetingCode.trim()
  if (!trimmed) throw new Error('Invalid meeting code')

  const url = defaultSignalingUrl()
  const socket = io(url, { auth: { token: jwt }, transports: ['polling', 'websocket'] })

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      socket.disconnect()
      reject(new Error('Signaling connection timed out'))
    }, CONNECT_MS)
    socket.once('connect', () => {
      clearTimeout(t)
      resolve()
    })
    socket.once('connect_error', (err: Error) => {
      clearTimeout(t)
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })

  const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
    // Mobile meeting UI uses LiveKit for media; tell signaling so room hostMode matches.
    socket.emit('meeting:join', { code: trimmed, rtcMode: 'livekit' as const }, (a: unknown) => {
      if (!a || typeof a !== 'object') {
        reject(new Error('Invalid join response'))
        return
      }
      resolve(a as Record<string, unknown>)
    })
  })

  if (ack.ok === true) {
    return { socket, joinPayload: ack }
  }

  if (ack.ok === false && ack.pending === true) {
    opts?.onWaitingForHost?.()
    const approvedPayload = await new Promise<MeetingJoinPayload>((resolve, reject) => {
      const onApproved = (p: unknown) => {
        socket.off('meeting:join-denied', onDenied)
        if (!p || typeof p !== 'object') {
          reject(new Error('Invalid join approval'))
          return
        }
        resolve(p as MeetingJoinPayload)
      }
      const onDenied = (msg: { message?: string }) => {
        socket.off('meeting:join-approved', onApproved)
        reject(new Error(typeof msg?.message === 'string' ? msg.message : 'Host denied entry'))
      }
      socket.once('meeting:join-approved', onApproved)
      socket.once('meeting:join-denied', onDenied)
    })
    return { socket, joinPayload: approvedPayload }
  }

  socket.disconnect()
  const errMsg = typeof ack.error === 'string' ? ack.error : 'Could not join meeting'
  throw new Error(errMsg)
}

export function leaveMeetingRoom(socket: Socket | null): void {
  if (!socket) return
  try {
    socket.emit('meeting:leave')
  } finally {
    socket.disconnect()
  }
}
