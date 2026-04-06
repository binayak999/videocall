const STORAGE_KEY = 'nexivo.notes.v1'

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

export interface StoredNote {
  id: string
  title: string
  body: string
  checklist: ChecklistItem[]
  /** When set, this note is the saved pad for that meeting code. */
  meetingCode: string | null
  createdAt: string
  updatedAt: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createChecklistItem(text: string): ChecklistItem {
  return { id: newId(), text: text.trim(), done: false }
}

function parseChecklist(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return []
  const out: ChecklistItem[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.text !== 'string' || typeof o.done !== 'boolean') continue
    out.push({ id: o.id, text: o.text, done: o.done })
  }
  return out
}

function readRaw(): StoredNote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: StoredNote[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue
      const o = row as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.title !== 'string' || typeof o.body !== 'string') continue
      const meetingCode = o.meetingCode === null || typeof o.meetingCode === 'string' ? o.meetingCode : null
      const createdAt = typeof o.createdAt === 'string' ? o.createdAt : nowIso()
      const updatedAt = typeof o.updatedAt === 'string' ? o.updatedAt : createdAt
      const checklist = parseChecklist(o.checklist)
      out.push({ id: o.id, title: o.title, body: o.body, checklist, meetingCode, createdAt, updatedAt })
    }
    return out
  } catch {
    return []
  }
}

function writeRaw(notes: StoredNote[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes))
  } catch {
    // quota or private mode
  }
}

export function listNotes(): StoredNote[] {
  return readRaw().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export function getNote(id: string): StoredNote | undefined {
  return readRaw().find(n => n.id === id)
}

export function deleteNote(id: string): void {
  writeRaw(readRaw().filter(n => n.id !== id))
}

export function upsertNote(input: {
  id?: string
  title: string
  body: string
  meetingCode: string | null
  checklist?: ChecklistItem[]
}): StoredNote {
  const all = readRaw()
  const t = nowIso()
  if (input.id) {
    const idx = all.findIndex(n => n.id === input.id)
    if (idx >= 0) {
      const prev = all[idx]!
      const next: StoredNote = {
        ...prev,
        title: input.title,
        body: input.body,
        meetingCode: input.meetingCode,
        checklist: input.checklist !== undefined ? input.checklist : prev.checklist,
        updatedAt: t,
      }
      all[idx] = next
      writeRaw(all)
      return next
    }
  }
  const note: StoredNote = {
    id: newId(),
    title: input.title.trim() || 'Untitled',
    body: input.body,
    checklist: input.checklist ?? [],
    meetingCode: input.meetingCode,
    createdAt: t,
    updatedAt: t,
  }
  writeRaw([...all, note])
  return note
}

/** One persistent notepad per meeting code (first match wins). */
export function getOrCreateMeetingNotePad(meetingCode: string, meetingTitle?: string): StoredNote {
  const code = meetingCode.trim()
  const all = readRaw()
  const existing = all.find(n => n.meetingCode != null && n.meetingCode.toLowerCase() === code.toLowerCase())
  if (existing) return existing
  const title = meetingTitle?.trim()
    ? `Notes — ${meetingTitle.trim()}`
    : `Notes — ${code}`
  return upsertNote({ title, body: '', meetingCode: code })
}

function checklistPlainLines(items: ChecklistItem[]): string {
  if (items.length === 0) return ''
  return (
    '\n\nChecklist\n'
    + items.map(i => `${i.done ? '[x]' : '[ ]'} ${i.text || '(empty)'}`).join('\n')
  )
}

function checklistMdLines(items: ChecklistItem[]): string {
  if (items.length === 0) return ''
  return `\n\n## Checklist\n\n${items.map(i => `- [${i.done ? 'x' : ' '}] ${i.text || '(empty)'}`).join('\n')}`
}

export function noteAsPlainText(note: StoredNote): string {
  const head = note.title.trim() || 'Untitled'
  const body = note.body.trim()
  return `${head}\n\n${body}${checklistPlainLines(note.checklist ?? [])}`
}

export function noteAsMarkdown(note: StoredNote): string {
  const body = note.body.trim()
  const parts = [`# ${note.title || 'Untitled'}`, body ? `\n\n${body}` : '', checklistMdLines(note.checklist ?? [])]
  return parts.join('')
}

export function downloadNoteFile(note: StoredNote, format: 'txt' | 'md'): void {
  const text = format === 'md' ? noteAsMarkdown(note) : noteAsPlainText(note)
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const safe = (note.title || 'note').replace(/[^\w\s-]/g, '').trim().slice(0, 48) || 'note'
  a.download = `${safe}.${format}`
  a.click()
  URL.revokeObjectURL(url)
}

export async function copyNoteToClipboard(note: StoredNote, format: 'txt' | 'md'): Promise<void> {
  const text = format === 'md' ? noteAsMarkdown(note) : noteAsPlainText(note)
  await navigator.clipboard.writeText(text)
}

export async function shareNote(note: StoredNote): Promise<void> {
  const text = noteAsPlainText(note)
  if (navigator.share) {
    await navigator.share({ title: note.title || 'Notes', text })
    return
  }
  await copyNoteToClipboard(note, 'txt')
}
