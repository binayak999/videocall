import { isVideoHorizontallyFlippedByCss } from './videoMirrorCss'

/**
 * Captures all <video> elements inside a container to a canvas stream and mixes
 * participant audio for a single-file host-side meeting recording.
 */
export class HostMeetingRecorder {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private raf = 0
  private audioCtx: AudioContext | null = null
  private dest: MediaStreamAudioDestinationNode | null = null
  private mediaRecorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private mimeType = 'video/webm'

  start(container: HTMLElement, audioStreams: MediaStream[], options?: { frameRate?: number; maxWidth?: number }): void {
    const frameRate = options?.frameRate ?? 12
    const maxW = options?.maxWidth ?? 1280
    const cw = Math.max(1, Math.min(container.clientWidth || 1280, maxW))
    const ratio = container.clientWidth > 0 ? container.clientHeight / container.clientWidth : 9 / 16
    const ch = Math.max(1, Math.round(cw * ratio))

    this.canvas = document.createElement('canvas')
    this.canvas.width = cw
    this.canvas.height = ch
    this.ctx = this.canvas.getContext('2d', { alpha: false })
    if (!this.ctx) {
      throw new Error('Could not create recording canvas context')
    }

    const canvasStream = this.canvas.captureStream(frameRate)
    const out = new MediaStream()

    const vTrack = canvasStream.getVideoTracks()[0]
    if (vTrack) {
      out.addTrack(vTrack)
    }

    try {
      this.audioCtx = new AudioContext()
      void this.audioCtx.resume()
      this.dest = this.audioCtx.createMediaStreamDestination()
      for (const stream of audioStreams) {
        for (const track of stream.getAudioTracks()) {
          if (track.readyState !== 'live') {
            continue
          }
          try {
            const src = this.audioCtx.createMediaStreamSource(new MediaStream([track]))
            src.connect(this.dest)
          } catch {
            /* ignore single-track failures */
          }
        }
      }
      const aTrack = this.dest.stream.getAudioTracks()[0]
      if (aTrack) {
        out.addTrack(aTrack)
      }
    } catch {
      this.audioCtx = null
      this.dest = null
    }

    const preferred = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]
    this.mimeType = preferred.find(m => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
    this.mediaRecorder = new MediaRecorder(out, { mimeType: this.mimeType })
    this.chunks = []
    this.mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) {
        this.chunks.push(e.data)
      }
    }
    this.mediaRecorder.start(1000)

    const draw = () => {
      this.raf = requestAnimationFrame(draw)
      const ctx = this.ctx
      const c = this.canvas
      if (!ctx || !c) {
        return
      }
      const w = c.width
      const h = c.height
      const videos = [...container.querySelectorAll('video')] as HTMLVideoElement[]
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, w, h)
      if (videos.length === 0) {
        return
      }
      const n = videos.filter(v => v.readyState >= 2).length
      if (n === 0) {
        return
      }
      const cols = Math.ceil(Math.sqrt(n))
      const rows = Math.ceil(n / cols)
      const cellW = w / cols
      const cellH = h / rows
      let i = 0
      for (const vid of videos) {
        if (vid.readyState < 2) {
          continue
        }
        const col = i % cols
        const row = Math.floor(i / cols)
        const vw = vid.videoWidth || 640
        const vh = vid.videoHeight || 480
        const scale = Math.min(cellW / vw, cellH / vh)
        const dw = vw * scale
        const dh = vh * scale
        const dx = col * cellW + (cellW - dw) / 2
        const dy = row * cellH + (cellH - dh) / 2
        try {
          const mirror = isVideoHorizontallyFlippedByCss(vid)
          if (mirror) {
            ctx.save()
            ctx.translate(dx + dw, dy)
            ctx.scale(-1, 1)
            ctx.drawImage(vid, 0, 0, dw, dh)
            ctx.restore()
          } else {
            ctx.drawImage(vid, dx, dy, dw, dh)
          }
        } catch {
          /* tainted canvas / decode */
        }
        i++
      }
    }
    draw()
  }

  async stop(): Promise<Blob> {
    cancelAnimationFrame(this.raf)
    this.raf = 0

    const mr = this.mediaRecorder
    this.mediaRecorder = null

    await new Promise<void>(resolve => {
      if (!mr || mr.state === 'inactive') {
        resolve()
        return
      }
      mr.onstop = () => resolve()
      mr.stop()
    })

    if (this.audioCtx) {
      await this.audioCtx.close().catch(() => {})
      this.audioCtx = null
    }
    this.dest = null
    this.canvas = null
    this.ctx = null

    return new Blob(this.chunks, { type: this.mimeType })
  }
}
