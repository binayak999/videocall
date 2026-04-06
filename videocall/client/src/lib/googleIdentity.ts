declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: {
            client_id: string
            callback: (resp: { credential: string }) => void
            auto_select?: boolean
            use_fedcm_for_prompt?: boolean
          }) => void
          renderButton: (
            parent: HTMLElement,
            options: {
              type?: string
              theme?: string
              size?: string
              text?: string
              width?: string | number
              locale?: string
            },
          ) => void
        }
      }
    }
  }
}

let gsiLoadPromise: Promise<void> | null = null

export function loadGoogleIdentityScript(): Promise<void> {
  if (gsiLoadPromise) return gsiLoadPromise
  gsiLoadPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve()
      return
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="https://accounts.google.com/gsi/client"]`,
    )
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true })
      existing.addEventListener("error", () => reject(new Error("Google Identity script failed")), { once: true })
      return
    }
    const s = document.createElement("script")
    s.src = "https://accounts.google.com/gsi/client"
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error("Google Identity script failed"))
    document.head.appendChild(s)
  })
  return gsiLoadPromise
}
