import type { BodySegmenter } from '@tensorflow-models/body-segmentation'

export type CameraBackgroundEffectMode = 'blur' | 'image'

let segmenterPromise: Promise<BodySegmenter> | null = null

async function loadSegmenter(): Promise<BodySegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const tf = await import('@tensorflow/tfjs')
      await tf.setBackend('webgl')
      await tf.ready()
      const bodySegmentation = await import('@tensorflow-models/body-segmentation')
      return bodySegmentation.createSegmenter(bodySegmentation.SupportedModels.MediaPipeSelfieSegmentation, {
        runtime: 'mediapipe',
        modelType: 'general',
        solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation',
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
  options?: { blurAmount?: number },
): Promise<CameraBackgroundPipeline> {
  const bodySegmentation = await import('@tensorflow-models/body-segmentation')
  const segmenter = await loadSegmenter()

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', 'true')
  video.srcObject = new MediaStream([rawTrack])
  await video.play().catch(() => {})

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas 2D not available')

  const maskCanvas = document.createElement('canvas')
  const maskCtx = maskCanvas.getContext('2d')
  if (!maskCtx) throw new Error('Mask canvas not available')

  const personCanvas = document.createElement('canvas')
  const personCtx = personCanvas.getContext('2d')
  if (!personCtx) throw new Error('Person canvas not available')

  const drawCtx: CanvasRenderingContext2D = ctx
  const maskDrawCtx: CanvasRenderingContext2D = maskCtx
  const personDrawCtx: CanvasRenderingContext2D = personCtx

  let mode: CameraBackgroundEffectMode = initialMode
  let bgImg = backgroundImage
  let blurAmount = Math.min(20, Math.max(1, options?.blurAmount ?? 12))
  let running = true
  let raf = 0

  const outputStream = canvas.captureStream(30)
  const processedTrack = outputStream.getVideoTracks()[0]
  if (!processedTrack) throw new Error('captureStream produced no video track')

  function resizeToVideo() {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw < 16 || vh < 16) return
    const maxW = 960
    const scale = vw > maxW ? maxW / vw : 1
    const w = Math.round(vw * scale)
    const h = Math.round(vh * scale)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      personCanvas.width = w
      personCanvas.height = h
    }
  }

  async function processFrame() {
    if (!running) return
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    try {
      resizeToVideo()
      const w = canvas.width
      const h = canvas.height
      if (w < 16 || h < 16) return

      const segmentation = await segmenter.segmentPeople(video, { flipHorizontal: false })

      // Draw background
      if (mode === 'blur') {
        // Draw oversized to prevent dark edges from blur kernel bleeding into the black canvas border
        const pad = blurAmount
        drawCtx.filter = `blur(${blurAmount}px)`
        drawCtx.drawImage(video, -pad, -pad, w + pad * 2, h + pad * 2)
        drawCtx.filter = 'none'
      } else {
        drawCtx.fillStyle = '#1c1c1e'
        drawCtx.fillRect(0, 0, w, h)
        if (bgImg && bgImg.complete && (bgImg.naturalWidth || 0) > 0) {
          // Pre-flip the background image so that after the CSS scaleX(-1) on the
          // local video element it cancels out and appears in its natural orientation.
          drawCtx.save()
          drawCtx.translate(w, 0)
          drawCtx.scale(-1, 1)
          drawCover(drawCtx, bgImg, w, h)
          drawCtx.restore()
        }
      }

      // Get person mask — lower threshold captures more uncertain edge pixels (hair, etc.)
      const maskImage = await bodySegmentation.toBinaryMask(
        segmentation,
        { r: 255, g: 255, b: 255, a: 255 },
        { r: 0, g: 0, b: 0, a: 0 },
        false,
        0.35,
      )
      if (!maskImage) {
        drawCtx.drawImage(video, 0, 0, w, h)
        return
      }

      if (maskCanvas.width !== maskImage.width || maskCanvas.height !== maskImage.height) {
        maskCanvas.width = maskImage.width
        maskCanvas.height = maskImage.height
      }
      maskDrawCtx.putImageData(maskImage, 0, 0)

      // Composite person on top of background.
      // Feathering: blur the mask when applying it as destination-in so the edges
      // fade as a gradient instead of cutting hard — same technique as Meet/Zoom.
      personDrawCtx.imageSmoothingEnabled = true
      personDrawCtx.imageSmoothingQuality = 'high'
      personDrawCtx.globalCompositeOperation = 'source-over'
      personDrawCtx.clearRect(0, 0, w, h)
      personDrawCtx.drawImage(video, 0, 0, w, h)
      personDrawCtx.filter = 'blur(8px)'
      personDrawCtx.globalCompositeOperation = 'destination-in'
      personDrawCtx.drawImage(maskCanvas, 0, 0, w, h)
      personDrawCtx.filter = 'none'
      personDrawCtx.globalCompositeOperation = 'source-over'

      drawCtx.drawImage(personCanvas, 0, 0)
    } catch {
      resizeToVideo()
      if (canvas.width >= 16 && canvas.height >= 16) {
        drawCtx.drawImage(video, 0, 0, canvas.width, canvas.height)
      }
    }
  }

  function scheduleFrame() {
    if (!running) return
    raf = requestAnimationFrame(() => {
      void processFrame().finally(() => {
        if (running) scheduleFrame()
      })
    })
  }
  scheduleFrame()

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
