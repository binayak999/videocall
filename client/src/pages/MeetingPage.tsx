import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'
import { errorMessage, getMeeting } from '../lib/api'
import { getToken } from '../lib/auth'
import type { Meeting } from '../lib/types'
import '../meeting.css'

type CallView = 'detail' | 'lobby' | 'call'

interface PeerState {
  pc: RTCPeerConnection
  pendingIce: RTCIceCandidateInit[]
  remoteDescriptionReady: boolean
}

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

function shortId(id: string) {
  return id.length <= 8 ? id : id.slice(0, 6) + '\u2026'
}

function defaultSignalingUrl() {
  return window.location.origin
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

export function MeetingPage() {
  const params = useParams()
  const code = (params.code ?? '').trim()

  // meeting detail
  const [busy, setBusy] = useState(true)
  const [fetchErr, setFetchErr] = useState<string | null>(null)
  const [meeting, setMeeting] = useState<Meeting | null>(null)

  // call UI state
  const [callView, setCallView] = useState<CallView>('lobby')
  const [micEnabled, setMicEnabled] = useState(true)
  const [camEnabled, setCamEnabled] = useState(true)
  const [statusLine, setStatusLine] = useState('')
  const [peerIds, setPeerIds] = useState<string[]>([])
  const [activeMeetingCode, setActiveMeetingCode] = useState('')
  const [timerSeconds, setTimerSeconds] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [inputSignal, setInputSignal] = useState('')
  const [connectBtnDisabled, setConnectBtnDisabled] = useState(false)
  const [previewCamOff, setPreviewCamOff] = useState(false)
  const [pipCamOff, setPipCamOff] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [debugLog, setDebugLog] = useState('')

  // refs
  const socketRef = useRef<Socket | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const peersRef = useRef<Map<string, PeerState>>(new Map())
  const preConnectIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const mySocketIdRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerSecondsRef = useRef(0)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const peerVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map())
  const localPreviewRef = useRef<HTMLVideoElement>(null)
  const localPipRef = useRef<HTMLVideoElement>(null)

  // fetch meeting detail
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (code.length === 0) { setBusy(false); setFetchErr('Missing meeting code.'); return }
      setBusy(true); setFetchErr(null)
      try {
        const r = await getMeeting(code)
        if (!cancelled) setMeeting(r.meeting)
      } catch (e: unknown) {
        if (!cancelled) setFetchErr(errorMessage(e))
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [code])

  // body overflow lock during lobby/call
  useEffect(() => {
    if (callView === 'detail') return
    document.documentElement.style.height = '100%'
    document.body.style.height = '100%'
    document.body.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.height = ''
      document.body.style.height = ''
      document.body.style.overflow = ''
    }
  }, [callView])

  // init signaling URL from URL params
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    setInputSignal(sp.get('signal') || defaultSignalingUrl())
  }, [])

  // Shift+D debug toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'D' && e.shiftKey) setShowDebug(v => !v) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // auto-start camera when lobby opens
  useEffect(() => {
    if (callView !== 'lobby') return
    ensureStream().catch(() => setPreviewCamOff(true))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callView])

  // sync local PiP srcObject after call view mounts
  useEffect(() => {
    if (callView === 'call' && localPipRef.current && localStreamRef.current) {
      localPipRef.current.srcObject = localStreamRef.current
    }
  }, [callView])

  // cleanup on unmount
  useEffect(() => {
    return () => {
      socketRef.current?.disconnect()
      localStreamRef.current?.getTracks().forEach(t => t.stop())
      for (const s of peersRef.current.values()) s.pc.close()
      peersRef.current.clear()
      if (timerRef.current) clearInterval(timerRef.current)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  const appendLog = useCallback((...args: unknown[]) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    setDebugLog(prev => prev + line + '\n')
  }, [])

  const showToast = useCallback((text: string, duration = 3500) => {
    setToast(text)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), duration)
  }, [])

  async function ensureStream() {
    if (localStreamRef.current) return localStreamRef.current
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    for (const t of stream.getAudioTracks()) t.enabled = micEnabled
    for (const t of stream.getVideoTracks()) t.enabled = camEnabled
    localStreamRef.current = stream
    if (localPreviewRef.current) localPreviewRef.current.srcObject = stream
    return stream
  }

  function startTimer() {
    timerSecondsRef.current = 0
    setTimerSeconds(0)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      timerSecondsRef.current++
      setTimerSeconds(timerSecondsRef.current)
    }, 1000)
  }

  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    setTimerSeconds(0)
  }

  function shouldInitiateOffer(remoteId: string) {
    return mySocketIdRef.current.length > 0 && mySocketIdRef.current < remoteId
  }

  function flushPendingIce(state: PeerState) {
    while (state.pendingIce.length > 0) {
      const c = state.pendingIce.shift()
      if (c) void state.pc.addIceCandidate(c).catch(() => {})
    }
  }

  function ensurePeerState(remoteId: string): PeerState {
    const existing = peersRef.current.get(remoteId)
    if (existing) return existing

    const pendingIce: RTCIceCandidateInit[] = []
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    if (localStreamRef.current) {
      for (const t of localStreamRef.current.getTracks()) pc.addTrack(t, localStreamRef.current)
    }

    pc.ontrack = ev => {
      const s = ev.streams[0]
      if (!s) return
      const videoEl = peerVideoRefs.current.get(remoteId)
      if (videoEl) {
        videoEl.srcObject = s
      } else {
        // wait for ref to attach after React re-render
        const iv = setInterval(() => {
          const el = peerVideoRefs.current.get(remoteId)
          if (el) { el.srcObject = s; clearInterval(iv) }
        }, 50)
        setTimeout(() => clearInterval(iv), 2000)
      }
    }

    pc.onicecandidate = ev => {
      if (ev.candidate && socketRef.current?.connected) {
        socketRef.current.emit('webrtc:ice', { to: remoteId, candidate: ev.candidate.toJSON() })
      }
    }

    pc.onconnectionstatechange = () => appendLog('pc[' + shortId(remoteId) + ']', pc.connectionState)

    const state: PeerState = { pc, pendingIce, remoteDescriptionReady: false }
    peersRef.current.set(remoteId, state)

    const early = preConnectIceRef.current.get(remoteId)
    if (early) { for (const c of early) pendingIce.push(c); preConnectIceRef.current.delete(remoteId) }

    setPeerIds(prev => [...prev, remoteId])
    return state
  }

  function removePeer(remoteId: string) {
    peersRef.current.get(remoteId)?.pc.close()
    peersRef.current.delete(remoteId)
    preConnectIceRef.current.delete(remoteId)
    peerVideoRefs.current.delete(remoteId)
    setPeerIds(prev => prev.filter(id => id !== remoteId))
  }

  function resetAllPeers() {
    for (const s of peersRef.current.values()) s.pc.close()
    peersRef.current.clear()
    preConnectIceRef.current.clear()
    peerVideoRefs.current.clear()
    setPeerIds([])
  }

  async function createAndSendOffer(remoteId: string) {
    await ensureStream()
    const state = ensurePeerState(remoteId)
    const offer = await state.pc.createOffer()
    await state.pc.setLocalDescription(offer)
    const sdp = state.pc.localDescription?.toJSON()
    if (sdp && socketRef.current?.connected) {
      socketRef.current.emit('webrtc:offer', { to: remoteId, sdp })
      appendLog('sent offer \u2192', shortId(remoteId))
    }
  }

  function registerSocketHandlers(socket: Socket) {
    socket.on('connect', () => {
      mySocketIdRef.current = socket.id ?? ''
      appendLog('connected', mySocketIdRef.current)
    })
    socket.on('connect_error', (err: Error) => {
      appendLog('connect_error', err.message)
      setStatusLine('Connection failed: ' + err.message)
      showToast('Connection failed: ' + err.message)
      setConnectBtnDisabled(false)
    })
    socket.on('disconnect', (reason: string) => {
      appendLog('disconnected', reason)
      showToast('Disconnected from signaling')
    })
    socket.on('meeting:peer-joined', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const peerId = (payload as { peerId?: unknown }).peerId
      if (typeof peerId !== 'string' || peerId === mySocketIdRef.current) return
      appendLog('peer-joined', shortId(peerId))
      showToast('Someone joined the call')
      if (shouldInitiateOffer(peerId)) void createAndSendOffer(peerId).catch(e => appendLog('offer error', String(e)))
    })
    socket.on('webrtc:offer', async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return
      const { from, sdp } = msg as { from?: unknown; sdp?: unknown }
      if (typeof from !== 'string' || !sdp || typeof sdp !== 'object') return
      const state = ensurePeerState(from)
      try {
        await state.pc.setRemoteDescription(sdp as RTCSessionDescriptionInit)
        state.remoteDescriptionReady = true
        flushPendingIce(state)
        const answer = await state.pc.createAnswer()
        await state.pc.setLocalDescription(answer)
        const local = state.pc.localDescription?.toJSON()
        if (local && socketRef.current?.connected) {
          socketRef.current.emit('webrtc:answer', { to: from, sdp: local })
          appendLog('sent answer \u2192', shortId(from))
        }
      } catch (e) { appendLog('offer handler error', String(e)) }
    })
    socket.on('webrtc:answer', async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return
      const { from, sdp } = msg as { from?: unknown; sdp?: unknown }
      if (typeof from !== 'string' || !sdp || typeof sdp !== 'object') return
      const state = peersRef.current.get(from)
      if (!state) return
      try {
        await state.pc.setRemoteDescription(sdp as RTCSessionDescriptionInit)
        state.remoteDescriptionReady = true
        flushPendingIce(state)
        appendLog('answer \u2190', shortId(from))
      } catch (e) { appendLog('answer handler error', String(e)) }
    })
    socket.on('webrtc:ice', async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return
      const { from, candidate } = msg as { from?: unknown; candidate?: unknown }
      if (typeof from !== 'string' || !candidate || typeof candidate !== 'object') return
      const init = candidate as RTCIceCandidateInit
      const state = peersRef.current.get(from)
      if (!state) {
        if (!preConnectIceRef.current.has(from)) preConnectIceRef.current.set(from, [])
        preConnectIceRef.current.get(from)!.push(init)
        return
      }
      if (!state.remoteDescriptionReady) { state.pendingIce.push(init); return }
      try { await state.pc.addIceCandidate(init) } catch { /* ignore stale ICE */ }
    })
    socket.on('meeting:peer-left', (payload: unknown) => {
      const peerId =
        payload && typeof payload === 'object' && 'peerId' in (payload as object)
          ? (payload as { peerId: unknown }).peerId
          : undefined
      if (typeof peerId === 'string') {
        appendLog('peer-left', shortId(peerId))
        removePeer(peerId)
        showToast('A participant left')
      } else {
        appendLog('peer-left (full reset)')
        resetAllPeers()
      }
    })
  }

  async function connect() {
    const token = getToken()
    if (!token) {
      setStatusLine('Not signed in \u2014 log in first.')
      showToast('Sign in first')
      return
    }
    const signalBase = inputSignal.trim() || defaultSignalingUrl()
    setConnectBtnDisabled(true)
    setStatusLine('Connecting\u2026')
    setDebugLog('')
    mySocketIdRef.current = ''
    resetAllPeers()

    try {
      await ensureStream()
    } catch (e) {
      setStatusLine('Camera or microphone unavailable.')
      appendLog(String(e))
      setConnectBtnDisabled(false)
      return
    }

    socketRef.current?.disconnect()
    const socket = io(signalBase, { auth: { token }, transports: ['polling', 'websocket'] })
    socketRef.current = socket
    registerSocketHandlers(socket)

    socket.emit('meeting:join', code, (ack: unknown) => {
      if (!ack || typeof ack !== 'object') {
        setStatusLine('Invalid join response')
        setConnectBtnDisabled(false)
        return
      }
      const a = ack as Record<string, unknown>
      if (a.ok !== true) {
        const msg = typeof a.error === 'string' ? a.error : 'Join failed'
        setStatusLine(msg); showToast(msg); appendLog(ack)
        setConnectBtnDisabled(false)
        socketRef.current?.disconnect()
        return
      }
      mySocketIdRef.current = socket.id ?? mySocketIdRef.current
      appendLog('joined', ack)
      const peerList = Array.isArray(a.peerIds)
        ? (a.peerIds as unknown[]).filter((id): id is string => typeof id === 'string')
        : []
      for (const pid of peerList) {
        if (shouldInitiateOffer(pid)) void createAndSendOffer(pid).catch(e => appendLog('offer error', String(e)))
      }
      setActiveMeetingCode(code)
      setCallView('call')
      startTimer()
      const n = typeof a.peerCount === 'number' ? a.peerCount : peerList.length + 1
      showToast(n <= 1 ? "You're the only one here" : `${n} people in this call`)
    })
  }

  function leave() {
    socketRef.current?.emit('meeting:leave')
    socketRef.current?.disconnect()
    socketRef.current = null
    mySocketIdRef.current = ''
    resetAllPeers()
    setConnectBtnDisabled(false)
    stopTimer()
    setCallView('lobby')
    showToast('You left the call')
  }

  function toggleMic() {
    if (!localStreamRef.current) return
    const next = !micEnabled
    setMicEnabled(next)
    for (const t of localStreamRef.current.getAudioTracks()) t.enabled = next
    showToast(next ? 'Microphone on' : 'Microphone muted')
  }

  async function toggleCam() {
    const next = !camEnabled

    if (!next) {
      if (!localStreamRef.current) return
      const localStream = localStreamRef.current
      for (const t of localStream.getVideoTracks()) {
        t.enabled = false
        t.stop()
        localStream.removeTrack(t)
      }
      setCamEnabled(false)
      setPipCamOff(true)
      setPreviewCamOff(true)
      showToast('Camera off')
      return
    }

    try {
      const localStream = localStreamRef.current ?? await ensureStream()
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      const newVideoTrack = cameraStream.getVideoTracks()[0]
      if (!newVideoTrack) throw new Error('No camera track available')
      newVideoTrack.enabled = true

      for (const t of localStream.getVideoTracks()) localStream.removeTrack(t)
      localStream.addTrack(newVideoTrack)

      for (const { pc } of peersRef.current.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        if (sender) {
          await sender.replaceTrack(newVideoTrack)
        } else {
          pc.addTrack(newVideoTrack, localStream)
        }
      }

      if (localPreviewRef.current) localPreviewRef.current.srcObject = localStream
      if (localPipRef.current) localPipRef.current.srcObject = localStream

      setCamEnabled(true)
      setPipCamOff(false)
      setPreviewCamOff(false)
      showToast('Camera on')
    } catch (e) {
      appendLog('camera toggle error', String(e))
      showToast('Unable to turn camera on')
      setCamEnabled(false)
      setPipCamOff(true)
      setPreviewCamOff(true)
    }
  }

  const shareUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return `${window.location.origin}/m/${encodeURIComponent(code)}`
  }, [code])

  const timerDisplay = `${Math.floor(timerSeconds / 60)}:${String(timerSeconds % 60).padStart(2, '0')}`
  const participantCount = peerIds.length + 1
  const isSoloInCall = peerIds.length === 0

  const gridStyle: React.CSSProperties =
    peerIds.length === 0 ? {} :
    peerIds.length === 1 ? { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' } :
    peerIds.length === 2 ? { gridTemplateColumns: 'repeat(2,1fr)', gridTemplateRows: '1fr' } :
    peerIds.length <= 4 ? { gridTemplateColumns: 'repeat(2,1fr)', gridTemplateRows: 'repeat(2,1fr)' } :
    peerIds.length <= 6 ? { gridTemplateColumns: 'repeat(3,1fr)', gridTemplateRows: 'repeat(2,1fr)' } :
    peerIds.length <= 9 ? { gridTemplateColumns: 'repeat(3,1fr)', gridTemplateRows: 'repeat(3,1fr)' } :
    { gridTemplateColumns: 'repeat(4,1fr)', gridTemplateRows: `repeat(${Math.ceil(peerIds.length / 4)},1fr)` }

  return (
    <>
      {/* ── Meeting detail ── */}
      {callView === 'detail' && (
        <div
          className="meeting-route-root fixed inset-0 overflow-hidden"
          style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
        >
        {/* background */}
        <img src="/image.png" alt="" aria-hidden draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover" />

        {/* header */}
        <div className="relative z-20 flex items-center justify-between px-10 py-4">
          <Link to="/">
            <img src="/nexivo_logo.svg" alt="Nexivo" className="h-14 w-auto" draggable={false} />
          </Link>
          <Link to="/" className="rounded-full border border-black/10 bg-white/60 px-4 py-1.5 text-sm font-medium text-gray-600 backdrop-blur-sm transition hover:bg-white/80">
            ← Back home
          </Link>
        </div>

        {/* centered card */}
        <div className="relative z-10 flex h-[calc(100vh-80px)] items-center justify-center px-4">
          <div className="w-full max-w-md rounded-[22px] bg-[#1c1c1e]/95 backdrop-blur-xl p-7 md:min-h-[560px]">

            <p className="text-[0.6rem] font-bold uppercase tracking-[0.2em] text-white/30">Meeting</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-white/90">
              {code.length > 0 ? code : '—'}
            </h1>

            <div className="mt-5 flex flex-col gap-4">
              {busy ? (
                <p className="text-sm text-white/40">Loading meeting details…</p>
              ) : fetchErr ? (
                <div className="flex flex-col gap-1">
                  <p className="text-sm text-red-400">{fetchErr}</p>
                  <p className="text-xs text-white/30">Confirm the API is running and reachable.</p>
                </div>
              ) : meeting ? (
                <>
                  <div className="flex flex-col gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.05] p-4">
                    <div>
                      <p className="text-[0.6rem] font-semibold uppercase tracking-wider text-white/30">Title</p>
                      <p className="mt-0.5 text-sm font-semibold text-white/80">{meeting.title ?? 'Untitled meeting'}</p>
                    </div>
                    <div>
                      <p className="text-[0.6rem] font-semibold uppercase tracking-wider text-white/30">Host</p>
                      <p className="mt-0.5 text-sm font-semibold text-white/80">{meeting.host?.name ?? 'Unknown'}</p>
                      <p className="text-xs text-white/40">{meeting.host?.email ?? ''}</p>
                    </div>
                    <div>
                      <p className="text-[0.6rem] font-semibold uppercase tracking-wider text-white/30">Created</p>
                      <p className="mt-0.5 text-xs text-white/50">{formatDate(meeting.createdAt)}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.05] p-3">
                    <code className="flex-1 truncate text-xs text-white/50">{shareUrl}</code>
                    <button
                      type="button"
                      className="rounded-xl border border-white/[0.1] bg-white/[0.08] px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:bg-white/[0.14]"
                      onClick={async () => { try { await navigator.clipboard.writeText(shareUrl) } catch { /* ignore */ } }}
                    >
                      Copy
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setCallView('lobby')}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-[#f59e0b] text-sm font-semibold text-black transition hover:bg-[#fbbf24]"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                    Join video call
                  </button>
                </>
              ) : (
                <p className="text-sm text-white/40">No meeting data.</p>
              )}
            </div>
          </div>
        </div>
        </div>
      )}

      {/* ── Lobby overlay (same shell as meeting detail) ── */}
      {callView === 'lobby' && (
        <div
          className="fixed inset-0 z-[100] overflow-hidden"
          style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
        >
          <img
            src="/image.png"
            alt=""
            aria-hidden
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
          />

          <div className="relative z-20 flex items-center justify-between px-10 py-4">
            <Link to="/">
              <img src="/nexivo_logo.svg" alt="Nexivo" className="h-14 w-auto" draggable={false} />
            </Link>
            <Link
              to="/"
              className="rounded-full border border-black/10 bg-white/60 px-4 py-1.5 text-sm font-medium text-gray-600 backdrop-blur-sm transition hover:bg-white/80"
            >
              ← Back home
            </Link>
          </div>

          <div className="relative z-10 flex min-h-[calc(100vh-80px)] items-center justify-center px-4 py-6">
            <div className="w-full max-w-4xl rounded-[22px] bg-[#1c1c1e]/95 p-6 backdrop-blur-xl md:min-h-[560px] md:p-7">
              <p className="text-[0.6rem] font-bold uppercase tracking-[0.2em] text-white/30">Video call</p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-white/90">Ready to join?</h2>
              <p className="mt-1 font-mono text-sm text-white/50">{code.length > 0 ? code : '—'}</p>

              <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-stretch">
                <div className="relative min-h-[380px] flex-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-black/35 lg:min-h-[380px]">
                  <video
                    ref={localPreviewRef}
                    playsInline
                    autoPlay
                    muted
                    className="mirror absolute h-full w-full object-cover"
                  />
                  {previewCamOff && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#1c1c1e]/90">
                      <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-white/10">
                        <svg viewBox="0 0 24 24" fill="#9ca3af" width="40" height="40">
                          <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
                        </svg>
                      </div>
                    </div>
                  )}
                  <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2">
                    <button
                      type="button"
                      onClick={toggleMic}
                      title="Toggle mic"
                      className={`flex h-11 w-11 items-center justify-center rounded-full border backdrop-blur-sm transition ${
                        micEnabled
                          ? 'border-white/[0.12] bg-white/[0.12] text-white hover:bg-white/[0.18]'
                          : 'border-red-500/35 bg-red-500/25 text-white hover:bg-red-500/35'
                      }`}
                    >
                      {micEnabled ? (
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                          <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={toggleCam}
                      title="Toggle camera"
                      className={`flex h-11 w-11 items-center justify-center rounded-full border backdrop-blur-sm transition ${
                        camEnabled
                          ? 'border-white/[0.12] bg-white/[0.12] text-white hover:bg-white/[0.18]'
                          : 'border-red-500/35 bg-red-500/25 text-white hover:bg-red-500/35'
                      }`}
                    >
                      {camEnabled ? (
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                          <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                          <path d="M21 6.5l-4-4-9.86 9.86-2.09-2.09L4 11.36l2.11 2.11L3 16.5V21h4.5l3.03-3.03 2.11 2.11 1.09-1.09-2.09-2.09L21 6.5zM7.04 19H5v-2.04l9.86-9.86 2.04 2.04L7.04 19z" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex w-full flex-col justify-center gap-4 lg:w-[min(100%,280px)] lg:flex-shrink-0">
                  <p className="min-h-[1.25rem] text-sm text-white/40">{statusLine}</p>

                  <div>
                    <p className="text-[0.6rem] font-semibold uppercase tracking-wider text-white/30">Meeting code</p>
                    <input
                      readOnly
                      value={code}
                      className="mt-1.5 w-full rounded-xl border border-white/[0.1] bg-white/[0.05] px-3 py-2.5 font-mono text-sm text-white/80 outline-none"
                    />
                  </div>

                  <details className="text-xs text-white/45">
                    <summary className="cursor-pointer select-none list-none text-white/50 transition hover:text-white/70 [&::-webkit-details-marker]:hidden">
                      Advanced
                    </summary>
                    <input
                      type="url"
                      placeholder="Signaling URL (http://host:4002)"
                      autoComplete="off"
                      className="mt-2 w-full rounded-xl border border-white/[0.1] bg-white/[0.05] px-3 py-2 text-xs text-white/80 placeholder:text-white/25 outline-none focus:border-white/20"
                      value={inputSignal}
                      onChange={e => setInputSignal(e.target.value)}
                    />
                  </details>

                  <button
                    type="button"
                    onClick={() => void connect()}
                    disabled={connectBtnDisabled}
                    className="flex h-11 w-full items-center justify-center rounded-2xl bg-[#f59e0b] text-sm font-semibold text-black transition hover:bg-[#fbbf24] disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    Join now
                  </button>
                  <Link
                    to="/"
                    className="text-center text-sm font-medium text-white/45 transition hover:text-white/70"
                  >
                    ← Cancel
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Call view overlay ── */}
      {callView === 'call' && (
        <div style={{ position: 'fixed', inset: 0, background: '#111', zIndex: 100 }}>
          {/* Video grid */}
          <div className="meet-grid" style={gridStyle}>
            {peerIds.length === 0 && (
              <div className="waiting-placeholder">
                <div className="waiting-icon">
                  <svg viewBox="0 0 24 24" fill="#9aa0a6" width="32" height="32">
                    <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
                  </svg>
                </div>
                <p>Waiting for others to join&hellip;</p>
              </div>
            )}
            {peerIds.map(id => (
              <div key={id} className="meet-tile">
                <video
                  ref={el => {
                    if (el) peerVideoRefs.current.set(id, el)
                    else peerVideoRefs.current.delete(id)
                  }}
                  playsInline
                  autoPlay
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: 'scaleX(-1)' }}
                />
                <div className="meet-tile-label">Peer {shortId(id)}</div>
              </div>
            ))}
          </div>

          {/* Local PiP */}
          <div className={`local-pip ${isSoloInCall ? 'local-pip--solo' : 'local-pip--floating'}`}>
            <video ref={localPipRef} playsInline autoPlay muted className="mirror" />
            {pipCamOff && (
              <div className="cam-off-overlay">
                <svg viewBox="0 0 24 24" fill="#9aa0a6" width="28" height="28">
                  <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
                </svg>
              </div>
            )}
            <div className="pip-label">
              <span>You</span>
              {!micEnabled && (
                <svg viewBox="0 0 24 24" fill="#ea4335" width="12" height="12">
                  <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                </svg>
              )}
            </div>
          </div>

          {/* Top bar */}
          <div className="call-top-bar">
            <div className="call-top-left">
              <span className="call-brand">Meet</span>
              <span className="call-timer">{timerDisplay}</span>
            </div>
            <div className="call-top-right">
              <span className="call-peers">
                {participantCount === 1 ? '1 participant' : `${participantCount} participants`}
              </span>
              <span className="call-code-badge">{activeMeetingCode}</span>
            </div>
          </div>

          {/* Bottom controls */}
          <div className="call-bottom-bar">
            <button
              onClick={toggleMic}
              className={`ctrl-btn ctrl-btn--lg ${micEnabled ? 'ctrl-btn--active' : 'ctrl-btn--danger'}`}
              title="Mute/Unmute"
            >
              {micEnabled ? (
                <svg viewBox="0 0 24 24" fill="white" width="24" height="24">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="white" width="24" height="24">
                  <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                </svg>
              )}
            </button>
            <button
              onClick={toggleCam}
              className={`ctrl-btn ctrl-btn--lg ${camEnabled ? 'ctrl-btn--active' : 'ctrl-btn--danger'}`}
              title="Toggle camera"
            >
              {camEnabled ? (
                <svg viewBox="0 0 24 24" fill="white" width="24" height="24">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="white" width="24" height="24">
                  <path d="M21 6.5l-4-4-9.86 9.86-2.09-2.09L4 11.36l2.11 2.11L3 16.5V21h4.5l3.03-3.03 2.11 2.11 1.09-1.09-2.09-2.09L21 6.5zM7.04 19H5v-2.04l9.86-9.86 2.04 2.04L7.04 19z" />
                </svg>
              )}
            </button>
            <button onClick={leave} className="ctrl-btn ctrl-btn--leave ctrl-btn--lg" title="Leave call">
              <svg viewBox="0 0 24 24" fill="white" width="24" height="24">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="toast">
          <span>{toast}</span>
        </div>
      )}

      {/* Debug log (Shift+D) */}
      {showDebug && (
        <pre className="debug-log" aria-live="polite">
          {debugLog}
        </pre>
      )}
    </>
  )
}
