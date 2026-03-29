/**
 * Merges successive speech-recognition phrases when the engine sends
 * overlapping fragments, repeated words, or mixed casing.
 */
const MIN_OVERLAP_GRAPHEMES = 2

function norm(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim()
}

function lc(s: string): string {
  return s.toLowerCase()
}

function graphemes(s: string): string[] {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(seg.segment(s), x => x.segment)
  } catch {
    return [...s]
  }
}

/** Remove consecutive duplicate words (any casing). */
function dedupeConsecutiveWords(words: string[]): string[] {
  const out: string[] = []
  for (const x of words) {
    if (x.length === 0) continue
    if (out.length === 0 || lc(out[out.length - 1]!) !== lc(x)) {
      out.push(x)
    }
  }
  return out
}

/**
 * If the tail repeats the preceding phrase (e.g. "...guess my name guess my name"),
 * keep a single copy. Repeat until stable.
 */
function collapseRepeatedTailPhrases(words: string[]): string[] {
  let arr = dedupeConsecutiveWords(words)
  let guard = 0
  while (arr.length >= 4 && guard < 20) {
    guard++
    let cut = false
    const maxL = Math.min(14, Math.floor(arr.length / 2))
    for (let L = maxL; L >= 2; L--) {
      if (arr.length < 2 * L) continue
      const p1 = arr.slice(-2 * L, -L).join(' ').toLowerCase()
      const p2 = arr.slice(-L).join(' ').toLowerCase()
      if (p1 === p2) {
        arr = arr.slice(0, -L)
        cut = true
        break
      }
    }
    if (!cut) break
  }
  return arr
}

/** Normalize stuttering / repeated n-grams for display and before emit. */
export function collapseStutteringCaption(text: string): string {
  const raw = norm(text)
  if (!raw) return ''
  const words = raw.split(/\s+/).filter(Boolean)
  return collapseRepeatedTailPhrases(words).join(' ')
}

function mergeByWordOverlap(a: string, b: string): string | null {
  const aW = dedupeConsecutiveWords(a.split(/\s+/).filter(Boolean))
  const bW = dedupeConsecutiveWords(b.split(/\s+/).filter(Boolean))
  if (aW.length === 0 || bW.length === 0) return null
  const maxK = Math.min(aW.length, bW.length)
  for (let k = maxK; k >= 1; k--) {
    const suf = aW.slice(-k).join(' ').toLowerCase()
    const pre = bW.slice(0, k).join(' ').toLowerCase()
    if (suf === pre) {
      const mergedWords = collapseRepeatedTailPhrases([...aW, ...bW.slice(k)])
      return mergedWords.join(' ')
    }
  }
  return null
}

export type CaptionMergeKind = 'identical' | 'takeLonger' | 'overlap' | 'concat'

export function mergeCaptionContinuation(
  prev: string,
  next: string,
): { merged: string; kind: CaptionMergeKind } {
  const a = collapseStutteringCaption(prev)
  const b = collapseStutteringCaption(next)
  if (!a) return { merged: b, kind: b ? 'takeLonger' : 'identical' }
  if (!b) return { merged: a, kind: 'takeLonger' }
  if (lc(a) === lc(b)) return { merged: b.length >= a.length ? b : a, kind: 'identical' }
  if (lc(b).startsWith(lc(a))) return { merged: b, kind: 'takeLonger' }
  if (lc(a).startsWith(lc(b))) return { merged: a, kind: 'takeLonger' }
  if (lc(a).includes(lc(b))) return { merged: a, kind: 'takeLonger' }
  if (lc(b).includes(lc(a))) return { merged: b, kind: 'takeLonger' }

  const wordMerged = mergeByWordOverlap(a, b)
  if (wordMerged !== null) {
    return { merged: collapseStutteringCaption(wordMerged), kind: 'overlap' }
  }

  const aG = graphemes(a)
  const bG = graphemes(b)
  const maxK = Math.min(aG.length, bG.length)
  for (let k = maxK; k >= MIN_OVERLAP_GRAPHEMES; k--) {
    const suf = aG.slice(-k).join('').toLowerCase()
    const pre = bG.slice(0, k).join('').toLowerCase()
    if (suf === pre) {
      const joined = [...aG, ...bG.slice(k)].join('')
      return { merged: collapseStutteringCaption(joined), kind: 'overlap' }
    }
  }

  return { merged: collapseStutteringCaption(`${a} ${b}`), kind: 'concat' }
}
