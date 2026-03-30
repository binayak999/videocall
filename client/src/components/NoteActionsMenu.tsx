import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  copyNoteToClipboard,
  downloadNoteFile,
  shareNote,
  type StoredNote,
} from '../lib/notesStorage'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

type Variant = 'home' | 'meeting'

export function NoteActionsMenu({
  note,
  disabled,
  variant,
  onDelete,
  onToast,
}: {
  note: StoredNote | null | undefined
  disabled?: boolean
  variant: Variant
  onDelete: () => void
  onToast: (msg: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const r = buttonRef.current.getBoundingClientRect()
    const w = 228
    let left = r.right - w
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    setMenuPos({ top: r.bottom + 6, left })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onScroll = () => close()
    const onResize = () => close()
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close])

  const run = (fn: () => void | Promise<void>) => {
    void Promise.resolve(fn()).finally(() => close())
  }

  const mainBtn = variant === 'home'
    ? 'inline-flex items-center gap-1 rounded-lg border border-white/12 bg-[#f59e0b]/90 px-3 py-2 text-[11px] font-semibold text-black shadow-sm transition hover:bg-[#fbbf24] disabled:opacity-40'
    : 'inline-flex items-center gap-1 rounded-lg border border-amber-500/35 bg-amber-500/20 px-3 py-2 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-500/30 disabled:opacity-40'

  const panel = variant === 'home'
    ? 'fixed min-w-[228px] rounded-xl border border-(--nexivo-menu-border) bg-(--nexivo-menu-bg) py-1.5 shadow-xl backdrop-blur-md'
    : 'fixed min-w-[228px] rounded-xl border border-white/10 bg-[#1c1c1f] py-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.5)] backdrop-blur-md'

  const section = cx(
    'px-2.5 pb-1 pt-1.5 text-[0.6rem] font-bold uppercase tracking-wider',
    variant === 'home' ? 'text-(--nexivo-menu-section)' : 'text-white/35',
  )
  const item = variant === 'home'
    ? 'flex w-full cursor-pointer items-center rounded-lg px-2.5 py-2 text-left text-xs text-(--nexivo-menu-item-text) transition hover:bg-(--nexivo-menu-item-hover)'
    : 'flex w-full cursor-pointer items-center rounded-lg px-2.5 py-2 text-left text-[13px] text-white/88 transition hover:bg-white/8'
  const danger = 'text-red-300 hover:bg-red-500/15'

  const menuBorderT =
    variant === 'home' ? 'border-t border-(--nexivo-border-subtle)' : 'border-t border-white/8'

  const canUse = !!note && !disabled

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        className={mainBtn}
        disabled={!canUse}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => canUse && setOpen(o => !o)}
      >
        Share &amp; export
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="currentColor"
          className={cx('opacity-80 transition-transform duration-200', open && 'rotate-180')}
          aria-hidden
        >
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>

      {open &&
        canUse &&
        note &&
        createPortal(
          <div
            ref={menuRef}
            className={panel}
            style={{ top: menuPos.top, left: menuPos.left, zIndex: 6000 }}
            role="menu"
            aria-label="Note actions"
          >
            <p className={section}>Download</p>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => run(() => downloadNoteFile(note, 'txt'))}
            >
              Download .txt
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => run(() => downloadNoteFile(note, 'md'))}
            >
              Download .md
            </button>

            <p className={cx(section, 'mt-1', menuBorderT)}>Copy</p>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() =>
                run(async () => {
                  try {
                    await copyNoteToClipboard(note, 'txt')
                    onToast('Copied as text')
                  } catch {
                    onToast('Could not copy')
                  }
                })
              }
            >
              Copy as text
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() =>
                run(async () => {
                  try {
                    await copyNoteToClipboard(note, 'md')
                    onToast('Copied as Markdown')
                  } catch {
                    onToast('Could not copy')
                  }
                })
              }
            >
              Copy as Markdown
            </button>

            <div className={cx('mt-1 pt-1', menuBorderT)}>
              <button
                type="button"
                role="menuitem"
                className={item}
                disabled={shareBusy}
                onClick={() =>
                  run(async () => {
                    setShareBusy(true)
                    try {
                      await shareNote(note)
                      onToast('Shared')
                    } catch {
                      onToast('Share cancelled or unavailable')
                    } finally {
                      setShareBusy(false)
                    }
                  })
                }
              >
                Share…
              </button>
            </div>

            <div className={cx('mt-1 pt-1', menuBorderT)}>
              <button
                type="button"
                role="menuitem"
                className={cx(item, danger)}
                onClick={() => {
                  close()
                  onDelete()
                }}
              >
                Delete note
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
