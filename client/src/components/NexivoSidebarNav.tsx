import { type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { clearToken } from '../lib/auth'
import { useAuthToken } from '../lib/useAuthToken'
import { useLayoutApp } from './LayoutAppContext'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

const navItems: Array<{
  label: string
  key: 'home' | 'join' | 'create' | 'notes' | 'control' | 'settings' | 'recordings' | 'login' | 'register'
  icon: ReactNode
}> = [
  {
    label: 'Home',
    key: 'home',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
      </svg>
    ),
  },
  {
    label: 'Join Meeting',
    key: 'join',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z" />
      </svg>
    ),
  },
  {
    label: 'Create Meeting',
    key: 'create',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
      </svg>
    ),
  },
  {
    label: 'Notes',
    key: 'notes',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path d="M3 18h12v-2H3v2zm0-5h12v-2H3v2zm0-7v2h12V6H3zm14 8.17V12h-2v6.17l-1.59-1.59L12 18l3.5 3.5L18 18l-1.41-1.41L17 18.17z" />
      </svg>
    ),
  },
  {
    label: 'Control',
    key: 'control',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.07.63-.07.94 0 .31.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
      </svg>
    ),
  },
  {
    label: 'Settings',
    key: 'settings',
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.07.63-.07.94 0 .31.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
      </svg>
    ),
  },
]

export function NexivoSidebarNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const authed = useAuthToken() !== null
  const { systemRtcLoaded, canControlRtcMode } = useLayoutApp()
  const panel = searchParams.get('panel')
  const tab = searchParams.get('tab')

  const showControlNav = systemRtcLoaded && canControlRtcMode

  const authedItems = authed
    ? ([
        {
          label: 'My Recordings',
          key: 'recordings' as const,
          icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
            </svg>
          ),
        },
      ] as const)
    : []

  const guestItems = !authed
    ? ([
        {
          label: 'Login',
          key: 'login' as const,
          icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
          ),
        },
        {
          label: 'Register',
          key: 'register' as const,
          icon: (
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
          ),
        },
      ] as const)
    : []

  const coreNav = showControlNav ? navItems : navItems.filter(i => i.key !== 'control')
  const items = [...coreNav, ...authedItems, ...guestItems]

  function navActive(navKey: (typeof items)[number]['key']): boolean {
    if (navKey === 'recordings') return pathname.startsWith('/recordings')
    if (navKey === 'settings') return pathname.startsWith('/settings')
    if (navKey === 'control') return pathname.startsWith('/control')
    if (navKey === 'login') return pathname.startsWith('/login')
    if (navKey === 'register') return pathname.startsWith('/register')
    if (pathname !== '/') return false
    if (panel === 'notes') return navKey === 'notes'
    if (navKey === 'notes') return false
    if (navKey === 'home') return tab == null || tab === ''
    if (navKey === 'join') return tab === 'join'
    if (navKey === 'create') return tab === 'create'
    return false
  }

  return (
    <>
      <p className="mb-4 px-1 text-[0.6rem] font-bold uppercase tracking-[0.2em] text-(--nexivo-nav-label)">
        Navigation
      </p>
      <div className="flex flex-col gap-0.5">
        {items.map(({ label, key: navKey, icon }) => {
          const active = navActive(navKey)
          const to =
            navKey === 'login'
              ? '/login'
              : navKey === 'register'
                ? '/register'
                : navKey === 'notes'
                  ? '/?panel=notes'
                  : navKey === 'control'
                    ? '/control'
                  : navKey === 'settings'
                    ? '/settings'
                    : navKey === 'recordings'
                      ? '/recordings'
                      : navKey === 'join'
                        ? '/?tab=join'
                        : navKey === 'create'
                          ? '/?tab=create'
                          : '/'
          return (
            <Link
              key={navKey}
              to={to}
              className={cx(
                'flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition no-underline',
                active
                  ? 'bg-[#f59e0b] text-black'
                  : 'text-(--nexivo-nav-muted) hover:bg-(--nexivo-nav-hover) hover:text-(--nexivo-text)',
              )}
            >
              <span className={active ? 'text-black' : 'text-(--nexivo-text-subtle)'}>{icon}</span>
              <span className="flex-1 text-sm font-medium">{label}</span>
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                width="12"
                height="12"
                className={active ? 'text-black/50' : 'text-(--nexivo-text-subtle)'}
              >
                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
              </svg>
            </Link>
          )
        })}
      </div>

      {authed && (
        <button
          type="button"
          onClick={() => {
            clearToken()
            navigate('/', { replace: true })
          }}
          className="mt-auto flex items-center gap-3 rounded-xl px-3 py-2.5 text-red-400 transition hover:bg-red-500/10"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" />
          </svg>
          <span className="flex-1 text-sm font-medium">Logout</span>
        </button>
      )}
    </>
  )
}
