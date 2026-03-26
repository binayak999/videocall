import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { clearToken } from '../lib/auth'
import { useAuthToken } from '../lib/useAuthToken'
import { useTheme } from '../lib/useTheme'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function Layout() {
  const navigate = useNavigate()
  const token = useAuthToken()
  const authed = token !== null
  const theme = useTheme()

  return (
    <div className="min-h-svh bg-(--bg) text-(--text)">
      <header className="sticky top-0 z-10 border-b border-(--border) bg-[color-mix(in_oklab,var(--bg)_92%,transparent)] backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-(--text-h) no-underline">
            <img
              src="/nexivo_logo.svg"
              alt="Nexivo"
              className="h-8 w-auto"
              draggable={false}
            />
          </Link>

          <nav className="flex items-center gap-2">
            <label className="sr-only" htmlFor="theme">
              Theme
            </label>
            <select
              id="theme"
              value={theme.preference}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'light' || v === 'dark' || v === 'system') theme.setPreference(v)
              }}
              className="h-9 rounded-lg border border-(--border) bg-(--bg) px-2 text-sm text-(--text-h) outline-none hover:bg-(--social-bg) focus:border-(--accent-border)"
              aria-label="Theme"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>

            <NavLink
              to="/"
              className={({ isActive }) =>
                cx(
                  'rounded-lg px-3 py-2 text-sm no-underline transition',
                  isActive ? 'bg-(--code-bg) text-(--text-h)' : 'text-(--text) hover:bg-(--social-bg)',
                )
              }
              end
            >
              Home
            </NavLink>

            {!authed ? (
              <>
                <NavLink
                  to="/login"
                  className={({ isActive }) =>
                    cx(
                      'rounded-lg px-3 py-2 text-sm no-underline transition',
                      isActive ? 'bg-(--code-bg) text-(--text-h)' : 'text-(--text) hover:bg-(--social-bg)',
                    )
                  }
                >
                  Login
                </NavLink>
                <NavLink
                  to="/register"
                  className={({ isActive }) =>
                    cx(
                      'rounded-lg px-3 py-2 text-sm no-underline transition',
                      isActive ? 'bg-(--code-bg) text-(--text-h)' : 'text-(--text) hover:bg-(--social-bg)',
                    )
                  }
                >
                  Register
                </NavLink>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  clearToken()
                  navigate('/', { replace: true })
                }}
                className="rounded-lg px-3 py-2 text-sm text-(--text-h) transition hover:bg-(--social-bg)"
              >
                Logout
              </button>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-10">
        <Outlet />
      </main>

      <footer className="border-t border-(--border)">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 text-sm text-(--text)">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Public view for meetings on <span className="font-semibold text-(--text-h)">Nexivo</span>
            </span>
            <a
              className="text-(--text) underline underline-offset-4 hover:text-(--text-h)"
              href="/api"
              target="_blank"
              rel="noreferrer"
            >
              API manifest
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}

