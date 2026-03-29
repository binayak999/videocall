export type BrowserSpeechRecognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((ev: BrowserSpeechResultEvent) => void) | null
  onerror: ((ev: BrowserSpeechErrorEvent) => void) | null
  onend: (() => void) | null
}

export type BrowserSpeechResultEvent = {
  resultIndex: number
  results: ArrayLike<{ 0: { transcript: string } }>
}

export type BrowserSpeechErrorEvent = { error: string }

export function speechRecognitionCtor(): (new () => BrowserSpeechRecognition) | null {
  if (typeof window === 'undefined') return null
  const w = window as Window & {
    SpeechRecognition?: new () => BrowserSpeechRecognition
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}
