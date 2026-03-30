import { useState } from 'react'
import { translateText as translateTextApi, errorMessage } from '../lib/api'
import { getToken } from '../lib/auth'
import { translateNameForBcp47 } from '../lib/meetingLanguages'
import { MeetingSpeechLanguageSelect } from './MeetingSpeechLanguageSelect'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function TextTranslateControls({
  sourceText,
  speechLangBcp47,
  onApplyTranslation,
  onAppendTranslation,
  variant,
}: {
  sourceText: string
  /** Helps the model when text came from your chosen dictation language. */
  speechLangBcp47: string
  onApplyTranslation: (translated: string) => void
  /** When set (e.g. meeting notes), show an extra control to add the result without erasing existing text. */
  onAppendTranslation?: (translated: string) => void
  variant: 'agenda' | 'notes'
}) {
  const [targetBcp47, setTargetBcp47] = useState('en-US')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [out, setOut] = useState('')

  const token = getToken()
  const canAuth = typeof token === 'string' && token.length > 0
  const trimmed = sourceText.trim()
  const selectCls =
    variant === 'agenda'
      ? 'w-full cursor-pointer rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-white outline-none focus:border-amber-500/45'
      : 'w-full cursor-pointer rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[12px] text-white outline-none focus:border-amber-500/45'

  const run = async () => {
    setErr(null)
    setOut('')
    if (!trimmed) {
      setErr('Nothing to translate yet.')
      return
    }
    if (!canAuth) {
      setErr('Sign in to use translation (same account as the app).')
      return
    }
    setBusy(true)
    try {
      const sourceHint = translateNameForBcp47(speechLangBcp47)
      const targetLang = translateNameForBcp47(targetBcp47)
      const { translated } = await translateTextApi({
        text: sourceText,
        targetLanguage: targetLang,
        sourceLanguage: sourceHint,
      })
      setOut(translated)
    } catch (e: unknown) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const copyOut = async () => {
    if (!out) return
    try {
      await navigator.clipboard.writeText(out)
    } catch {
      setErr('Could not copy to clipboard.')
    }
  }

  return (
    <div
      className={cx(
        'rounded-xl border border-white/8 bg-white/3 p-2.5',
        variant === 'notes' && 'mt-2',
      )}
    >
      <p className="mb-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-white/35">Translate</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="sr-only" htmlFor={`translate-target-${variant}`}>
          Translate to
        </label>
        <MeetingSpeechLanguageSelect
          id={`translate-target-${variant}`}
          value={targetBcp47}
          onChange={setTargetBcp47}
          disabled={busy}
          className={cx(selectCls, 'sm:min-w-[160px] sm:flex-1')}
        />
        <button
          type="button"
          disabled={busy || !trimmed}
          onClick={() => void run()}
          className="shrink-0 cursor-pointer rounded-lg border border-sky-500/35 bg-sky-500/15 px-3 py-1.5 text-[11px] font-semibold text-sky-100 disabled:opacity-35"
        >
          {busy ? 'Translating…' : 'Translate'}
        </button>
      </div>
      {err && <p className="mt-2 text-[11px] text-red-300">{err}</p>}
      {!canAuth && (
        <p className="mt-1.5 text-[10px] text-white/35">Translation uses your account on the server (HF or OpenAI).</p>
      )}
      {out.length > 0 && (
        <div className="mt-2 space-y-2">
          <textarea
            readOnly
            className="max-h-[140px] min-h-[72px] w-full resize-y rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 text-[11px] leading-snug text-white/85"
            value={out}
            aria-label="Translation result"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copyOut()}
              className="cursor-pointer rounded-lg border border-white/12 bg-white/8 px-2.5 py-1 text-[11px] font-medium text-white/85"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => onApplyTranslation(out)}
              className="cursor-pointer rounded-lg border border-amber-500/35 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-100"
            >
              {variant === 'notes' ? 'Replace note' : 'Use translation'}
            </button>
            {onAppendTranslation && (
              <button
                type="button"
                onClick={() => onAppendTranslation(out)}
                className="cursor-pointer rounded-lg border border-white/12 bg-white/8 px-2.5 py-1 text-[11px] font-medium text-white/85"
              >
                Append to note
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
