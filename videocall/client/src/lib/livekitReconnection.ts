import { DisconnectReason } from 'livekit-client'

/** Max automatic full-session reconnects (new token + new Room) after the SFU drops. */
export const LIVEKIT_FULL_RECONNECT_MAX_ATTEMPTS = 10

const BACKOFF_MS = [400, 800, 1_600, 3_200, 6_400, 12_800, 25_000] as const

/**
 * Whether to start a full LiveKit reconnect (fetch token, new Room) for this disconnect reason.
 * Intentional client leaves are filtered separately via a ref in MeetingPage.
 */
export function shouldAttemptFullLiveKitReconnect(reason: DisconnectReason | undefined): boolean {
  if (reason === undefined) return true
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
    case DisconnectReason.DUPLICATE_IDENTITY:
    case DisconnectReason.PARTICIPANT_REMOVED:
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.USER_REJECTED:
    case DisconnectReason.ROOM_CLOSED:
      return false
    default:
      return true
  }
}

/** Delay before the next full reconnect attempt (based on consecutive failures so far). */
export function liveKitFullReconnectDelayMs(failureIndex: number): number {
  if (failureIndex <= 0) return BACKOFF_MS[0]
  const i = Math.min(failureIndex, BACKOFF_MS.length - 1)
  const base = BACKOFF_MS[i]
  return base + Math.floor(Math.random() * 400)
}
