/**
 * reCAPTCHA v3 is score-based and does not show a checkbox. Google shows a small badge (bottom-right)
 * once the script loads; this text satisfies branding expectations when the badge is easy to miss.
 */
export function RecaptchaDisclosure() {
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY
  if (typeof siteKey !== 'string' || siteKey.length === 0) return null

  return (
    <p className="mt-5 text-center text-[10px] leading-snug text-(--nexivo-text-muted)">
      This site is protected by reCAPTCHA and the Google{' '}
      <a
        href="https://policies.google.com/privacy"
        className="text-(--nexivo-link) underline underline-offset-2"
        target="_blank"
        rel="noreferrer"
      >
        Privacy Policy
      </a>{' '}
      and{' '}
      <a
        href="https://policies.google.com/terms"
        className="text-(--nexivo-link) underline underline-offset-2"
        target="_blank"
        rel="noreferrer"
      >
        Terms of Service
      </a>{' '}
      apply.
    </p>
  )
}
