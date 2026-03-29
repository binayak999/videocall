import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RecordingVideoPlayer } from '../components/RecordingVideoPlayer'
import { errorMessage, listMyRecordings } from '../lib/api'
import { getToken } from '../lib/auth'
import type { MeetingRecordingItem } from '../lib/types'

function formatBytes(n: number | null) {
  if (n == null || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDur(sec: number | null) {
  if (sec == null || sec < 0) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function RecordingsPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<MeetingRecordingItem[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!getToken()) {
      navigate('/login', { replace: true })
      return
    }
    let cancelled = false
    void (async () => {
      setBusy(true)
      setErr(null)
      try {
        const r = await listMyRecordings()
        if (!cancelled) setItems(r.recordings)
      } catch (e: unknown) {
        if (!cancelled) setErr(errorMessage(e))
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [navigate])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-5 text-left">
      <div className="shrink-0">
        <h1 className="text-xl font-bold tracking-tight text-(--nexivo-text)">My recordings</h1>
        <p className="mt-1 text-sm text-(--nexivo-text-secondary)">Meetings you hosted and saved after recording.</p>
      </div>

      {busy && <p className="text-sm text-(--nexivo-text-muted)">Loading…</p>}
      {err && <p className="text-sm text-red-400">{err}</p>}

      {!busy && !err && items.length === 0 && (
        <p className="rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) px-4 py-8 text-center text-sm leading-relaxed text-(--nexivo-text-muted)">
          No recordings yet. While hosting, use Start recording in settings, then stop and upload.
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto overscroll-contain pb-1 sm:grid-cols-2">
        {items.map(rec => (
          <article
            key={rec.id}
            className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-(--nexivo-border-subtle) bg-(--nexivo-panel) shadow-sm ring-1 ring-black/5 transition hover:border-(--nexivo-border) hover:shadow-md dark:ring-white/5"
          >
            <div className="relative aspect-video overflow-hidden bg-black">
              <RecordingVideoPlayer
                variant="tile"
                src={rec.playbackUrl}
                theme="nexivo"
                className="h-full min-h-[140px] rounded-none"
              />
             
            </div>
            <div className="flex min-h-[120px] flex-1 flex-col gap-2 p-3.5">
              <div className="min-w-0">
                <h2 className="line-clamp-2 text-sm font-semibold leading-snug text-(--nexivo-text)">
                  {rec.meetingTitle?.trim() || `Meeting ${rec.meetingCode}`}
                </h2>
                <p className="mt-1 truncate font-mono text-[0.65rem] tracking-wide text-(--nexivo-text-subtle)">{rec.meetingCode}</p>
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1.5">
                <span className="rounded-md bg-(--nexivo-muted-surface) px-2 py-0.5 text-[0.65rem] tabular-nums text-(--nexivo-text-secondary)">
                  {new Date(rec.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
                <span className="rounded-md bg-(--nexivo-muted-surface) px-2 py-0.5 text-[0.65rem] tabular-nums text-(--nexivo-text-secondary)">
                  {formatDur(rec.durationSec)}
                </span>
                <span className="rounded-md bg-(--nexivo-muted-surface) px-2 py-0.5 text-[0.65rem] tabular-nums text-(--nexivo-text-secondary)">
                  {formatBytes(rec.sizeBytes)}
                </span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
