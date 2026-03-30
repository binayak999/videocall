import { useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'
import { mergeCaptionContinuation, collapseStutteringCaption } from './captionContinuationMerge'
import { speechRecognitionCtor, type BrowserSpeechResultEvent } from './browserSpeechRecognition'

/**
 * Streams the local mic to the browser speech API and emits captions on the signaling socket.
 * Final segments are persisted server-side and broadcast to the room.
 */
export function useMeetingCaptionRecognition(opts: {
  enabled: boolean
  micEnabled: boolean
  speechLang: string
  inCall: boolean
  /** Your signaling socket id while in the call (used to restart after reconnect). */
  localSocketId: string | null
  getSocket: () => Socket | null
}) {
  const recRef = useRef<{ stop: () => void } | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const stopRec = () => {
      try {
        recRef.current?.stop()
      } catch {
        /* ignore */
      }
      recRef.current = null
    }

    const { enabled, micEnabled, speechLang, inCall, localSocketId, getSocket } = optsRef.current
    if (!enabled || !micEnabled || !inCall || !localSocketId) {
      stopRec()
      return
    }

    const socket = getSocket()
    if (!socket?.connected) {
      stopRec()
      return
    }

    const Ctor = speechRecognitionCtor()
    if (!Ctor) {
      return
    }

    let cancelled = false
    let lastInterimSend = 0
    let lastFinalNorm = ''
    let lastFinalAt = 0
    /** Running merged text for the current utterance (same session as this recognition instance). */
    let utteranceAccum = ''
    let active: InstanceType<typeof Ctor> | null = null

    const start = () => {
      if (cancelled) return
      stopRec()
      utteranceAccum = ''
      const r = new Ctor()
      active = r
      r.continuous = true
      r.interimResults = true
      r.lang = speechLang
      r.onresult = (event: BrowserSpeechResultEvent) => {
        const socketNow = optsRef.current.getSocket()
        if (!socketNow?.connected) return
        const { results, resultIndex } = event
        if (!results || results.length === 0 || resultIndex >= results.length) return
        // Browsers often append several progressive finals in one event; only the last
        // result reflects the current phrase. Emitting every index duplicates the transcript.
        const res = results[results.length - 1]!
        const raw = (res[0]?.transcript ?? '').trim()
        if (!raw) return
        const cleaned = collapseStutteringCaption(raw)
        if (!cleaned) return
        const interim = !res.isFinal

        let out: string
        if (interim) {
          // Always trust the browser's latest recognition result — never blend or compare
          // lengths, because the browser can both extend AND correct (shorten) the text.
          out = cleaned
          if (out.toLowerCase() === utteranceAccum.toLowerCase()) return
          const now = Date.now()
          if (now - lastInterimSend < 260) return
          lastInterimSend = now
          utteranceAccum = out
        } else {
          // For finals: use the merge to de-duplicate repeated phrases (stutter, echo).
          const { merged } = mergeCaptionContinuation(utteranceAccum, cleaned)
          out = merged
          const outNorm = out.toLowerCase()
          const now = Date.now()
          if (outNorm === lastFinalNorm && now - lastFinalAt < 2500) return
          lastFinalNorm = outNorm
          lastFinalAt = now
          utteranceAccum = ''
        }
        socketNow.emit('meeting:caption', { text: out, interim })
      }
      r.onerror = () => {}
      r.onend = () => {
        if (cancelled || active !== r) return
        const o = optsRef.current
        if (!o.enabled || !o.micEnabled || !o.inCall || !o.localSocketId || !o.getSocket()?.connected) {
          return
        }
        try {
          r.start()
        } catch {
          /* ignore */
        }
      }
      recRef.current = {
        stop: () => {
          try {
            r.stop()
          } catch {
            /* ignore */
          }
          if (active === r) active = null
        },
      }
      try {
        r.start()
      } catch {
        recRef.current = null
        active = null
      }
    }

    const onConnect = () => {
      if (!optsRef.current.localSocketId) return
      start()
    }

    const onDisconnect = () => {
      stopRec()
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    start()

    return () => {
      cancelled = true
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      stopRec()
    }
  }, [
    opts.enabled,
    opts.micEnabled,
    opts.speechLang,
    opts.inCall,
    opts.localSocketId,
    opts.getSocket,
  ])
}
