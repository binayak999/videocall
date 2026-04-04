import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom'
import type { NexivoOutletContext } from '../components/Layout'
import { NEXIVO_FEATURE_ITEMS } from '../components/NexivoFeaturesPanel'
import { NotesWorkspace } from '../components/NotesWorkspace'
import { createMeeting, errorMessage, getMeeting } from '../lib/api'
import { useAuthToken } from '../lib/useAuthToken'
import heroImg from '../assets/hero.png'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

const pillInactive =
  'text-(--nexivo-pill-inactive) hover:text-(--nexivo-pill-inactive-hover)'

export function HomePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const authed = useAuthToken() !== null
  const { selectedFeature, setSelectedFeature } = useOutletContext<NexivoOutletContext>()

  const panel = searchParams.get('panel')
  const tabParam = searchParams.get('tab')
  const tab: 'join' | 'create' = tabParam === 'join' ? 'join' : 'create'
  const showNotesPanel = panel === 'notes'

  const [code, setCode] = useState('')
  const [joinBusy, setJoinBusy] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const meetingState = useMemo(
    () => (selectedFeature ? { meetingFocus: selectedFeature } : undefined),
    [selectedFeature],
  )

  const onJoin = useCallback(async () => {
    const trimmed = code.trim()
    if (!trimmed) return
    setJoinBusy(true)
    setJoinError(null)
    try {
      await getMeeting(trimmed)
      navigate(`/m/${encodeURIComponent(trimmed)}`, { state: meetingState })
    } catch (err: unknown) {
      setJoinError(errorMessage(err))
    } finally {
      setJoinBusy(false)
    }
  }, [code, navigate, meetingState])

  const onCreate = useCallback(async () => {
    setCreateBusy(true)
    setCreateError(null)
    try {
      const r = await createMeeting({ title: title.trim() || undefined })
      navigate(`/m/${encodeURIComponent(r.meeting.code)}`, { state: meetingState })
    } catch (err: unknown) {
      setCreateError(errorMessage(err))
    } finally {
      setCreateBusy(false)
    }
  }, [navigate, meetingState, title])

  const inputClass =
    'rounded-xl border border-(--nexivo-input-border) bg-(--nexivo-input-bg) text-sm text-(--nexivo-text) outline-none transition placeholder:text-(--nexivo-placeholder) focus:border-[#f59e0b]/50'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden max-lg:min-h-0 max-lg:flex-none">
      {selectedFeature && (() => {
        const f = NEXIVO_FEATURE_ITEMS.find(x => x.label === selectedFeature)
        if (!f) return null
        return (
          <div
            className="flex shrink-0 flex-col gap-2 border-b border-(--nexivo-border-subtle) px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-5"
            style={{ background: `linear-gradient(90deg, ${f.color}14 0%, transparent 100%)` }}
          >
            <div className="flex min-w-0 items-start gap-3 sm:flex-1 sm:items-center">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                style={{ backgroundColor: `${f.color}28` }}
              >
                <svg viewBox="0 0 24 24" fill={f.color} width="18" height="18">
                  {f.icon}
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="wrap-break-word text-xs font-semibold text-(--nexivo-text)">Starting with {f.label}</p>
                <p className="text-[0.65rem] text-(--nexivo-text-muted)">Opens when you join the call.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedFeature(null)}
              className="self-start rounded-lg px-2 py-1 text-[0.65rem] font-medium text-(--nexivo-text-subtle) transition hover:bg-(--nexivo-nav-hover) hover:text-(--nexivo-text) sm:self-auto"
            >
              Clear
            </button>
          </div>
        )
      })()}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-4 pt-4 pb-3 sm:px-5">
        <Link
          to={{ pathname: '/', search: '?tab=join' }}
          className={cx(
            'rounded-full px-3 py-1.5 text-xs font-semibold transition no-underline sm:px-4 sm:text-sm',
            !showNotesPanel && tab === 'join' ? 'bg-[#f59e0b] text-black' : pillInactive,
          )}
        >
          Join
        </Link>
        <Link
          to={{ pathname: '/', search: '?tab=create' }}
          className={cx(
            'rounded-full px-3 py-1.5 text-xs font-semibold transition no-underline sm:px-4 sm:text-sm',
            !showNotesPanel && tab === 'create' ? 'bg-[#f59e0b] text-black' : pillInactive,
          )}
        >
          Create
        </Link>
        <Link
          to={{ pathname: '/', search: '?panel=notes' }}
          className={cx(
            'rounded-full px-3 py-1.5 text-xs font-semibold transition no-underline sm:px-4 sm:text-sm',
            showNotesPanel ? 'bg-[#f59e0b] text-black' : pillInactive,
          )}
        >
          Notes
        </Link>
        {authed && (
          <Link
            to="/recordings"
            className={cx(
              'rounded-full px-3 py-1.5 text-xs font-semibold transition no-underline sm:px-4 sm:text-sm',
              pillInactive,
            )}
          >
            Recordings
          </Link>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 pb-4 max-lg:flex-none max-lg:overflow-visible sm:px-5">
        {showNotesPanel ? (
          <NotesWorkspace />
        ) : tab === 'join' ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <p className="text-lg font-bold tracking-tight text-(--nexivo-text) sm:text-xl">Join a meeting</p>
            <p className="text-sm text-(--nexivo-text-secondary)">Enter the code shared by your host.</p>

            <div className="flex min-h-0 min-w-0 max-h-[min(38vh,260px)] flex-1 flex-col items-center justify-center overflow-hidden rounded-xl bg-(--nexivo-hero-tile) sm:max-h-none">
              <img
                src={heroImg}
                alt=""
                aria-hidden
                draggable={false}
                className="h-full w-full max-w-full select-none object-contain p-3 opacity-40 sm:p-4"
              />
            </div>

            <div className="mt-1 flex min-w-0 flex-col gap-2 sm:flex-row">
              <input
                value={code}
                onChange={e => setCode(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void onJoin()
                }}
                placeholder="Meeting code"
                autoComplete="off"
                className={cx('min-w-0 flex-1 px-4 py-2.5', inputClass)}
              />
              <button
                type="button"
                onClick={() => void onJoin()}
                disabled={joinBusy || !code.trim()}
                className="w-full shrink-0 rounded-xl bg-[#f59e0b] px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-[#fbbf24] disabled:opacity-30 sm:w-auto"
              >
                {joinBusy ? '…' : 'Join'}
              </button>
            </div>
            {joinError && <p className="text-xs text-red-400">{joinError}</p>}
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <p className="text-lg font-bold tracking-tight text-(--nexivo-text) sm:text-xl">Start a video call</p>
            <p className="text-sm text-(--nexivo-text-muted)">Create a room and share the code instantly.</p>

            <div className="flex min-h-0 min-w-0 max-h-[min(38vh,260px)] flex-1 flex-col items-center justify-center overflow-hidden rounded-xl bg-(--nexivo-hero-tile-2) sm:max-h-none">
              <img
                src={heroImg}
                alt=""
                aria-hidden
                draggable={false}
                className="h-full w-full max-w-full select-none object-contain p-3 opacity-70 sm:p-4"
              />
            </div>

            {authed ? (
              <div className="mt-1 flex min-w-0 flex-col gap-2">
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="Meeting title (optional)"
                  className={cx('w-full min-w-0 px-4 py-2.5', inputClass)}
                />
                {createError && <p className="text-xs text-red-400">{createError}</p>}
                <button
                  type="button"
                  onClick={() => void onCreate()}
                  disabled={createBusy}
                  className="w-full rounded-xl bg-[#f59e0b] py-2.5 text-sm font-semibold text-black transition hover:bg-[#fbbf24] disabled:opacity-30"
                >
                  {createBusy ? 'Creating…' : 'Create meeting'}
                </button>
              </div>
            ) : (
              <div className="mt-1 flex min-w-0 flex-col gap-2 sm:flex-row">
                <Link
                  to="/login"
                  className="w-full flex-1 rounded-xl border border-(--nexivo-input-border) bg-(--nexivo-muted-surface) py-2.5 text-center text-sm font-medium text-(--nexivo-text-muted) transition hover:bg-(--nexivo-nav-hover) hover:text-(--nexivo-text-secondary) sm:w-auto"
                >
                  Sign in
                </Link>
                <Link
                  to="/register"
                  className="w-full flex-1 rounded-xl bg-[#f59e0b] py-2.5 text-center text-sm font-semibold text-black transition hover:bg-[#fbbf24] sm:w-auto"
                >
                  Register
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
