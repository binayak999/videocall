import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { errorMessage, login } from '../lib/api'
import { setToken } from '../lib/auth'
import { useAuthToken } from '../lib/useAuthToken'

export function LoginPage() {
  const navigate = useNavigate()
  const authed = useAuthToken() !== null
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (authed) return <Navigate to="/" replace />

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const r = await login({ email: email.trim(), password })
      setToken(r.token)
      navigate('/', { replace: true })
    } catch (e2: unknown) {
      setErr(errorMessage(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* background image */}
      <img
        src="/image.png"
        alt=""
        aria-hidden
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
      />

      {/* header */}
      <div className="relative z-20 flex items-center px-10 py-4">
        <Link to="/">
          <img src="/nexivo_logo.svg" alt="Nexivo" className="h-14 w-auto" draggable={false} />
        </Link>
      </div>

      {/* centered card */}
      <div className="relative z-10 flex h-[calc(100vh-80px)] items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-[22px] bg-gradient-to-br from-white/90 to-white/70 backdrop-blur-xl p-7">

          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Sign in</h1>
          <p className="mt-1.5 text-sm text-gray-500">
            Don't have an account?{' '}
            <Link to="/register" className="text-[#f59e0b] hover:text-[#fbbf24] transition">
              Register
            </Link>
          </p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Email</span>
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                type="email"
                autoComplete="email"
                required
                className="h-11 rounded-xl border border-gray-200 bg-white/80 px-4 text-sm text-gray-900 placeholder-gray-300 outline-none transition focus:border-[#f59e0b]/50 focus:bg-white/[0.09]"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Password</span>
              <input
                value={password}
                onChange={e => setPassword(e.target.value)}
                type="password"
                autoComplete="current-password"
                required
                className="h-11 rounded-xl border border-gray-200 bg-white/80 px-4 text-sm text-gray-900 placeholder-gray-300 outline-none transition focus:border-[#f59e0b]/50 focus:bg-white/[0.09]"
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
        </div>
      </div>
    </div>
  )
}
