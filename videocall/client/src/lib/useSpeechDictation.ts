import { useCallback, useEffect, useRef, useState } from 'react'
import {
  speechRecognitionCtor,
  type BrowserSpeechRecognition,
  type BrowserSpeechErrorEvent,
  type BrowserSpeechResultEvent,
} from './browserSpeechRecognition'

/**
 * Browser speech-to-text; `lang` should be a BCP-47 tag (see `MEETING_VOICE_LANGUAGES`).
 */
export function useSpeechDictation(lang: string) {
  const recRef = useRef<BrowserSpeechRecognition | null>(null)
  const [listening, setListening] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const langRef = useRef(lang)
  langRef.current = lang

  const stop = useCallback(() => {
    try {
      recRef.current?.stop()
    } catch {
      /* ignore */
    }
    recRef.current = null
    setListening(false)
  }, [])

  useEffect(() => {
    return () => {
      stop()
    }
  }, [stop])

  const start = useCallback(
    (appendText: (chunk: string) => void) => {
      const Ctor = speechRecognitionCtor()
      if (!Ctor) {
        setErr('Speech recognition is not supported in this browser (try Chrome).')
        return
      }
      setErr(null)
      try {
        recRef.current?.stop()
      } catch {
        /* ignore */
      }
      recRef.current = null

      const r = new Ctor()
      r.continuous = true
      r.interimResults = true
      r.lang = langRef.current
      r.onresult = (event: BrowserSpeechResultEvent) => {
        let chunk = ''
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          chunk += event.results[i]![0]!.transcript
        }
        if (!chunk) return
        appendText(chunk)
      }
      r.onerror = (e: BrowserSpeechErrorEvent) => {
        if (e.error === 'aborted' || e.error === 'no-speech') return
        setErr(e.error === 'not-allowed' ? 'Microphone permission denied.' : e.error)
        setListening(false)
        recRef.current = null
      }
      r.onend = () => {
        setListening(false)
        recRef.current = null
      }
      recRef.current = r
      try {
        r.start()
        setListening(true)
      } catch {
        setErr('Could not start speech recognition.')
        recRef.current = null
      }
    },
    [],
  )

  const speechOk = speechRecognitionCtor() !== null

  return { listening, err, setErr, start, stop, speechOk }
}
