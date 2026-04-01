import type { BodySegmenter } from '@tensorflow-models/body-segmentation'

export type CameraBackgroundEffectMode = 'blur' | 'image'

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
      const tf = await import('@tensorflow/tfjs')
      // WebGL can be unavailable/blocked (private browsing, GPU denylist, older devices).
      // Fall back to WASM/CPU so background effects still work (albeit slower).
      try {
        await tf.setBackend('webgl')
      } catch {
        try {
          await tf.setBackend('wasm')
        } catch {
          await tf.setBackend('cpu')
        }
      }
      await tf.ready()
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

export interface CameraBackgroundPipeline {
  getRawTrack: () => MediaStreamTrack
  getProcessedTrack: () => MediaStreamTrack
  setMode: (mode: CameraBackgroundEffectMode) => void
  setBackgroundImage: (img: HTMLImageElement | null) => void
  setBlurAmount: (amount: number) => void
  stop: () => void
}

export async function startCameraBackgroundPipeline(
  rawTrack: MediaStreamTrack,
  initialMode: CameraBackgroundEffectMode,
  backgroundImage: HTMLImageElement | null,
  options?: { blurAmount?: number; onFrameError?: (err: unknown) => void },
): Promise<CameraBackgroundPipeline> {
  await loadMediapipeScript()
  const bodySegmentation = await import('@tensorflow-models/body-segmentation')
  const segmenter = await loadSegmenter()

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
  // Cap at 640px — smaller size means much faster ML inference.
  const MAX_W = 640
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

  const outputStream = canvas.captureStream(30)
  const processedTrack = outputStream.getVideoTracks()[0]
  if (!processedTrack) throw new Error('captureStream produced no video track')

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

  /**
   * Render loop — runs every animation frame (~60fps), synchronous, no inference.
   * Uses the last available mask from the inference loop to composite the frame.
   * This keeps output smooth regardless of how long inference takes.
   */
  function renderFrame() {
    if (!running) return
    raf = requestAnimationFrame(renderFrame)

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    resizeToVideo()
    const w = canvas.width
    const h = canvas.height
    if (w < 16 || h < 16) return

    if (!maskReady) {
      // No mask yet — show raw video while first inference runs
      ctx.drawImage(video, 0, 0, w, h)
      return
    }

    // Draw background layer
    if (mode === 'blur') {
      // Draw oversized to prevent dark edges from blur kernel bleeding into the black canvas border
      const pad = blurAmount
      ctx.filter = `blur(${blurAmount}px)`
      ctx.drawImage(video, -pad, -pad, w + pad * 2, h + pad * 2)
      ctx.filter = 'none'
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

  /**
   * Inference loop — runs as a separate async loop, continuously updating the mask.
   * Decoupled from the render loop so a slow inference (~100ms) doesn't freeze frames.
   * The render loop uses whatever mask was last computed.
   */
  async function inferenceLoop() {
    while (running) {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && canvas.width >= 16 && canvas.height >= 16) {
        try {
          const segmentation = await segmenter.segmentPeople(video, { flipHorizontal: false })

          // Get person mask — lower threshold captures more uncertain edge pixels (hair, etc.)
          const maskImage = await bodySegmentation.toBinaryMask(
            segmentation,
            { r: 255, g: 255, b: 255, a: 255 },
            { r: 0, g: 0, b: 0, a: 0 },
            false,
            0.35,
          )
          if (maskImage) {
            if (maskCanvas.width !== maskImage.width || maskCanvas.height !== maskImage.height) {
              maskCanvas.width = maskImage.width
              maskCanvas.height = maskImage.height
            }
            maskCtx.putImageData(maskImage, 0, 0)
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
      // Yield to the event loop so the render loop (RAF) can run between inferences.
      // If inference is fast this keeps it running continuously; if slow it just loops again.
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  renderFrame()
  void inferenceLoop()

  return {
    getRawTrack: () => rawTrack,
    getProcessedTrack: () => processedTrack,
    setMode: (m) => { mode = m },
    setBackgroundImage: (img) => { bgImg = img },
    setBlurAmount: (amount) => { blurAmount = Math.min(20, Math.max(1, amount)) },
    stop: () => {
      running = false
      cancelAnimationFrame(raf)
      processedTrack.stop()
      video.srcObject = null
    },
  }
}
