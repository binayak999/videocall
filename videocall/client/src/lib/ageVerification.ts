/**
 * Age attestation stored on device. This is not legal ID verification;
 * regulated products require vendor-approved age checks.
 */

const STORAGE_KEY = 'bandr_age_attestation_v1'

export interface AgeAttestation {
  /** ISO date string YYYY-MM-DD */
  birthDate: string
  /** When the user submitted (ms) */
  attestedAt: number
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = (import.meta.env as Record<string, string | undefined>)[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 && n < 130 ? n : fallback
}

export const MINIMUM_AGE_YEARS = parseEnvInt('VITE_MINIMUM_AGE', 18)

export function ageFromBirthDate(birthDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const d = Number(m[3])
  const born = new Date(y, mo, d)
  if (born.getFullYear() !== y || born.getMonth() !== mo || born.getDate() !== d) return null
  const today = new Date()
  let age = today.getFullYear() - born.getFullYear()
  const md = today.getMonth() - born.getMonth()
  if (md < 0 || (md === 0 && today.getDate() < born.getDate())) age--
  return age
}

export function meetsMinimumAge(birthDate: string): boolean {
  const age = ageFromBirthDate(birthDate)
  return age !== null && age >= MINIMUM_AGE_YEARS
}

export function readAgeAttestation(): AgeAttestation | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as { birthDate?: unknown; attestedAt?: unknown }
    if (typeof o.birthDate !== 'string' || typeof o.attestedAt !== 'number') return null
    if (!meetsMinimumAge(o.birthDate)) return null
    return { birthDate: o.birthDate, attestedAt: o.attestedAt }
  } catch {
    return null
  }
}

export function saveAgeAttestation(birthDate: string): boolean {
  if (!meetsMinimumAge(birthDate)) return false
  const payload: AgeAttestation = { birthDate, attestedAt: Date.now() }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  return true
}

export function clearAgeAttestation(): void {
  localStorage.removeItem(STORAGE_KEY)
}
