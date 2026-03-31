import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { ShellBackgroundLayer } from '../components/ShellBackgroundLayer'
import { useAppTheme } from '../components/ThemeProvider'
import { GoogleSignInButton } from '../components/GoogleSignInButton'
import { RecaptchaDisclosure } from '../components/RecaptchaDisclosure'
import { errorMessage, login, loginWithGoogle } from '../lib/api'
import { getRecaptchaToken, warmupRecaptcha } from '../lib/recaptchaBrowser'
import { setToken } from '../lib/auth'
import { useAuthToken } from '../lib/useAuthToken'

const fieldClass =
  'h-11 rounded-xl border border-(--nexivo-input-border) bg-(--nexivo-input-bg) px-4 text-sm text-(--nexivo-text) outline-none transition placeholder:text-(--nexivo-placeholder) focus:border-[#f59e0b]/50'

export function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const theme = useAppTheme()
  const authed = useAuthToken() !== null
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY
  const googleClientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim()

  useEffect(() => {
    if (!authed) warmupRecaptcha(recaptchaSiteKey)
  }, [authed, recaptchaSiteKey])

  if (authed) return <Navigate to="/" replace />

  const redirectAfterAuth = () => {
    const redirect = searchParams.get('redirect')
    if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) {
      navigate(redirect, { replace: true })
    } else {
      navigate('/', { replace: true })
    }
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const recaptchaToken = await getRecaptchaToken(recaptchaSiteKey, 'login')
      const r = await login({ email: email.trim(), password, recaptchaToken })
      setToken(r.token)
      redirectAfterAuth()
    } catch (e2: unknown) {
      setErr(errorMessage(e2))
    } finally {
      setBusy(false)
    }
  }

  const onGoogleCredential = async (idToken: string) => {
    setBusy(true)
    setErr(null)
    try {
      const recaptchaToken = await getRecaptchaToken(recaptchaSiteKey, 'google_login')
      const r = await loginWithGoogle({ idToken, recaptchaToken })
      setToken(r.token)
      redirectAfterAuth()
    } catch (e2: unknown) {
      setErr(errorMessage(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col overflow-x-hidden overflow-y-auto" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <ShellBackgroundLayer />

      <div className="relative z-20 flex shrink-0 items-center justify-between gap-3 px-4 py-3 sm:px-8 sm:py-4 lg:px-10">
        <Link to="/">
          <img src="/nexivo_logo.svg" alt="Nexivo" className="h-10 w-auto sm:h-14" draggable={false} />
        </Link>
        <label className="sr-only" htmlFor="login-theme">
          Theme
        </label>
        <select
          id="login-theme"
          value={theme.preference}
          onChange={e => {
            const v = e.target.value
            if (v === 'light' || v === 'dark' || v === 'system') theme.setPreference(v)
          }}
          className="h-9 max-w-34 cursor-pointer rounded-lg border border-(--nexivo-input-border) bg-(--nexivo-input-bg) px-2 text-xs text-(--nexivo-text) outline-none backdrop-blur-sm focus:border-[#f59e0b]/50"
          aria-label="Theme"
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-4 py-6 sm:min-h-[calc(100vh-80px)] sm:py-0">
        <div className="w-full max-w-sm rounded-[22px] border border-(--nexivo-border-subtle) bg-(--nexivo-panel) p-6 backdrop-blur-xl sm:p-7">
          <h1 className="text-2xl font-bold tracking-tight text-(--nexivo-text)">Sign in</h1>
          <p className="mt-1.5 text-sm text-(--nexivo-text-muted)">
            Don&apos;t have an account?{' '}
            <Link to="/register" className="text-[#f59e0b] transition hover:text-[#fbbf24]">
              Register
            </Link>
          </p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-(--nexivo-text-muted) uppercase tracking-wider">Email</span>
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                type="email"
                autoComplete="email"
                required
                className={fieldClass}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-(--nexivo-text-muted) uppercase tracking-wider">Password</span>
              <input
                value={password}
                onChange={e => setPassword(e.target.value)}
                type="password"
                autoComplete="current-password"
                required
                className={fieldClass}
              />
            </label>

            {err && <p className="text-xs text-red-400">{err}</p>}

            <button
              type="submit"
              disabled={busy}
              className="mt-1 h-11 rounded-xl bg-[#f59e0b] text-sm font-semibold text-black transition hover:bg-[#fbbf24] disabled:opacity-40"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {googleClientId.length > 0 && (
            <div className="mt-5">
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-(--nexivo-border-subtle)" />
                <span className="text-xs text-(--nexivo-text-muted)">or</span>
                <div className="h-px flex-1 bg-(--nexivo-border-subtle)" />
              </div>
              <div className="mt-4">
                <GoogleSignInButton clientId={googleClientId} onCredential={onGoogleCredential} disabled={busy} />
              </div>
            </div>
          )}

          <RecaptchaDisclosure />
        </div>
      </div>
    </div>
  )
}
