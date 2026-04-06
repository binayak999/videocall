/**
 * Decode JWT payload (same fields as web MeetingPage) without verifying signature.
 */
function decodePayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
    const bin = globalThis.atob(b64 + pad)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    const json = new TextDecoder().decode(bytes)
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

export function getUserIdFromToken(token: string): string {
  const json = decodePayload(token)
  if (!json) return ''
  const sub = json.sub
  const uid = json.userId
  if (typeof sub === 'string') return sub
  if (typeof uid === 'string') return uid
  return ''
}

export function getJwtProfile(token: string): { userId: string; email: string; name: string } {
  const json = decodePayload(token)
  if (!json) return { userId: '', email: '', name: '' }
  const sub = json.sub
  const uid = json.userId
  const userId =
    typeof sub === 'string' ? sub : typeof uid === 'string' ? uid : ''
  return {
    userId,
    email: typeof json.email === 'string' ? json.email : '',
    name: typeof json.name === 'string' ? json.name : '',
  }
}
