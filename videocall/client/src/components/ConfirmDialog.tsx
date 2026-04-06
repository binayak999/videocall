import { createPortal } from 'react-dom'
import { useEffect } from 'react'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export type ConfirmDialogVariant = 'danger' | 'primary'

type ConfirmDialogProps = {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: ConfirmDialogVariant
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Modal confirm — portaled so it is not clipped by overflow/backdrop on parent panels.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const confirmBtn =
    variant === 'danger'
      ? 'rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500'
      : 'rounded-xl bg-[#f59e0b] px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-[#fbbf24]'

  return createPortal(
    <div
      className="fixed inset-0 z-9000 flex items-center justify-center p-4"
      role="presentation"
      style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >
      <button
        type="button"
        className="absolute inset-0 border-0 bg-(--nexivo-dialog-scrim) backdrop-blur-[2px]"
        aria-label={cancelLabel}
        onClick={onCancel}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        className="relative w-full max-w-md rounded-[22px] border border-(--nexivo-border) bg-(--nexivo-panel-solid) p-6 shadow-2xl backdrop-blur-xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="text-lg font-bold tracking-tight text-(--nexivo-text)">
          {title}
        </h2>
        <p id="confirm-dialog-desc" className="mt-2 text-sm leading-relaxed text-(--nexivo-text-muted)">
          {description}
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-(--nexivo-border) bg-(--nexivo-muted-surface) px-4 py-2.5 text-sm font-semibold text-(--nexivo-text-secondary) transition hover:bg-(--nexivo-nav-hover)"
          >
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm} className={cx(confirmBtn)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
