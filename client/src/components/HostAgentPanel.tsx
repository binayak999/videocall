import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, fetchMeetingCaptions, hostAgentChat, hostAgentTranscribe, hostAgentTts } from '../lib/api'
import { useSpeechDictation } from '../lib/useSpeechDictation'
import { MeetingSpeechLanguageSelect } from './MeetingSpeechLanguageSelect'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function appendChunk(prev: string, chunk: string): string {
  const sep = prev.length > 0 && !/\s$/.test(prev) ? ' ' : ''
  return `${prev}${sep}${chunk}`
}

export function HostAgentPanel({
  meetingCode,
  open,
  onClose,
  speechLang,
  onSpeechLangChange,
  onSpeakInCall,
  onAutopilotConfigChange,
}: {
  meetingCode: string
  open: boolean
  onClose: () => void
  speechLang: string
  onSpeechLangChange: (bcp47: string) => void
  onSpeakInCall: (audio: Blob) => Promise<void>
  onAutopilotConfigChange: (cfg: { enabled: boolean; knowledgeBase: string }) => void
}) {
  const [knowledgeBase, setKnowledgeBase] = useState('')
  const [meetingContext, setMeetingContext] = useState('')
  const [prompt, setPrompt] = useState('')
  const [reply, setReply] = useState('')
  const [providerLabel, setProviderLabel] = useState<string | null>(null)
  const [chatBusy, setChatBusy] = useState(false)
  const [captionsBusy, setCaptionsBusy] = useState(false)
  const [sttBusy, setSttBusy] = useState(false)
  const [ttsBusy, setTtsBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [autopilotEnabled, setAutopilotEnabled] = useState(false)

  const { listening, err: speechErr, start, stop, speechOk } = useSpeechDictation(speechLang)
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!open) {
      stop()
      if (recRef.current && recRef.current.state !== 'inactive') {
        try {
          recRef.current.stop()
        } catch {
          /* ignore */
        }
      }
      recRef.current = null
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      chunksRef.current = []
      setRecording(false)
    }
  }, [open, stop])

  useEffect(() => {
    onAutopilotConfigChange({ enabled: autopilotEnabled, knowledgeBase })
  }, [autopilotEnabled, knowledgeBase, onAutopilotConfigChange])

  useEffect(() => {
    stop()
  }, [speechLang, stop])

  const appendPrompt = useCallback((chunk: string) => {
    setPrompt(prev => appendChunk(prev, chunk))
  }, [])

  const startListening = () => {
    start(appendPrompt)
  }

  const loadCaptions = async () => {
    setErr(null)
    setCaptionsBusy(true)
    try {
      const { captions } = await fetchMeetingCaptions(meetingCode)
      const lines = captions.map(c => `[${c.speakerName}]: ${c.text}`)
      setMeetingContext(lines.join('\n'))
    } catch (e: unknown) {
      setErr(errorMessage(e))
    } finally {
      setCaptionsBusy(false)
    }
  }

  const onAsk = async () => {
    setErr(null)
    setReply('')
    setProviderLabel(null)
    const m = prompt.trim()
    if (!m) {
      setErr('Add a question or instruction for the agent.')
      return
    }
    setChatBusy(true)
    try {
      const r = await hostAgentChat(meetingCode, {
        message: m,
        knowledgeBase: knowledgeBase.trim() || undefined,
        meetingContext: meetingContext.trim() || undefined,
      })
      setReply(r.reply)
      setProviderLabel(r.provider === 'openai' ? 'OpenAI' : 'Hugging Face')
    } catch (e: unknown) {
      setErr(errorMessage(e))
    } finally {
      setChatBusy(false)
    }
  }

  const onSpeakReply = async () => {
    setErr(null)
    const text = reply.trim() || prompt.trim()
    if (!text) {
      setErr('Generate a reply (or type a short line) first.')
      return
    }
    setTtsBusy(true)
    try {
      const audio = await hostAgentTts(meetingCode, { text })
      await onSpeakInCall(audio)
    } catch (e: unknown) {
      setErr(errorMessage(e))
    } finally {
      setTtsBusy(false)
    }
  }

  const stopRecordingAndTranscribe = useCallback(() => {
    const mr = recRef.current
    if (!mr || mr.state === 'inactive') {
      setRecording(false)
      return
    }
    mr.stop()
  }, [])

  const startMicClip = async () => {
    setErr(null)
    if (recording) {
      stopRecordingAndTranscribe()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []
      const mime =
        typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'
      const mr = new MediaRecorder(stream, { mimeType: mime })
      recRef.current = mr
      mr.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      mr.onstop = () => {
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = null
        recRef.current = null
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: mime })
        chunksRef.current = []
        if (blob.size < 64) return
        void (async () => {
          setSttBusy(true)
          try {
            const { text, provider } = await hostAgentTranscribe(meetingCode, blob)
            const tag = provider === 'openai' ? 'OpenAI STT' : 'HF STT'
            setPrompt(prev => {
              const head = prev.trim().length > 0 ? `${prev.trim()}\n\n` : ''
              return `${head}[${tag}] ${text.trim()}`
            })
          } catch (e: unknown) {
            setErr(errorMessage(e))
          } finally {
            setSttBusy(false)
          }
        })()
      }
      mr.start()
      setRecording(true)
    } catch {
      setErr('Could not access microphone for recording.')
    }
  }

  if (!open) return null

  return (
    <aside
      className={cx(
        'absolute top-4 bottom-4 z-26 flex w-[min(380px,92vw)] flex-col overflow-hidden rounded-[22px] border border-white/7 bg-[#1c1c1e]/95 shadow-2xl backdrop-blur-xl',
        'left-4 max-[900px]:w-[min(320px,92vw)] max-[480px]:top-auto max-[480px]:right-0 max-[480px]:bottom-0 max-[480px]:left-0 max-[480px]:h-[72vh] max-[480px]:w-full max-[480px]:rounded-t-[18px] max-[480px]:rounded-b-none max-[480px]:border-x-0 max-[480px]:border-b-0 max-[480px]:border-t max-[480px]:border-white/10',
      )}
      aria-label="Host AI stand-in"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-white/7 px-4 pb-3 pt-4">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-white/90">Host AI stand-in</p>
          <p className="text-[10px] font-medium text-violet-300/90">HF LLM + STT (upgrade path: OpenAI)</p>
        </div>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/6 text-base leading-none text-white/60 transition hover:border-white/16 hover:bg-white/12 hover:text-white"
          onClick={onClose}
          aria-label="Close host agent panel"
        >
          ✕
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15">
        <p className="text-[11px] leading-snug text-white/45">
          Draft answers on your behalf using your knowledge text and optional meeting captions. Next steps: inject voice into the call and persistent KB uploads.
        </p>

        <div>
          <label className="mb-1 block text-[0.65rem] font-bold uppercase tracking-wider text-white/35">
            Knowledge base (paste for now)
          </label>
          <textarea
            className="min-h-[100px] w-full resize-y rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[12px] leading-snug text-white/90 outline-none placeholder:text-white/28 focus:border-violet-500/45"
            placeholder="Product facts, pricing, policies, talk track…"
            value={knowledgeBase}
            onChange={e => setKnowledgeBase(e.target.value)}
            aria-label="Knowledge base"
          />
          <label className="mt-2 flex cursor-pointer items-start gap-2.5 text-[12px] text-white/80">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 accent-emerald-500"
              checked={autopilotEnabled}
              onChange={e => setAutopilotEnabled(e.target.checked)}
            />
            <span>
              Autopilot: when someone says your name (host profile), answer from your knowledge base — with captions on, or via audio when captions are off (host only).
            </span>
          </label>
        </div>

        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <label className="text-[0.65rem] font-bold uppercase tracking-wider text-white/35">Meeting context</label>
            <button
              type="button"
              disabled={captionsBusy}
              onClick={() => void loadCaptions()}
              className="rounded-lg border border-white/12 bg-white/6 px-2 py-1 text-[10px] font-semibold text-white/85 transition hover:border-violet-500/35 hover:bg-white/10 disabled:opacity-45"
            >
              {captionsBusy ? 'Loading…' : 'Load saved captions'}
            </button>
          </div>
          <textarea
            className="min-h-[88px] w-full resize-y rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[12px] leading-snug text-white/90 outline-none placeholder:text-white/28 focus:border-violet-500/45"
            placeholder="Captions from this room, or paste what was said…"
            value={meetingContext}
            onChange={e => setMeetingContext(e.target.value)}
            aria-label="Meeting context"
          />
        </div>

        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <label className="text-[0.65rem] font-bold uppercase tracking-wider text-white/35">Your question</label>
            <div className="flex flex-wrap items-center gap-1.5">
              <MeetingSpeechLanguageSelect
                value={speechLang}
                onChange={onSpeechLangChange}
                disabled={listening || recording}
                className="max-w-[130px] cursor-pointer rounded-lg border border-white/10 bg-white/5 px-1.5 py-1 text-[10px] text-white outline-none focus:border-violet-500/45"
              />
              {listening ? (
                <button
                  type="button"
                  onClick={stop}
                  className="rounded-lg border border-red-500/35 bg-red-500/15 px-2 py-1 text-[10px] font-semibold text-red-200"
                >
                  Stop dictation
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startListening}
                  disabled={!speechOk || recording}
                  className="rounded-lg border border-violet-500/35 bg-violet-500/15 px-2 py-1 text-[10px] font-semibold text-violet-100 disabled:opacity-35"
                >
                  Voice (browser)
                </button>
              )}
              <button
                type="button"
                onClick={() => void startMicClip()}
                disabled={sttBusy}
                className={cx(
                  'rounded-lg border px-2 py-1 text-[10px] font-semibold disabled:opacity-45',
                  recording
                    ? 'border-red-500/40 bg-red-500/15 text-red-100'
                    : 'border-white/14 bg-white/8 text-white/88',
                )}
              >
                {sttBusy ? 'STT…' : recording ? 'Stop & send to HF STT' : 'Record → HF STT'}
              </button>
            </div>
          </div>
          <textarea
            className="min-h-[96px] w-full resize-y rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[12px] leading-snug text-white/90 outline-none placeholder:text-white/28 focus:border-violet-500/45"
            placeholder="What should the agent answer (as you)?"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            aria-label="Question for host agent"
          />
          {speechErr && <p className="mt-1 text-[11px] text-red-300">{speechErr}</p>}
          {!speechOk && (
            <p className="mt-1 text-[10px] text-white/35">Browser dictation unavailable; use Record → HF STT.</p>
          )}
        </div>

        {err && <p className="text-[11px] text-red-300">{err}</p>}

        <button
          type="button"
          disabled={chatBusy}
          onClick={() => void onAsk()}
          className="w-full cursor-pointer rounded-xl border border-violet-500/40 bg-violet-600/28 py-2.5 text-[13px] font-semibold text-white transition hover:border-violet-400/55 hover:bg-violet-600/40 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {chatBusy ? 'Thinking…' : 'Ask host agent'}
        </button>

        <button
          type="button"
          disabled={ttsBusy || chatBusy}
          onClick={() => void onSpeakReply()}
          className="w-full cursor-pointer rounded-xl border border-emerald-500/40 bg-emerald-600/22 py-2.5 text-[13px] font-semibold text-white transition hover:border-emerald-400/55 hover:bg-emerald-600/34 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {ttsBusy ? 'Generating voice…' : 'Speak this in the meeting (AI voice)'}
        </button>

        {reply.length > 0 && (
          <div className="rounded-xl border border-white/10 bg-white/4 px-2.5 py-2">
            <p className="mb-1 text-[0.65rem] font-bold uppercase tracking-wider text-white/35">Suggested reply</p>
            <p className="whitespace-pre-wrap text-[12px] leading-snug text-white/88">{reply}</p>
            {providerLabel && (
              <p className="mt-2 text-[10px] text-white/35">Model route: {providerLabel}</p>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
