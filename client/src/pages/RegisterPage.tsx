import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { errorMessage, register } from '../lib/api'
import { setToken } from '../lib/auth'
import { useAuthToken } from '../lib/useAuthToken'

export function RegisterPage() {
  const navigate = useNavigate()
  const authed = useAuthToken() !== null
  const [name, setName] = useState('')
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
      const r = await register({ name: name.trim(), email: email.trim(), password })
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
        <div className="w-full max-w-sm rounded-[22px] bg-[#1c1c1e]/90 backdrop-blur-xl p-7">

          <h1 className="text-2xl font-bold tracking-tight text-white/90">Create account</h1>
          <p className="mt-1.5 text-sm text-white/50">
            Already have an account?{' '}
            <Link to="/login" className="text-[#f59e0b] hover:text-[#fbbf24] transition">
              Sign in
            </Link>
          </p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Name</span>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                autoComplete="name"
                required
                className="h-11 rounded-xl border border-white/8 bg-white/6 px-4 text-sm text-white/90 placeholder-white/20 outline-none transition focus:border-[#f59e0b]/50 focus:bg-white/9"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Email</span>
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                type="email"
                autoComplete="email"
                required
                className="h-11 rounded-xl border border-white/8 bg-white/6 px-4 text-sm text-white/90 placeholder-white/20 outline-none transition focus:border-[#f59e0b]/50 focus:bg-white/9"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Password</span>
              <input
                value={password}
                onChange={e => setPassword(e.target.value)}
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                className="h-11 rounded-xl border border-white/8 bg-white/6 px-4 text-sm text-white/90 placeholder-white/20 outline-none transition focus:border-[#f59e0b]/50 focus:bg-white/9"
              />
            </label>

            {err && <p className="text-xs text-red-400">{err}</p>}

            <button
              type="submit"
              disabled={busy}
              className="mt-1 h-11 rounded-xl bg-[#f59e0b] text-sm font-semibold text-black transition hover:bg-[#fbbf24] disabled:opacity-40"
            >
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
