import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppTheme } from '../components/ThemeProvider'
import {
  clearCustomShellBackground,
  SHELL_BACKGROUND_PRESETS,
  setShellBackgroundCustomDataUrl,
  setShellBackgroundPreset,
  type ShellBackgroundPresetId,
} from '../lib/shellBackground'
import { useShellBackground, useShellBackgroundSelection } from '../lib/useShellBackground'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function ShellBackgroundSettings() {
  const selection = useShellBackgroundSelection()
  const resolved = useShellBackground()
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const presetSelected = (id: ShellBackgroundPresetId) =>
    selection.mode === 'preset' && selection.id === id

  return (
    <div>
      <label className="mb-2 block text-[0.65rem] font-bold uppercase tracking-[0.15em] text-(--nexivo-nav-label)">
        Shell background
      </label>
      <p className="mb-3 text-sm text-(--nexivo-text-muted)">
        Backdrop for home, login, register, meeting lobby, and the loading screen. Saved only on this browser.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SHELL_BACKGROUND_PRESETS.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setUploadErr(null)
              setShellBackgroundPreset(p.id)
            }}
            className={cx(
              'flex flex-col gap-1.5 rounded-xl border p-2 text-left transition',
              presetSelected(p.id)
                ? 'border-[#f59e0b] bg-[#f59e0b]/12 ring-2 ring-[#f59e0b]/45'
                : 'border-(--nexivo-border-subtle) bg-(--nexivo-input-bg) hover:border-(--nexivo-border)',
            )}
          >
            <div className="aspect-video w-full overflow-hidden rounded-lg ring-1 ring-(--nexivo-border-subtle)">
              {p.kind === 'image' ? (
                <img src={p.src} alt="" draggable={false} className="h-full w-full object-cover" />
              ) : (
                <div className="h-full w-full" style={{ background: p.css }} />
              )}
            </div>
            <span className="text-xs font-semibold text-(--nexivo-text)">{p.label}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setUploadErr(null)
            fileRef.current?.click()
          }}
          className={cx(
            'flex flex-col gap-1.5 rounded-xl border border-dashed p-2 text-left transition',
            selection.mode === 'custom'
              ? 'border-[#f59e0b] bg-[#f59e0b]/12 ring-2 ring-[#f59e0b]/45'
              : 'border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) hover:border-(--nexivo-border)',
          )}
        >
          <div className="aspect-video w-full overflow-hidden rounded-lg bg-(--nexivo-muted-surface) ring-1 ring-(--nexivo-border-subtle)">
            {selection.mode === 'custom' && resolved.kind === 'image' ? (
              <img src={resolved.src} alt="" draggable={false} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center px-2 text-center text-[0.65rem] font-medium text-(--nexivo-text-muted)">
                + Upload photo
              </div>
            )}
          </div>
          <span className="text-xs font-semibold text-(--nexivo-text)">Your image</span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label="Upload shell background image"
        onChange={e => {
          setUploadErr(null)
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          if (!f.type.startsWith('image/')) {
            setUploadErr('Choose an image file.')
            return
          }
          const reader = new FileReader()
          reader.onload = () => {
            try {
              setShellBackgroundCustomDataUrl(reader.result as string)
            } catch (err: unknown) {
              setUploadErr(err instanceof Error ? err.message : 'Could not use this image.')
            }
          }
          reader.onerror = () => setUploadErr('Could not read the file.')
          reader.readAsDataURL(f)
        }}
      />
      {selection.mode === 'custom' && (
        <button
          type="button"
          className="mt-3 text-sm font-medium text-(--nexivo-link) underline-offset-2 hover:underline"
          onClick={() => {
            setUploadErr(null)
            clearCustomShellBackground()
          }}
        >
          Remove custom image
        </button>
      )}
      {uploadErr && <p className="mt-2 text-xs text-red-400">{uploadErr}</p>}
    </div>
  )
}

