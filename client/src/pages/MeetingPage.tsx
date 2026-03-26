import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'
import { errorMessage, getMeeting } from '../lib/api'
import { getToken } from '../lib/auth'
import { getIceServers } from '../lib/ice'
import type { Meeting } from '../lib/types'
import '../meeting.css'

type CallView = 'detail' | 'lobby' | 'call'

interface PeerState {
  pc: RTCPeerConnection
  pendingIce: RTCIceCandidateInit[]
  remoteDescriptionReady: boolean
}

interface ChatMessage {
  id: string
  senderId: string
  senderUserId?: string
  senderName?: string
  text: string
  createdAt: string
}

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

function shortId(id: string) {
  return id.length <= 8 ? id : id.slice(0, 6) + '\u2026'
}

function RemoteConnectionIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="6" cy="12" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 11l8-4" />
      <path d="M8 13l8 4" />
    </svg>
  )
}

function defaultSignalingUrl() {
  return window.location.origin
}

function getCompanionBridgeBaseUrl(): string {
  const env = import.meta.env as Record<string, string | undefined>
  const configured = env.VITE_COMPANION_BRIDGE_URL?.trim()
  if (configured) return configured.replace(/\/$/, '')
  return 'http://127.0.0.1:7830'
}

function companionBridgeWsUrl(httpBase: string): string {
  return httpBase.replace(/^http/i, 'ws')
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function formatChatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function getUserIdFromToken(token: string): string {
  try {
    const payload = token.split('.')[1]
    if (!payload) return ''
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown; userId?: unknown }
    if (typeof json.sub === 'string') return json.sub
    if (typeof json.userId === 'string') return json.userId
    return ''
  } catch {
    return ''
  }
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
  const [micEnabled, setMicEnabled] = useState(false)
  const [camEnabled, setCamEnabled] = useState(false)
  const [statusLine, setStatusLine] = useState('')
  const [peerIds, setPeerIds] = useState<string[]>([])
  const [activeMeetingCode, setActiveMeetingCode] = useState('')
  const [timerSeconds, setTimerSeconds] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [inputSignal, setInputSignal] = useState('')
  const [connectBtnDisabled, setConnectBtnDisabled] = useState(false)
  const [previewCamOff, setPreviewCamOff] = useState(true)
  const [pipCamOff, setPipCamOff] = useState(true)
  const [showDebug, setShowDebug] = useState(false)
  const [debugLog, setDebugLog] = useState('')
  const [screenSharing, setScreenSharing] = useState(false)
  const [screenSharingPeers, setScreenSharingPeers] = useState<Set<string>>(new Set())
  const [companionAvailable, setCompanionAvailable] = useState(false)
  const [controllingPeer, setControllingPeer] = useState<string | null>(null)
  const [controlledBy, setControlledBy] = useState<string | null>(null)
  const [incomingControlReq, setIncomingControlReq] = useState<{ from: string; fromName: string } | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatUnread, setChatUnread] = useState(0)
  const [chatHasMore, setChatHasMore] = useState(false)
  const [chatLoadingMore, setChatLoadingMore] = useState(false)
  const [hostJoinRequests, setHostJoinRequests] = useState<{ requestId: string; name: string }[]>([])
  const [isHostInCall, setIsHostInCall] = useState(false)
  const [hostPeerId, setHostPeerId] = useState<string | null>(null)
  const [whiteboardOpen, setWhiteboardOpen] = useState(false)
  const [whiteboardColor, setWhiteboardColor] = useState('#ffffff')
  const [whiteboardWidth, setWhiteboardWidth] = useState(3)
  const [whiteboardOwnerId, setWhiteboardOwnerId] = useState<string | null>(null)
  const [whiteboardEditors, setWhiteboardEditors] = useState<string[]>([])
  const [whiteboardRevokeUserId, setWhiteboardRevokeUserId] = useState('')
  const [incomingWhiteboardReq, setIncomingWhiteboardReq] = useState<{ from: string; fromName: string } | null>(null)

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
  const peerVideoCallbackRefs = useRef<Map<string, (el: HTMLVideoElement | null) => void>>(new Map())
  const peerStreamRefs = useRef<Map<string, MediaStream>>(new Map())
  const localPreviewRef = useRef<HTMLVideoElement>(null)
  const localPipRef = useRef<HTMLVideoElement>(null)
  const localPresenterRef = useRef<HTMLVideoElement>(null)
  const localStripRef = useRef<HTMLVideoElement>(null)
  const chatSeqRef = useRef(0)
  const myUserIdRef = useRef('')
  const chatBottomRef = useRef<HTMLDivElement>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const screenSharingRef = useRef(false)
  const companionWsRef = useRef<WebSocket | null>(null)
  const iceServersRef = useRef<RTCIceServer[]>(DEFAULT_STUN_SERVERS)
  const controlledByRef = useRef<string | null>(null)
  const controllingPeerRef = useRef<string | null>(null)
  const lastMouseSendRef = useRef(0)
  const whiteboardCanvasRef = useRef<HTMLCanvasElement>(null)
  const whiteboardLastPointRef = useRef<{ x: number; y: number } | null>(null)
  const whiteboardDrawingRef = useRef(false)

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

  useEffect(() => {
    if (callView !== 'call' || !whiteboardOpen) return
    const canvas = whiteboardCanvasRef.current
    if (!canvas) return
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const ratio = window.devicePixelRatio || 1
      const nextWidth = Math.max(1, Math.floor(rect.width * ratio))
      const nextHeight = Math.max(1, Math.floor(rect.height * ratio))
      if (canvas.width === nextWidth && canvas.height === nextHeight) return
      const prev = document.createElement('canvas')
      prev.width = canvas.width
      prev.height = canvas.height
      const prevCtx = prev.getContext('2d')
      if (prevCtx && canvas.width > 0 && canvas.height > 0) prevCtx.drawImage(canvas, 0, 0)
      canvas.width = nextWidth
      canvas.height = nextHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      if (prev.width > 0 && prev.height > 0) {
        ctx.drawImage(prev, 0, 0, prev.width / ratio, prev.height / ratio, 0, 0, rect.width, rect.height)
      }
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [callView, whiteboardOpen])

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
    if (callView === 'call' && localPresenterRef.current && localStreamRef.current) {
      localPresenterRef.current.srcObject = localStreamRef.current
    }
    if (callView === 'call' && localStripRef.current && localStreamRef.current) {
      localStripRef.current.srcObject = localStreamRef.current
    }
  }, [callView])

  // keep chat pinned to latest message
  useEffect(() => {
    if (!chatOpen) return
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chatMessages, chatOpen])

  useEffect(() => {
    if (chatOpen) setChatUnread(0)
  }, [chatOpen])

  // Detect companion app and open WebSocket bridge
  useEffect(() => {
    if (callView !== 'call') return
    let ws: WebSocket | null = null
    const bridgeHttpBase = getCompanionBridgeBaseUrl()
    const bridgeWsBase = companionBridgeWsUrl(bridgeHttpBase)
    const detect = async () => {
      try {
        const r = await fetch(`${bridgeHttpBase}/status`, { signal: AbortSignal.timeout(600) })
        const data = await r.json() as { ok?: boolean; remoteControl?: boolean }
        if (!data.ok) return
        // Only mark companion as available when native control is actually ready.
        setCompanionAvailable(data.remoteControl === true)
        ws = new WebSocket(bridgeWsBase)
        companionWsRef.current = ws
        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data as string) as { type: string; to?: string; accepted?: boolean }
            if (msg.type === 'control-response' && typeof msg.to === 'string') {
              socketRef.current?.emit('meeting:control-response', { to: msg.to, accepted: msg.accepted })
              if (msg.accepted) {
                setControlledBy(msg.to)
                controlledByRef.current = msg.to
              }
            }
          } catch { /* ignore */ }
        }
        ws.onclose = () => { setCompanionAvailable(false); companionWsRef.current = null }
        ws.onerror = () => { setCompanionAvailable(false); companionWsRef.current = null }
      } catch { /* companion not running */ }
    }
    void detect()
    return () => { ws?.close(); companionWsRef.current = null }
  }, [callView])

  // cleanup on unmount
  useEffect(() => {
    return () => {
      socketRef.current?.disconnect()
      localStreamRef.current?.getTracks().forEach(t => t.stop())
      screenStreamRef.current?.getTracks().forEach(t => t.stop())
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

  const pushChatMessage = useCallback((message: Omit<ChatMessage, 'id'> & { id?: string }) => {
    const { senderId, text, createdAt, senderName, senderUserId } = message
    chatSeqRef.current += 1
    const id = message.id ?? `${createdAt}-${senderId}-${chatSeqRef.current}`
    setChatMessages(prev => [...prev, { id, senderId, senderName, senderUserId, text, createdAt }])
    if (!chatOpen && senderId !== mySocketIdRef.current) setChatUnread(prev => prev + 1)
  }, [chatOpen])

  async function ensureStream() {
    if (localStreamRef.current) return localStreamRef.current
    const stream = new MediaStream()
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
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current })

    if (localStreamRef.current) {
      for (const t of localStreamRef.current.getTracks()) pc.addTrack(t, localStreamRef.current)
    }

    pc.ontrack = ev => {
      const s = ev.streams[0] ?? new MediaStream([ev.track])
      peerStreamRefs.current.set(remoteId, s)
      const videoEl = peerVideoRefs.current.get(remoteId)
      if (videoEl) {
        videoEl.srcObject = s
        void videoEl.play().catch(() => {})
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
    peerVideoCallbackRefs.current.delete(remoteId)
    peerStreamRefs.current.delete(remoteId)
    setPeerIds(prev => prev.filter(id => id !== remoteId))
  }

  function resetAllPeers() {
    for (const s of peersRef.current.values()) s.pc.close()
    peersRef.current.clear()
    preConnectIceRef.current.clear()
    peerVideoRefs.current.clear()
    peerVideoCallbackRefs.current.clear()
    peerStreamRefs.current.clear()
    setPeerIds([])
  }

  function getPeerVideoRef(remoteId: string) {
    const existing = peerVideoCallbackRefs.current.get(remoteId)
    if (existing) return existing

    const callback = (el: HTMLVideoElement | null) => {
      if (el) {
        peerVideoRefs.current.set(remoteId, el)
        const stream = peerStreamRefs.current.get(remoteId)
        if (stream && el.srcObject !== stream) {
          el.srcObject = stream
          void el.play().catch(() => {})
        }
      } else {
        peerVideoRefs.current.delete(remoteId)
      }
    }

    peerVideoCallbackRefs.current.set(remoteId, callback)
    return callback
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
    const drawWhiteboardSegment = (seg: { x0: number; y0: number; x1: number; y1: number; color: string; width: number }) => {
      const canvas = whiteboardCanvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const widthPx = canvas.clientWidth
      const heightPx = canvas.clientHeight
      ctx.strokeStyle = seg.color
      ctx.lineWidth = seg.width
      ctx.beginPath()
      ctx.moveTo(seg.x0 * widthPx, seg.y0 * heightPx)
      ctx.lineTo(seg.x1 * widthPx, seg.y1 * heightPx)
      ctx.stroke()
    }
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
    socket.on('meeting:join-request', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { requestId?: unknown; name?: unknown }
      if (typeof p.requestId !== 'string') return
      const requestId = p.requestId
      setHostJoinRequests(prev => {
        if (prev.some(r => r.requestId === requestId)) return prev
        return [...prev, { requestId, name: typeof p.name === 'string' ? p.name : 'Someone' }]
      })
      showToast('Join request received')
    })
    socket.on('meeting:join-approved', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      finalizeJoin(payload as Record<string, unknown>)
    })
    socket.on('meeting:join-denied', (payload: unknown) => {
      const p = payload && typeof payload === 'object' ? payload as { message?: unknown } : {}
      const msg = typeof p.message === 'string' ? p.message : 'Host denied your request.'
      setStatusLine(msg)
      showToast(msg)
      setConnectBtnDisabled(false)
      socketRef.current?.disconnect()
    })
    socket.on('meeting:host-changed', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { hostPeerId?: unknown; hostUserId?: unknown }
      if (typeof p.hostPeerId !== 'string' || typeof p.hostUserId !== 'string') return
      setHostPeerId(p.hostPeerId)
      const iAmHost = p.hostUserId === myUserIdRef.current
      setIsHostInCall(iAmHost)
      showToast(iAmHost ? 'You are now the host' : 'Host changed')
    })
    socket.on('webrtc:offer', async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return
      const { from, sdp } = msg as { from?: unknown; sdp?: unknown }
      if (typeof from !== 'string' || !sdp || typeof sdp !== 'object') return
      const isRenegotiation = peerStreamRefs.current.has(from)
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
        // If this is a renegotiation (e.g. screen share started), swap in a
        // fresh MediaStream wrapping the same tracks. The browser reruns its
        // load algorithm and requests a new keyframe from the decoder, fixing
        // the green-screen without a black-frame flash (no srcObject=null).
        if (isRenegotiation) {
          const stream = peerStreamRefs.current.get(from)
          const videoEl = peerVideoRefs.current.get(from)
          if (stream && videoEl) {
            const fresh = new MediaStream(stream.getTracks())
            peerStreamRefs.current.set(from, fresh)
            videoEl.srcObject = fresh
            void videoEl.play().catch(() => {})
          }
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
        setScreenSharingPeers(prev => { const s = new Set(prev); s.delete(peerId); return s })
        showToast('A participant left')
      } else {
        appendLog('peer-left (full reset)')
        resetAllPeers()
        setScreenSharingPeers(new Set())
      }
    })
    socket.on('meeting:control-request', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { from, fromName } = payload as { from?: string; fromName?: string }
      if (typeof from !== 'string') return
      const name = fromName || 'Someone'
      if (companionWsRef.current?.readyState === WebSocket.OPEN) {
        companionWsRef.current.send(JSON.stringify({ type: 'control-request', from, fromName: name }))
      } else {
        setIncomingControlReq({ from, fromName: name })
      }
    })
    socket.on('meeting:control-response', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { from, accepted } = payload as { from?: string; accepted?: boolean }
      if (typeof from !== 'string' || typeof accepted !== 'boolean') return
      if (!accepted) {
        showToast('Control request was denied')
        setControllingPeer(null)
        controllingPeerRef.current = null
        return
      }
      setControllingPeer(from)
      controllingPeerRef.current = from
      showToast('Control granted — click their screen to interact')
    })
    socket.on('meeting:control-event', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { from?: string } & Record<string, unknown>
      if (p.from !== controlledByRef.current) return
      if (companionWsRef.current?.readyState === WebSocket.OPEN) {
        companionWsRef.current.send(JSON.stringify({ type: 'control-event', ...p }))
      }
    })
    socket.on('meeting:control-release', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { from } = payload as { from?: string }
      if (from !== controlledByRef.current) return
      controlledByRef.current = null
      setControlledBy(null)
      companionWsRef.current?.send(JSON.stringify({ type: 'control-released' }))
      showToast('Remote control session ended')
    })
    socket.on('meeting:screenshare', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { peerId, sharing } = payload as { peerId?: unknown; sharing?: unknown }
      if (typeof peerId !== 'string' || typeof sharing !== 'boolean') return
      setScreenSharingPeers(prev => {
        const s = new Set(prev)
        sharing ? s.add(peerId) : s.delete(peerId)
        return s
      })
    })
    socket.on('meeting:chat', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { id, senderId, senderUserId, senderName, text, createdAt } =
        payload as { id?: unknown; senderId?: unknown; senderUserId?: unknown; senderName?: unknown; text?: unknown; createdAt?: unknown }
      if (typeof senderId !== 'string' || typeof text !== 'string') return
      const stamp = typeof createdAt === 'string' ? createdAt : new Date().toISOString()
      pushChatMessage({
        id: typeof id === 'string' ? id : undefined,
        senderId,
        senderUserId: typeof senderUserId === 'string' ? senderUserId : undefined,
        senderName: typeof senderName === 'string' ? senderName : undefined,
        text,
        createdAt: stamp,
      })
    })
    socket.on('meeting:whiteboard-state', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { active } = payload as { active?: unknown }
      if (typeof active !== 'boolean') return
      setWhiteboardOpen(active)
      if (!active) {
        whiteboardDrawingRef.current = false
        whiteboardLastPointRef.current = null
        setIncomingWhiteboardReq(null)
      }
    })
    socket.on('meeting:whiteboard-permissions', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { ownerId?: unknown; editors?: unknown }
      setWhiteboardOwnerId(typeof p.ownerId === 'string' ? p.ownerId : null)
      const editors = Array.isArray(p.editors)
        ? p.editors.filter((id): id is string => typeof id === 'string')
        : []
      setWhiteboardEditors(editors)
      setWhiteboardRevokeUserId(prev => {
        if (prev && editors.includes(prev)) return prev
        const owner = typeof p.ownerId === 'string' ? p.ownerId : null
        const fallback = editors.find(id => id !== owner)
        return fallback ?? ''
      })
    })
    socket.on('meeting:whiteboard-request-edit', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { from?: unknown; fromName?: unknown }
      if (typeof p.from !== 'string') return
      setIncomingWhiteboardReq({
        from: p.from,
        fromName: typeof p.fromName === 'string' ? p.fromName : 'Someone',
      })
    })
    socket.on('meeting:whiteboard-edit-response', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { accepted?: unknown }
      if (p.accepted === true) showToast('Whiteboard collaboration approved')
      if (p.accepted === false) showToast('Whiteboard collaboration denied')
    })
    socket.on('meeting:whiteboard-edit-revoked', () => {
      showToast('Your whiteboard edit access was removed')
      whiteboardDrawingRef.current = false
      whiteboardLastPointRef.current = null
    })
    socket.on('meeting:whiteboard-draw', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown; color?: unknown; width?: unknown
      }
      if (
        typeof p.x0 !== 'number' ||
        typeof p.y0 !== 'number' ||
        typeof p.x1 !== 'number' ||
        typeof p.y1 !== 'number'
      ) return
      drawWhiteboardSegment({
        x0: p.x0,
        y0: p.y0,
        x1: p.x1,
        y1: p.y1,
        color: typeof p.color === 'string' ? p.color : '#ffffff',
        width: typeof p.width === 'number' ? p.width : 3,
      })
    })
    socket.on('meeting:whiteboard-clear', () => {
      const canvas = whiteboardCanvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    })
  }

  function finalizeJoin(a: Record<string, unknown>) {
    mySocketIdRef.current = socketRef.current?.id ?? mySocketIdRef.current
    appendLog('joined', a)
    const peerList = Array.isArray(a.peerIds)
      ? (a.peerIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : []
    const history = Array.isArray(a.chatHistory)
      ? (a.chatHistory as unknown[]).flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const row = item as {
            id?: unknown
            senderUserId?: unknown
            senderName?: unknown
            text?: unknown
            createdAt?: unknown
          }
          if (
            typeof row.id !== 'string' ||
            typeof row.senderUserId !== 'string' ||
            typeof row.senderName !== 'string' ||
            typeof row.text !== 'string' ||
            typeof row.createdAt !== 'string'
          ) return []
          return [{
            id: row.id,
            senderId: row.senderUserId,
            senderUserId: row.senderUserId,
            senderName: row.senderName,
            text: row.text,
            createdAt: row.createdAt,
          } satisfies ChatMessage]
        })
      : []
    for (const pid of peerList) {
      if (shouldInitiateOffer(pid)) void createAndSendOffer(pid).catch(e => appendLog('offer error', String(e)))
    }
    setActiveMeetingCode(code)
    setChatMessages(history)
    setChatHasMore(a.chatHasMore === true)
    setChatUnread(0)
    setChatDraft('')
    setIsHostInCall(a.isHost === true)
    setHostPeerId(typeof a.hostPeerId === 'string' ? a.hostPeerId : (a.isHost === true ? mySocketIdRef.current : null))
    setHostJoinRequests([])
    setWhiteboardOpen(a.whiteboardActive === true)
    setWhiteboardOwnerId(typeof a.whiteboardOwnerId === 'string' ? a.whiteboardOwnerId : null)
    setWhiteboardEditors(
      Array.isArray(a.whiteboardEditors)
        ? (a.whiteboardEditors as unknown[]).filter((id): id is string => typeof id === 'string')
        : [],
    )
    setWhiteboardRevokeUserId(
      Array.isArray(a.whiteboardEditors)
        ? ((a.whiteboardEditors as unknown[]).find(
            (id): id is string => typeof id === 'string' && id !== (typeof a.whiteboardOwnerId === 'string' ? a.whiteboardOwnerId : null),
          ) ?? '')
        : '',
    )
    setCallView('call')
    startTimer()
    const n = typeof a.peerCount === 'number' ? a.peerCount : peerList.length + 1
    showToast(n <= 1 ? "You're the only one here" : `${n} people in this call`)
  }

  function respondJoinRequest(requestId: string, accepted: boolean) {
    socketRef.current?.emit('meeting:join-decision', { requestId, accepted })
    setHostJoinRequests(prev => prev.filter(r => r.requestId !== requestId))
  }

  function transferHost(toPeerId: string) {
    if (!isHostInCall) return
    socketRef.current?.emit('meeting:host-transfer', { to: toPeerId })
  }

  async function connect() {
    const token = getToken()
    if (!token) {
      setStatusLine('Not signed in \u2014 log in first.')
      showToast('Sign in first')
      return
    }
    const signalBase = inputSignal.trim() || defaultSignalingUrl()
    myUserIdRef.current = getUserIdFromToken(token)
    setConnectBtnDisabled(true)
    setStatusLine('Connecting\u2026')
    setDebugLog('')
    mySocketIdRef.current = ''
    resetAllPeers()

    try {
      iceServersRef.current = await getIceServers()
      await ensureStream()
    } catch (e) {
      setStatusLine('Unable to initialize call connection.')
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
        if (a.pending === true) {
          const msg = typeof a.message === 'string' ? a.message : 'Waiting for host approval.'
          setStatusLine(msg)
          showToast(msg)
          return
        }
        const msg = typeof a.error === 'string' ? a.error : 'Join failed'
        setStatusLine(msg); showToast(msg); appendLog(ack)
        setConnectBtnDisabled(false)
        socketRef.current?.disconnect()
        return
      }
      finalizeJoin(a)
    })
  }

  function leave() {
    const socket = socketRef.current
    socket?.emit('meeting:leave')
    if (controllingPeerRef.current) {
      socket?.emit('meeting:control-release', { to: controllingPeerRef.current })
    }
    socket?.disconnect()
    socketRef.current = null
    mySocketIdRef.current = ''
    resetAllPeers()
    screenStreamRef.current?.getTracks().forEach(t => t.stop())
    screenStreamRef.current = null
    screenSharingRef.current = false
    setScreenSharing(false)
    setScreenSharingPeers(new Set())
    controllingPeerRef.current = null
    controlledByRef.current = null
    setControllingPeer(null)
    setControlledBy(null)
    setIncomingControlReq(null)
    setConnectBtnDisabled(false)
    stopTimer()
    setChatMessages([])
    setChatHasMore(false)
    setChatUnread(0)
    setChatOpen(false)
    setChatDraft('')
    setIsHostInCall(false)
    setHostPeerId(null)
    setHostJoinRequests([])
    setWhiteboardOpen(false)
    setWhiteboardOwnerId(null)
    setWhiteboardEditors([])
    setWhiteboardRevokeUserId('')
    setIncomingWhiteboardReq(null)
    setMicEnabled(false)
    setCamEnabled(false)
    setPreviewCamOff(true)
    setPipCamOff(true)
    setCallView('lobby')
    showToast('You left the call')
  }

  function sendChatMessage() {
    const text = chatDraft.trim()
    if (!text) return
    if (!socketRef.current?.connected) {
      showToast('Chat unavailable while disconnected')
      return
    }
    socketRef.current.emit('meeting:chat', { text })
    setChatDraft('')
  }

  function whiteboardPointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    }
  }

  function drawLocalWhiteboardSegment(seg: { x0: number; y0: number; x1: number; y1: number; color: string; width: number }) {
    const canvas = whiteboardCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const widthPx = canvas.clientWidth
    const heightPx = canvas.clientHeight
    ctx.strokeStyle = seg.color
    ctx.lineWidth = seg.width
    ctx.beginPath()
    ctx.moveTo(seg.x0 * widthPx, seg.y0 * heightPx)
    ctx.lineTo(seg.x1 * widthPx, seg.y1 * heightPx)
    ctx.stroke()
  }

  function emitWhiteboardSegment(seg: { x0: number; y0: number; x1: number; y1: number; color: string; width: number }) {
    if (!socketRef.current?.connected) return
    socketRef.current.emit('meeting:whiteboard-draw', seg)
  }

  function openWhiteboard() {
    setWhiteboardOpen(true)
    socketRef.current?.emit('meeting:whiteboard-state', { active: true })
  }

  function closeWhiteboard() {
    setWhiteboardOpen(false)
    whiteboardDrawingRef.current = false
    whiteboardLastPointRef.current = null
    socketRef.current?.emit('meeting:whiteboard-state', { active: false })
  }

  function clearWhiteboard() {
    if (!whiteboardCanEdit) return
    const canvas = whiteboardCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    socketRef.current?.emit('meeting:whiteboard-clear')
  }

  function requestWhiteboardEdit() {
    socketRef.current?.emit('meeting:whiteboard-request-edit')
    showToast('Edit request sent')
  }

  function respondWhiteboardEditRequest(accepted: boolean) {
    if (!incomingWhiteboardReq) return
    socketRef.current?.emit('meeting:whiteboard-edit-response', {
      to: incomingWhiteboardReq.from,
      accepted,
    })
    setIncomingWhiteboardReq(null)
  }

  function revokeWhiteboardEdit() {
    if (!whiteboardIsOwner || !whiteboardRevokeUserId) return
    socketRef.current?.emit('meeting:whiteboard-revoke-edit', { userId: whiteboardRevokeUserId })
  }

  function loadOlderChat() {
    if (!socketRef.current?.connected || chatLoadingMore || !chatHasMore) return
    const first = chatMessages[0]
    if (!first) return
    setChatLoadingMore(true)
    socketRef.current.emit(
      'meeting:chat-history',
      { beforeCreatedAt: first.createdAt, beforeId: first.id, limit: 50 },
      (ack: unknown) => {
        setChatLoadingMore(false)
        if (!ack || typeof ack !== 'object') return
        const a = ack as Record<string, unknown>
        if (a.ok !== true) {
          if (typeof a.error === 'string') showToast(a.error)
          return
        }
        const older = Array.isArray(a.messages)
          ? (a.messages as unknown[]).flatMap(item => {
              if (!item || typeof item !== 'object') return []
              const row = item as {
                id?: unknown
                senderUserId?: unknown
                senderName?: unknown
                text?: unknown
                createdAt?: unknown
              }
              if (
                typeof row.id !== 'string' ||
                typeof row.senderUserId !== 'string' ||
                typeof row.senderName !== 'string' ||
                typeof row.text !== 'string' ||
                typeof row.createdAt !== 'string'
              ) return []
              return [{
                id: row.id,
                senderId: row.senderUserId,
                senderUserId: row.senderUserId,
                senderName: row.senderName,
                text: row.text,
                createdAt: row.createdAt,
              } satisfies ChatMessage]
            })
          : []
        setChatMessages(prev => {
          const known = new Set(prev.map(m => m.id))
          const dedupedOlder = older.filter(m => !known.has(m.id))
          return [...dedupedOlder, ...prev]
        })
        setChatHasMore(a.hasMore === true)
      },
    )
  }

  async function toggleMic() {
    const next = !micEnabled
    const localStream = localStreamRef.current ?? await ensureStream()

    if (!next) {
      setMicEnabled(false)
      for (const t of localStream.getAudioTracks()) t.enabled = false
      showToast('Microphone muted')
      return
    }

    try {
      let audioTrack = localStream.getAudioTracks()[0] ?? null
      if (!audioTrack) {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        const newAudioTrack = micStream.getAudioTracks()[0]
        if (!newAudioTrack) throw new Error('No microphone track available')
        localStream.addTrack(newAudioTrack)
        audioTrack = newAudioTrack

        for (const [remoteId, { pc }] of peersRef.current.entries()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
          if (sender) {
            await sender.replaceTrack(newAudioTrack)
          } else {
            pc.addTrack(newAudioTrack, localStream)
            void renegotiate(remoteId)
          }
        }
      }

      audioTrack.enabled = true
      setMicEnabled(true)
      showToast('Microphone on')
    } catch (e) {
      appendLog('mic toggle error', String(e))
      setMicEnabled(false)
      showToast('Unable to turn microphone on')
    }
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
      setPipCamOff(!screenSharingRef.current)
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

      // Only push camera to peers if not currently screen sharing
      if (!screenSharingRef.current) {
        for (const [remoteId, { pc }] of peersRef.current.entries()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video')
          if (sender) {
            await sender.replaceTrack(newVideoTrack)
          } else {
            pc.addTrack(newVideoTrack, localStream)
            void renegotiate(remoteId)
          }
        }
        if (localPipRef.current) localPipRef.current.srcObject = localStream
      }

      if (localPreviewRef.current) localPreviewRef.current.srcObject = localStream

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

  function requestControl(peerId: string) {
    socketRef.current?.emit('meeting:control-request', { to: peerId })
    showToast('Control request sent…')
  }

  function releaseControl() {
    if (controllingPeerRef.current) {
      socketRef.current?.emit('meeting:control-release', { to: controllingPeerRef.current })
    }
    setControllingPeer(null)
    controllingPeerRef.current = null
    showToast('Control released')
  }

  function respondControl(from: string, accepted: boolean) {
    setIncomingControlReq(null)
    socketRef.current?.emit('meeting:control-response', { to: from, accepted })
    if (accepted) {
      setControlledBy(from)
      controlledByRef.current = from
      showToast('Remote control allowed')
    } else {
      showToast('Remote control denied')
    }
  }

  function getVideoNormCoords(e: React.MouseEvent<HTMLDivElement>, peerId: string) {
    const videoEl = peerVideoRefs.current.get(peerId)
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    if (!videoEl?.videoWidth || !videoEl?.videoHeight) {
      return { normX: mx / rect.width, normY: my / rect.height }
    }
    const { videoWidth, videoHeight } = videoEl
    const scale = Math.max(rect.width / videoWidth, rect.height / videoHeight)
    const ox = (rect.width - videoWidth * scale) / 2
    const oy = (rect.height - videoHeight * scale) / 2
    return {
      normX: Math.max(0, Math.min(1, (mx - ox) / (videoWidth * scale))),
      normY: Math.max(0, Math.min(1, (my - oy) / (videoHeight * scale))),
    }
  }

  function sendControlEvent(peerId: string, payload: Record<string, unknown>) {
    socketRef.current?.emit('meeting:control-event', { to: peerId, ...payload })
  }

  function handleControlMouseMove(e: React.MouseEvent<HTMLDivElement>, peerId: string) {
    const now = Date.now()
    if (now - lastMouseSendRef.current < 33) return
    lastMouseSendRef.current = now
    sendControlEvent(peerId, { eventType: 'mousemove', ...getVideoNormCoords(e, peerId) })
  }

  function handleControlClick(e: React.MouseEvent<HTMLDivElement>, peerId: string) {
    sendControlEvent(peerId, { eventType: 'click', button: e.button, ...getVideoNormCoords(e, peerId) })
  }

  function handleControlDblClick(e: React.MouseEvent<HTMLDivElement>, peerId: string) {
    sendControlEvent(peerId, { eventType: 'dblclick', ...getVideoNormCoords(e, peerId) })
  }

  function handleControlScroll(e: React.WheelEvent<HTMLDivElement>, peerId: string) {
    sendControlEvent(peerId, { eventType: 'scroll', deltaY: e.deltaY })
  }

  function handleControlKey(e: React.KeyboardEvent<HTMLDivElement>, peerId: string) {
    e.preventDefault()
    sendControlEvent(peerId, { eventType: 'keydown', key: e.key })
  }

  async function renegotiate(remoteId: string) {
    const state = peersRef.current.get(remoteId)
    if (!state || !socketRef.current?.connected) return
    try {
      const offer = await state.pc.createOffer()
      await state.pc.setLocalDescription(offer)
      const sdp = state.pc.localDescription?.toJSON()
      if (sdp) socketRef.current.emit('webrtc:offer', { to: remoteId, sdp })
    } catch (e) {
      appendLog('renegotiate error', String(e))
    }
  }

  async function stopScreenShare() {
    screenStreamRef.current?.getTracks().forEach(t => t.stop())
    screenStreamRef.current = null
    screenSharingRef.current = false
    socketRef.current?.emit('meeting:screenshare', { sharing: false })
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] ?? null
    for (const [remoteId, { pc }] of peersRef.current.entries()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video')
      if (sender) {
        await sender.replaceTrack(cameraTrack)
        void renegotiate(remoteId)
      }
    }
    if (localPipRef.current && localStreamRef.current) {
      localPipRef.current.srcObject = localStreamRef.current
    }
    setPipCamOff(!cameraTrack)
    setScreenSharing(false)
    showToast('Screen sharing stopped')
  }

  async function toggleScreenShare() {
    if (screenSharingRef.current) { void stopScreenShare(); return }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      showToast('Screen share is not supported on this browser/device')
      return
    }
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const screenTrack = screenStream.getVideoTracks()[0]
      if (!screenTrack) return
      screenTrack.contentHint = 'detail'
      screenStreamRef.current = screenStream
      screenSharingRef.current = true
      socketRef.current?.emit('meeting:screenshare', { sharing: true })
      for (const [remoteId, { pc }] of peersRef.current.entries()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        if (sender) {
          await sender.replaceTrack(screenTrack)
          void renegotiate(remoteId)
        }
      }
      if (localPipRef.current) {
        const pipStream = new MediaStream([screenTrack])
        for (const t of (localStreamRef.current?.getAudioTracks() ?? [])) pipStream.addTrack(t)
        localPipRef.current.srcObject = pipStream
      }
      setScreenSharing(true)
      showToast('Screen sharing started')
      screenTrack.onended = () => { void stopScreenShare() }
    } catch (e) {
      screenSharingRef.current = false
      const err = e as DOMException
      if (err.name === 'NotAllowedError') {
        showToast('Screen share permission was denied')
        return
      }
      if (err.name === 'NotSupportedError') {
        showToast('Screen share is not supported on this browser/device')
        return
      }
      appendLog('screen share error', String(e))
      showToast('Unable to share screen')
    }
  }

  const shareUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return `${window.location.origin}/m/${encodeURIComponent(code)}`
  }, [code])

  const timerDisplay = `${Math.floor(timerSeconds / 60)}:${String(timerSeconds % 60).padStart(2, '0')}`
  const participantCount = peerIds.length + 1
  const isSoloInCall = peerIds.length === 0
  const remotePresenterId = peerIds.find(id => screenSharingPeers.has(id)) ?? null
  const presenterIsLocal = !remotePresenterId && screenSharing
  const presenterMode = Boolean(remotePresenterId || presenterIsLocal)
  const stripPeerIds = presenterMode
    ? peerIds.filter(id => id !== remotePresenterId)
    : peerIds
  const whiteboardCanEdit = whiteboardEditors.includes(mySocketIdRef.current)
  const whiteboardIsOwner = whiteboardOwnerId === mySocketIdRef.current
  const whiteboardOtherEditors = whiteboardEditors.filter(id => id !== whiteboardOwnerId)

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
                  <div className="flex flex-col gap-3 rounded-2xl border border-white/[0.07] bg-white/5 p-4">
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

                  <div className="flex items-center gap-2 rounded-2xl border border-white/[0.07] bg-white/5 p-3">
                    <code className="flex-1 truncate text-xs text-white/50">{shareUrl}</code>
                    <button
                      type="button"
                      className="rounded-xl border border-white/10 bg-white/8 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:bg-white/[0.14]"
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
          className="meeting-route-root fixed inset-0 z-100 overflow-hidden"
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
                <div className="relative w-full flex-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-black/35 aspect-video lg:aspect-auto lg:min-h-[380px]">
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
                          ? 'border-white/12 bg-white/12 text-white hover:bg-white/18'
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
                          ? 'border-white/12 bg-white/12 text-white hover:bg-white/18'
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

                <div className="flex w-full flex-col justify-center gap-4 lg:w-[min(100%,280px)] lg:shrink-0">
                  <p className="min-h-5 text-sm text-white/40">{statusLine}</p>

                  <div>
                    <p className="text-[0.6rem] font-semibold uppercase tracking-wider text-white/30">Meeting code</p>
                    <input
                      readOnly
                      value={code}
                      className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 font-mono text-sm text-white/80 outline-none"
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
                      className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 placeholder:text-white/25 outline-none focus:border-white/20"
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
        <div className="meeting-route-root" style={{ position: 'fixed', inset: 0, background: '#111', zIndex: 100 }}>
          {/* Video grid */}
          <div className={`meet-grid ${presenterMode ? 'meet-grid--presenter' : ''}`} style={presenterMode ? undefined : gridStyle}>
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
            {presenterMode ? (
              <>
                <div className="presenter-main">
                  {remotePresenterId ? (
                    <div className="meet-tile meet-tile--presenter">
                      <video
                        ref={getPeerVideoRef(remotePresenterId)}
                        playsInline
                        autoPlay
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: 'none' }}
                      />
                      <div className="meet-tile-label">Peer {shortId(remotePresenterId)} • Presenting</div>
                      {isHostInCall && remotePresenterId !== hostPeerId && (
                        <button
                          className="host-transfer-btn"
                          onClick={() => transferHost(remotePresenterId)}
                          title="Assign as host"
                        >
                          Make host
                        </button>
                      )}
                      {!controllingPeer && !controlledBy && (
                        <button
                          className="request-control-btn request-control-btn--visible"
                          onClick={() => requestControl(remotePresenterId)}
                          title={companionAvailable ? 'Request control' : 'Requires Bandr Companion app'}
                        >
                          <RemoteConnectionIcon size={13} />
                          {companionAvailable ? 'Request Control' : 'Needs Companion'}
                        </button>
                      )}
                      {controllingPeer === remotePresenterId && (
                        <div
                          className="control-overlay"
                          onMouseMove={e => handleControlMouseMove(e, remotePresenterId)}
                          onClick={e => handleControlClick(e, remotePresenterId)}
                          onDoubleClick={e => handleControlDblClick(e, remotePresenterId)}
                          onContextMenu={e => { e.preventDefault(); handleControlClick(e, remotePresenterId) }}
                          onWheel={e => handleControlScroll(e, remotePresenterId)}
                          onKeyDown={e => handleControlKey(e, remotePresenterId)}
                          tabIndex={0}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="meet-tile meet-tile--presenter">
                      <video ref={localPresenterRef} playsInline autoPlay muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: 'none' }} />
                      <div className="meet-tile-label">You • Presenting</div>
                    </div>
                  )}
                </div>
                <div className="presenter-strip">
                  {!presenterIsLocal && (
                    <div className="meet-tile meet-tile--thumb">
                      <video ref={localStripRef} playsInline autoPlay muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: 'scaleX(-1)' }} />
                      <div className="meet-tile-label">You</div>
                    </div>
                  )}
                  {stripPeerIds.map(id => (
                    <div key={id} className="meet-tile meet-tile--thumb">
                      <video
                        ref={getPeerVideoRef(id)}
                        playsInline
                        autoPlay
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: screenSharingPeers.has(id) ? 'none' : 'scaleX(-1)' }}
                      />
                      <div className="meet-tile-label">Peer {shortId(id)}</div>
                      {isHostInCall && id !== hostPeerId && (
                        <button className="host-transfer-btn" onClick={() => transferHost(id)} title="Assign as host">
                          Make host
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              peerIds.map(id => (
                <div key={id} className="meet-tile">
                  <video
                    ref={getPeerVideoRef(id)}
                    playsInline
                    autoPlay
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: screenSharingPeers.has(id) ? 'none' : 'scaleX(-1)' }}
                  />
                  <div className="meet-tile-label">Peer {shortId(id)}</div>
                  {isHostInCall && id !== hostPeerId && (
                    <button className="host-transfer-btn" onClick={() => transferHost(id)} title="Assign as host">
                      Make host
                    </button>
                  )}

                  {/* Request control button — shown on screen-sharing peers */}
                  {screenSharingPeers.has(id) && !controllingPeer && !controlledBy && (
                    <button
                      className="request-control-btn"
                      onClick={() => requestControl(id)}
                      title={companionAvailable ? 'Request control' : 'Requires Bandr Companion app'}
                    >
                      <RemoteConnectionIcon size={13} />
                      {companionAvailable ? 'Request Control' : 'Needs Companion'}
                    </button>
                  )}

                  {/* Invisible overlay capturing input when we're in control */}
                  {controllingPeer === id && (
                    <div
                      className="control-overlay"
                      onMouseMove={e => handleControlMouseMove(e, id)}
                      onClick={e => handleControlClick(e, id)}
                      onDoubleClick={e => handleControlDblClick(e, id)}
                      onContextMenu={e => { e.preventDefault(); handleControlClick(e, id) }}
                      onWheel={e => handleControlScroll(e, id)}
                      onKeyDown={e => handleControlKey(e, id)}
                      tabIndex={0}
                    />
                  )}
                </div>
              ))
            )}
          </div>

          {/* Local PiP */}
          <div className={`local-pip ${isSoloInCall ? 'local-pip--solo' : 'local-pip--floating'} ${presenterMode ? 'local-pip--hidden' : ''}`}>
            <video ref={localPipRef} playsInline autoPlay muted className={screenSharing ? '' : 'mirror'} />
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
              {companionAvailable && (
                <span className="companion-badge" title="Bandr Companion connected">
                  <RemoteConnectionIcon size={11} />
                  Companion
                </span>
              )}
              <span className="call-code-badge">{activeMeetingCode}</span>
            </div>
          </div>

          {whiteboardOpen && (
            <div className="whiteboard-layer">
              <div className="whiteboard-toolbar">
                <span className="whiteboard-title">Whiteboard</span>
                {!whiteboardCanEdit && (
                  <button type="button" onClick={requestWhiteboardEdit}>Ask to collaborate</button>
                )}
                {whiteboardIsOwner && whiteboardOtherEditors.length > 0 && (
                  <>
                    <select
                      value={whiteboardRevokeUserId}
                      onChange={e => setWhiteboardRevokeUserId(e.target.value)}
                      title="Select collaborator to remove"
                    >
                      {whiteboardOtherEditors.map(id => (
                        <option key={id} value={id}>{`Editor ${shortId(id)}`}</option>
                      ))}
                    </select>
                    <button type="button" onClick={revokeWhiteboardEdit} disabled={!whiteboardRevokeUserId}>
                      Remove access
                    </button>
                  </>
                )}
                <input
                  type="color"
                  value={whiteboardColor}
                  onChange={e => setWhiteboardColor(e.target.value)}
                  title="Brush color"
                  disabled={!whiteboardCanEdit}
                />
                <input
                  type="range"
                  min={1}
                  max={12}
                  value={whiteboardWidth}
                  onChange={e => setWhiteboardWidth(Number(e.target.value))}
                  title="Brush size"
                  disabled={!whiteboardCanEdit}
                />
                <button type="button" onClick={clearWhiteboard} disabled={!whiteboardCanEdit}>Clear</button>
                {whiteboardIsOwner && <button type="button" onClick={closeWhiteboard}>Close</button>}
              </div>
              <canvas
                ref={whiteboardCanvasRef}
                className="whiteboard-canvas"
                onPointerDown={e => {
                  if (!whiteboardCanEdit) return
                  if (e.button !== 0) return
                  e.currentTarget.setPointerCapture(e.pointerId)
                  whiteboardDrawingRef.current = true
                  whiteboardLastPointRef.current = whiteboardPointFromEvent(e)
                }}
                onPointerMove={e => {
                  if (!whiteboardCanEdit) return
                  if (!whiteboardDrawingRef.current) return
                  const next = whiteboardPointFromEvent(e)
                  const last = whiteboardLastPointRef.current
                  if (!last) {
                    whiteboardLastPointRef.current = next
                    return
                  }
                  const seg = { x0: last.x, y0: last.y, x1: next.x, y1: next.y, color: whiteboardColor, width: whiteboardWidth }
                  drawLocalWhiteboardSegment(seg)
                  emitWhiteboardSegment(seg)
                  whiteboardLastPointRef.current = next
                }}
                onPointerUp={e => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
                  whiteboardDrawingRef.current = false
                  whiteboardLastPointRef.current = null
                }}
                onPointerCancel={e => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
                  whiteboardDrawingRef.current = false
                  whiteboardLastPointRef.current = null
                }}
              />
            </div>
          )}
          {incomingWhiteboardReq && whiteboardIsOwner && (
            <div className="control-request-dialog">
              <p className="control-request-title">Whiteboard collaboration request</p>
              <p className="control-request-body">
                <strong>{incomingWhiteboardReq.fromName}</strong> wants to edit the whiteboard.
              </p>
              <div className="control-request-actions">
                <button className="control-req-allow" onClick={() => respondWhiteboardEditRequest(true)}>Allow</button>
                <button className="control-req-deny" onClick={() => respondWhiteboardEditRequest(false)}>Deny</button>
              </div>
            </div>
          )}

          {chatOpen && (
            <aside className="chat-panel" aria-label="Meeting chat">
              <div className="chat-panel-header">
                <div className="chat-panel-title">
                  <span>Meeting chat</span>
                  <small>{participantCount === 1 ? 'Just you' : `${participantCount} participants`}</small>
                </div>
                <button type="button" className="chat-close-btn" onClick={() => setChatOpen(false)} aria-label="Close chat">
                  ✕
                </button>
              </div>
              <div className="chat-messages">
                {chatHasMore && (
                  <button
                    type="button"
                    className="chat-load-older"
                    onClick={loadOlderChat}
                    disabled={chatLoadingMore}
                  >
                    {chatLoadingMore ? 'Loading…' : 'Load older messages'}
                  </button>
                )}
                {chatMessages.length === 0 ? (
                  <p className="chat-empty-state">No messages yet</p>
                ) : (
                  chatMessages.map(m => {
                    const mine = m.senderId === mySocketIdRef.current || (m.senderUserId != null && m.senderUserId === myUserIdRef.current)
                    return (
                      <div key={m.id} className={`chat-message ${mine ? 'chat-message--mine' : ''}`}>
                        <div className="chat-message-meta">
                          <span>{mine ? 'You' : (m.senderName || `Peer ${shortId(m.senderId)}`)}</span>
                          <time>{formatChatTime(m.createdAt)}</time>
                        </div>
                        <p>{m.text}</p>
                      </div>
                    )
                  })
                )}
                <div ref={chatBottomRef} />
              </div>
              <form
                className="chat-input-row"
                onSubmit={e => {
                  e.preventDefault()
                  sendChatMessage()
                }}
              >
                <input
                  type="text"
                  value={chatDraft}
                  onChange={e => setChatDraft(e.target.value)}
                  placeholder="Send a message"
                  maxLength={500}
                />
                <button type="submit" disabled={chatDraft.trim().length === 0}>Send</button>
              </form>
            </aside>
          )}

          {/* Incoming control request dialog (browser fallback — shown when companion is not running) */}
          {incomingControlReq && (
            <div className="control-request-dialog">
              <p className="control-request-title">
                <RemoteConnectionIcon size={16} />
                Remote control request
              </p>
              <p className="control-request-body">
                <strong>{incomingControlReq.fromName}</strong> wants to control your computer.
                {!companionAvailable && <span className="control-request-warn"> Download the Companion app for OS-level control.</span>}
              </p>
              <div className="control-request-actions">
                <button className="control-req-allow" onClick={() => respondControl(incomingControlReq.from, true)}>Allow</button>
                <button className="control-req-deny" onClick={() => respondControl(incomingControlReq.from, false)}>Deny</button>
              </div>
            </div>
          )}

          {isHostInCall && hostJoinRequests.length > 0 && (
            <div className="control-request-dialog" style={{ bottom: incomingControlReq ? 248 : 90 }}>
              <p className="control-request-title">Join request</p>
              <p className="control-request-body">
                <strong>{hostJoinRequests[0]?.name ?? 'Someone'}</strong> wants to join this meeting.
              </p>
              <div className="control-request-actions">
                <button
                  className="control-req-allow"
                  onClick={() => hostJoinRequests[0] && respondJoinRequest(hostJoinRequests[0].requestId, true)}
                >
                  Allow
                </button>
                <button
                  className="control-req-deny"
                  onClick={() => hostJoinRequests[0] && respondJoinRequest(hostJoinRequests[0].requestId, false)}
                >
                  Deny
                </button>
              </div>
            </div>
          )}

          {/* Active control banner */}
          {(controllingPeer || controlledBy) && (
            <div className="control-banner">
              {controllingPeer
                ? <>You are controlling a peer's computer — <button onClick={releaseControl}>Stop</button></>
                : <>Your computer is being remotely controlled</>
              }
            </div>
          )}

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
            <button
              onClick={() => void toggleScreenShare()}
              className={`ctrl-btn ctrl-btn--lg ${screenSharing ? 'ctrl-btn--danger' : 'ctrl-btn--active'}`}
              title={screenSharing ? 'Stop sharing' : 'Share screen'}
            >
              {screenSharing ? (
                <svg viewBox="0 0 24 24" fill="white" width="22" height="22">
                  <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9 10h6v4H9z"/>
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="white" width="22" height="22">
                  <path d="M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 16V6h16v10.01L4 16zm9-6.87l3 3.87H8l3-3.87z"/>
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={whiteboardOpen ? (whiteboardIsOwner ? closeWhiteboard : undefined) : openWhiteboard}
              className={`ctrl-btn ctrl-btn--lg ${whiteboardOpen ? 'ctrl-btn--danger' : 'ctrl-btn--active'}`}
              title={whiteboardOpen ? (whiteboardIsOwner ? 'Close whiteboard' : 'Whiteboard is active') : 'Open whiteboard'}
              disabled={whiteboardOpen && !whiteboardIsOwner}
            >
              <svg viewBox="0 0 24 24" fill="white" width="22" height="22">
                <path d="M3 4.5C3 3.67 3.67 3 4.5 3h12c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5h-12C3.67 15 3 14.33 3 13.5v-9zm1.5 0v9h12v-9h-12z" />
                <path d="M18.6 5.8l2.6-2.6 1.2 1.2-2.6 2.6-.7 3.3-3.3.7.7-3.3 2.1-2.1z" />
                <path d="M6 18h12v2H6z" />
              </svg>
            </button>
            {(screenSharingPeers.size > 0 || controllingPeer) && (
              <button
                onClick={() => controllingPeer ? releaseControl() : requestControl([...screenSharingPeers][0]!)}
                className={`ctrl-btn ctrl-btn--lg ${controllingPeer ? 'ctrl-btn--danger' : 'ctrl-btn--active'}`}
                title={controllingPeer ? 'Stop controlling' : 'Request control of shared screen'}
              >
                <svg viewBox="0 0 24 24" fill="white" width="22" height="22">
                  <path d="M13.64 21.97C11.27 24.34 7.58 24.57 4.94 22.63L8.08 19.5c1.56.7 3.49.45 4.79-.85 1.62-1.62 1.62-4.25 0-5.87L9.7 9.6l1.41-1.41 3.54 3.54c2.34 2.34 2.34 6.09-.01 8.24zM10.36 2.03C12.73-.34 16.42-.57 19.06 1.37l-3.14 3.13c-1.56-.7-3.49-.45-4.79.85-1.62 1.62-1.62 4.25 0 5.87l3.17 3.18-1.41 1.41-3.54-3.54c-2.34-2.34-2.34-6.1.01-8.24z"/>
                </svg>
              </button>
            )}
            <button
              type="button"
              className={`chat-toggle-btn${chatOpen ? ' chat-toggle-btn--active' : ''}`}
              onClick={() => setChatOpen(prev => !prev)}
              aria-label={chatOpen ? 'Hide chat' : 'Show chat'}
              aria-pressed={chatOpen}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </svg>
              {chatUnread > 0 && <span className="chat-unread-badge">{chatUnread > 99 ? '99+' : chatUnread}</span>}
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
