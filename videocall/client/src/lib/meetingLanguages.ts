import { useEffect, useState } from 'react'

/**
 * Browser speech recognition (`SpeechRecognition.lang`) uses BCP-47 tags.
 * `translateName` is passed to the server so the model knows the target variety.
 */
export const MEETING_VOICE_LANGUAGES: ReadonlyArray<{
  bcp47: string
  label: string
  translateName: string
}> = [
  { bcp47: 'en-US', label: 'English (US)', translateName: 'English (United States)' },
  { bcp47: 'en-GB', label: 'English (UK)', translateName: 'English (United Kingdom)' },
  { bcp47: 'es-ES', label: 'Spanish (Spain)', translateName: 'Spanish (Spain)' },
  { bcp47: 'es-MX', label: 'Spanish (Mexico)', translateName: 'Spanish (Mexico)' },
  { bcp47: 'fr-FR', label: 'French', translateName: 'French' },
  { bcp47: 'de-DE', label: 'German', translateName: 'German' },
  { bcp47: 'it-IT', label: 'Italian', translateName: 'Italian' },
  { bcp47: 'pt-BR', label: 'Portuguese (Brazil)', translateName: 'Portuguese (Brazil)' },
  { bcp47: 'pt-PT', label: 'Portuguese (Portugal)', translateName: 'Portuguese (Portugal)' },
  { bcp47: 'nl-NL', label: 'Dutch', translateName: 'Dutch' },
  { bcp47: 'pl-PL', label: 'Polish', translateName: 'Polish' },
  { bcp47: 'ru-RU', label: 'Russian', translateName: 'Russian' },
  { bcp47: 'uk-UA', label: 'Ukrainian', translateName: 'Ukrainian' },
  { bcp47: 'cs-CZ', label: 'Czech', translateName: 'Czech' },
  { bcp47: 'ro-RO', label: 'Romanian', translateName: 'Romanian' },
  { bcp47: 'el-GR', label: 'Greek', translateName: 'Greek' },
  { bcp47: 'tr-TR', label: 'Turkish', translateName: 'Turkish' },
  { bcp47: 'ar-SA', label: 'Arabic', translateName: 'Arabic' },
  { bcp47: 'he-IL', label: 'Hebrew', translateName: 'Hebrew' },
  { bcp47: 'hi-IN', label: 'Hindi', translateName: 'Hindi' },
  { bcp47: 'bn-BD', label: 'Bengali', translateName: 'Bengali' },
  { bcp47: 'ne-NP', label: 'Nepali', translateName: 'Nepali' },
  { bcp47: 'ta-IN', label: 'Tamil', translateName: 'Tamil' },
  { bcp47: 'ja-JP', label: 'Japanese', translateName: 'Japanese' },
  { bcp47: 'ko-KR', label: 'Korean', translateName: 'Korean' },
  { bcp47: 'zh-CN', label: 'Chinese (Simplified)', translateName: 'Simplified Chinese' },
  { bcp47: 'zh-TW', label: 'Chinese (Traditional)', translateName: 'Traditional Chinese' },
  { bcp47: 'vi-VN', label: 'Vietnamese', translateName: 'Vietnamese' },
  { bcp47: 'th-TH', label: 'Thai', translateName: 'Thai' },
  { bcp47: 'id-ID', label: 'Indonesian', translateName: 'Indonesian' },
  { bcp47: 'ms-MY', label: 'Malay', translateName: 'Malay' },
  { bcp47: 'tl-PH', label: 'Filipino', translateName: 'Filipino' },
  { bcp47: 'sv-SE', label: 'Swedish', translateName: 'Swedish' },
  { bcp47: 'da-DK', label: 'Danish', translateName: 'Danish' },
  { bcp47: 'no-NO', label: 'Norwegian', translateName: 'Norwegian' },
  { bcp47: 'fi-FI', label: 'Finnish', translateName: 'Finnish' },
]

const DEFAULT_BCP47 = 'en-US'

function storageKey(meetingCode: string): string {
  return `bandr:meetingSpeechLang:${meetingCode.trim()}`
}

export function loadMeetingSpeechLang(meetingCode: string): string {
  if (typeof window === 'undefined') return DEFAULT_BCP47
  try {
    const raw = window.localStorage.getItem(storageKey(meetingCode))
    if (raw && MEETING_VOICE_LANGUAGES.some(l => l.bcp47 === raw)) return raw
  } catch {
    /* ignore */
  }
  return DEFAULT_BCP47
}

export function saveMeetingSpeechLang(meetingCode: string, bcp47: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(meetingCode), bcp47)
  } catch {
    /* ignore */
  }
}

export function translateNameForBcp47(bcp47: string): string {
  return MEETING_VOICE_LANGUAGES.find(l => l.bcp47 === bcp47)?.translateName ?? bcp47
}

/** Per-meeting preference stored locally (each browser / user). */
export function useMeetingSpeechLanguage(meetingCode: string): [string, (bcp47: string) => void] {
  const [lang, setLang] = useState(() => loadMeetingSpeechLang(meetingCode))

  useEffect(() => {
    setLang(loadMeetingSpeechLang(meetingCode))
  }, [meetingCode])

  useEffect(() => {
    saveMeetingSpeechLang(meetingCode, lang)
  }, [meetingCode, lang])

  return [lang, setLang]
}
