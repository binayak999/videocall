import type { CSSProperties, ReactNode } from 'react'

export type NexivoFeatureItem = {
  label: string
  detail: string
  color: string
  icon: ReactNode
}

export const NEXIVO_FEATURE_ITEMS: NexivoFeatureItem[] = [
  {
    label: 'Video Call',
    detail: 'HD peer-to-peer video',
    color: '#3b82f6',
    icon: <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />,
  },
  {
    label: 'Meeting Room',
    detail: 'Multi-participant rooms',
    color: '#f59e0b',
    icon: (
      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
    ),
  },
  {
    label: 'Whiteboard',
    detail: 'Real-time collaborative canvas',
    color: '#a855f7',
    icon: <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />,
  },
  {
    label: 'Chat',
    detail: 'In-meeting messaging',
    color: '#22c55e',
    icon: <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" />,
  },
  {
    label: 'Note Taker',
    detail: 'Save notes in the call; export or share anytime',
    color: '#f43f5e',
    icon: (
      <path d="M3 18h12v-2H3v2zm0-5h12v-2H3v2zm0-7v2h12V6H3zm13 9.17V12h-2v6.17l-1.59-1.59L11 18l3.5 3.5L18 18l-1.41-1.41L15 18.17zM20 6h-2V4h-2v2h-2v2h2v2h2V8h2V6z" />
    ),
  },
  {
    label: 'Screen Share',
    detail: 'Share your display live',
    color: '#06b6d4',
    icon: <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z" />,
  },
]

type NexivoFeaturesPanelProps = {
  selectedFeature: string | null
  onToggle: (label: string | null) => void
  panelStyle?: CSSProperties
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export function NexivoFeaturesPanel({
  selectedFeature,
  onToggle,
  panelStyle,
  onMouseEnter,
  onMouseLeave,
}: NexivoFeaturesPanelProps) {
  return (
    <div
      className="flex w-full shrink-0 flex-col rounded-[22px] border border-(--nexivo-border-subtle) bg-(--nexivo-panel) p-5 shadow-none backdrop-blur-xl max-lg:max-h-[min(42vh,340px)] max-lg:overflow-y-auto lg:h-[60%] lg:w-64 lg:shrink-0"
      style={panelStyle}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <p className="mb-3 px-1 text-[0.6rem] font-bold uppercase tracking-[0.2em] text-(--nexivo-nav-label)">Features</p>
      <div className="flex flex-col gap-0.5 overflow-y-auto">
        {NEXIVO_FEATURE_ITEMS.map(({ label, detail, color, icon }) => {
          const active = selectedFeature === label
          return (
            <button
              key={label}
              type="button"
              onClick={() => onToggle(active ? null : label)}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition"
              style={{ backgroundColor: active ? `${color}18` : undefined }}
            >
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition"
                style={{ backgroundColor: active ? `${color}35` : `${color}20` }}
              >
                <svg viewBox="0 0 24 24" fill={color} width="16" height="16">
                  {icon}
                </svg>
              </div>
              <div className="min-w-0">
                <p
                  className="truncate text-xs font-semibold transition"
                  style={{ color: active ? color : 'var(--nexivo-text-secondary)' }}
                >
                  {label}
                </p>
                <p className="truncate text-[0.6rem] text-(--nexivo-text-muted)">{detail}</p>
              </div>
              {active && (
                <div className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
