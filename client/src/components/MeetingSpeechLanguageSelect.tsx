import { MEETING_VOICE_LANGUAGES } from '../lib/meetingLanguages'

export function MeetingSpeechLanguageSelect({
  id,
  value,
  onChange,
  className,
  disabled,
}: {
  id?: string
  value: string
  onChange: (bcp47: string) => void
  className?: string
  disabled?: boolean
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      className={className}
    >
      {MEETING_VOICE_LANGUAGES.map(l => (
        <option key={l.bcp47} value={l.bcp47}>
          {l.label}
        </option>
      ))}
    </select>
  )
}
