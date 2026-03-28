import { createPortal } from 'react-dom'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

function formatClock(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export type RecordingVideoPlayerTheme = 'nexivo' | 'app'

type BaseProps = {
  src: string
  theme?: RecordingVideoPlayerTheme
  className?: string
}

export type RecordingVideoPlayerProps = BaseProps & {
  /**
   * `tile` — grid cards: preview opens a modal with the full player.
   * `inline` — full player in the card.
   */
  variant?: 'inline' | 'tile'
}

function usePlayerFullscreen(wrapRef: RefObject<HTMLDivElement | null>) {
  const [isFs, setIsFs] = useState(false)
  useEffect(() => {
    const sync = () => {
      const el = wrapRef.current
      setIsFs(!!el && document.fullscreenElement === el)
    }
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [wrapRef])
  return isFs
}

function RecordingPlayerInline({ src, theme = 'nexivo', className }: BaseProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [hover, setHover] = useState(false)
  const [dragging, setDragging] = useState(false)

  const inBrowserFullscreen = usePlayerFullscreen(wrapRef)

  const nexivo = theme === 'nexivo'
  const showChrome = !playing || hover || dragging || inBrowserFullscreen

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }, [])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onTime = () => setCurrent(v.currentTime)
    const onMeta = () => setDuration(Number.isFinite(v.duration) ? v.duration : 0)
    const onEnded = () => setPlaying(false)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('ended', onEnded)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('ended', onEnded)
    }
  }, [src])

  useEffect(() => {
    const v = videoRef.current
    if (v) v.muted = muted
  }, [muted])

  function seekFromClientX(clientX: number, el: HTMLDivElement) {
    const v = videoRef.current
    const d = duration
    if (!v || !d) return
    const r = el.getBoundingClientRect()
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    v.currentTime = t * d
    setCurrent(v.currentTime)
  }

  async function toggleFullscreen() {
    const el = wrapRef.current
    if (!el) return
    try {
      if (document.fullscreenElement === el) await document.exitFullscreen()
      else await el.requestFullscreen()
    } catch {
      /* ignore */
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const v = videoRef.current
    if (!v) return
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault()
      togglePlay()
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault()
      setMuted(m => !m)
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault()
      void toggleFullscreen()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      v.currentTime = Math.max(0, v.currentTime - 5)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      v.currentTime = Math.min(duration || v.duration, v.currentTime + 5)
    }
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0

  return (
    <div
      ref={wrapRef}
      role="region"
      aria-label="Recording playback"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false)
        setDragging(false)
      }}
      className={cx(
        'relative isolate h-full w-full overflow-hidden rounded-[inherit] bg-black outline-none focus-visible:ring-2',
        nexivo ? 'focus-visible:ring-[#f59e0b]/60' : 'focus-visible:ring-(--accent-border)',
        className,
      )}
    >
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="metadata"
        className="h-full w-full scale-x-[-1] object-contain"
        onClick={() => togglePlay()}
      />

      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={e => {
          e.stopPropagation()
          togglePlay()
        }}
        className={cx(
          'absolute left-1/2 top-1/2 z-1 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border transition',
          showChrome ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
          nexivo
            ? 'border-white/25 bg-black/55 text-[#fbbf24] backdrop-blur-sm hover:bg-black/70'
            : 'border-(--border) bg-(--bg)/90 text-(--accent) shadow-md backdrop-blur-sm hover:bg-(--social-bg)',
        )}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28" aria-hidden>
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28" aria-hidden className="ml-0.5">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      <div
        className={cx(
          'absolute inset-x-0 bottom-0 z-2 bg-linear-to-t from-black/85 via-black/50 to-transparent px-2.5 pb-2 pt-8 transition-opacity duration-200',
          showChrome ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      >
        <div
          role="slider"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          tabIndex={0}
          className={cx(
            'group/track relative mb-2 h-1.5 w-full cursor-pointer rounded-full touch-none',
            nexivo ? 'bg-white/20' : 'bg-(--border)',
          )}
          onPointerDown={e => {
            e.currentTarget.setPointerCapture(e.pointerId)
            setDragging(true)
            seekFromClientX(e.clientX, e.currentTarget)
          }}
          onPointerMove={e => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
            seekFromClientX(e.clientX, e.currentTarget)
          }}
          onPointerUp={e => {
            e.currentTarget.releasePointerCapture(e.pointerId)
            setDragging(false)
          }}
          onKeyDown={e => {
            const v = videoRef.current
            const d = duration
            if (!v || !d) return
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              v.currentTime = Math.max(0, v.currentTime - 3)
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              v.currentTime = Math.min(d, v.currentTime + 3)
            }
          }}
        >
          <div
            className={cx('absolute inset-y-0 left-0 rounded-full', nexivo ? 'bg-[#f59e0b]' : 'bg-(--accent)')}
            style={{ width: `${pct}%` }}
          />
          <div
            className={cx(
              'absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full opacity-0 shadow transition group-hover/track:opacity-100',
              nexivo ? 'bg-[#fbbf24]' : 'bg-(--text-h)',
            )}
            style={{ left: `calc(${pct}% - 6px)` }}
          />
        </div>

        <div className="relative flex items-center gap-1.5">
          <button
            type="button"
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={() => togglePlay()}
            className={cx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition',
              nexivo ? 'text-white/85 hover:bg-white/12 hover:text-[#fbbf24]' : 'text-(--text-h) hover:bg-(--social-bg)',
            )}
          >
            {playing ? (
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" className="ml-px">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <span
            className={cx(
              'min-w-22 shrink-0 tabular-nums text-[0.65rem] font-medium',
              nexivo ? 'text-white/70' : 'text-(--text)',
            )}
          >
            {formatClock(current)} / {formatClock(duration)}
          </span>

          <div className="min-w-0 flex-1" />

          <button
            type="button"
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={() => setMuted(m => !m)}
            className={cx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition',
              nexivo ? 'text-white/85 hover:bg-white/12 hover:text-[#fbbf24]' : 'text-(--text-h) hover:bg-(--social-bg)',
            )}
          >
            {muted ? (
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            aria-label="Fullscreen"
            onClick={() => void toggleFullscreen()}
            className={cx(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition',
              nexivo ? 'text-white/85 hover:bg-white/12 hover:text-[#fbbf24]' : 'text-(--text-h) hover:bg-(--social-bg)',
            )}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

function RecordingTileOpenView({
  src,
  theme = 'nexivo',
  className,
  onOpen,
}: BaseProps & { onOpen: () => void }) {
  const nexivo = theme === 'nexivo'
  const videoRef = useRef<HTMLVideoElement>(null)

  return (
    <div
      className={cx(
        'relative h-full w-full min-h-[100px] cursor-pointer overflow-hidden rounded-[inherit] bg-black outline-none focus-visible:ring-2',
        nexivo ? 'focus-visible:ring-[#f59e0b]/60' : 'focus-visible:ring-(--accent-border)',
        className,
      )}
      role="button"
      tabIndex={0}
      aria-label="Play recording"
      onClick={() => onOpen()}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        preload="metadata"
        className="pointer-events-none h-full w-full scale-x-[-1] object-contain"
      />
      <div
        className={cx(
          'pointer-events-none absolute inset-0 bg-linear-to-t from-black/70 via-transparent to-black/25',
        )}
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span
          className={cx(
            'flex h-12 w-12 items-center justify-center rounded-full border shadow-lg',
            nexivo
              ? 'border-white/30 bg-black/50 text-[#fbbf24] backdrop-blur-sm'
              : 'border-(--border) bg-(--code-bg)/90 text-(--accent) backdrop-blur-sm',
          )}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26" aria-hidden className="ml-0.5">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </div>
    </div>
  )
}

export function RecordingVideoPlayer({
  src,
  theme = 'nexivo',
  className,
  variant = 'inline',
}: RecordingVideoPlayerProps) {
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    if (!modalOpen) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setModalOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [modalOpen])

  if (variant === 'tile') {
    const nexivo = theme === 'nexivo'
    return (
      <>
        <RecordingTileOpenView src={src} theme={theme} className={className} onOpen={() => setModalOpen(true)} />
        {modalOpen &&
          createPortal(
            <div
              className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-3 backdrop-blur-md sm:p-6"
              role="dialog"
              aria-modal="true"
              aria-labelledby="recording-modal-title"
              onClick={() => setModalOpen(false)}
            >
              <div
                className={cx(
                  'relative w-full max-w-5xl max-h-[min(92dvh,920px)] overflow-hidden rounded-2xl border shadow-2xl',
                  nexivo ? 'border-white/15 bg-[#1c1c1e]' : 'border-(--border) bg-(--code-bg) shadow-(--shadow)',
                )}
                onClick={e => e.stopPropagation()}
              >
                <h2 id="recording-modal-title" className="sr-only">
                  Recording playback
                </h2>
                <button
                  type="button"
                  className={cx(
                    'absolute right-2 top-2 z-20 flex h-9 w-9 items-center justify-center rounded-full border text-lg font-light transition',
                    nexivo
                      ? 'border-white/20 bg-black/50 text-white hover:bg-black/70'
                      : 'border-(--border) bg-(--bg) text-(--text-h) hover:bg-(--social-bg)',
                  )}
                  aria-label="Close"
                  onClick={() => setModalOpen(false)}
                >
                  ×
                </button>
                <div className="p-2 pt-12 sm:p-4 sm:pt-14">
                  <RecordingPlayerInline src={src} theme={theme} className="aspect-video min-h-[200px] rounded-xl" />
                </div>
              </div>
            </div>,
            document.body,
          )}
      </>
    )
  }

  return <RecordingPlayerInline src={src} theme={theme} className={className} />
}
