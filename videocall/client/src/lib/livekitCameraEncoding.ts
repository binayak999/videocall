/**
 * LiveKit camera publish bitrate aligned with mesh `applyBitrateCaps` (2 Mbps video cap).
 * Default `VideoPresets.h720` uses 1.7 Mbps; this matches the P2P cap.
 */
export const LIVEKIT_CAMERA_VIDEO_ENCODING = {
  maxBitrate: 2_000_000,
  maxFramerate: 30,
} as const
