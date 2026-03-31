import { useEffect, useMemo, useState } from 'react'
import { defaultRtcModeFromEnv, readRtcModeFromStorage, type RtcMode, writeRtcModeToStorage } from '../lib/rtcMode'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function ControlPage() {
  const envDefault = useMemo(() => defaultRtcModeFromEnv(), [])
  const [stored, setStored] = useState<RtcMode | null>(null)

  useEffect(() => {
    setStored(readRtcModeFromStorage())
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'bandr:rtcMode') setStored(readRtcModeFromStorage())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const effective: RtcMode = stored ?? envDefault

  const card = 'rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) p-5'
  const radioRow = 'flex items-start gap-3 rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-input-bg) p-4 transition'

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-5 text-left">
      <h1 className="text-xl font-bold tracking-tight text-(--nexivo-text)">Control</h1>
      <p className="mt-1 text-sm text-(--nexivo-text-muted)">
        Pick how call media is carried: mesh (peer-to-peer over the existing signaling server) or LiveKit (SFU). Both stay
        available; changing this reloads the app and applies to the next meeting you join.
      </p>

      <div className={cx('mt-5 space-y-4', card)}>
        <div>
          <div className="text-sm font-semibold text-(--nexivo-text)">Meeting transport</div>
          <div className="mt-1 text-sm text-(--nexivo-text-muted)">
            Current: <span className="font-semibold text-(--nexivo-text)">{effective}</span>
            {stored ? (
              <span className="text-(--nexivo-text-muted)"> (overridden in this browser)</span>
            ) : (
              <span className="text-(--nexivo-text-muted)"> (default from env)</span>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            className={cx(radioRow, effective === 'mesh' && 'border-[#f59e0b] ring-2 ring-[#f59e0b]/35')}
            onClick={() => {
              writeRtcModeToStorage('mesh')
              setStored('mesh')
              window.location.reload()
            }}
          >
            <span
              className={cx(
                'mt-1 inline-flex h-4 w-4 items-center justify-center rounded-full border',
                effective === 'mesh' ? 'border-[#f59e0b]' : 'border-(--nexivo-border)',
              )}
            >
              {effective === 'mesh' && <span className="h-2 w-2 rounded-full bg-[#f59e0b]" />}
            </span>
            <span className="flex-1">
              <span className="block text-sm font-semibold text-(--nexivo-text)">Mesh (current signaling)</span>
              <span className="mt-0.5 block text-sm text-(--nexivo-text-muted)">
                Peer-to-peer media. Easiest to run, but doesn’t scale well to many participants.
              </span>
            </span>
          </button>

          <button
            type="button"
            className={cx(radioRow, effective === 'livekit' && 'border-[#f59e0b] ring-2 ring-[#f59e0b]/35')}
            onClick={() => {
              writeRtcModeToStorage('livekit')
              setStored('livekit')
              window.location.reload()
            }}
          >
            <span
              className={cx(
                'mt-1 inline-flex h-4 w-4 items-center justify-center rounded-full border',
                effective === 'livekit' ? 'border-[#f59e0b]' : 'border-(--nexivo-border)',
              )}
            >
              {effective === 'livekit' && <span className="h-2 w-2 rounded-full bg-[#f59e0b]" />}
            </span>
            <span className="flex-1">
              <span className="block text-sm font-semibold text-(--nexivo-text)">LiveKit (SFU)</span>
              <span className="mt-0.5 block text-sm text-(--nexivo-text-muted)">
                SFU media with simulcast/adaptive streaming. Best quality and scalability, needs LiveKit server.
              </span>
            </span>
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-(--nexivo-border-subtle) pt-4">
          <div className="text-sm text-(--nexivo-text-muted)">
            Reset to env default: <span className="font-semibold text-(--nexivo-text)">{envDefault}</span>
          </div>
          <button
            type="button"
            className="h-9 rounded-lg border border-(--nexivo-border-subtle) bg-(--nexivo-input-bg) px-3 text-sm font-semibold text-(--nexivo-text) transition hover:border-(--nexivo-border)"
            onClick={() => {
              writeRtcModeToStorage(null)
              setStored(null)
              window.location.reload()
            }}
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}

