let recaptchaLoadPromise: Promise<void> | null = null

declare global {
  interface Window {
    grecaptcha?: {
      ready: (cb: () => void) => void
      execute: (siteKey: string, opts: { action: string }) => Promise<string>
    }
  }
}

export function loadRecaptchaScript(siteKey: string): Promise<void> {
  if (recaptchaLoadPromise) return recaptchaLoadPromise
  recaptchaLoadPromise = new Promise((resolve, reject) => {
    if (window.grecaptcha?.execute) {
      resolve()
      return
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="https://www.google.com/recaptcha/api.js"]`,
    )
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true })
      existing.addEventListener("error", () => reject(new Error("reCAPTCHA script failed")), { once: true })
      return
    }
    const s = document.createElement("script")
    s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error("reCAPTCHA script failed"))
    document.head.appendChild(s)
  })
  return recaptchaLoadPromise
}

/** Load the v3 script on page load so the corner badge appears (v3 has no visible challenge). */
export function warmupRecaptcha(siteKey: string | undefined): void {
  if (!siteKey || siteKey.length === 0) return
  void loadRecaptchaScript(siteKey)
}

/** Returns a v3 token, or `undefined` if no site key is configured. */
export async function getRecaptchaToken(siteKey: string | undefined, action: string): Promise<string | undefined> {
  if (!siteKey || siteKey.length === 0) return undefined
  await loadRecaptchaScript(siteKey)
  const g = window.grecaptcha
  if (!g) return undefined
  return new Promise((resolve, reject) => {
    g.ready(async () => {
      try {
        const token = await g.execute(siteKey, { action })
        resolve(token)
      } catch (e) {
        reject(e instanceof Error ? e : new Error("reCAPTCHA execute failed"))
      }
    })
  })
}
