/**
 * In-call notification sounds.
 *
 * Add your own clips under **client/public/sounds/meeting/** (served as /sounds/meeting/…).
 * They are requested in this order until one loads: .mp3 → .ogg → .m4a → .wav
 *
 * Expected base names:
 *   chat              → chat.mp3 (etc.)
 *   join              → join.mp3
 *   join-request      → join-request.mp3
 *   screen-share      → screen-share.mp3
 *   screen-share-end  → screen-share-end.mp3
 *   recording-start   → recording-start.mp3
 *   recording-stop    → recording-stop.mp3
 *   vote-start        → vote-start.mp3 (poll opened)
 *   vote-end          → vote-end.mp3 (poll closed)
 *   attention-warning → attention-warning.mp3 (host nudge)
 *
 * Free / paid libraries you can export short SFX from: Mixkit, Pixabay, Freesound,
 * Zapsplat, Adobe Stock. Use short notification-style clips (under ~1s) for chat/join.
 */

const SOUND_EXTENSIONS = ['.mp3', '.ogg', '.m4a', '.wav'] as const

const STEM_BY_KIND: Record<MeetingNotificationSoundKind, string> = {
  chat: 'chat',
  join: 'join',
  joinRequest: 'join-request',
  screenShare: 'screen-share',
  screenShareEnd: 'screen-share-end',
  recordingStart: 'recording-start',
  recordingStop: 'recording-stop',
  voteStart: 'vote-start',
  voteEnd: 'vote-end',
  attentionWarning: 'attention-warning',
}

function soundsDirUrl(): string {
  const base = import.meta.env.BASE_URL || '/'
  const normalized = base.endsWith('/') ? base : `${base}/`
  return `${normalized}sounds/meeting/`
}

let sharedCtx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!sharedCtx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    try {
      sharedCtx = new AC()
    } catch {
      return null
    }
  }
  return sharedCtx
}

/** Call once when entering the call (after a tap) so synthesized fallback can play if files are missing. */
export function primeMeetingNotificationAudio(): void {
  const c = getCtx()
  if (c?.state === 'suspended') void c.resume()
}

function playSoundFile(stem: string, fallback: () => void, extIndex = 0): void {
  if (typeof window === 'undefined') return
  if (extIndex >= SOUND_EXTENSIONS.length) {
    fallback()
    return
  }
  const url = `${soundsDirUrl()}${stem}${SOUND_EXTENSIONS[extIndex]}`
  const a = new Audio(url)
  a.preload = 'auto'
  a.volume = 0.88

  const tryNext = () => playSoundFile(stem, fallback, extIndex + 1)

  let settled = false
  const finishNext = () => {
    if (settled) return
    settled = true
    tryNext()
  }
  const finishFallback = () => {
    if (settled) return
    settled = true
    fallback()
  }

  a.addEventListener('error', finishNext, { once: true })

  const onReady = () => {
    if (settled) return
    void a.play().catch(() => finishFallback())
  }

  if (a.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    onReady()
  } else {
    a.addEventListener('canplay', onReady, { once: true })
    a.load()
  }
}

function tone(
  freq: number,
  durationSec: number,
  startOffsetSec: number,
  gain = 0.11,
  type: OscillatorType = 'sine',
): void {
  const c = getCtx()
  if (!c) return
  void c.resume()
  const t0 = c.currentTime + startOffsetSec
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec)
  osc.connect(g)
  g.connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + durationSec + 0.04)
}

function playSynthFallback(kind: MeetingNotificationSoundKind): void {
  switch (kind) {
    case 'chat':
      tone(880, 0.07, 0, 0.1)
      tone(1174, 0.09, 0.09, 0.09)
      break
    case 'join':
      tone(523, 0.1, 0, 0.1)
      tone(659, 0.12, 0.08, 0.1)
      break
    case 'joinRequest':
      tone(698, 0.14, 0, 0.09)
      break
    case 'screenShare':
      tone(392, 0.14, 0, 0.12)
      tone(523, 0.1, 0.1, 0.1)
      break
    case 'screenShareEnd':
      tone(523, 0.1, 0, 0.09)
      tone(349, 0.14, 0.09, 0.08)
      break
    case 'recordingStart':
      tone(659, 0.08, 0, 0.1)
      tone(880, 0.08, 0.1, 0.1)
      tone(1046, 0.12, 0.2, 0.11)
      break
    case 'recordingStop':
      tone(784, 0.1, 0, 0.09)
      tone(523, 0.14, 0.1, 0.08)
      break
    case 'voteStart':
      tone(622, 0.09, 0, 0.1)
      tone(784, 0.1, 0.08, 0.1)
      tone(988, 0.11, 0.17, 0.1)
      break
    case 'voteEnd':
      tone(784, 0.08, 0, 0.09)
      tone(659, 0.09, 0.09, 0.085)
      tone(523, 0.12, 0.18, 0.08)
      break
    case 'attentionWarning':
      tone(880, 0.1, 0, 0.11)
      tone(1174, 0.12, 0.1, 0.1)
      tone(1568, 0.14, 0.22, 0.1)
      break
    default:
      break
  }
}

export type MeetingNotificationSoundKind =
  | 'chat'
  | 'join'
  | 'joinRequest'
  | 'screenShare'
  | 'screenShareEnd'
  | 'recordingStart'
  | 'recordingStop'
  | 'voteStart'
  | 'voteEnd'
  | 'attentionWarning'

export function playMeetingNotificationSound(kind: MeetingNotificationSoundKind): void {
  const stem = STEM_BY_KIND[kind]
  playSoundFile(stem, () => playSynthFallback(kind))
}
