/**
 * Detects horizontal flip from computed CSS transform (e.g. scaleX(-1), -scale-x-100).
 * Used when compositing video to canvas so recording matches on-screen preview.
 */
export function isVideoHorizontallyFlippedByCss(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  const t = getComputedStyle(el).transform
  if (!t || t === 'none') return false

  const m2 = /^matrix\(([-0-9.eE+\s,]+)\)$/.exec(t)
  if (m2) {
    const a = parseFloat(m2[1].split(',')[0]!.trim())
    return !Number.isNaN(a) && a < 0
  }

  const m3 = /^matrix3d\(([-0-9.eE+\s,]+)\)$/.exec(t)
  if (m3) {
    const a = parseFloat(m3[1].split(',')[0]!.trim())
    return !Number.isNaN(a) && a < 0
  }

  return false
}
