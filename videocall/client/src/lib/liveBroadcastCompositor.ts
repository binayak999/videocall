/**
 * Host-side composite of all meeting video + mixed audio for public /watch WebRTC viewers.
 * Single outbound video track (canvas) + one mixed audio track.
 */

export type BroadcastTile = {
  /** Stable id for pooling video elements */
  key: string
  label: string
  stream: MediaStream | null
}

export type BroadcastScreenMain = {
  stream: MediaStream
  label?: string
}

const CANVAS_W = 1280
const CANVAS_H = 720
const CAPTURE_FPS = 24
const STRIP_H = 140

/** Detect track set changes when callers mutate a MediaStream in place (common with LiveKit). */
function streamPlaybackFingerprint(s: MediaStream | null): string {
  if (!s) return ''
  return [...s.getTracks()]
    .map(t => `${t.kind}:${t.id}:${t.readyState}:${t.muted}`)
    .sort()
    .join('|')
}

/**
 * Dedicated playback stream for compositor &lt;video&gt; elements. Cloning avoids Chrome/Chromium
 * failing to decode WebRTC (especially SFU/LiveKit) when the same MediaStream is already bound
 * to visible tiles, and attaching elements to the document avoids zero videoWidth on off-DOM videos.
 */
function cloneStreamForVideoPlayback(src: MediaStream | null): MediaStream | null {
  if (!src) return null
  const out = new MediaStream()
  for (const t of src.getTracks()) {
    if (t.kind !== 'video') continue
    try {
      out.addTrack(t.clone())
    } catch {
      out.addTrack(t)
    }
  }
  return out.getVideoTracks().length > 0 ? out : null
}

function drawVideoCover(
  ctx: CanvasRenderingContext2D,
  v: HTMLVideoElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || v.videoWidth === 0) {
    ctx.fillStyle = '#1a1a1f'
    ctx.fillRect(dx, dy, dw, dh)
    return
  }
  const vw = v.videoWidth
  const vh = v.videoHeight
  const scale = Math.max(dw / vw, dh / vh)
  const tw = dw / scale
  const th = dh / scale
  const sx = (vw - tw) / 2
  const sy = (vh - th) / 2
  ctx.drawImage(v, sx, sy, tw, th, dx, dy, dw, dh)
}

function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 }
  if (n === 1) return { cols: 1, rows: 1 }
  if (n === 2) return { cols: 2, rows: 1 }
  if (n <= 4) return { cols: 2, rows: 2 }
  if (n <= 6) return { cols: 3, rows: 2 }
  if (n <= 9) return { cols: 3, rows: 3 }
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  return { cols, rows }
}

export class LiveBroadcastCompositor {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private raf = 0
  private running = false
  private videoEls = new Map<string, HTMLVideoElement>()
  /** Last fingerprint we built playback clones for (per tile / screen key). */
  private playbackFingerprintByKey = new Map<string, string>()
  private hiddenMount: HTMLDivElement | null = null
  private audioCtx: AudioContext | null = null
  private gainMaster: GainNode | null = null
  private audioSources = new Map<string, MediaStreamAudioSourceNode>()
  private compositeStream: MediaStream | null = null
  private tiles: BroadcastTile[] = []
  private screenMain: BroadcastScreenMain | null = null

