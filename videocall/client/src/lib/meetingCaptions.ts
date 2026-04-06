import { mergeCaptionContinuation } from './captionContinuationMerge'

export type CaptionLine = {
  key: string
  id?: string
  userId: string
  speakerName: string
  text: string
  final: boolean
  createdAt?: string
}

export function mergeCaptionMessage(
  prev: CaptionLine[],
  msg: {
    speakerUserId: string
    speakerName: string
    text: string
    interim: boolean
    id?: string
    createdAt?: string
  },
  max = 120,
): CaptionLine[] {
  const next = [...prev]
  const last = next[next.length - 1]
  if (msg.interim) {
    if (last && last.userId === msg.speakerUserId && !last.final) {
      // Always replace with the sender's latest text. The sender is the ground truth
      // for interims; it may shorten/correct, so never pick by length.
      next[next.length - 1] = { ...last, text: msg.text, speakerName: msg.speakerName }
    } else {
      next.push({
        key: `i-${msg.speakerUserId}-${Date.now()}`,
        userId: msg.speakerUserId,
        speakerName: msg.speakerName,
        text: msg.text,
        final: false,
      })
    }
    return next.slice(-max)
  }

  if (last && last.userId === msg.speakerUserId && last.final) {
    const { merged, kind } = mergeCaptionContinuation(last.text, msg.text)
    if (kind === 'identical') {
      return prev
    }
    if (kind === 'concat') {
      next.push({
        key: msg.id ?? `f-${msg.speakerUserId}-${Date.now()}`,
        id: msg.id,
        userId: msg.speakerUserId,
        speakerName: msg.speakerName,
        text: msg.text,
        final: true,
        createdAt: msg.createdAt,
      })
      return next.slice(-max)
    }
    next[next.length - 1] = {
      ...last,
      key: msg.id ?? last.key,
      id: msg.id ?? last.id,
      text: merged,
      createdAt: msg.createdAt ?? last.createdAt,
    }
    return next.slice(-max)
  }

  if (last && last.userId === msg.speakerUserId && !last.final) {
    const { merged } = mergeCaptionContinuation(last.text, msg.text)
    next[next.length - 1] = {
      key: msg.id ?? last.key,
      id: msg.id,
      userId: msg.speakerUserId,
      speakerName: msg.speakerName,
      text: merged,
      final: true,
      createdAt: msg.createdAt,
    }
  } else {
    next.push({
      key: msg.id ?? `f-${msg.speakerUserId}-${Date.now()}`,
      id: msg.id,
      userId: msg.speakerUserId,
      speakerName: msg.speakerName,
      text: msg.text,
      final: true,
      createdAt: msg.createdAt,
    })
  }
  return next.slice(-max)
}

export function captionLinesFromHistory(
  rows: { id: string; speakerUserId: string; speakerName: string; text: string; createdAt: string }[],
): CaptionLine[] {
  return rows.map(r => ({
    key: r.id,
    id: r.id,
    userId: r.speakerUserId,
    speakerName: r.speakerName,
    text: r.text,
    final: true,
    createdAt: r.createdAt,
  }))
}
