import { ScreenSharePresets, Track } from 'livekit-client'

/**
 * LiveKit camera publish bitrate aligned with mesh `applyBitrateCaps` (2 Mbps video cap).
 * Default `VideoPresets.h720` uses 1.7 Mbps; this matches the P2P cap.
 */
export const LIVEKIT_CAMERA_VIDEO_ENCODING = {
  maxBitrate: 2_000_000,
  maxFramerate: 30,
} as const

/**
 * Screen share: disable simulcast (fewer encoder/SFU edge cases) and use a stable 720p30-style cap.
 */
export const LIVEKIT_SCREEN_SHARE_PUBLISH_OPTIONS = {
  source: Track.Source.ScreenShare,
  simulcast: false,
  screenShareEncoding: ScreenSharePresets.h720fps30.encoding,
} as const
