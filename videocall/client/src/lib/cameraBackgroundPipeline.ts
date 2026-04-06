import type { BodySegmenter } from '@tensorflow-models/body-segmentation'

import type { CameraBackgroundEffectMode, CameraBackgroundPipeline } from './cameraBackgroundTypes'

export type { CameraBackgroundEffectMode, CameraBackgroundPipeline }

let segmenterPromise: Promise<BodySegmenter> | null = null

/**
 * Load the mediapipe selfie_segmentation UMD bundle via a <script> tag instead of bundling it.
 * Rollup wraps CJS files so `this` becomes the module exports object — the UMD's
 * `var ya = this || self` then assigns to exports, not window, so globalThis.SelfieSegmentation
 * is never set. Loading the script from the public directory avoids bundling entirely and lets
 * it run as a plain browser script where `this === window`.
 */
let mediapipeScriptPromise: Promise<void> | null = null
function loadMediapipeScript(): Promise<void> {
  const g = globalThis as { SelfieSegmentation?: unknown }
  if (g.SelfieSegmentation) return Promise.resolve()
  if (mediapipeScriptPromise) return mediapipeScriptPromise
  const base = import.meta.env.BASE_URL
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base
  mediapipeScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `${prefix}/mediapipe/selfie_segmentation/selfie_segmentation.js`
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load mediapipe selfie_segmentation.js from public/'))
    document.head.appendChild(script)
  })
  return mediapipeScriptPromise
}

/**
 * Same-origin Mediapipe assets (see `public/mediapipe/selfie_segmentation/`).
 * Loading WASM / .tflite from cdn.jsdelivr.net works on many dev machines but is often blocked
 * in production (CSP, corporate firewall, ad blockers).
 */
function mediapipeSelfieSegmentationSolutionPath(): string {
  const base = import.meta.env.BASE_URL
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base
  if (typeof window === 'undefined') {
    return 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation'
  }
  return `${window.location.origin}${prefix}/mediapipe/selfie_segmentation`
}

async function loadSegmenter(): Promise<BodySegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      // Must load the mediapipe script (and have globalThis.SelfieSegmentation set)
      // BEFORE body-segmentation is imported, since the shim reads globalThis at eval time.
      await loadMediapipeScript()
      const { ensureTfjsPreferGpuBackend } = await import('./tfjsPreferGpuBackend')
      await ensureTfjsPreferGpuBackend()
      const bodySegmentation = await import('@tensorflow-models/body-segmentation')
      return bodySegmentation.createSegmenter(bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation, {
        runtime: 'mediapipe',
        modelType: 'landscape',
        solutionPath: mediapipeSelfieSegmentationSolutionPath(),
      })
    })()
  }
  return segmenterPromise
}

function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource, cw: number, ch: number) {
  const el = img as HTMLImageElement & HTMLVideoElement
  const w = el.naturalWidth || el.videoWidth
  const h = el.naturalHeight || el.videoHeight
  if (!w || !h) return
  const scale = Math.max(cw / w, ch / h)
  const dw = w * scale
  const dh = h * scale
  const ox = (cw - dw) / 2
  const oy = (ch - dh) / 2
  ctx.drawImage(img, ox, oy, dw, dh)
}

