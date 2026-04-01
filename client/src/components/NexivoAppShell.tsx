import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuthToken } from '../lib/useAuthToken'
import { useLgUp } from '../lib/useLgUp'
import { NexivoFeaturesPanel } from './NexivoFeaturesPanel'
import { ShellBackgroundLayer } from './ShellBackgroundLayer'

export function NexivoAppShell({
  sidebar,
  children,
  selectedFeature,
  onToggleFeature,
}: {
  sidebar: ReactNode
  children: ReactNode
  selectedFeature: string | null
  onToggleFeature: (label: string | null) => void
}) {
  const authed = useAuthToken() !== null
  const lgUp = useLgUp()
  const [leftHovered, setLeftHovered] = useState(false)
  const [rightHovered, setRightHovered] = useState(false)

  const leftPanelStyle = lgUp
    ? {
        height: '60%' as const,
        transform: `perspective(900px) rotateY(${leftHovered ? 0 : 14}deg)`,
        transition: 'transform 0.35s ease',
      }
    : { transition: 'transform 0.35s ease' as const }

  const rightPanelStyle = lgUp
    ? {
        height: '60%' as const,
        transform: `perspective(900px) rotateY(${rightHovered ? 0 : -14}deg)`,
        transition: 'transform 0.35s ease',
      }
    : { transition: 'transform 0.35s ease' as const }

  return (
    <div
      className="nexivo-chrome-root fixed inset-0 flex flex-col overflow-hidden"
      style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >
      <ShellBackgroundLayer />

      <header className="relative z-20 flex w-full shrink-0 justify-center px-3 sm:px-4 lg:px-6">
        <div className="flex w-full max-w-8xl items-center justify-between gap-3 py-3 sm:py-4 lg:py-4">
          <Link to="/" className="inline-flex">
            <img src="/nexivo_logo.svg" alt="Nexivo" className="h-10 w-auto sm:h-14" draggable={false} />
          </Link>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {authed ? (
              <span className="rounded-full border border-(--nexivo-badge-border) bg-(--nexivo-badge-bg) px-3 py-1 text-xs text-(--nexivo-badge-text) backdrop-blur-sm">
                Signed in
              </span>
            ) : (
              <span className="rounded-full border border-(--nexivo-badge-border) bg-(--nexivo-badge-bg) px-3 py-1 text-xs text-(--nexivo-badge-text) backdrop-blur-sm">
                Guest
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="relative z-10 flex min-h-0 w-full flex-1 justify-center overflow-hidden px-3 sm:px-4 lg:px-6">
        <div className="flex min-h-0 w-full max-w-8xl flex-1 flex-col gap-4 overflow-y-auto overscroll-y-auto pb-4 pt-1 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden max-lg:touch-pan-y lg:flex-row lg:items-center lg:justify-center lg:gap-6 lg:overflow-hidden lg:pt-0">
          <div
            className="flex w-full shrink-0 flex-col rounded-[22px] border border-(--nexivo-border-subtle) bg-(--nexivo-panel) p-5 shadow-none backdrop-blur-xl max-lg:max-h-max lg:h-[60%] lg:w-64 lg:shrink-0"
            style={leftPanelStyle}
            onMouseEnter={() => setLeftHovered(true)}
            onMouseLeave={() => setLeftHovered(false)}
          >
            {sidebar}
          </div>

          <div className="z-10 flex min-h-[min(52vh,440px)] w-full max-w-[880px] flex-1 flex-col overflow-hidden rounded-[22px] border border-(--nexivo-border-subtle) bg-(--nexivo-panel) shadow-none backdrop-blur-xl max-lg:min-h-0 max-lg:flex-none max-lg:overflow-visible lg:h-[72%] lg:min-h-0 lg:shrink-0 lg:w-[880px] lg:max-w-none">
            <div className="flex min-h-0 flex-1 flex-col max-lg:min-h-0 max-lg:flex-none max-lg:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:overflow-y-auto lg:overscroll-contain">
              {children}
            </div>
          </div>

          <NexivoFeaturesPanel
            selectedFeature={selectedFeature}
            onToggle={onToggleFeature}
            panelStyle={rightPanelStyle}
            onMouseEnter={() => setRightHovered(true)}
            onMouseLeave={() => setRightHovered(false)}
          />
        </div>
      </div>
    </div>
  )
}
