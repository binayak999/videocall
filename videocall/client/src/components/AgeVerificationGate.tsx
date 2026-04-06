import { type ReactNode, useCallback, useState } from 'react'
import {
  clearAgeAttestation,
  meetsMinimumAge,
  MINIMUM_AGE_YEARS,
  readAgeAttestation,
  saveAgeAttestation,
} from '../lib/ageVerification'

export function AgeVerificationGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(() => readAgeAttestation() !== null)
  const [birthDate, setBirthDate] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(() => {
    setError(null)
    if (!birthDate) {
      setError('Enter your date of birth.')
      return
    }
    if (!meetsMinimumAge(birthDate)) {
      setError(`You must be at least ${MINIMUM_AGE_YEARS} to use this service.`)
      return
    }
    saveAgeAttestation(birthDate)
    setOk(true)
  }, [birthDate])

  if (ok) return <>{children}</>

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        background: 'radial-gradient(ellipse at top, #1a1a2e 0%, #0d0d12 55%, #050508 100%)',
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#16161c]/95 p-6 shadow-2xl backdrop-blur-xl">
        <h1 className="text-lg font-semibold tracking-tight text-white">Age confirmation</h1>
        <p className="mt-2 text-sm leading-relaxed text-white/55">
          This product is intended for adults. Enter your date of birth. This is stored only on this device as a
          self-declaration and is not the same as government ID verification.
        </p>

        <label className="mt-5 block text-xs font-medium uppercase tracking-wider text-white/35">
          Date of birth
        </label>
        <input
          type="date"
          value={birthDate}
          onChange={e => setBirthDate(e.target.value)}
          max={new Date().toISOString().slice(0, 10)}
          className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-500/40"
        />

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        <button
          type="button"
          onClick={submit}
          className="mt-5 w-full rounded-xl bg-amber-500 py-2.5 text-sm font-semibold text-black transition hover:bg-amber-400"
        >
          Continue
        </button>

        <p className="mt-4 text-center text-[0.65rem] text-white/30">
          Wrong account?{' '}
          <button
            type="button"
            className="text-amber-500/80 underline-offset-2 hover:underline"
            onClick={() => {
              clearAgeAttestation()
              setBirthDate('')
              setError(null)
            }}
          >
            Clear saved attestation
          </button>
        </p>
      </div>
    </div>
  )
}
