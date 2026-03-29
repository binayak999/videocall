import { useEffect, useRef, useState } from 'react'

import type { GestureRecognizer, GestureRecognizerResult } from '@mediapipe/tasks-vision'

export type VoteGestureStatus = 'off' | 'loading' | 'ready' | 'error'

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task'

/** Match installed `@mediapipe/tasks-vision` for WASM layout compatibility. */
const TASKS_VISION_VERSION = '0.10.34'

const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`

/** Square input side — avoids MediaPipe “NORM_RECT without IMAGE_DIMENSIONS” on wide webcam frames. */
const SQUARE = 288

const STREAK_FRAMES = 4
const COOLDOWN_MS = 2400
/** Client-side threshold; do not set cannedGestures scoreThreshold (it was starving results). */
const THUMB_SCORE_MIN = 0.45

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

function drawVideoCenterSquareToCanvas(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D,
): void {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (vw <= 0 || vh <= 0) return
  const dim = Math.min(vw, vh)
  const sx = (vw - dim) / 2
  const sy = (vh - dim) / 2
  ctx.drawImage(video, sx, sy, dim, dim, 0, 0, SQUARE, SQUARE)
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
    return await withDelegate('CPU')
  } catch {
    return await withDelegate('GPU')
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
 * While enabled, runs MediaPipe GestureRecognizer on a square crop of the camera
 * (fixes non-square ROI warnings) and calls `onGesture` when thumbs-up / down is steady.
 */
export function useVoteGestureRecognition(options: {
  enabled: boolean
  getStream: () => MediaStream | null
  onGesture: (choice: 'up' | 'down') => void
}): { status: VoteGestureStatus } {
  const { enabled, getStream, onGesture } = options
  const onGestureRef = useRef(onGesture)
  onGestureRef.current = onGesture
  const getStreamRef = useRef(getStream)
  getStreamRef.current = getStream

  const [status, setStatus] = useState<VoteGestureStatus>('off')

  useEffect(() => {
    if (!enabled) {
      setStatus('off')
      return
    }

    let cancelled = false
    let recognizer: GestureRecognizer | null = null
    let raf = 0
    const lastFireAt = { t: 0 }
    const streak = { kind: null as 'up' | 'down' | null, count: 0 }
    let lastVideoTime = -1

    const canvas = document.createElement('canvas')
    canvas.width = SQUARE
    canvas.height = SQUARE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      setStatus('error')
      return
    }

    const video = attachGestureVideoEl()

    setStatus('loading')

    void (async () => {
      try {
        recognizer = await createGestureRecognizer()
      } catch (e) {
        console.error('Vote gesture recognizer failed to load', e)
        if (!cancelled) setStatus('error')
        video.remove()
        return
      }
      if (cancelled) {
        recognizer.close()
        video.remove()
        return
      }
      setStatus('ready')

      const tick = () => {
        if (cancelled || !recognizer || !ctx) return
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
              drawVideoCenterSquareToCanvas(v, ctx)
              const tsMs = Math.round(t * 1000)
              const result = recognizer.recognizeForVideo(canvas, tsMs)
              const kind = pickThumbFromResult(result)
              const now = performance.now()
              if (kind) {
                if (streak.kind === kind) streak.count += 1
                else {
                  streak.kind = kind
                  streak.count = 1
                }
                if (streak.count >= STREAK_FRAMES && now - lastFireAt.t >= COOLDOWN_MS) {
                  lastFireAt.t = now
                  streak.kind = null
                  streak.count = 0
                  onGestureRef.current(kind)
                }
              } else {
                streak.kind = null
                streak.count = 0
              }
            } catch {
              /* single-frame failure */
            }
          }
        } else {
          streak.kind = null
          streak.count = 0
        }

        raf = requestAnimationFrame(tick)
      }

      raf = requestAnimationFrame(tick)
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      streak.kind = null
      streak.count = 0
      recognizer?.close()
      recognizer = null
      video.srcObject = null
      video.remove()
    }
  }, [enabled, getStream])

  return { status }
}
