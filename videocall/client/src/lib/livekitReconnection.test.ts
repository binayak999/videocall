import { DisconnectReason } from 'livekit-client'
import { describe, expect, it } from 'vitest'
import {
  LIVEKIT_FULL_RECONNECT_MAX_ATTEMPTS,
  liveKitFullReconnectDelayMs,
  shouldAttemptFullLiveKitReconnect,
} from './livekitReconnection'

describe('shouldAttemptFullLiveKitReconnect', () => {
  it('allows retry for transient / server-side reasons', () => {
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.UNKNOWN_REASON)).toBe(true)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.SERVER_SHUTDOWN)).toBe(true)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.SIGNAL_CLOSE)).toBe(true)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.CONNECTION_TIMEOUT)).toBe(true)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.MEDIA_FAILURE)).toBe(true)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.STATE_MISMATCH)).toBe(true)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.MIGRATION)).toBe(true)
  })

  it('denies retry for explicit leave / policy reasons', () => {
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.CLIENT_INITIATED)).toBe(false)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.DUPLICATE_IDENTITY)).toBe(false)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.PARTICIPANT_REMOVED)).toBe(false)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.ROOM_DELETED)).toBe(false)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.USER_REJECTED)).toBe(false)
    expect(shouldAttemptFullLiveKitReconnect(DisconnectReason.ROOM_CLOSED)).toBe(false)
  })

  it('treats undefined reason as retryable', () => {
    expect(shouldAttemptFullLiveKitReconnect(undefined)).toBe(true)
  })
})

describe('liveKitFullReconnectDelayMs', () => {
  it('returns positive delays that grow with failure index', () => {
    const d0 = liveKitFullReconnectDelayMs(0)
    const d1 = liveKitFullReconnectDelayMs(1)
    const d2 = liveKitFullReconnectDelayMs(2)
    expect(d0).toBeGreaterThanOrEqual(400)
    expect(d0).toBeLessThan(400 + 400)
    expect(d1).toBeGreaterThanOrEqual(800)
    expect(d2).toBeGreaterThanOrEqual(1_600)
  })

  it('caps backoff index for very large failure counts', () => {
    const hi = liveKitFullReconnectDelayMs(999)
    expect(hi).toBeGreaterThanOrEqual(25_000)
    expect(hi).toBeLessThanOrEqual(25_000 + 400)
  })
})

describe('LIVEKIT_FULL_RECONNECT_MAX_ATTEMPTS', () => {
  it('is a sane positive bound', () => {
    expect(LIVEKIT_FULL_RECONNECT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5)
    expect(LIVEKIT_FULL_RECONNECT_MAX_ATTEMPTS).toBeLessThanOrEqual(20)
  })
})
