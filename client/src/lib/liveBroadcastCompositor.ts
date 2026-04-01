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
/** Bottom filmstrip height when screen sharing */
const STRIP_H = 152
const GUTTER = 10
const TILE_RADIUS = 14
const LABEL_BAR_H = 28

/** Lay out `n` tiles in an even grid with gutters (fallback for large n). */
function layoutEvenGrid(
  n: number,
  W: number,
  H: number,
  g: number,
): { x: number; y: number; w: number; h: number }[] {
  if (n <= 0) return [{ x: g, y: g, w: W - 2 * g, h: H - 2 * g }]
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const cw = (W - (cols + 1) * g) / cols
  const ch = (H - (rows + 1) * g) / rows
  const out: { x: number; y: number; w: number; h: number }[] = []
  for (let i = 0; i < n; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    out.push({ x: g + c * (cw + g), y: g + r * (ch + g), w: cw, h: ch })
  }
  return out
}

/**
 * Human-friendly layouts for typical meeting sizes (gutters, no awkward empty holes).
 */
function layoutBroadcastTiles(
  n: number,
  W: number,
  H: number,
  g: number,
): { x: number; y: number; w: number; h: number }[] {
  if (n <= 0) return [{ x: g, y: g, w: W - 2 * g, h: H - 2 * g }]
  if (n === 1) {
    return [{ x: g, y: g, w: W - 2 * g, h: H - 2 * g }]
  }
  if (n === 2) {
    const cw = (W - 3 * g) / 2
    const ch = H - 2 * g
    return [
      { x: g, y: g, w: cw, h: ch },
      { x: g + cw + g, y: g, w: cw, h: ch },
    ]
  }
  if (n === 3) {
    // One large primary + two stacked (good for host + two guests)
    const mainW = Math.round((W - 3 * g) * 0.58)
    const sideW = W - 3 * g - mainW
    const sh = (H - 3 * g) / 2
    return [
      { x: g, y: g, w: mainW, h: H - 2 * g },
      { x: g + mainW + g, y: g, w: sideW, h: sh },
      { x: g + mainW + g, y: g + sh + g, w: sideW, h: sh },
    ]
  }
  if (n === 4) {
    const cw = (W - 3 * g) / 2
    const ch = (H - 3 * g) / 2
    return [
      { x: g, y: g, w: cw, h: ch },
      { x: g + cw + g, y: g, w: cw, h: ch },
      { x: g, y: g + ch + g, w: cw, h: ch },
      { x: g + cw + g, y: g + ch + g, w: cw, h: ch },
    ]
  }
  if (n === 5) {
    const cw = (W - 4 * g) / 3
    const ch = (H - 3 * g) / 2
    const topY = g
    const botY = g + ch + g
    const bw = (W - 3 * g) / 2
    const botBlockW = 2 * bw + g
    const botStartX = Math.max(g, (W - botBlockW) / 2)
    return [
      { x: g, y: topY, w: cw, h: ch },
      { x: g + cw + g, y: topY, w: cw, h: ch },
      { x: g + 2 * (cw + g), y: topY, w: cw, h: ch },
      { x: botStartX, y: botY, w: bw, h: ch },
      { x: botStartX + bw + g, y: botY, w: bw, h: ch },
    ]
  }
  if (n === 6) {
    const cw = (W - 4 * g) / 3
    const ch = (H - 3 * g) / 2
    const out: { x: number; y: number; w: number; h: number }[] = []
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        out.push({ x: g + c * (cw + g), y: g + r * (ch + g), w: cw, h: ch })
      }
    }
    return out
  }
  if (n <= 8) {
    const cols = 4
    const rows = 2
    const cw = (W - (cols + 1) * g) / cols
    const ch = (H - (rows + 1) * g) / rows
    const out: { x: number; y: number; w: number; h: number }[] = []
    for (let i = 0; i < n; i++) {
      const c = i % cols
      const r = Math.floor(i / cols)
      out.push({ x: g + c * (cw + g), y: g + r * (ch + g), w: cw, h: ch })
    }
    return out
  }
  return layoutEvenGrid(n, W, H, g)
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
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
    return false
  }
  const vw = v.videoWidth
  const vh = v.videoHeight
  const scale = Math.max(dw / vw, dh / vh)
  const tw = dw / scale
  const th = dh / scale
  const sx = (vw - tw) / 2
  const sy = (vh - th) / 2
  ctx.drawImage(v, sx, sy, tw, th, dx, dy, dw, dh)
  return true
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string) {
  const g0 = ctx.createLinearGradient(x, y, x + w, y + h)
  g0.addColorStop(0, '#1c1c24')
  g0.addColorStop(0.5, '#14141a')
  g0.addColorStop(1, '#0e0e12')
  ctx.fillStyle = g0
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = 'rgba(255,255,255,0.04)'
  ctx.lineWidth = 1
  for (let i = 0; i < 6; i++) {
    const t = (i + 1) / 7
    ctx.beginPath()
    ctx.moveTo(x + t * w, y)
    ctx.lineTo(x + t * w, y + h)
    ctx.stroke()
  }
  const initial = label.trim().charAt(0).toUpperCase() || '?'
  ctx.fillStyle = 'rgba(255,255,255,0.12)'
  ctx.font = `600 ${Math.min(56, Math.floor(Math.min(w, h) * 0.35))}px system-ui, -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(initial, x + w / 2, y + h / 2 - 6)
  ctx.textAlign = 'start'
  ctx.textBaseline = 'alphabetic'
}

function truncateLabel(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const ell = '…'
  if (ctx.measureText(text).width <= maxWidth) return text
  let s = text
  while (s.length > 0 && ctx.measureText(s + ell).width > maxWidth) {
    s = s.slice(0, -1)
  }
  return s.length > 0 ? s + ell : ell
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  v: HTMLVideoElement | undefined,
  label: string,
  labelBarH: number,
) {
  const r = Math.min(TILE_RADIUS, w / 4, h / 4)
  const innerH = Math.max(0, h - labelBarH)
  const barY = y + innerH

  ctx.save()
  roundRectPath(ctx, x, y, w, h, r)
  ctx.clip()

  const hasVideo = v && drawVideoCover(ctx, v, x, y, w, innerH)
  if (!hasVideo) {
    if (!v || v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || v.videoWidth === 0) {
      drawPlaceholder(ctx, x, y, w, innerH, label)
    } else {
      ctx.fillStyle = '#16161c'
      ctx.fillRect(x, y, w, innerH)
    }
  }

  const grad = ctx.createLinearGradient(x, barY, x, y + h)
  grad.addColorStop(0, 'rgba(0,0,0,0.92)')
  grad.addColorStop(1, 'rgba(0,0,0,0.78)')
  ctx.fillStyle = grad
  ctx.fillRect(x, barY, w, y + h - barY)

  ctx.restore()

  ctx.fillStyle = 'rgba(255,255,255,0.88)'
  ctx.font = '600 13px system-ui, -apple-system, sans-serif'
  const pad = 10
  const maxTextW = w - pad * 2
  const shown = truncateLabel(ctx, label, maxTextW)
  ctx.fillText(shown, x + pad, barY + labelBarH / 2 + 4)

  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 1
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r)
  ctx.stroke()
}

export class LiveBroadcastCompositor {
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private raf = 0
  private running = false
  private videoEls = new Map<string, HTMLVideoElement>()
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
      v.srcObject = null
      v.remove()
    }
    this.videoEls.clear()
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

  private ensureVideo(key: string): HTMLVideoElement {
    let v = this.videoEls.get(key)
    if (!v) {
      v = document.createElement('video')
      v.muted = true
      v.playsInline = true
      v.setAttribute('playsinline', '')
      v.setAttribute('webkit-playsinline', '')
      this.videoEls.set(key, v)
    }
    return v
  }

  private syncVideos(): void {
    const keys = new Set<string>()
    if (this.screenMain) keys.add(`screen:${this.screenMain.stream.id}`)
    for (const t of this.tiles) keys.add(t.key)

    for (const k of [...this.videoEls.keys()]) {
      if (!keys.has(k)) {
        const v = this.videoEls.get(k)
        if (v) {
          v.srcObject = null
          v.remove()
        }
        this.videoEls.delete(k)
      }
    }

    if (this.screenMain) {
      const k = `screen:${this.screenMain.stream.id}`
      const v = this.ensureVideo(k)
      if (v.srcObject !== this.screenMain.stream) {
        v.srcObject = this.screenMain.stream
        void v.play().catch(() => {})
      }
    }

    for (const t of this.tiles) {
      const v = this.ensureVideo(t.key)
      const next = t.stream
      if (v.srcObject !== next) {
        v.srcObject = next
        void v.play().catch(() => {})
      }
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
    const g = GUTTER

    // Background vignette
    const bg = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, Math.hypot(W, H) * 0.55)
    bg.addColorStop(0, '#12121a')
    bg.addColorStop(1, '#060608')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, W, H)

    if (this.screenMain) {
      const stripTilesH = STRIP_H
      const mainH = H - 3 * g - stripTilesH
      const stripY = g + mainH + g
      const sv = this.videoEls.get(`screen:${this.screenMain.stream.id}`)
      const mx = g
      const my = g
      const mw = W - 2 * g
      const mh = mainH
      const sr = Math.min(18, mw / 20, mh / 20)
      ctx.save()
      roundRectPath(ctx, mx, my, mw, mh, sr)
      ctx.clip()
      if (sv && drawVideoCover(ctx, sv, mx, my, mw, mh)) {
        /* ok */
      } else {
        const g0 = ctx.createLinearGradient(mx, my, mx + mw, my + mh)
        g0.addColorStop(0, '#1a1a22')
        g0.addColorStop(1, '#0c0c10')
        ctx.fillStyle = g0
        ctx.fillRect(mx, my, mw, mh)
        ctx.fillStyle = 'rgba(255,255,255,0.25)'
        ctx.font = '600 15px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('Screen share', mx + mw / 2, my + mh / 2)
        ctx.textAlign = 'start'
      }
      ctx.restore()
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      roundRectPath(ctx, mx + 0.5, my + 0.5, mw - 1, mh - 1, sr)
      ctx.stroke()

      const n = Math.max(1, this.tiles.length)
      const innerW = W - 2 * g
      const thumbGap = 8
      const tw = (innerW - (n - 1) * thumbGap) / n
      let i = 0
      for (const t of this.tiles) {
        const v = this.videoEls.get(t.key)
        const dx = g + i * (tw + thumbGap)
        drawTile(ctx, dx, stripY, tw, stripTilesH, v, t.label, LABEL_BAR_H)
        i++
      }
    } else {
      const n = Math.max(1, this.tiles.length)
      const boxes = layoutBroadcastTiles(n, W, H, g)
      for (let idx = 0; idx < this.tiles.length; idx++) {
        const t = this.tiles[idx]!
        const b = boxes[idx] ?? { x: g, y: g, w: W - 2 * g, h: H - 2 * g }
        const v = this.videoEls.get(t.key)
        drawTile(ctx, b.x, b.y, b.w, b.h, v, t.label, LABEL_BAR_H)
      }
    }
  }
}
