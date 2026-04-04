import { useCallback, useEffect, useState } from 'react'
import { analyzeMeetingAgenda, errorMessage } from '../lib/api'
import type { AgendaCheckResult } from '../lib/types'
import { useSpeechDictation } from '../lib/useSpeechDictation'
import { MeetingSpeechLanguageSelect } from './MeetingSpeechLanguageSelect'
import { TextTranslateControls } from './TextTranslateControls'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function HostAgendaPanel({
  meetingCode,
  open,
  onClose,
  speechLang,
  onSpeechLangChange,
}: {
  meetingCode: string
  open: boolean
  onClose: () => void
  speechLang: string
  onSpeechLangChange: (bcp47: string) => void
}) {
  const [agenda, setAgenda] = useState('')
  const [transcript, setTranscript] = useState('')
  const [analyzeBusy, setAnalyzeBusy] = useState(false)
  const [result, setResult] = useState<AgendaCheckResult | null>(null)
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null)
  const { listening, err: speechErr, start, stop, speechOk } = useSpeechDictation(speechLang)

  useEffect(() => {
    if (!open) {
      stop()
    }
  }, [open, stop])

  useEffect(() => {
    stop()
  }, [speechLang, stop])

  const appendTranscript = useCallback((chunk: string) => {
    setTranscript(prev => {
      const sep = prev.length > 0 && !/\s$/.test(prev) ? ' ' : ''
      return `${prev}${sep}${chunk}`
    })
  }, [])

  const startListening = () => {
    start(appendTranscript)
  }

  const onAnalyze = async () => {
    setAnalyzeErr(null)
    setResult(null)
    const a = agenda.trim()
    const t = transcript.trim()
    if (!a || !t) {
      setAnalyzeErr('Add an agenda and capture or paste a transcript first.')
      return
    }
    setAnalyzeBusy(true)
    try {
      const r = await analyzeMeetingAgenda(meetingCode, { agenda: a, transcript: t })
      setResult(r)
    } catch (e: unknown) {
      setAnalyzeErr(errorMessage(e))
    } finally {
      setAnalyzeBusy(false)
    }
  }

  if (!open) return null

  return (
    <aside
      className={cx(
        'absolute top-4 bottom-4 z-26 flex w-[min(360px,92vw)] flex-col overflow-hidden rounded-[22px] border border-white/7 bg-[#1c1c1e]/95 shadow-2xl backdrop-blur-xl',
        'left-4 max-[900px]:w-[min(320px,92vw)] max-[480px]:top-auto max-[480px]:right-0 max-[480px]:bottom-0 max-[480px]:left-0 max-[480px]:h-[72vh] max-[480px]:w-full max-[480px]:rounded-t-[18px] max-[480px]:rounded-b-none max-[480px]:border-x-0 max-[480px]:border-b-0 max-[480px]:border-t max-[480px]:border-white/10',
      )}
      aria-label="Host agenda assistant"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-white/7 px-4 pb-3 pt-4">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-white/90">Agenda &amp; AI check</p>
          <p className="text-[10px] font-medium text-amber-300/90">Host only</p>
        </div>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/6 text-base leading-none text-white/60 transition hover:border-white/16 hover:bg-white/12 hover:text-white"
          onClick={onClose}
          aria-label="Close agenda panel"
        >
          ✕
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15">
        <div>
          <label className="mb-1 block text-[0.65rem] font-bold uppercase tracking-wider text-white/35">Agenda</label>
          <textarea
            className="min-h-[88px] w-full resize-y rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[12px] leading-snug text-white/90 outline-none placeholder:text-white/28 focus:border-amber-500/45"
            placeholder="One item per line, e.g.&#10;Budget review&#10;Q2 roadmap&#10;Action items"
            value={agenda}
            onChange={e => setAgenda(e.target.value)}
            aria-label="Meeting agenda"
          />
        </div>

        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <label className="text-[0.65rem] font-bold uppercase tracking-wider text-white/35">Transcript</label>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <MeetingSpeechLanguageSelect
                value={speechLang}
                onChange={onSpeechLangChange}
                disabled={listening}
                className="max-w-[140px] cursor-pointer rounded-lg border border-white/10 bg-white/5 px-1.5 py-1 text-[10px] text-white outline-none focus:border-amber-500/45"
              />
              {listening ? (
                <button
                  type="button"
                  onClick={stop}
                  className="rounded-lg border border-red-500/35 bg-red-500/15 px-2 py-1 text-[10px] font-semibold text-red-200"
                >
                  Stop mic
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startListening}
                  disabled={!speechOk}
                  className="rounded-lg border border-amber-500/35 bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-100 disabled:opacity-35"
                >
                  Voice to text
                </button>
              )}
            </div>
          </div>
          <textarea
            className="min-h-[120px] w-full resize-y rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[12px] leading-snug text-white/90 outline-none placeholder:text-white/28 focus:border-amber-500/45"
            placeholder="Paste notes or use Voice to text (browser speech recognition)."
            value={transcript}
            onChange={e => setTranscript(e.target.value)}
            aria-label="Meeting transcript"
          />
          {speechErr && <p className="mt-1 text-[11px] text-red-300">{speechErr}</p>}
          {!speechOk && (
            <p className="mt-1 text-[10px] text-white/35">Voice uses your browser; you can always paste text instead.</p>
          )}
          <TextTranslateControls
            variant="agenda"
            sourceText={transcript}
            speechLangBcp47={speechLang}
            onApplyTranslation={setTranscript}
          />
        </div>

        <button
          type="button"
          disabled={analyzeBusy}
          onClick={() => void onAnalyze()}
          className="w-full cursor-pointer rounded-xl border-0 bg-amber-500 py-2.5 text-[13px] font-semibold text-black transition hover:bg-amber-400 disabled:opacity-45"
        >
          {analyzeBusy ? 'Checking…' : 'Check agenda with AI'}
        </button>

        {analyzeErr && <p className="text-[12px] text-red-300">{analyzeErr}</p>}

        {result && (
          <div className="rounded-xl border border-white/10 bg-white/4 p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">AI summary</p>
            <p className="mb-3 text-[12px] leading-snug text-white/80">{result.summary}</p>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/45">Items</p>
            <ul className="space-y-2">
              {result.items.map((it, i) => (
                <li
                  key={`${it.label}-${i}`}
                  className={cx(
                    'rounded-lg border px-2.5 py-2 text-[12px]',
                    it.met ? 'border-emerald-500/25 bg-emerald-500/10' : 'border-white/10 bg-white/4',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-white/90">{it.label}</span>
                    <span
                      className={cx(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                        it.met ? 'bg-emerald-500/25 text-emerald-200' : 'bg-white/10 text-white/55',
                      )}
                    >
                      {it.met ? 'Met' : 'Not met'}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-white/50">
                    {it.reason}
                    <span className="text-white/35"> · {it.confidence}</span>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  )
}