type SettingsTab = 'features' | 'settings'

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('features')
  const theme = useAppTheme()

  const tabInactive = 'text-(--nexivo-text-muted) hover:bg-(--nexivo-nav-hover) hover:text-(--nexivo-text-secondary)'

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-5 text-left">
      <h1 className="text-xl font-bold tracking-tight text-(--nexivo-text)">Settings</h1>
      <p className="mt-1 text-sm text-(--nexivo-text-muted)">
        Product overview and app preferences. In-call options (camera background, recording, captions) stay in the meeting gear menu.
      </p>

      <div
        role="tablist"
        aria-label="Settings sections"
        className="mt-5 flex gap-1 rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'features'}
          className={cx(
            'flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold transition',
            tab === 'features' ? 'bg-[#f59e0b] text-black' : tabInactive,
          )}
          onClick={() => setTab('features')}
        >
          Features
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'settings'}
          className={cx(
            'flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold transition',
            tab === 'settings' ? 'bg-[#f59e0b] text-black' : tabInactive,
          )}
          onClick={() => setTab('settings')}
        >
          Settings
        </button>
      </div>

      {tab === 'features' && (
        <div
          role="tabpanel"
          className="mt-5 space-y-5 rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) p-5"
          aria-label="Features"
        >
          <section>
            <h2 className="text-sm font-semibold text-(--nexivo-text)">Meetings</h2>
            <p className="mt-1 text-sm leading-relaxed text-(--nexivo-text-muted)">
              Create or join video calls with a meeting code. Grid layout, presenter mode for screen share, and optional Bandr Companion for remote control.
            </p>
          </section>
          <section className="border-t border-(--nexivo-border-subtle) pt-5">
            <h2 className="text-sm font-semibold text-(--nexivo-text)">Live captions &amp; transcripts</h2>
            <p className="mt-1 text-sm leading-relaxed text-(--nexivo-text-muted)">
              Turn on closed captions in the call to show subtitles, share speech with others, and save phrases to the meeting. Download a transcript from the host tools in a call.
            </p>
          </section>
          <section className="border-t border-(--nexivo-border-subtle) pt-5">
            <h2 className="text-sm font-semibold text-(--nexivo-text)">Host recording</h2>
            <p className="mt-1 text-sm leading-relaxed text-(--nexivo-text-muted)">
              The meeting host can record tiles and mixed audio. Recordings upload to your account; open{' '}
              <Link to="/recordings" className="font-medium text-(--nexivo-link) underline-offset-2 hover:underline">
                Recordings
              </Link>{' '}
              to play them back.
            </p>
          </section>
          <section className="border-t border-(--nexivo-border-subtle) pt-5">
            <h2 className="text-sm font-semibold text-(--nexivo-text)">Notes board</h2>
            <p className="mt-1 text-sm leading-relaxed text-(--nexivo-text-muted)">
              During a call, open the meeting gear menu → <strong className="text-(--nexivo-text-secondary)">Features</strong> → Notes board for a per-meeting scratchpad (saved on this device). On the home page, use the full notes workspace.
            </p>
            <Link
              to="/?panel=notes"
              className="mt-3 inline-flex text-sm font-medium text-(--nexivo-link) underline-offset-2 hover:underline"
            >
              Open home notes workspace
            </Link>
          </section>
          <section className="border-t border-(--nexivo-border-subtle) pt-5">
            <h2 className="text-sm font-semibold text-(--nexivo-text)">Agenda &amp; AI check</h2>
            <p className="mt-1 text-sm leading-relaxed text-(--nexivo-text-muted)">
              Hosts can paste an agenda and run an AI check against the saved meeting transcript. In a call, open{' '}
              <strong className="text-(--nexivo-text-secondary)">Meeting → Features → Agenda &amp; AI check</strong>.
            </p>
          </section>
          <section className="border-t border-(--nexivo-border-subtle) pt-5">
            <h2 className="text-sm font-semibold text-(--nexivo-text)">Whiteboard</h2>
            <p className="mt-1 text-sm leading-relaxed text-(--nexivo-text-muted)">
              Open a shared canvas from <strong className="text-(--nexivo-text-secondary)">Meeting → Features → Whiteboard</strong>. The person who opens it controls closing; others can request to draw from the board UI.
            </p>
          </section>
        </div>
      )}

      {tab === 'settings' && (
        <div
          role="tabpanel"
          className="mt-5 space-y-6 rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) p-5"
          aria-label="App settings"
        >
          <div>
            <label className="mb-2 block text-[0.65rem] font-bold uppercase tracking-[0.15em] text-(--nexivo-nav-label)">
              Theme
            </label>
            <p className="mb-3 text-sm text-(--nexivo-text-muted)">Applies across the site (home, recordings, settings).</p>
            <select
              value={theme.preference}
              onChange={e => {
                const v = e.target.value
                if (v === 'light' || v === 'dark' || v === 'system') theme.setPreference(v)
              }}
              className="w-full max-w-xs rounded-xl border border-(--nexivo-input-border) bg-(--nexivo-input-bg) px-3 py-2.5 text-sm text-(--nexivo-text) outline-none transition focus:border-[#f59e0b]/50"
              aria-label="Theme"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <div className="border-t border-(--nexivo-border-subtle) pt-6">
            <ShellBackgroundSettings />
          </div>
        </div>
      )}
    </div>
  )
}
