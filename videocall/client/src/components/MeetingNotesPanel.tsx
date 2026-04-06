import { useCallback, useEffect, useRef, useState } from 'react'
import { useSpeechDictation } from '../lib/useSpeechDictation'
import { ConfirmDialog } from './ConfirmDialog'
import { NoteActionsMenu } from './NoteActionsMenu'
import { NoteEditorBody } from './NoteEditorBody'
import { MeetingSpeechLanguageSelect } from './MeetingSpeechLanguageSelect'
import { TextTranslateControls } from './TextTranslateControls'
import {
  deleteNote,
  getNote,
  getOrCreateMeetingNotePad,
  upsertNote,
  type ChecklistItem,
  type StoredNote,
} from '../lib/notesStorage'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function MeetingNotesPanel({
  meetingCode,
  meetingTitle,
  open,
  onClose,
  speechLang,
  onSpeechLangChange,
}: {
  meetingCode: string
  meetingTitle?: string
  open: boolean
  onClose: () => void
  speechLang: string
  onSpeechLangChange: (bcp47: string) => void
}) {
  const [note, setNote] = useState<StoredNote | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [checklist, setChecklist] = useState<ChecklistItem[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const noteIdRef = useRef<string | null>(null)
  const { listening, err: speechErr, start, stop, speechOk } = useSpeechDictation(speechLang)

  useEffect(() => {
    if (!open) stop()
  }, [open, stop])

  useEffect(() => {
    stop()
  }, [speechLang, stop])

  const appendBody = useCallback((chunk: string) => {
    setBody(prev => {
      const sep = prev.length > 0 && !/\s$/.test(prev) ? ' ' : ''
      return `${prev}${sep}${chunk}`
    })
  }, [])

  useEffect(() => {
    if (!open || !meetingCode.trim()) return
    const pad = getOrCreateMeetingNotePad(meetingCode.trim(), meetingTitle)
    noteIdRef.current = pad.id
    setNote(pad)
    setTitle(pad.title)
    setBody(pad.body)
    setChecklist([...pad.checklist])
  }, [open, meetingCode, meetingTitle])

  useEffect(() => {
    if (!open || !noteIdRef.current) return
    const id = noteIdRef.current
    const t = window.setTimeout(() => {
      const cur = getNote(id)
      if (!cur) return
      const sameList = JSON.stringify(cur.checklist) === JSON.stringify(checklist)
      if (cur.title === title && cur.body === body && sameList) return
      const saved = upsertNote({
        id,
        title: title.trim() || 'Untitled',
        body,
        meetingCode: meetingCode.trim(),
        checklist,
      })
      setNote(saved)
    }, 450)
    return () => window.clearTimeout(t)
  }, [title, body, checklist, open, meetingCode])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2200)
  }, [])

  const onDeleteNote = () => setDeleteConfirmOpen(true)

  const performDeleteMeetingNote = () => {
    const id = noteIdRef.current
    if (!id) {
      setDeleteConfirmOpen(false)
      return
    }
    deleteNote(id)
    const pad = getOrCreateMeetingNotePad(meetingCode.trim(), meetingTitle)
    noteIdRef.current = pad.id
    setNote(pad)
    setTitle(pad.title)
    setBody(pad.body)
    setChecklist([...pad.checklist])
    showToast('Note cleared')
    setDeleteConfirmOpen(false)
  }

  if (!open) return null

  const latest: StoredNote | null = noteIdRef.current
    ? {
        id: noteIdRef.current,
        title: title.trim() || 'Untitled',
        body,
        checklist,
        meetingCode: meetingCode.trim() || null,
        createdAt: note?.createdAt ?? new Date().toISOString(),
        updatedAt: note?.updatedAt ?? new Date().toISOString(),
      }
    : null

  return (
    <>
      <aside
        className={cx(
          'absolute top-4 bottom-4 z-25 flex w-[min(340px,88vw)] flex-col overflow-hidden rounded-[22px] border border-white/7 bg-[#1c1c1e]/95 shadow-2xl backdrop-blur-xl',
          'left-4 max-[900px]:w-[min(300px,90vw)] max-[480px]:top-auto max-[480px]:right-0 max-[480px]:bottom-0 max-[480px]:left-0 max-[480px]:h-[70vh] max-[480px]:w-full max-[480px]:rounded-t-[18px] max-[480px]:rounded-b-none max-[480px]:border-x-0 max-[480px]:border-b-0 max-[480px]:border-t max-[480px]:border-white/10',
        )}
        aria-label="Meeting notes"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/7 px-4 pb-3.5 pt-4 text-[13px] font-semibold text-white/90">
          <div className="flex min-w-0 flex-col gap-px">
            <span>Notes</span>
            <small className="truncate font-mono text-[11px] font-medium text-white/45">{meetingCode}</small>
          </div>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/6 text-base leading-none text-white/60 transition hover:border-white/16 hover:bg-white/12 hover:text-white"
            onClick={onClose}
            aria-label="Close notes"
          >
            ✕
          </button>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-b border-white/7 px-3 py-2.5">
          <input
            type="text"
            className="w-full rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[13px] text-white/90 outline-none placeholder:text-white/30 focus:border-amber-500/45 focus:bg-white/8"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Note title"
            aria-label="Note title"
          />
          <div className="flex justify-end">
            <NoteActionsMenu
              variant="meeting"
              note={latest}
              disabled={!latest}
              onDelete={onDeleteNote}
              onToast={showToast}
            />
          </div>
          <p className="text-[10px] leading-snug text-white/35">Saved on this device. Open Notes from the home menu to see all notes.</p>
        </div>

        <div className="flex shrink-0 flex-col gap-2 border-b border-white/7 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <MeetingSpeechLanguageSelect
              value={speechLang}
              onChange={onSpeechLangChange}
              disabled={listening}
              className="min-w-0 flex-1 cursor-pointer rounded-xl border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-white outline-none focus:border-amber-500/45"
            />
            {listening ? (
              <button
                type="button"
                onClick={stop}
                className="shrink-0 cursor-pointer rounded-lg border border-red-500/35 bg-red-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-red-200"
              >
                Stop mic
              </button>
            ) : (
              <button
                type="button"
                onClick={() => start(appendBody)}
                disabled={!speechOk}
                className="shrink-0 cursor-pointer rounded-lg border border-amber-500/35 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-amber-100 disabled:opacity-35"
              >
                Voice to text
              </button>
            )}
          </div>
          {speechErr && <p className="text-[11px] text-red-300">{speechErr}</p>}
          {!speechOk && <p className="text-[10px] text-white/35">Voice works in Chrome/Edge. Or type and translate below.</p>}
          <TextTranslateControls
            variant="notes"
            sourceText={body}
            speechLangBcp47={speechLang}
            onApplyTranslation={setBody}
            onAppendTranslation={t =>
              setBody(prev => `${prev.trim().length > 0 ? `${prev.trim()}\n\n` : ''}${t}`)
            }
          />
        </div>

        <NoteEditorBody
          variant="meeting"
          body={body}
          onBodyChange={setBody}
          checklist={checklist}
          onChecklistChange={setChecklist}
          bodyPlaceholder="Meeting notes, action items, ideas…"
        />
      </aside>

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Clear meeting note"
        description="This removes the current note for this room. A new empty note will appear here. This cannot be undone."
        confirmLabel="Clear note"
        cancelLabel="Cancel"
        variant="danger"
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={performDeleteMeetingNote}
      />

      {toast && (
        <output
          className="absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-full border border-white/12 bg-[#161618]/95 px-3 py-1.5 text-[12px] text-white/90 shadow-lg max-[480px]:bottom-22"
          aria-live="polite"
        >
          {toast}
        </output>
      )}
    </>
  )
}
