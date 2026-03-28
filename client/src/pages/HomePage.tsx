import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { RecordingVideoPlayer } from '../components/RecordingVideoPlayer'
import { createMeeting, errorMessage, getMeeting, listMyRecordings } from '../lib/api'
import type { MeetingRecordingItem } from '../lib/types'
import { useAuthToken } from '../lib/useAuthToken'
import { clearToken } from '../lib/auth'
import heroImg from '../assets/hero.png'

function useLgUp() {
  const [lg, setLg] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const sync = () => setLg(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return lg
}

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

export function HomePage() {
  const navigate = useNavigate()
  const authed = useAuthToken() !== null

  const [code, setCode] = useState('')
  const [joinBusy, setJoinBusy] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [tab, setTab] = useState<'join' | 'create'>('create')
  const [sidebarKey, setSidebarKey] = useState<'home' | 'join' | 'create' | 'recordings'>('create')
  const [recordings, setRecordings] = useState<MeetingRecordingItem[]>([])
  const [recordingsBusy, setRecordingsBusy] = useState(false)
  const [recordingsErr, setRecordingsErr] = useState<string | null>(null)
  const [leftHovered, setLeftHovered] = useState(false)
  const [rightHovered, setRightHovered] = useState(false)
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null)
  const lgUp = useLgUp()

  const onJoin = async () => {
    const trimmed = code.trim()
    if (!trimmed) return
    setJoinBusy(true)
    setJoinError(null)
    try {
      await getMeeting(trimmed)
      navigate(`/m/${encodeURIComponent(trimmed)}`, {
        state: selectedFeature ? { meetingFocus: selectedFeature } : undefined,
      })
    } catch (err: unknown) {
      setJoinError(errorMessage(err))
    } finally {
      setJoinBusy(false)
    }
  }

  const onCreate = async () => {
    setCreateBusy(true)
    setCreateError(null)
    try {
      const r = await createMeeting({ title: title.trim() || undefined })
      navigate(`/m/${encodeURIComponent(r.meeting.code)}`, {
        state: selectedFeature ? { meetingFocus: selectedFeature } : undefined,
      })
    } catch (err: unknown) {
      setCreateError(errorMessage(err))
    } finally {
      setCreateBusy(false)
    }
  }

  const showRecordingsPanel = sidebarKey === 'recordings'

  useEffect(() => {
    if (!authed && sidebarKey === 'recordings') setSidebarKey('create')
  }, [authed, sidebarKey])

  useEffect(() => {
    if (!showRecordingsPanel || !authed) return
    let cancelled = false
    void (async () => {
      setRecordingsBusy(true)
      setRecordingsErr(null)
      try {
        const r = await listMyRecordings()
        if (!cancelled) setRecordings(r.recordings)
      } catch (e: unknown) {
        if (!cancelled) setRecordingsErr(errorMessage(e))
      } finally {
        if (!cancelled) setRecordingsBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showRecordingsPanel, authed])

  const navItems: Array<{
    label: string
    key: 'home' | 'join' | 'create' | 'recordings' | 'login' | 'register'
    icon: ReactNode
  }> = [
    {
      label: 'Home',
      key: 'home',
      icon: (
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
          <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
        </svg>
      ),
    },
    {
      label: 'Join Meeting',
      key: 'join',
      icon: (
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
          <path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z" />
        </svg>
      ),
    },
    {
      label: 'Create Meeting',
      key: 'create',
      icon: (
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
          <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
        </svg>
      ),
    },
    ...(authed
      ? [
          {
            label: 'My Recordings',
            key: 'recordings' as const,
            icon: (
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
              </svg>
            ),
          },
        ]
      : []),
    ...(!authed
      ? [
          {
            label: 'Login',
            key: 'login' as const,
            icon: (
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
              </svg>
            ),
          },
          {
            label: 'Register',
            key: 'register' as const,
            icon: (
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
              </svg>
            ),
          },
        ]
      : []),
  ]

  const features = [
    {
      label: 'Video Call',
      detail: 'HD peer-to-peer video',
      color: '#3b82f6',
      icon: <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />,
    },
    {
      label: 'Meeting Room',
      detail: 'Multi-participant rooms',
      color: '#f59e0b',
      icon: <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />,
    },
    {
      label: 'Whiteboard',
      detail: 'Real-time collaborative canvas',
      color: '#a855f7',
      icon: <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />,
    },
    {
      label: 'Chat',
      detail: 'In-meeting messaging',
      color: '#22c55e',
      icon: <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" />,
    },
    {
      label: 'Note Taker',
      detail: 'AI-assisted meeting notes',
      color: '#f43f5e',
      icon: <path d="M3 18h12v-2H3v2zm0-5h12v-2H3v2zm0-7v2h12V6H3zm13 9.17V12h-2v6.17l-1.59-1.59L11 18l3.5 3.5L18 18l-1.41-1.41L15 18.17zM20 6h-2V4h-2v2h-2v2h2v2h2V8h2V6z" />,
    },
    {
      label: 'Screen Share',
      detail: 'Share your display live',
      color: '#06b6d4',
      icon: <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z" />,
    },
  ]

  const leftPanelStyle = lgUp
    ? {
        height: '60%' as const,
        transform: `perspective(900px) rotateY(${leftHovered ? 0 : 14}deg)`,
        transition: 'transform 0.35s ease',
      }
    : { transition: 'transform 0.35s ease' as const }

  const rightPanelStyle = lgUp
    ? {
        height: '60%' as const,
        transform: `perspective(900px) rotateY(${rightHovered ? 0 : -14}deg)`,
        transition: 'transform 0.35s ease',
      }
    : { transition: 'transform 0.35s ease' as const }

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden"
      style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >

      {/* ── BACKGROUND IMAGE ── */}
      <img
        src="/image.png"
        alt=""
        aria-hidden
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
      />

      {/* ── HEADER ── */}
      <div className="relative z-20 flex shrink-0 items-center justify-between px-4 py-3 sm:px-8 sm:py-4 lg:px-10">
        <img src="/nexivo_logo.svg" alt="Nexivo" className="h-10 w-auto sm:h-14" draggable={false} />
        <div className="flex items-center gap-2">
          {authed ? (
            <span className="rounded-full border border-white/20 bg-black/30 px-3 py-1 text-xs text-white/60 backdrop-blur-sm">
              Signed in
            </span>
          ) : (
            <span className="rounded-full border border-white/20 bg-black/30 px-3 py-1 text-xs text-white/50 backdrop-blur-sm">
              Guest
            </span>
          )}
        </div>
      </div>

      {/* ── THREE-PANEL LAYOUT (stacked + scrollable below lg) ── */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 pt-1 sm:px-4 lg:flex-row lg:items-center lg:justify-center lg:gap-6 lg:overflow-hidden lg:pt-0 max-w-7xl mx-auto">

        {/* ── LEFT: Navigation ── */}
        <div
          className="flex w-full shrink-0 flex-col rounded-[22px] bg-[#1c1c1e]/90 p-5 shadow-none backdrop-blur-xl max-lg:max-h-[min(38vh,300px)] max-lg:overflow-y-auto lg:h-[60%] lg:w-64 lg:shrink-0"
          style={leftPanelStyle}
          onMouseEnter={() => setLeftHovered(true)}
          onMouseLeave={() => setLeftHovered(false)}
        >
          <p className="mb-4 px-1 text-[0.6rem] font-bold uppercase tracking-[0.2em] text-white/30">
            Navigation
          </p>
          <div className="flex flex-col gap-0.5">
            {navItems.map(({ label, key: navKey, icon }) => {
              const active = sidebarKey === navKey
              const to =
                navKey === 'login'
                  ? '/login'
                  : navKey === 'register'
                    ? '/register'
                    : '/'
              const handleClick =
                navKey === 'home'
                  ? () => {
                      setSidebarKey('home')
                      setTab('join')
                    }
                  : navKey === 'join'
                    ? () => {
                        setSidebarKey('join')
                        setTab('join')
                      }
                    : navKey === 'create'
                      ? () => {
                          setSidebarKey('create')
                          setTab('create')
                        }
                      : navKey === 'recordings'
                        ? (e: MouseEvent) => {
                            e.preventDefault()
                            setSidebarKey('recordings')
                          }
                        : undefined
              return (
                <Link
                  key={navKey}
                  to={to}
                  onClick={handleClick}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition ${
                    active
                      ? 'bg-[#f59e0b] text-black'
                      : 'text-white/60 hover:bg-white/[0.07] hover:text-white/90'
                  }`}
                >
                  <span className={active ? 'text-black' : 'text-white/50'}>{icon}</span>
                  <span className="flex-1 text-sm font-medium">{label}</span>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" className={active ? 'text-black/50' : 'text-white/20'}>
                    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                  </svg>
                </Link>
              )
            })}
          </div>

          {authed && (
            <button
              type="button"
              onClick={() => { clearToken(); navigate('/') }}
              className="mt-auto flex items-center gap-3 rounded-xl px-3 py-2.5 text-red-400 transition hover:bg-red-500/10"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" />
              </svg>
              <span className="flex-1 text-sm font-medium">Logout</span>
            </button>
          )}
        </div>

        {/* ── CENTER: Main ── */}
        <div
          className="z-10 flex min-h-[min(52vh,440px)] w-full max-w-[680px] flex-1 flex-col overflow-hidden rounded-[22px] bg-[#1c1c1e]/90 shadow-none backdrop-blur-xl lg:h-[72%] lg:min-h-0 lg:shrink-0 lg:w-[680px] lg:max-w-none"
        >

          {selectedFeature && (() => {
            const f = features.find(x => x.label === selectedFeature)
            if (!f) return null
            return (
              <div
                className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-5 py-3"
                style={{ background: `linear-gradient(90deg, ${f.color}14 0%, transparent 100%)` }}
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                  style={{ backgroundColor: `${f.color}28` }}
                >
                  <svg viewBox="0 0 24 24" fill={f.color} width="18" height="18">{f.icon}</svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-white/90">Starting with {f.label}</p>
                  <p className="text-[0.65rem] text-white/45">Opens when you join the call.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedFeature(null)}
                  className="shrink-0 rounded-lg px-2 py-1 text-[0.65rem] font-medium text-white/40 transition hover:bg-white/[0.06] hover:text-white/70"
                >
                  Clear
                </button>
              </div>
            )
          })()}

          <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-3">
            <button
              type="button"
              onClick={() => {
                setSidebarKey('join')
                setTab('join')
              }}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                !showRecordingsPanel && tab === 'join'
                  ? 'bg-[#f59e0b] text-black'
                  : 'text-white/50 hover:text-white/70'
              }`}
            >
              Join
            </button>
            <button
              type="button"
              onClick={() => {
                setSidebarKey('create')
                setTab('create')
              }}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                !showRecordingsPanel && tab === 'create'
                  ? 'bg-[#f59e0b] text-black'
                  : 'text-white/50 hover:text-white/70'
              }`}
            >
              Create
            </button>
            {authed && (
              <button
                type="button"
                onClick={() => setSidebarKey('recordings')}
                className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  showRecordingsPanel
                    ? 'bg-[#f59e0b] text-black'
                    : 'text-white/50 hover:text-white/70'
                }`}
              >
                Recordings
              </button>
            )}
          </div>

          <div className="flex flex-1 flex-col px-5 pb-4 overflow-hidden min-h-0">
            {showRecordingsPanel ? (
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
                <div className="shrink-0">
                  <h2 className="text-xl font-bold tracking-tight text-white/90">My recordings</h2>
                  <p className="text-sm text-white/80">Meetings you hosted and saved after recording.</p>
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {recordingsBusy && (
                    <p className="text-sm text-white/55">Loading…</p>
                  )}
                  {recordingsErr && <p className="text-sm text-red-400">{recordingsErr}</p>}
                  {!recordingsBusy && !recordingsErr && recordings.length === 0 && (
                    <p className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-8 text-center text-sm leading-relaxed text-white/60">
                      No recordings yet. While hosting, use Start recording in settings, then stop and upload.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3 pb-1">
                    {recordings.map(rec => (
                      <article
                        key={rec.id}
                        className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.04] shadow-sm transition hover:border-white/15 hover:bg-white/[0.06]"
                      >
                        <div className="relative aspect-video bg-black">
                          <RecordingVideoPlayer variant="tile" src={rec.playbackUrl} theme="nexivo" className="h-full min-h-[120px]" />
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col border-t border-white/[0.06] p-2.5">
                          <h3 className="line-clamp-2 text-xs font-semibold leading-snug text-white/90">
                            {rec.meetingTitle?.trim() || `Meeting ${rec.meetingCode}`}
                          </h3>
                          <p className="mt-1 truncate font-mono text-[0.6rem] text-white/40">{rec.meetingCode}</p>
                          <p className="mt-1 line-clamp-2 text-[0.6rem] leading-relaxed text-white/40">
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
                            className="mt-auto pt-2 text-[0.6rem] font-semibold text-[#fbbf24] underline underline-offset-2"
                          >
                            Open
                          </a>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            ) : tab === 'join' ? (
              <div className="flex flex-1 flex-col gap-2 min-h-0">
                <p className="text-xl font-bold tracking-tight text-white/90">Join a meeting</p>
                <p className="text-sm text-white/80">Enter the code shared by your host.</p>

                {/* hero image — fixed height */}
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-white/[0.03]">
                  <img src={heroImg} alt="" aria-hidden draggable={false} className="h-full w-auto max-w-full select-none object-contain opacity-40 p-4" />
                </div>

                <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                  <input
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void onJoin() }}
                    placeholder="Meeting code"
                    autoComplete="off"
                    className="min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-white/[0.06] px-4 py-2.5 text-sm text-white/90 placeholder-white/20 outline-none transition focus:border-[#f59e0b]/50 focus:bg-white/[0.09]"
                  />
                  <button
                    type="button"
                    onClick={() => void onJoin()}
                    disabled={joinBusy || !code.trim()}
                    className="shrink-0 rounded-xl bg-[#f59e0b] px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-[#fbbf24] disabled:opacity-30 sm:w-auto"
                  >
                    {joinBusy ? '…' : 'Join'}
                  </button>
                </div>
                {joinError && <p className="text-xs text-red-400">{joinError}</p>}
              </div>
            ) : (
              <div className="flex flex-1 flex-col gap-2 min-h-0">
                <p className="text-xl font-bold tracking-tight text-white/90">Start a video call</p>
                <p className="text-sm text-white/35">Create a room and share the code instantly.</p>

                {/* hero image — fixed height */}
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-white/[0.04]">
                  <img src={heroImg} alt="" aria-hidden draggable={false} className="h-full w-auto max-w-full select-none object-contain opacity-70 p-4" />
                </div>

                {authed ? (
                  <div className="flex flex-col gap-2 mt-1">
                    <input
                      value={title}
                      onChange={e => setTitle(e.target.value)}
                      placeholder="Meeting title (optional)"
                      className="w-full rounded-xl border border-white/[0.08] bg-white/[0.06] px-4 py-2.5 text-sm text-white/90 placeholder-white/20 outline-none transition focus:border-[#f59e0b]/50"
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
                  <div className="flex gap-2 mt-1">
                    <Link to="/login" className="flex-1 rounded-xl border border-white/[0.1] bg-white/[0.06] py-2.5 text-center text-sm font-medium text-white/60 transition hover:bg-white/[0.1] hover:text-white/80">
                      Sign in
                    </Link>
                    <Link to="/register" className="flex-1 rounded-xl bg-[#f59e0b] py-2.5 text-center text-sm font-semibold text-black transition hover:bg-[#fbbf24]">
                      Register
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: Features ── */}
        <div
          className="flex w-full shrink-0 flex-col rounded-[22px] bg-[#1c1c1e]/90 p-5 shadow-none backdrop-blur-xl max-lg:max-h-[min(42vh,340px)] max-lg:overflow-y-auto lg:h-[60%] lg:w-64 lg:shrink-0"
          style={rightPanelStyle}
          onMouseEnter={() => setRightHovered(true)}
          onMouseLeave={() => setRightHovered(false)}
        >
          <p className="mb-3 px-1 text-[0.6rem] font-bold uppercase tracking-[0.2em] text-white/30">
            Features
          </p>
          <div className="flex flex-col gap-0.5 overflow-y-auto">
            {features.map(({ label, detail, color, icon }) => {
              const active = selectedFeature === label
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setSelectedFeature(active ? null : label)}
                  className="flex items-center gap-3 rounded-xl px-2 py-2 transition text-left w-full"
                  style={{ backgroundColor: active ? `${color}18` : undefined }}
                >
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition"
                    style={{ backgroundColor: active ? `${color}35` : `${color}20` }}
                  >
                    <svg viewBox="0 0 24 24" fill={color} width="16" height="16">{icon}</svg>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold transition" style={{ color: active ? color : 'rgba(255,255,255,0.75)' }}>{label}</p>
                    <p className="truncate text-[0.6rem] text-white/50">{detail}</p>
                  </div>
                  {active && (
                    <div className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  )}
                </button>
              )
            })}
          </div>
        </div>

      </div>
    </div>
  )
}