export async function startCameraBackgroundPipeline(
  rawTrack: MediaStreamTrack,
  initialMode: CameraBackgroundEffectMode,
  backgroundImage: HTMLImageElement | null,
  options?: { blurAmount?: number; onFrameError?: (err: unknown) => void },
): Promise<CameraBackgroundPipeline> {
  const engine = (import.meta.env.VITE_CAMERA_BG_ENGINE ?? 'legacy').trim().toLowerCase()
  if (engine === 'tasks-worker') {
    const { startCameraBackgroundPipelineTasksWorker } = await import('./cameraBackgroundPipelineTasks')
    return startCameraBackgroundPipelineTasksWorker(rawTrack, initialMode, backgroundImage, options)
  }

  const segmenter = await loadSegmenter()
  const bodySegmentation = await import('@tensorflow-models/body-segmentation')

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', 'true')
  video.srcObject = new MediaStream([rawTrack])
  await video.play().catch(() => {})

  // Ensure the video has decoded at least one frame so videoWidth/videoHeight are available.
  // play() resolves on canplay, but dimensions are sometimes still 0 on the same microtask.
  if (video.videoWidth < 16) {
    await new Promise<void>(resolve => {
      const check = () => { if (video.videoWidth >= 16) resolve() }
      video.addEventListener('resize', check, { once: true })
      // Fallback: poll in case the event already fired
      const t = setInterval(() => { if (video.videoWidth >= 16) { clearInterval(t); resolve() } }, 50)
      setTimeout(() => { clearInterval(t); resolve() }, 2000)
    })
  }

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D
  if (!ctx) throw new Error('Canvas 2D not available')

  const maskCanvas = document.createElement('canvas')
  const maskCtx = maskCanvas.getContext('2d') as CanvasRenderingContext2D
  if (!maskCtx) throw new Error('Mask canvas not available')

  const inferCanvas = document.createElement('canvas')
  const inferCtxMaybe = inferCanvas.getContext('2d', { alpha: false })
  if (inferCtxMaybe == null) throw new Error('Inference canvas not available')
  const inferDrawCtx: CanvasRenderingContext2D = inferCtxMaybe

  /** EMA buffer for temporal mask smoothing (same length as last mask `ImageData.data`). */
  const maskSmoothState = { buffer: null as Uint8ClampedArray | null }

  const personCanvas = document.createElement('canvas')
  const personCtx = personCanvas.getContext('2d') as CanvasRenderingContext2D
  if (!personCtx) throw new Error('Person canvas not available')

  let mode: CameraBackgroundEffectMode = initialMode
  let bgImg = backgroundImage
  let blurAmount = Math.min(20, Math.max(1, options?.blurAmount ?? 12))
  let running = true
  let raf = 0
  let frameErrorReported = false
  // True once we have at least one valid mask to composite with
  let maskReady = false

  // Pre-size the canvas and draw the first raw frame so the captureStream track
  // starts at the correct resolution with real content instead of 300×150 blank.
  // This prevents WebRTC from negotiating/encoding a tiny black frame first.
  // Output / composite width — keep preview quality.
  const MAX_W = 540
  {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw >= 16 && vh >= 16) {
      const scale = vw > MAX_W ? MAX_W / vw : 1
      canvas.width = Math.round(vw * scale)
      canvas.height = Math.round(vh * scale)
      personCanvas.width = canvas.width
      personCanvas.height = canvas.height
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    }
  }

  /** Higher cadence helps WebRTC/preview feel closer to native camera; duplicate frames are cheap. */
  const OUTPUT_FPS = 60
  const outputStream = canvas.captureStream(OUTPUT_FPS)
  const processedTrack = outputStream.getVideoTracks()[0]
  if (!processedTrack) throw new Error('captureStream produced no video track')

  /** Downscaled scratch for approximate background blur (full-res CSS blur is very expensive). */
  const blurBgScratch = document.createElement('canvas')
  const blurBgCtx = blurBgScratch.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null
  const BLUR_DOWNSCALE = 2.5

  function resizeToVideo() {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw < 16 || vh < 16) return
    const scale = vw > MAX_W ? MAX_W / vw : 1
    const w = Math.round(vw * scale)
    const h = Math.round(vh * scale)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      personCanvas.width = w
      personCanvas.height = h
    }
  }

  function drawBlurredBackgroundFast(w: number, h: number) {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw < 16 || vh < 16) return

    if (!blurBgCtx) {
      const pad = blurAmount
      ctx.filter = `blur(${blurAmount}px)`
      ctx.drawImage(video, 0, 0, vw, vh, -pad, -pad, w + pad * 2, h + pad * 2)
      ctx.filter = 'none'
      return
    }

    const sw = Math.max(32, Math.round(w / BLUR_DOWNSCALE))
    const sh = Math.max(32, Math.round(h / BLUR_DOWNSCALE))
    const padS = Math.max(1, Math.ceil(blurAmount / BLUR_DOWNSCALE))
    const blurRad = Math.max(1, blurAmount / BLUR_DOWNSCALE)

    if (blurBgScratch.width !== sw || blurBgScratch.height !== sh) {
      blurBgScratch.width = sw
      blurBgScratch.height = sh
    }
    blurBgCtx.clearRect(0, 0, sw, sh)
    blurBgCtx.imageSmoothingEnabled = true
    blurBgCtx.imageSmoothingQuality = 'low'
    blurBgCtx.filter = `blur(${blurRad}px)`
    blurBgCtx.drawImage(video, 0, 0, vw, vh, -padS, -padS, sw + padS * 2, sh + padS * 2)
    blurBgCtx.filter = 'none'
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'medium'
    ctx.drawImage(blurBgScratch, 0, 0, sw, sh, 0, 0, w, h)
  }

  /**
   * Render one output frame (synchronous). Uses last mask from inference.
   * Scheduled from requestVideoFrameCallback when available so we paint ~camera fps, not ~display fps.
   */
  function renderFrame() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    resizeToVideo()
    const w = canvas.width
    const h = canvas.height
    if (w < 16 || h < 16) return

    if (!maskReady) {
      ctx.drawImage(video, 0, 0, w, h)
      return
    }

    if (mode === 'blur') {
      drawBlurredBackgroundFast(w, h)
    } else {
      ctx.fillStyle = '#1c1c1e'
      ctx.fillRect(0, 0, w, h)
      if (bgImg && bgImg.complete && (bgImg.naturalWidth || 0) > 0) {
        // Pre-flip the background image so that after the CSS scaleX(-1) on the
        // local video element it cancels out and appears in its natural orientation.
        ctx.save()
        ctx.translate(w, 0)
        ctx.scale(-1, 1)
        drawCover(ctx, bgImg, w, h)
        ctx.restore()
      }
    }

    // Composite person on top of background using the last mask.
    // Feathering: blur the mask when applying it as destination-in so the edges
    // fade as a gradient instead of cutting hard — same technique as Meet/Zoom.
    personCtx.globalCompositeOperation = 'source-over'
    personCtx.clearRect(0, 0, w, h)
    personCtx.drawImage(video, 0, 0, w, h)
    personCtx.filter = 'blur(3px)'
    personCtx.globalCompositeOperation = 'destination-in'
    personCtx.drawImage(maskCanvas, 0, 0, w, h)
    personCtx.filter = 'none'
    personCtx.globalCompositeOperation = 'source-over'

    ctx.drawImage(personCanvas, 0, 0)
  }

  let inferBusy = false
  /** Pending `requestVideoFrameCallback` id so we can cancel on stop(). */
  let pendingVfcHandle: number | undefined

  /** Reused so `ImageData` keeps a stable `ArrayBuffer` type for TypeScript / `putImageData`. */
  let smoothedMaskImage: ImageData | null = null

  function applyTemporalMaskSmooth(maskImage: ImageData): ImageData {
    const MASK_TEMPORAL_BLEND = 0.38
    const { data, width, height } = maskImage
    const len = data.length
    let buf = maskSmoothState.buffer
    if (!buf || buf.length !== len) {
      buf = new Uint8ClampedArray(len)
      buf.set(data)
      maskSmoothState.buffer = buf
      smoothedMaskImage = new ImageData(buf as ImageData['data'], width, height)
      return smoothedMaskImage
    }
    const inv = 1 - MASK_TEMPORAL_BLEND
    const b = MASK_TEMPORAL_BLEND
    for (let i = 0; i < len; i++) {
      buf[i] = (buf[i] * inv + data[i] * b) | 0
    }
    if (!smoothedMaskImage || smoothedMaskImage.width !== width || smoothedMaskImage.height !== height) {
      smoothedMaskImage = new ImageData(buf as ImageData['data'], width, height)
    }
    return smoothedMaskImage
  }

  async function runSegmentationOnce() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || canvas.width < 16 || canvas.height < 16) {
      return
    }
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw < 16 || vh < 16) return

    /** Segmentation runs on a smaller surface so each frame finishes sooner (smoother mask updates). */
    const INFER_MAX_W = 416
    const inferScale = vw > INFER_MAX_W ? INFER_MAX_W / vw : 1
    const iw = Math.max(16, Math.round(vw * inferScale))
    const ih = Math.max(16, Math.round(vh * inferScale))
    if (inferCanvas.width !== iw || inferCanvas.height !== ih) {
      inferCanvas.width = iw
      inferCanvas.height = ih
      maskSmoothState.buffer = null
      smoothedMaskImage = null
    }
    inferDrawCtx.drawImage(video, 0, 0, iw, ih)

    try {
      const segmentation = await segmenter.segmentPeople(inferCanvas, { flipHorizontal: false })
      const maskImage = await bodySegmentation.toBinaryMask(
        segmentation,
        { r: 255, g: 255, b: 255, a: 255 },
        { r: 0, g: 0, b: 0, a: 0 },
        false,
        0.35,
      )
      if (maskImage) {
        const smoothed = applyTemporalMaskSmooth(maskImage)
        if (maskCanvas.width !== smoothed.width || maskCanvas.height !== smoothed.height) {
          maskCanvas.width = smoothed.width
          maskCanvas.height = smoothed.height
        }
        maskCtx.putImageData(smoothed, 0, 0)
        maskReady = true
      }
    } catch (e: unknown) {
      if (!frameErrorReported) {
        frameErrorReported = true
        try {
          options?.onFrameError?.(e)
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Drive output + inference from decoded camera frames (~15–30fps).
   * Avoids painting ~60×/s when captureStream is 30fps (wasted work + jank).
   * Skips a new inference if the previous is still running (reuse last mask).
   */
  function scheduleVideoFrameCallbackLoop() {
    if (!running) return
    pendingVfcHandle = video.requestVideoFrameCallback(() => {
      pendingVfcHandle = undefined
      if (!running) return
      scheduleVideoFrameCallbackLoop()
      renderFrame()
      if (!inferBusy) {
        inferBusy = true
        void runSegmentationOnce().finally(() => {
          inferBusy = false
        })
      }
    })
  }

  let lastInferAt = 0
  const INFER_MIN_MS = 1000 / OUTPUT_FPS

  function renderLoopRaf() {
    if (!running) return
    raf = requestAnimationFrame(renderLoopRaf)
    renderFrame()
    const now = performance.now()
    if (!inferBusy && now - lastInferAt >= INFER_MIN_MS) {
      lastInferAt = now
      inferBusy = true
      void runSegmentationOnce().finally(() => {
        inferBusy = false
      })
    }
  }

  resizeToVideo()
  renderFrame()

  if (typeof video.requestVideoFrameCallback === 'function') {
    scheduleVideoFrameCallbackLoop()
  } else {
    renderLoopRaf()
  }

  return {
    getRawTrack: () => rawTrack,
    getProcessedTrack: () => processedTrack,
    setMode: (m) => { mode = m },
    setBackgroundImage: (img) => { bgImg = img },
    setBlurAmount: (amount) => { blurAmount = Math.min(20, Math.max(1, amount)) },
    stop: () => {
      running = false
      if (pendingVfcHandle != null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(pendingVfcHandle)
        pendingVfcHandle = undefined
      }
      cancelAnimationFrame(raf)
      processedTrack.stop()
      video.srcObject = null
    },
  }
}
