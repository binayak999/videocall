/**
 * Meeting mesh (P2P) adaptive quality helpers — no SFU.
 */

export type MeetingQualityTier = 'good' | 'fair' | 'poor'

export const TIER_VIDEO_BPS: Record<MeetingQualityTier, number> = {
  good: 500_000,
  fair: 200_000,
  poor: 80_000,
}

export const TIER_AUDIO_BPS: Record<MeetingQualityTier, number> = {
  good: 48_000,
  fair: 32_000,
  poor: 24_000,
}

export const MIN_AUDIO_BPS = 16_000

export function tierRank(t: MeetingQualityTier): number {
  return t === 'good' ? 2 : t === 'fair' ? 1 : 0
}

/** Prefer VP9, then VP8, then other negotiated codecs (e.g. H.264). */
export function preferVp9Vp8VideoCodecs(pc: RTCPeerConnection): void {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')
    if (!caps?.codecs?.length) return
    const vp9 = caps.codecs.filter(c => c.mimeType.toLowerCase().includes('vp9'))
    const vp8 = caps.codecs.filter(c => c.mimeType.toLowerCase().includes('vp8'))
    const others = caps.codecs.filter(c => {
      const m = c.mimeType.toLowerCase()
      return !m.includes('vp9') && !m.includes('vp8')
    })
    const ordered = [...vp9, ...vp8, ...others]
    for (const t of pc.getTransceivers()) {
      const k = t.sender?.track?.kind ?? t.receiver?.track?.kind
      if (k === 'video' && ordered.length) {
        t.setCodecPreferences(ordered)
      }
    }
  } catch {
    /* ignore */
  }
}

export function parseMeetingConnectionStats(stats: RTCStatsReport): {
  availableOutgoingBitrate: number | null
  packetLossPercent: number | null
  rttMs: number | null
} {
  let availableOutgoingBitrate: number | null = null
  let rttMs: number | null = null
  let lost = 0
  let received = 0

  for (const r of stats.values()) {
    if (r.type === 'candidate-pair') {
      const p = r as RTCStatsReport & {
        nominated?: boolean
        state?: string
        availableOutgoingBitrate?: number
        currentRoundTripTime?: number
      }
      if (p.state === 'succeeded' && p.nominated) {
        if (typeof p.availableOutgoingBitrate === 'number') {
          availableOutgoingBitrate = p.availableOutgoingBitrate
        }
        if (typeof p.currentRoundTripTime === 'number') {
          rttMs = p.currentRoundTripTime * 1000
        }
      }
    }
    if (r.type === 'remote-inbound-rtp') {
      const ri = r as RTCStatsReport & {
        kind?: string
        packetsLost?: number
        packetsReceived?: number
      }
      if (ri.kind === 'video' || ri.kind === 'audio') {
        if (typeof ri.packetsLost === 'number') lost += ri.packetsLost
        if (typeof ri.packetsReceived === 'number') received += ri.packetsReceived
      }
    }
  }

  const packetLossPercent =
    lost + received > 0 ? (100 * lost) / (lost + received) : null

  return { availableOutgoingBitrate, packetLossPercent, rttMs }
}

/**
 * Good: >400kbps and <5% loss.
 * Fair: 150–400kbps or 5–15% loss (and not poor).
 * Poor: <150kbps or >15% loss.
 */
export function classifyMeetingQualityTier(
  availableOutgoingBitrate: number | null,
  packetLossPercent: number | null,
  rttMs: number | null = null,
): MeetingQualityTier {
  if (availableOutgoingBitrate === null) {
    return 'good'
  }
  const a = availableOutgoingBitrate
  const l = packetLossPercent ?? 0
  if (a < 150_000 || l > 15) return 'poor'
  if (a <= 400_000 || l >= 5) return 'fair'
  if (rttMs !== null && rttMs > 500) return 'fair'
  return 'good'
}

/** Opus fmtp maxaveragebitrate (bps) hint for SDP — complements sender maxBitrate. */
export function opusMaxAverageBitrateForTier(tier: MeetingQualityTier): number {
  return tier === 'poor' ? 24_000 : tier === 'fair' ? 32_000 : 48_000
}

/** Patch Opus fmtp line for the negotiated opus payload type. */
export function mungeOpusMaxAverageBitrate(sdp: string, maxAvBitrate: number): string {
  const lines = sdp.split(/\r\n/)
  let opusPt: string | null = null
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line)
    if (m) opusPt = m[1]
  }
  if (!opusPt) return sdp
  const prefix = `a=fmtp:${opusPt} `
  return lines.map(line => {
    if (!line.startsWith(prefix)) return line
    const rest = line.slice(prefix.length)
    let next = rest
    if (/maxaveragebitrate=\d+/i.test(next)) {
      next = next.replace(/maxaveragebitrate=\d+/i, `maxaveragebitrate=${maxAvBitrate}`)
    } else {
      next = `${next};maxaveragebitrate=${maxAvBitrate}`
    }
    return `${prefix}${next}`
  }).join('\r\n')
}