  start(): void {
    if (this.running) return
    const canvas = document.createElement('canvas')
    canvas.width = CANVAS_W
    canvas.height = CANVAS_H
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    this.canvas = canvas
    this.ctx = ctx

    const cap = canvas.captureStream(CAPTURE_FPS)
    const vTrack = cap.getVideoTracks()[0] ?? null

    const actx = new AudioContext()
    this.audioCtx = actx
    const gain = actx.createGain()
    gain.gain.value = 1
    const mixDest = actx.createMediaStreamDestination()
    gain.connect(mixDest)
    this.gainMaster = gain

    const aTrack = mixDest.stream.getAudioTracks()[0] ?? null
    this.compositeStream = new MediaStream(
      [vTrack, aTrack].filter((t): t is MediaStreamTrack => t != null),
    )
    this.running = true
    this.tick()
  }

  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const v of this.videoEls.values()) {
      const s = v.srcObject as MediaStream | null
      if (s) {
        for (const tr of s.getTracks()) tr.stop()
      }
      v.srcObject = null
      v.remove()
    }
    this.videoEls.clear()
    this.playbackFingerprintByKey.clear()
    if (this.hiddenMount) {
      this.hiddenMount.remove()
      this.hiddenMount = null
    }
    for (const n of this.audioSources.values()) {
      try {
        n.disconnect()
      } catch {
        /* ignore */
      }
    }
    this.audioSources.clear()
    this.canvas = null
    this.ctx = null
    this.tiles = []
    this.screenMain = null
    this.compositeStream = null
    if (this.audioCtx) {
      void this.audioCtx.close()
      this.audioCtx = null
    }
    this.gainMaster = null
  }

  getStream(): MediaStream | null {
    return this.compositeStream
  }

  /**
   * Update sources. When `screenMain` is set, it fills most of the frame; camera tiles render in a bottom strip.
   */
  setSources(tiles: BroadcastTile[], screenMain: BroadcastScreenMain | null): void {
    this.tiles = tiles
    this.screenMain = screenMain
    void this.audioCtx?.resume().catch(() => {})
    this.syncVideos()
    this.syncAudio()
  }

  private ensureHiddenMount(): HTMLDivElement {
    if (this.hiddenMount) return this.hiddenMount
    const d = document.createElement('div')
    d.setAttribute('aria-hidden', 'true')
    d.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;opacity:0;overflow:hidden;pointer-events:none;z-index:-1'
    document.body.appendChild(d)
    this.hiddenMount = d
    return d
  }

  private ensureVideo(key: string): HTMLVideoElement {
    let v = this.videoEls.get(key)
    if (!v) {
      v = document.createElement('video')
      v.muted = true
      v.playsInline = true
      v.setAttribute('playsinline', '')
      v.setAttribute('webkit-playsinline', '')
      this.ensureHiddenMount().appendChild(v)
      this.videoEls.set(key, v)
    }
    return v
  }

  private stopPlaybackOnVideo(v: HTMLVideoElement): void {
    const s = v.srcObject as MediaStream | null
    if (s) {
      for (const tr of s.getTracks()) tr.stop()
    }
    v.srcObject = null
  }

  private bindVideoPlayback(key: string, src: MediaStream | null): void {
    const fp = streamPlaybackFingerprint(src)
    if (this.playbackFingerprintByKey.get(key) === fp) return
    this.playbackFingerprintByKey.set(key, fp)
    const v = this.ensureVideo(key)
    this.stopPlaybackOnVideo(v)
    v.srcObject = cloneStreamForVideoPlayback(src)
    void v.play().catch(() => {})
  }

  private syncVideos(): void {
    const keys = new Set<string>()
    if (this.screenMain) keys.add(`screen:${this.screenMain.stream.id}`)
    for (const t of this.tiles) keys.add(t.key)

    for (const k of [...this.videoEls.keys()]) {
      if (!keys.has(k)) {
        const v = this.videoEls.get(k)
        if (v) {
          this.stopPlaybackOnVideo(v)
          v.remove()
        }
        this.videoEls.delete(k)
        this.playbackFingerprintByKey.delete(k)
      }
    }

    if (this.screenMain) {
      const k = `screen:${this.screenMain.stream.id}`
      this.bindVideoPlayback(k, this.screenMain.stream)
    }

    for (const t of this.tiles) {
      this.bindVideoPlayback(t.key, t.stream)
    }
  }

  private syncAudio(): void {
    const ctx = this.audioCtx
    const gain = this.gainMaster
    if (!ctx || !gain) return

    const tracks: MediaStreamTrack[] = []
    const addFrom = (s: MediaStream | null) => {
      if (!s) return
      for (const t of s.getAudioTracks()) {
        if (t.readyState === 'live') tracks.push(t)
      }
    }
    if (this.screenMain) addFrom(this.screenMain.stream)
    for (const t of this.tiles) addFrom(t.stream)

    const active = new Set(tracks.map(t => t.id))
    for (const [id, node] of this.audioSources) {
      if (!active.has(id)) {
        try {
          node.disconnect()
        } catch {
          /* ignore */
        }
        this.audioSources.delete(id)
      }
    }

    for (const t of tracks) {
      if (this.audioSources.has(t.id)) continue
      try {
        const src = ctx.createMediaStreamSource(new MediaStream([t]))
        src.connect(gain)
        this.audioSources.set(t.id, src)
      } catch {
        /* ignore */
      }
    }
  }

  private tick = (): void => {
    if (!this.running) return
    const canvas = this.canvas
    const ctx = this.ctx
    if (!canvas || !ctx) return
    this.raf = requestAnimationFrame(this.tick)

    const W = canvas.width
    const H = canvas.height
    ctx.fillStyle = '#0a0a0c'
    ctx.fillRect(0, 0, W, H)

    if (this.screenMain) {
      const mainH = H - STRIP_H
      const sv = this.videoEls.get(`screen:${this.screenMain.stream.id}`)
      if (sv) {
        drawVideoCover(ctx, sv, 0, 0, W, mainH)
      } else {
        ctx.fillStyle = '#12121a'
        ctx.fillRect(0, 0, W, mainH)
      }

      const stripY = mainH
      const n = Math.max(1, this.tiles.length)
      const tw = W / n
      let i = 0
      for (const t of this.tiles) {
        const v = this.videoEls.get(t.key)
        const dx = i * tw
        if (v) drawVideoCover(ctx, v, dx, stripY, tw, STRIP_H)
        else {
          ctx.fillStyle = '#1a1a1f'
          ctx.fillRect(dx, stripY, tw, STRIP_H)
        }
        ctx.fillStyle = 'rgba(0,0,0,0.45)'
        ctx.fillRect(dx, stripY + STRIP_H - 22, tw, 22)
        ctx.fillStyle = '#e8e8ee'
        ctx.font = '12px system-ui,sans-serif'
        ctx.fillText(t.label.slice(0, 28), dx + 6, stripY + STRIP_H - 7)
        i++
      }
    } else {
      const n = Math.max(1, this.tiles.length)
      const { cols, rows } = gridDims(n)
      const cw = W / cols
      const ch = H / rows
      let idx = 0
      for (const t of this.tiles) {
        const col = idx % cols
        const row = Math.floor(idx / cols)
        const dx = col * cw
        const dy = row * ch
        const v = this.videoEls.get(t.key)
        if (v) drawVideoCover(ctx, v, dx, dy, cw, ch)
        else {
          ctx.fillStyle = '#1a1a1f'
          ctx.fillRect(dx, dy, cw, ch)
        }
        ctx.fillStyle = 'rgba(0,0,0,0.5)'
        ctx.fillRect(dx, dy + ch - 24, cw, 24)
        ctx.fillStyle = '#f4f4f8'
        ctx.font = 'bold 13px system-ui,sans-serif'
        ctx.fillText(t.label.slice(0, 36), dx + 8, dy + ch - 8)
        idx++
      }
    }
  }
}
