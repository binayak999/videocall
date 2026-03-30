import { useMemo } from 'react'

import type { VoteGestureStatus } from '../lib/useVoteGestureRecognition'

export type MeetingVoteChoice = 'up' | 'down'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function MeetingVoteOverlay({
  title,
  anonymous,
  up,
  down,
  breakdown,
  myVote,
  localPeerId,
  isHost,
  onVote,
  onEndVote,
  gestureStatus = 'off',
  cameraOn = false,
}: {
  title: string
  anonymous: boolean
  up: number
  down: number
  breakdown: { peerId: string; userName: string; choice: MeetingVoteChoice }[] | null
  myVote: MeetingVoteChoice | null
  localPeerId: string
  isHost: boolean
  onVote: (choice: MeetingVoteChoice) => void
  onEndVote: () => void
  /** MediaPipe thumbs gesture pipeline status (camera vote). */
  gestureStatus?: VoteGestureStatus
  cameraOn?: boolean
}) {
  const total = up + down
  const upPct = total > 0 ? Math.round((up / total) * 100) : 0
  const downPct = total > 0 ? 100 - upPct : 0

  const sortedBreakdown = useMemo(() => {
    if (!breakdown || anonymous) return []
    return [...breakdown].sort((a, b) =>
      a.userName.localeCompare(b.userName, undefined, { sensitivity: 'base' }),
    )
  }, [breakdown, anonymous])

  return (
    <div
      className="pointer-events-auto absolute left-1/2 z-[24] w-[min(400px,calc(100vw-28px))] -translate-x-1/2 rounded-[20px] border border-white/12 bg-[#141416]/96 p-4 shadow-2xl backdrop-blur-xl max-[480px]:bottom-[calc(5.25rem+env(safe-area-inset-bottom,0px))] max-[480px]:max-h-[min(52vh,420px)] max-[480px]:overflow-y-auto bottom-[calc(5.75rem+env(safe-area-inset-bottom,0px))] sm:bottom-[calc(6.25rem+env(safe-area-inset-bottom,0px))]"
      role="region"
      aria-label="Live vote"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[0.65rem] font-bold uppercase tracking-wider text-amber-400/90">Vote</p>
          <h3 className="mt-0.5 text-[15px] font-semibold leading-snug text-white/95">{title}</h3>
          <p className="mt-1 text-[11px] font-medium text-white/45">
            {anonymous ? 'Anonymous — only totals are shown' : 'Identified — everyone sees who voted how'}
          </p>
          {cameraOn && gestureStatus === 'ready' && (
            <p className="mt-1.5 text-[11px] font-medium text-emerald-400/85">
              Or show 👍 / 👎 to your camera — hold it steady for about a second (clear gesture, hand in frame).
            </p>
          )}
          {cameraOn && gestureStatus === 'loading' && (
            <p className="mt-1.5 text-[11px] font-medium text-white/40">Loading gesture detection…</p>
          )}
          {cameraOn && gestureStatus === 'error' && (
            <p className="mt-1.5 text-[11px] font-medium text-amber-300/80">
              Camera gestures unavailable — use the buttons.
            </p>
          )}
          {!cameraOn && (
            <p className="mt-1.5 text-[11px] font-medium text-white/38">Turn your camera on to vote with gestures.</p>
          )}
        </div>
      </div>

      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() => onVote('up')}
          className={cx(
            'flex flex-1 flex-col items-center gap-1 rounded-xl border py-3 text-[13px] font-semibold transition',
            myVote === 'up'
              ? 'border-emerald-400/55 bg-emerald-500/25 text-emerald-100'
              : 'border-white/12 bg-white/6 text-white/85 hover:border-white/20 hover:bg-white/10',
          )}
          aria-pressed={myVote === 'up'}
          aria-label="Vote thumbs up"
        >
          <span className="text-2xl leading-none" aria-hidden>
            👍
          </span>
          <span>Up</span>
        </button>
        <button
          type="button"
          onClick={() => onVote('down')}
          className={cx(
            'flex flex-1 flex-col items-center gap-1 rounded-xl border py-3 text-[13px] font-semibold transition',
            myVote === 'down'
              ? 'border-rose-400/55 bg-rose-500/22 text-rose-100'
              : 'border-white/12 bg-white/6 text-white/85 hover:border-white/20 hover:bg-white/10',
          )}
          aria-pressed={myVote === 'down'}
          aria-label="Vote thumbs down"
        >
          <span className="text-2xl leading-none" aria-hidden>
            👎
          </span>
          <span>Down</span>
        </button>
      </div>

      <div className="mb-2 rounded-xl border border-white/8 bg-black/25 px-3 py-2.5">
        <div className="mb-1.5 flex justify-between text-[12px] font-medium text-white/55">
          <span>
            👍 {up}
            {total > 0 ? ` (${upPct}%)` : ''}
          </span>
          <span>
            👎 {down}
            {total > 0 ? ` (${downPct}%)` : ''}
          </span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className="bg-emerald-500/75 transition-[width] duration-300"
            style={{ width: total > 0 ? `${upPct}%` : '50%' }}
          />
          <div
            className="bg-rose-500/65 transition-[width] duration-300"
            style={{ width: total > 0 ? `${downPct}%` : '50%' }}
          />
        </div>
        <p className="mt-1.5 text-center text-[11px] text-white/40">{total} response{total === 1 ? '' : 's'}</p>
      </div>

      {!anonymous && sortedBreakdown.length > 0 && (
        <ul className="mb-3 max-h-[140px] space-y-1 overflow-y-auto text-[12px] text-white/80 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15">
          {sortedBreakdown.map(row => (
            <li
              key={row.peerId}
              className={cx(
                'flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5',
                row.peerId === localPeerId ? 'border-amber-500/35 bg-amber-500/10' : 'border-white/8 bg-white/4',
              )}
            >
              <span className="min-w-0 truncate font-medium">{row.userName}{row.peerId === localPeerId ? ' (you)' : ''}</span>
              <span className="shrink-0 text-lg leading-none">{row.choice === 'up' ? '👍' : '👎'}</span>
            </li>
          ))}
        </ul>
      )}

      {isHost && (
        <button
          type="button"
          onClick={onEndVote}
          className="w-full cursor-pointer rounded-xl border border-white/14 bg-white/8 py-2.5 text-[13px] font-semibold text-white/90 transition hover:border-red-400/40 hover:bg-red-600/25"
        >
          End vote
        </button>
      )}
    </div>
  )
}
