import { CameraSegmentationBridge } from './cameraSegmentationBridge'
import {
  applyTemporalMaskSmoothImageData,
  DEFAULT_MASK_TEMPORAL_BLEND,
  extractMaskAlphaR8Scaled,
  floatConfidenceToRgbaImageData,
  type MaskSmoothState,
} from './cameraMaskUtils'
import { tryCreateWebGpuBackgroundRenderer, type WebGpuBackgroundRenderer } from './webgpuBackgroundRenderer'

import type { CameraBackgroundEffectMode, CameraBackgroundPipeline } from './cameraBackgroundTypes'

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

/**
 * MediaPipe **Tasks** `ImageSegmenter` (GPU-first) in a dedicated worker + optional WebGPU composite.
 * Enable with `VITE_CAMERA_BG_ENGINE=tasks-worker` and optionally `VITE_CAMERA_BG_COMPOSITE=webgpu`.
 */
export async function startCameraBackgroundPipelineTasksWorker(
  rawTrack: MediaStreamTrack,
  initialMode: CameraBackgroundEffectMode,
  backgroundImage: HTMLImageElement | null,
  options?: { blurAmount?: number; onFrameError?: (err: unknown) => void },
): Promise<CameraBackgroundPipeline> {
  const bridge = new CameraSegmentationBridge()
  await bridge.init()

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.setAttribute('playsinline', 'true')
  video.srcObject = new MediaStream([rawTrack])
  await video.play().catch(() => {})

  if (video.videoWidth < 16) {
    await new Promise<void>(resolve => {
      const check = () => { if (video.videoWidth >= 16) resolve() }
      video.addEventListener('resize', check, { once: true })
      const t = setInterval(() => { if (video.videoWidth >= 16) { clearInterval(t); resolve() } }, 50)
      setTimeout(() => { clearInterval(t); resolve() }, 2000)
    })
  }

  const out = document.createElement('canvas')
  const outCtxMaybe = out.getContext('2d', { alpha: false })
  if (!outCtxMaybe) {
    bridge.close()
    throw new Error('Canvas 2D not available')
  }
  const outCtx: CanvasRenderingContext2D = outCtxMaybe

  const maskCanvas = document.createElement('canvas')
  const maskCtx = maskCanvas.getContext('2d') as CanvasRenderingContext2D
  if (!maskCtx) {
    bridge.close()
    throw new Error('Mask canvas not available')
  }

  const inferCanvas = document.createElement('canvas')
  const inferCtxMaybe = inferCanvas.getContext('2d', { alpha: false })
  if (inferCtxMaybe == null) {
    bridge.close()
    throw new Error('Inference canvas not available')
  }
  const inferDrawCtx: CanvasRenderingContext2D = inferCtxMaybe

  const maskSmoothState: MaskSmoothState = { buffer: null }
  const smoothedRef: { current: ImageData | null } = { current: null }

  const personCanvas = document.createElement('canvas')
  const personCtx = personCanvas.getContext('2d') as CanvasRenderingContext2D
  if (!personCtx) {
    bridge.close()
    throw new Error('Person canvas not available')
  }

  const maskAlphaScratch = document.createElement('canvas')
  const maskAlphaCtxMaybe = maskAlphaScratch.getContext('2d')
  const maskAlphaCtx: CanvasRenderingContext2D | null = maskAlphaCtxMaybe

  const gpuCanvas = document.createElement('canvas')
  const wantWebGpu =
    (import.meta.env.VITE_CAMERA_BG_COMPOSITE ?? 'canvas2d').trim().toLowerCase() === 'webgpu'
  let webgpu: WebGpuBackgroundRenderer | null = null
  if (wantWebGpu) {
    webgpu = await tryCreateWebGpuBackgroundRenderer(gpuCanvas)
  }

  let mode: CameraBackgroundEffectMode = initialMode
  let bgImg = backgroundImage
  let blurAmount = Math.min(20, Math.max(1, options?.blurAmount ?? 12))
  let running = true
  let raf = 0
  let frameErrorReported = false
  let maskReady = false

  const MAX_W = 540
  const INFER_MAX_W = 416
  {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw >= 16 && vh >= 16) {
      const scale = vw > MAX_W ? MAX_W / vw : 1
      out.width = Math.round(vw * scale)
      out.height = Math.round(vh * scale)
      personCanvas.width = out.width
      personCanvas.height = out.height
      outCtx.drawImage(video, 0, 0, out.width, out.height)
    }
  }

  const OUTPUT_FPS = 60
  const outputStream = out.captureStream(OUTPUT_FPS)
  const processedTrack = outputStream.getVideoTracks()[0]
  if (!processedTrack) {
    bridge.close()
    webgpu?.destroy()
    throw new Error('captureStream produced no video track')
  }

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
    if (out.width !== w || out.height !== h) {
      out.width = w
      out.height = h
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
      outCtx.filter = `blur(${blurAmount}px)`
      outCtx.drawImage(video, 0, 0, vw, vh, -pad, -pad, w + pad * 2, h + pad * 2)
      outCtx.filter = 'none'
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
    outCtx.imageSmoothingEnabled = true
    outCtx.imageSmoothingQuality = 'medium'
    outCtx.drawImage(blurBgScratch, 0, 0, sw, sh, 0, 0, w, h)
  }

  function composite2D(w: number, h: number) {
    if (mode === 'blur') {
      drawBlurredBackgroundFast(w, h)
    } else {
      outCtx.fillStyle = '#1c1c1e'
      outCtx.fillRect(0, 0, w, h)
      if (bgImg && bgImg.complete && (bgImg.naturalWidth || 0) > 0) {
        outCtx.save()
        outCtx.translate(w, 0)
        outCtx.scale(-1, 1)
        drawCover(outCtx, bgImg, w, h)
        outCtx.restore()
      }
    }
    personCtx.globalCompositeOperation = 'source-over'
    personCtx.clearRect(0, 0, w, h)
    personCtx.drawImage(video, 0, 0, w, h)
    personCtx.filter = 'blur(3px)'
    personCtx.globalCompositeOperation = 'destination-in'
    personCtx.drawImage(maskCanvas, 0, 0, w, h)
    personCtx.filter = 'none'
    personCtx.globalCompositeOperation = 'source-over'
    outCtx.drawImage(personCanvas, 0, 0)
  }

  function renderFrame() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    resizeToVideo()
    const w = out.width
    const h = out.height
    if (w < 16 || h < 16) return

    if (!maskReady) {
      outCtx.drawImage(video, 0, 0, w, h)
      return
    }

    const useWebGpu =
      webgpu != null &&
      maskAlphaCtx != null &&
      (mode === 'blur' || (mode === 'image' && !bgImg))

    if (useWebGpu) {
      const alpha = extractMaskAlphaR8Scaled(maskCanvas, w, h, maskAlphaScratch, maskAlphaCtx)
      webgpu!.resize(w, h)
      webgpu!.render({
        video,
        maskR8: alpha,
        width: w,
        height: h,
        modeBlur: mode === 'blur',
        solidBgRgb: [28 / 255, 28 / 255, 30 / 255],
        blurUvRadius: Math.min(0.04, Math.max(0.002, blurAmount * 0.0012)),
      })
      outCtx.drawImage(gpuCanvas, 0, 0, w, h)
      return
    }

    composite2D(w, h)
  }

  let inferBusy = false
  let pendingVfcHandle: number | undefined

  async function runSegmentationOnce() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || out.width < 16 || out.height < 16) {
      return
    }
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw < 16 || vh < 16) return

    const inferScale = vw > INFER_MAX_W ? INFER_MAX_W / vw : 1
    const iw = Math.max(16, Math.round(vw * inferScale))
    const ih = Math.max(16, Math.round(vh * inferScale))
    if (inferCanvas.width !== iw || inferCanvas.height !== ih) {
      inferCanvas.width = iw
      inferCanvas.height = ih
      maskSmoothState.buffer = null
      smoothedRef.current = null
    }
    inferDrawCtx.drawImage(video, 0, 0, iw, ih)

    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(inferCanvas)
    } catch {
      return
    }

    try {
      const { width, height, confidence } = await bridge.segment(bitmap, performance.now())
      const rgba = floatConfidenceToRgbaImageData(confidence, width, height)
      const smoothed = applyTemporalMaskSmoothImageData(
        rgba,
        maskSmoothState,
        DEFAULT_MASK_TEMPORAL_BLEND,
        smoothedRef,
      )
      if (maskCanvas.width !== smoothed.width || maskCanvas.height !== smoothed.height) {
        maskCanvas.width = smoothed.width
        maskCanvas.height = smoothed.height
      }
      maskCtx.putImageData(smoothed, 0, 0)
      maskReady = true
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
      bridge.close()
      webgpu?.destroy()
    },
  }
}
