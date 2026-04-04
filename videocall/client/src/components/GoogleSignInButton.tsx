import { useEffect, useRef } from 'react'
import { loadGoogleIdentityScript } from '../lib/googleIdentity'

type Props = {
  clientId: string
  onCredential: (idToken: string) => void
  disabled?: boolean
}

export function GoogleSignInButton({ clientId, onCredential, disabled }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const callbackRef = useRef(onCredential)

  useEffect(() => {
    callbackRef.current = onCredential
  }, [onCredential])

  useEffect(() => {
    if (!clientId || clientId.length === 0) return
    let cancelled = false
    const el = containerRef.current
    if (!el) return

    void (async () => {
      try {
        await loadGoogleIdentityScript()
        if (cancelled || !containerRef.current) return
        const id = window.google?.accounts?.id
        if (!id) return
        id.initialize({
          client_id: clientId,
          callback: resp => {
            if (typeof resp.credential === 'string' && resp.credential.length > 0) {
              callbackRef.current(resp.credential)
            }
          },
          // Avoid FedCM “GeneralOAuthFlow” until OAuth client + origins match; easier to debug with classic GIS.
          use_fedcm_for_prompt: false,
        })
        const host = containerRef.current
        host.innerHTML = ''
        const paintButton = (): void => {
          if (cancelled || !containerRef.current) return
          const h = containerRef.current
          // GIS only accepts width in pixels, not "100%" (see GSI_LOGGER invalid width warning).
          const raw = h.offsetWidth
          const widthPx = raw > 0 ? Math.min(Math.max(Math.round(raw), 200), 400) : 400
          id.renderButton(h, {
            type: 'standard',
            theme: 'outline',
            size: 'large',
            text: 'continue_with',
            width: widthPx,
          })
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(paintButton)
        })
      } catch {
        /* optional: surface in parent */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [clientId])

  return (
    <div
      ref={containerRef}
      className="min-h-[44px] w-full [&>div]:w-full"
      aria-hidden={disabled}
      style={{ pointerEvents: disabled ? 'none' : undefined, opacity: disabled ? 0.45 : undefined }}
    />
  )
}
