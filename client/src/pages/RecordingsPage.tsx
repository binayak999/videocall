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
    <div>
      <h1 className="mb-2 text-2xl font-bold text-(--text-h)">Your recordings</h1>
      <p className="mb-8 text-sm text-(--text)">Videos from meetings you hosted and saved after recording.</p>

      {busy && <p className="text-sm text-(--text)">Loading…</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {!busy && !err && items.length === 0 && (
        <p className="rounded-2xl border border-(--border) bg-(--social-bg) px-5 py-10 text-center text-sm text-(--text)">
          No recordings yet. While hosting a call, open settings (gear) and use Start recording, then Stop and upload.
        </p>
      )}

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(rec => (
          <article
            key={rec.id}
            className="overflow-hidden rounded-2xl border border-(--border) bg-(--code-bg) shadow-sm"
          >
            <div className="aspect-video bg-black">
              <RecordingVideoPlayer src={rec.playbackUrl} theme="app" className="h-full min-h-[140px]" />
            </div>
            <div className="border-t border-(--border) p-4">
              <h2 className="text-sm font-semibold text-(--text-h)">
                {rec.meetingTitle?.trim() || `Meeting ${rec.meetingCode}`}
              </h2>
              <p className="mt-1 font-mono text-xs text-(--text)">{rec.meetingCode}</p>
              <p className="mt-2 text-xs text-(--text)">
                {new Date(rec.createdAt).toLocaleString()}
                {' · '}
                {formatDur(rec.durationSec)}
                {' · '}
                {formatBytes(rec.sizeBytes)}
              </p>
              <a
                href={rec.playbackUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block text-xs font-semibold text-(--text-h) underline underline-offset-2"
              >
                Open in new tab
              </a>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
