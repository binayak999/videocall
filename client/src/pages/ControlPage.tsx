import { useEffect, useMemo, useState } from 'react'
import { Navigate, useOutletContext } from 'react-router-dom'
import type { NexivoOutletContext } from '../components/Layout'
import { errorMessage, patchSystemRtcMode } from '../lib/api'
import {
  defaultRtcModeFromEnv,
  readRtcModeFromStorage,
  resolvedRtcMode,
  type RtcMode,
  writeRtcModeToStorage,
} from '../lib/rtcMode'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function ControlPage() {
  const {
    systemRtcLoaded,
    systemRtcMode,
    systemRtcPersisted,
    canControlRtcMode,
    refreshSystemRtcMode,
  } = useOutletContext<NexivoOutletContext>()
  const envDefault = useMemo(() => defaultRtcModeFromEnv(), [])
  const [stored, setStored] = useState<RtcMode | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setStored(readRtcModeFromStorage())
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'bandr:rtcMode') setStored(readRtcModeFromStorage())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const globalMode = systemRtcMode ?? envDefault
  const effectivePick = systemRtcMode ?? envDefault

  const applySystemMode = async (mode: RtcMode) => {
    setErr(null)
    setBusy(true)
    try {
      await patchSystemRtcMode(mode)
      await refreshSystemRtcMode()
    } catch (e: unknown) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!systemRtcLoaded) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-12 text-sm text-(--nexivo-text-muted)">
        Loading…
      </div>
    )
  }

  if (!canControlRtcMode) {
    return <Navigate to="/" replace />
  }

  const card =
    'rounded-2xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) p-5 sm:p-6 shadow-sm'

  const optionBase =
    'flex flex-col gap-1 rounded-xl border px-4 py-3.5 text-left transition sm:min-h-[5.5rem]'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
      <div className="mx-auto w-full max-w-lg px-4 py-6 sm:px-5 sm:py-8">
        <header className="mb-6 min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-(--nexivo-text) sm:text-2xl">Control</h1>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-(--nexivo-text-muted)">
            Set the organization-wide default (mesh or LiveKit). Saved in the database for all users; individual browsers or
            meeting hosts can still override for a session.
          </p>
        </header>

        <section className={card}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-(--nexivo-border-subtle) pb-4">
            <div>
              <h2 className="text-sm font-semibold text-(--nexivo-text)">Global default</h2>
              <p className="mt-1 font-mono text-lg font-semibold tracking-tight text-(--nexivo-text)">{globalMode}</p>
            </div>
            <span
              className={cx(
                'shrink-0 rounded-full px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider',
                systemRtcPersisted
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-(--nexivo-input-bg) text-(--nexivo-text-muted)',
              )}
              title={
                systemRtcPersisted
                  ? 'Value is stored in PostgreSQL (SystemSetting).'
                  : 'No DB row yet; using server environment until you save.'
              }
            >
              {systemRtcPersisted ? 'Saved in database' : 'Env default only'}
            </span>
          </div>

          {systemRtcMode === null ? (
            <p className="mt-4 text-sm text-(--nexivo-text-muted)">
              API unreachable — showing build default <span className="font-mono font-semibold">{envDefault}</span>. Fix the API
              connection, then refresh.
            </p>
          ) : (
            <div className="mt-5 space-y-3">
              <p className="text-sm text-(--nexivo-text-secondary)">Choose transport — writes to the database for all users.</p>
              {err ? <p className="text-sm text-red-400">{err}</p> : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={busy || effectivePick === 'mesh'}
                  onClick={() => void applySystemMode('mesh')}
                  className={cx(
                    optionBase,
                    effectivePick === 'mesh'
                      ? 'border-[#f59e0b] bg-[#f59e0b]/10 ring-2 ring-[#f59e0b]/30'
                      : 'border-(--nexivo-border-subtle) bg-(--nexivo-input-bg) hover:border-(--nexivo-border)',
                    busy && effectivePick !== 'mesh' ? 'opacity-60' : '',
                  )}
                >
                  <span className="text-sm font-semibold text-(--nexivo-text)">Mesh</span>
                  <span className="text-xs leading-snug text-(--nexivo-text-muted)">Peer-to-peer via signaling. Simple, smaller groups.</span>
                </button>
                <button
                  type="button"
                  disabled={busy || effectivePick === 'livekit'}
                  onClick={() => void applySystemMode('livekit')}
                  className={cx(
                    optionBase,
                    effectivePick === 'livekit'
                      ? 'border-[#f59e0b] bg-[#f59e0b]/10 ring-2 ring-[#f59e0b]/30'
                      : 'border-(--nexivo-border-subtle) bg-(--nexivo-input-bg) hover:border-(--nexivo-border)',
                    busy && effectivePick !== 'livekit' ? 'opacity-60' : '',
                  )}
                >
                  <span className="text-sm font-semibold text-(--nexivo-text)">LiveKit</span>
                  <span className="text-xs leading-snug text-(--nexivo-text-muted)">SFU — needs LiveKit server and API credentials.</span>
                </button>
              </div>
              {busy ? <p className="text-xs text-(--nexivo-text-muted)">Saving to database…</p> : null}
            </div>
          )}
        </section>

        <section className={cx('mt-5', card)}>
          <h2 className="text-sm font-semibold text-(--nexivo-text)">This browser</h2>
          <p className="mt-2 text-sm leading-relaxed text-(--nexivo-text-muted)">
            Effective mode:{' '}
            <span className="font-mono font-semibold text-(--nexivo-text)">{resolvedRtcMode()}</span>
            {stored ? (
              <span> — includes a local value (preference or last host sync).</span>
            ) : (
              <span> — follows the global default above.</span>
            )}
          </p>
          <div className="mt-4 flex flex-col gap-3 border-t border-(--nexivo-border-subtle) pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-(--nexivo-text-muted)">
              Clear local storage so the global default applies again (reloads the page).
            </p>
            <button
              type="button"
              disabled={!stored}
              className="h-10 shrink-0 rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-input-bg) px-4 text-sm font-semibold text-(--nexivo-text) transition hover:border-(--nexivo-border) disabled:opacity-30"
              onClick={() => {
                writeRtcModeToStorage(null)
                setStored(null)
                window.location.reload()
              }}
            >
              Clear local override
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
