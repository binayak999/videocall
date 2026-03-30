function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function MeetingAttentionWarningModal({
  open,
  fromName,
  message,
  onDismiss,
}: {
  open: boolean
  fromName: string
  message: string
  onDismiss: () => void
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="attention-warn-title"
      aria-describedby="attention-warn-desc"
    >
      <div
        className={cx(
          'w-full max-w-md rounded-2xl border border-amber-500/35 bg-[#161618]/98 p-6 shadow-2xl',
          'ring-2 ring-amber-500/20',
        )}
      >
        <p id="attention-warn-title" className="text-lg font-bold text-amber-200">
          Your host needs your attention
        </p>
        <p id="attention-warn-desc" className="mt-2 text-[14px] leading-relaxed text-white/85">
          <strong className="text-white">{fromName}</strong>
          {' '}
          is asking you to look at the meeting.
          {message.trim().length > 0 && (
            <>
              <span className="mt-3 block rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-white/90">
                {message}
              </span>
            </>
          )}
        </p>
        <button
          type="button"
          className="mt-5 w-full cursor-pointer rounded-xl border-0 bg-amber-500 py-3 text-[14px] font-bold text-neutral-900 hover:bg-amber-400"
          onClick={onDismiss}
        >
          Got it
        </button>
      </div>
    </div>
  )
}
