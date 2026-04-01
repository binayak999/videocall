import { useEffect, useRef, useState } from 'react'

import type { GestureRecognizer, GestureRecognizerResult } from '@mediapipe/tasks-vision'

export type VoteGestureStatus = 'off' | 'loading' | 'ready' | 'error'

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'

/** MediaPipe WASM / TFLite logs harmless internals; there is no API to disable them. */
function shouldSuppressMediapipeConsoleWarn(args: unknown[]): boolean {
  const s = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')
  return (
    s.includes('inference_feedback_manager') ||
    s.includes('Feedback manager requires') ||
    s.includes('Disabling support for feedback tensors') ||
    s.includes('gl_context.cc') ||
    s.includes('OpenGL error checking is disabled')
  )
}

function installMediapipeConsoleNoiseFilter(): () => void {
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => {
    if (shouldSuppressMediapipeConsoleWarn(args)) return
    origWarn.apply(console, args)
  }
  return () => {
    console.warn = origWarn
  }
}

/** Match installed `@mediapipe/tasks-vision` for WASM layout compatibility. */
const TASKS_VISION_VERSION = '0.10.34'

const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`

const STREAK_FRAMES = 4
const PALM_STREAK_FRAMES = 2
const COOLDOWN_MS = 2400
const PALM_COOLDOWN_MS = 2000
/** Client-side threshold; do not set cannedGestures scoreThreshold (it was starving results). */
const THUMB_SCORE_MIN = 0.45
const OPEN_PALM_SCORE_MIN = 0.15

/** Gestures that count as "raise hand" — Open_Palm (palm facing camera) or Pointing_Up (finger raised). */
const RAISE_HAND_GESTURES: ReadonlySet<string> = new Set(['Open_Palm', 'Pointing_Up'])

function pickThumbFromResult(result: GestureRecognizerResult): 'up' | 'down' | null {
  let best: { choice: 'up' | 'down'; score: number } | null = null
  const gestures = result.gestures
  if (!gestures?.length) return null
  for (const handGestures of gestures) {
    if (!handGestures?.length) continue
    for (const cat of handGestures) {
      const name = cat.categoryName
      const score = cat.score
      if (name === 'Thumb_Up' && score >= THUMB_SCORE_MIN) {
        if (!best || score > best.score) best = { choice: 'up', score }
      } else if (name === 'Thumb_Down' && score >= THUMB_SCORE_MIN) {
        if (!best || score > best.score) best = { choice: 'down', score }
      }
    }
  }
  return best?.choice ?? null
}

let _palmDebugFrame = 0
/** Open palm or pointing-up — raise-hand intent when camera is on. */
function pickOpenPalmFromResult(result: GestureRecognizerResult): boolean {
  const gestures = result.gestures
  // Debug: log top gesture per hand every ~90 frames so you can tune thresholds.
  if (++_palmDebugFrame % 90 === 0 && gestures?.length) {
    for (let i = 0; i < gestures.length; i++) {
      const top = gestures[i]?.[0]
      if (top) console.debug(`[palm-dbg] hand${i}: ${top.categoryName} ${top.score.toFixed(3)}`)
    }
  }
  if (!gestures?.length) return false
  for (const handGestures of gestures) {
    if (!handGestures?.length) continue
    for (const cat of handGestures) {
      const n = cat.categoryName
      const s = cat.score
      if (RAISE_HAND_GESTURES.has(n) && s >= OPEN_PALM_SCORE_MIN) return true
    }
  }
  return false
}

async function createGestureRecognizer(): Promise<GestureRecognizer> {
  const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision')
  const wasm = await FilesetResolver.forVisionTasks(WASM_BASE)

  const common = {
    runningMode: 'VIDEO' as const,
    numHands: 2,
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
  }

  const withDelegate = (delegate: 'CPU' | 'GPU') =>
    GestureRecognizer.createFromOptions(wasm, {
      ...common,
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate,
      },
    })

  try {
    return await withDelegate('GPU')
  } catch {
    return await withDelegate('CPU')
  }
}

function attachGestureVideoEl(): HTMLVideoElement {
  const v = document.createElement('video')
  v.muted = true
  v.setAttribute('playsinline', '')
  v.setAttribute('webkit-playsinline', '')
  v.playsInline = true
  v.autoplay = true
  v.width = 640
  v.height = 480
  v.setAttribute('aria-hidden', 'true')
  v.style.cssText =
    'position:fixed;right:0;bottom:0;width:4px;height:4px;opacity:0.02;pointer-events:none;z-index:0;object-fit:cover;'
  document.body.appendChild(v)
  return v
}

/**
 * Single MediaPipe pass on the camera (one hidden video + one recognizer) for:
 * - thumbs up/down when `thumbGesturesEnabled` (e.g. during a poll)
 * - optional open palm for hand raise when `onOpenPalm` is set
 *
 * Running two separate gesture hooks on the same stream often fails for the second pipeline.
 */
export function useVoteGestureRecognition(options: {
  enabled: boolean
  getStream: () => MediaStream | null
  onGesture: (choice: 'up' | 'down') => void
  /** When false, thumb gestures are ignored (no active poll). Default true. */
  thumbGesturesEnabled?: boolean
  onOpenPalm?: () => void
}): { status: VoteGestureStatus } {
  const {
    enabled,
    getStream,
    onGesture,
    thumbGesturesEnabled = true,
    onOpenPalm,
  } = options
  const onGestureRef = useRef(onGesture)
  const onOpenPalmRef = useRef(onOpenPalm)
  const thumbGesturesEnabledRef = useRef(thumbGesturesEnabled)
  const getStreamRef = useRef(getStream)

  useEffect(() => {
    onGestureRef.current = onGesture
    onOpenPalmRef.current = onOpenPalm
    thumbGesturesEnabledRef.current = thumbGesturesEnabled
    getStreamRef.current = getStream
  }, [onGesture, onOpenPalm, thumbGesturesEnabled, getStream])

  /** When `enabled` is false, UI status is derived as `'off'` (no effect setState). */
  const [pipelineStatus, setPipelineStatus] = useState<'loading' | 'ready' | 'error' | null>(null)

  const status: VoteGestureStatus = !enabled ? 'off' : (pipelineStatus ?? 'loading')

  useEffect(() => {
    if (!enabled) {
      return
    }

    const removeConsoleNoiseFilter = installMediapipeConsoleNoiseFilter()

    let cancelled = false
    let recognizer: GestureRecognizer | null = null
    let raf = 0
    const lastThumbFire = { t: 0 }
    const lastPalmFire = { t: 0 }
    const thumbStreak = { kind: null as 'up' | 'down' | null, count: 0 }
    const palmStreak = { active: false, count: 0 }
    let lastVideoTime = -1

    const video = attachGestureVideoEl()

    void (async () => {
      try {
        recognizer = await createGestureRecognizer()
      } catch (e) {
        console.error('Vote gesture recognizer failed to load', e)
        if (!cancelled) setPipelineStatus('error')
        video.remove()
        return
      }
      if (cancelled) {
        recognizer.close()
        video.remove()
        return
      }
      setPipelineStatus('ready')

      const tick = () => {
        if (cancelled || !recognizer) return
        const stream = getStreamRef.current()
        if (stream && video.srcObject !== stream) {
          video.srcObject = stream
          void video.play().catch(() => {})
          lastVideoTime = -1
        }

        const v = video
        const hasFrame =
          v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && v.videoWidth > 0 && v.videoHeight > 0

        if (hasFrame && recognizer) {
          const t = v.currentTime
          if (t !== lastVideoTime) {
            lastVideoTime = t
            try {
              const tsMs = Math.round(t * 1000)
              // Process the full frame so gestures anywhere in the camera view are
              // detected — a truly "raised" hand is often at the edge/top of the frame
              // and would be missed by a center-square crop.
              const result = recognizer.recognizeForVideo(v, tsMs)
              const now = performance.now()

              let thumbDetectedThisFrame = false
              if (thumbGesturesEnabledRef.current) {
                const kind = pickThumbFromResult(result)
                if (kind) {
                  thumbDetectedThisFrame = true
                  if (thumbStreak.kind === kind) thumbStreak.count += 1
                  else {
                    thumbStreak.kind = kind
                    thumbStreak.count = 1
                  }
                  if (
                    thumbStreak.count >= STREAK_FRAMES &&
                    now - lastThumbFire.t >= COOLDOWN_MS
                  ) {
                    lastThumbFire.t = now
                    thumbStreak.kind = null
                    thumbStreak.count = 0
                    onGestureRef.current(kind)
                  }
                } else {
                  thumbStreak.kind = null
                  thumbStreak.count = 0
                }
              } else {
                thumbStreak.kind = null
                thumbStreak.count = 0
              }

              if (onOpenPalmRef.current) {
                // Skip palm detection when a thumb gesture is active to prevent
                // accidental hand raise during voting.
                const palm = !thumbDetectedThisFrame && pickOpenPalmFromResult(result)
                if (palm) {
                  if (palmStreak.active) palmStreak.count += 1
                  else {
                    palmStreak.active = true
                    palmStreak.count = 1
                  }
                  if (
                    palmStreak.count >= PALM_STREAK_FRAMES &&
                    now - lastPalmFire.t >= PALM_COOLDOWN_MS
                  ) {
                    lastPalmFire.t = now
                    palmStreak.active = false
                    palmStreak.count = 0
                    onOpenPalmRef.current()
                  }
                } else {
                  palmStreak.active = false
                  palmStreak.count = 0
                }
              } else {
                palmStreak.active = false
                palmStreak.count = 0
              }
            } catch {
              /* single-frame failure */
            }
          }
        } else {
          thumbStreak.kind = null
          thumbStreak.count = 0
          palmStreak.active = false
          palmStreak.count = 0
        }

        raf = requestAnimationFrame(tick)
      }

      raf = requestAnimationFrame(tick)
    })()

    return () => {
      cancelled = true
      removeConsoleNoiseFilter()
      cancelAnimationFrame(raf)
      thumbStreak.kind = null
      thumbStreak.count = 0
      palmStreak.active = false
      palmStreak.count = 0
      recognizer?.close()
      recognizer = null
      video.srcObject = null
      video.remove()
      setPipelineStatus(null)
    }
  }, [enabled, getStream])

  return { status }
}
