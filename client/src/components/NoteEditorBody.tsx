import { useCallback, useState } from 'react'
import { createChecklistItem, type ChecklistItem } from '../lib/notesStorage'
import { ConfirmDialog } from './ConfirmDialog'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

/**
 * Single in-note surface: free-form body flows into tasks (same scroll, no separate panel).
 */
export function NoteEditorBody({
  body,
  onBodyChange,
  checklist,
  onChecklistChange,
  disabled,
  variant,
  bodyPlaceholder,
  minTextareaHeight = '100px',
}: {
  body: string
  onBodyChange: (v: string) => void
  checklist: ChecklistItem[]
  onChecklistChange: (next: ChecklistItem[]) => void
  disabled?: boolean
  variant: 'home' | 'meeting'
  bodyPlaceholder: string
  /** Only used when variant is home (meeting uses responsive min-heights). */
  minTextareaHeight?: string
}) {
  const [draft, setDraft] = useState('')
  const [clearDoneOpen, setClearDoneOpen] = useState(false)
  const doneCount = checklist.filter(i => i.done).length

  const isHome = variant === 'home'
  const ta = isHome
    ? 'shrink-0 resize-y bg-transparent px-3 py-2.5 text-xs leading-relaxed text-(--nexivo-text) outline-none placeholder:text-(--nexivo-placeholder)'
    : 'min-h-[140px] shrink-0 resize-y bg-transparent px-3 py-3 text-[13px] leading-snug text-white/90 outline-none placeholder:text-white/28 sm:min-h-[160px]'

  const draftPh = isHome ? 'Add a task, Enter…' : 'Add a task, press Enter…'
  const draftInput = isHome
    ? 'min-w-0 flex-1 rounded-md border-0 bg-transparent py-1 text-xs text-(--nexivo-text) outline-none ring-0 placeholder:text-(--nexivo-placeholder) focus:ring-0'
    : 'min-w-0 flex-1 rounded-md border-0 bg-transparent py-1 text-[13px] text-white/90 outline-none ring-0 placeholder:text-white/35 focus:ring-0'
  const rowInput = isHome
    ? 'min-w-0 flex-1 rounded border border-transparent bg-transparent py-0.5 text-xs text-(--nexivo-text) outline-none focus:border-(--nexivo-input-border) focus:bg-(--nexivo-muted-surface)'
    : 'min-w-0 flex-1 rounded border border-transparent bg-transparent py-0.5 text-[13px] text-white/90 outline-none focus:border-white/8 focus:bg-white/4'
  const check = isHome
    ? 'mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border border-(--nexivo-input-border) accent-[#f59e0b]'
    : 'mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border border-white/25 accent-amber-500'
  const iconBtn = isHome
    ? 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] text-(--nexivo-text-subtle) transition hover:bg-(--nexivo-nav-hover) hover:text-(--nexivo-text-secondary) disabled:opacity-25'
    : 'flex h-7 w-7 shrink-0 items-center justify-center rounded text-[12px] text-white/40 transition hover:bg-white/8 hover:text-white/75 disabled:opacity-25'

  const updateAt = useCallback(
    (index: number, patch: Partial<ChecklistItem>) => {
      onChecklistChange(checklist.map((it, i) => (i === index ? { ...it, ...patch } : it)))
    },
    [checklist, onChecklistChange],
  )

  const removeAt = useCallback(
    (index: number) => {
      onChecklistChange(checklist.filter((_, i) => i !== index))
    },
    [checklist, onChecklistChange],
  )

  const move = useCallback(
    (index: number, dir: -1 | 1) => {
      const j = index + dir
      if (j < 0 || j >= checklist.length) return
      const next = [...checklist]
      const tmp = next[index]!
      next[index] = next[j]!
      next[j] = tmp
      onChecklistChange(next)
    },
    [checklist, onChecklistChange],
  )

  const addDraft = () => {
    const t = draft.trim()
    if (!t || disabled) return
    onChecklistChange([...checklist, createChecklistItem(t)])
    setDraft('')
  }

  const clearDone = () => {
    if (disabled || !checklist.some(i => i.done)) return
    setClearDoneOpen(true)
  }

  const runClearCompleted = () => {
    onChecklistChange(checklist.filter(i => !i.done))
    setClearDoneOpen(false)
  }

  return (
    <>
    <div
      className={cx(
        'flex min-h-0 flex-1 flex-col overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full',
        isHome ? '[&::-webkit-scrollbar-thumb]:bg-(--nexivo-scroll-thumb)' : '[&::-webkit-scrollbar-thumb]:bg-white/12',
      )}
    >
      <textarea
        className={ta}
        style={isHome ? { minHeight: minTextareaHeight } : undefined}
        placeholder={bodyPlaceholder}
        value={body}
        onChange={e => onBodyChange(e.target.value)}
        disabled={disabled}
        aria-label="Note body"
      />

      <div className="px-3 pb-3 pt-0">
        <div
          className={cx(
            'flex items-baseline gap-2 border-t pt-2',
            isHome ? 'border-(--nexivo-border-subtle)' : 'border-white/6',
          )}
        >
          <input
            type="text"
            className={draftInput}
            placeholder={draftPh}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addDraft()
              }
            }}
            disabled={disabled}
            aria-label="Add task"
          />
          {checklist.length > 0 && (
            <span
              className={cx('shrink-0 text-[10px] tabular-nums', isHome ? 'text-(--nexivo-text-subtle)' : 'text-white/35')}
            >
              {doneCount}/{checklist.length}
            </span>
          )}
        </div>

        {checklist.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {checklist.map((item, index) => (
              <li
                key={item.id}
                className={cx(
                  'flex items-start gap-1.5 rounded-md py-0.5 pl-0.5',
                  isHome ? 'hover:bg-(--nexivo-nav-hover)' : 'hover:bg-white/4',
                )}
              >
                <input
                  type="checkbox"
                  className={check}
                  checked={item.done}
                  onChange={e => updateAt(index, { done: e.target.checked })}
                  disabled={disabled}
                  aria-label={item.done ? 'Mark not done' : 'Mark done'}
                />
                <input
                  type="text"
                  className={cx(
                    rowInput,
                    item.done && (isHome ? 'text-(--nexivo-text-muted) line-through' : 'text-white/40 line-through'),
                  )}
                  value={item.text}
                  onChange={e => updateAt(index, { text: e.target.value })}
                  disabled={disabled}
                  aria-label="Task text"
                />
                <div className="flex shrink-0">
                  <button type="button" className={iconBtn} title="Move up" disabled={disabled || index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className={iconBtn}
                    title="Move down"
                    disabled={disabled || index === checklist.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button type="button" className={iconBtn} title="Remove" disabled={disabled} onClick={() => removeAt(index)}>
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {checklist.some(i => i.done) && (
          <button
            type="button"
            className={cx(
              'mt-2 text-[10px] font-medium underline underline-offset-2 transition',
              isHome
                ? 'text-(--nexivo-text-subtle) decoration-(--nexivo-border) hover:text-(--nexivo-text-muted)'
                : 'text-white/40 decoration-white/20 hover:text-white/60',
              disabled && 'pointer-events-none opacity-35',
            )}
            onClick={clearDone}
            disabled={disabled}
          >
            Clear completed
          </button>
        )}
      </div>
    </div>

    <ConfirmDialog
      open={clearDoneOpen}
      title="Remove completed tasks"
      description="All completed tasks will be removed from this note."
      confirmLabel="Remove"
      cancelLabel="Cancel"
      variant="primary"
      onCancel={() => setClearDoneOpen(false)}
      onConfirm={runClearCompleted}
    />
    </>
  )
}
