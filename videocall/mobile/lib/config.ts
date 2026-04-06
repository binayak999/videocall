import Constants from 'expo-constants'

/** Production API (same origin as web app). Override with EXPO_PUBLIC_API_BASE. */
export const DEFAULT_API_BASE = 'https://video.upliftsolutions.com.np'

export function getApiBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  const extra = Constants.expoConfig?.extra as { apiBase?: string } | undefined
  if (extra?.apiBase?.trim()) return extra.apiBase.replace(/\/$/, '')
  return DEFAULT_API_BASE
}

/** Socket.IO base; defaults to API host. */
export function getSignalingUrl(): string {
  const direct = process.env.EXPO_PUBLIC_SIGNALING_URL?.trim()
  if (direct) return direct.replace(/\/$/, '')
  const extra = Constants.expoConfig?.extra as { signalingUrl?: string } | undefined
  if (extra?.signalingUrl?.trim()) return extra.signalingUrl.replace(/\/$/, '')
  return getApiBase()
}

/**
 * Origin used when loading reCAPTCHA in WebView (`source.baseUrl`).
 * Must match a domain allowed for your site key in Google reCAPTCHA admin.
 * Defaults to API base (same as web app origin in typical setups).
 */
export function getRecaptchaBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_RECAPTCHA_BASE_URL?.trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  const extra = Constants.expoConfig?.extra as { recaptchaBaseUrl?: string } | undefined
  const fromExtra = extra?.recaptchaBaseUrl?.trim()
  if (fromExtra) return fromExtra.replace(/\/$/, '')
  return getApiBase()
}

/**
 * reCAPTCHA v3 **site key** (public). Same value as web `VITE_RECAPTCHA_SITE_KEY`.
 * Configure via `EXPO_PUBLIC_RECAPTCHA_SITE_KEY` or `app.json` → `expo.extra.recaptchaSiteKey`.
 */
export function getRecaptchaSiteKey(): string | undefined {
  const fromEnv = process.env.EXPO_PUBLIC_RECAPTCHA_SITE_KEY?.trim()
  if (fromEnv) return fromEnv
  const extra = Constants.expoConfig?.extra as { recaptchaSiteKey?: string } | undefined
  const k = extra?.recaptchaSiteKey?.trim()
  if (k && k.length > 0) return k
  return undefined
}
