import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import { NoteActionsMenu } from './NoteActionsMenu'
import { NoteEditorBody } from './NoteEditorBody'
import { deleteNote, getNote, listNotes, upsertNote, type ChecklistItem, type StoredNote } from '../lib/notesStorage'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

/** Notes list + editor styled for the Nexivo home center panel. */
export function NotesWorkspace() {
  const [notes, setNotes] = useState<StoredNote[]>(() => listNotes())
  const [selectedId, setSelectedId] = useState<string | null>(() => listNotes()[0]?.id ?? null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [checklist, setChecklist] = useState<ChecklistItem[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  const selected = useMemo(() => (selectedId ? getNote(selectedId) : undefined), [selectedId, notes])

  useEffect(() => {
    if (!selectedId) {
      setTitle('')
      setBody('')
      setChecklist([])
      return
    }
    const n = getNote(selectedId)
    if (n) {
      setTitle(n.title)
      setBody(n.body)
      setChecklist([...n.checklist])
    }
  }, [selectedId])

  const refresh = useCallback(() => {
    setNotes(listNotes())
  }, [])

  useEffect(() => {
    if (!selectedId) return
    const t = window.setTimeout(() => {
      const n = getNote(selectedId)
      if (!n) return
      const sameList = JSON.stringify(n.checklist) === JSON.stringify(checklist)
      if (n.title === title && n.body === body && sameList) return
      upsertNote({
        id: selectedId,
        title: title.trim() || 'Untitled',
        body,
        meetingCode: n.meetingCode,
        checklist,
      })
      refresh()
    }, 450)
    return () => window.clearTimeout(t)
  }, [title, body, checklist, selectedId, refresh])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2200)
  }, [])

  const onNewNote = () => {
    const n = upsertNote({ title: 'Untitled', body: '', meetingCode: null })
    refresh()
    setSelectedId(n.id)
    setTitle(n.title)
    setBody(n.body)
    setChecklist([...n.checklist])
  }

  const performDeleteNote = () => {
    if (!selectedId) return
    deleteNote(selectedId)
    const rest = listNotes()
    refresh()
    setSelectedId(rest[0]?.id ?? null)
    if (rest[0]) {
      setTitle(rest[0].title)
      setBody(rest[0].body)
      setChecklist([...rest[0].checklist])
    } else {
      setTitle('')
      setBody('')
      setChecklist([])
    }
    showToast('Note deleted')
    setDeleteConfirmOpen(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <div className="shrink-0">
        <h2 className="text-xl font-bold tracking-tight text-(--nexivo-text)">Notes</h2>
        <p className="text-sm text-(--nexivo-text-muted)">
          Saved on this device. Write notes and add tasks in the same editor, then export or share. Meeting pads sync here too.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden lg:flex-row lg:items-stretch">
        <aside className="flex w-full shrink-0 flex-col rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) lg:w-52">
          <div className="flex items-center justify-between gap-2 border-b border-(--nexivo-border-subtle) p-2.5">
            <span className="text-[0.65rem] font-bold uppercase tracking-wide text-(--nexivo-nav-label)">All notes</span>
            <button
              type="button"
              onClick={onNewNote}
              className="rounded-lg border border-(--nexivo-input-border) bg-(--nexivo-input-bg) px-2.5 py-1 text-[11px] font-semibold text-(--nexivo-text) transition hover:bg-(--nexivo-nav-hover)"
            >
              New
            </button>
          </div>
          <ul className="max-h-40 overflow-y-auto p-2 lg:max-h-[min(52vh,480px)] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-(--nexivo-scroll-thumb)">
            {notes.length === 0 && (
              <li className="px-2 py-6 text-center text-xs text-(--nexivo-text-muted)">No notes yet. Create one to get started.</li>
            )}
            {notes.map(n => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(n.id)}
                  className={cx(
                    'mb-1 w-full rounded-lg px-2.5 py-2 text-left text-xs transition',
                    n.id === selectedId
                      ? 'bg-(--nexivo-note-selected) font-medium text-(--nexivo-text)'
                      : 'text-(--nexivo-text-secondary) hover:bg-(--nexivo-nav-hover)',
                  )}
                >
                  <span className="line-clamp-2">{n.title.trim() || 'Untitled'}</span>
                  {n.meetingCode && (
                    <span className="mt-0.5 block font-mono text-[0.6rem] text-(--nexivo-text-subtle)">{n.meetingCode}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="flex min-h-[min(44vh,400px)] min-w-0 flex-1 flex-col rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface)">
          <div className="relative z-10 flex flex-wrap items-center gap-2 border-b border-(--nexivo-border-subtle) p-2.5">
            <input
              type="text"
              className="min-w-0 flex-1 rounded-lg border border-(--nexivo-input-border) bg-(--nexivo-input-bg) px-2.5 py-2 text-xs text-(--nexivo-text) outline-none placeholder:text-(--nexivo-placeholder) focus:border-[#f59e0b]/45"
              placeholder="Title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              disabled={!selectedId}
              aria-label="Note title"
            />
            <NoteActionsMenu
              variant="home"
              note={selected}
              disabled={!selectedId}
              onDelete={() => setDeleteConfirmOpen(true)}
              onToast={showToast}
            />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-b-xl">
            <NoteEditorBody
              variant="home"
              body={body}
              onBodyChange={setBody}
              checklist={checklist}
              onChecklistChange={setChecklist}
              disabled={!selectedId}
              bodyPlaceholder="Write here…"
              minTextareaHeight="100px"
            />
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Delete note"
        description="This removes the note from this device. This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={performDeleteNote}
      />

      {toast && (
        <output
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-(--nexivo-toast-border) bg-(--nexivo-toast-bg) px-4 py-2 text-xs text-(--nexivo-text) shadow-lg backdrop-blur-sm"
          aria-live="polite"
        >
          {toast}
        </output>
      )}
    </div>
  )
}
