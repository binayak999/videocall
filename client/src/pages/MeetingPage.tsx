import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'
import {
  completeMeetingRecording,
  errorMessage,
  getMeeting,
  uploadMeetingRecordingViaApi,
} from '../lib/api'
import { getToken } from '../lib/auth'
import { getIceServers } from '../lib/ice'
import { startCameraBackgroundPipeline, type CameraBackgroundPipeline } from '../lib/cameraBackgroundPipeline'
import { HostMeetingRecorder } from '../lib/hostMeetingRecorder'
import { classifyCameraFrame, preloadModerationModel } from '../lib/videoContentModeration'
import type { Meeting } from '../lib/types'

type CallView = 'detail' | 'lobby' | 'call'

type CameraBackgroundUiMode = 'none' | 'blur-low' | 'blur-high' | 'image'

function isBlurMode(m: CameraBackgroundUiMode): boolean { return m === 'blur-low' || m === 'blur-high' }
function blurAmountForMode(m: CameraBackgroundUiMode): number { return m === 'blur-low' ? 4 : 16 }

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

interface ParticipantRosterEntry {
  userName: string
  userId: string
}

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

function shortId(id: string) {
  return id.length <= 8 ? id : id.slice(0, 6) + '\u2026'
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
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

function RemoteCameraThumb({
  cameraId,
  streamsRef,
  ready,
}: {
  cameraId: string
  streamsRef: { current: Map<string, MediaStream> }
  ready: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (!ready) return
    const stream = streamsRef.current.get(cameraId)
    if (!stream || !videoRef.current) return
    videoRef.current.srcObject = stream
    void videoRef.current.play().catch(() => {})
  }, [cameraId, ready, streamsRef])

  return (
    <div className="shrink-0 h-9 w-14 overflow-hidden rounded-lg bg-black/40 relative">
      {ready
        ? <video ref={videoRef} playsInline muted autoPlay className="h-full w-full -scale-x-100 object-cover" />
        : <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-2.5 w-2.5 rounded-full border-2 border-white/30 border-t-white/80 animate-spin" />
          </div>
      }
    </div>
  )
}

export function MeetingPage() {
  const params = useParams()
  const location = useLocation()
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
  const [hasWeakNetwork, setHasWeakNetwork] = useState(false)
  const [presenterPage, setPresenterPage] = useState(0)
  const [screenSharing, setScreenSharing] = useState(false)
  const [screenSharingPeers, setScreenSharingPeers] = useState<Set<string>>(new Set())
  const [companionAvailable, setCompanionAvailable] = useState(false)
  const [controllingPeer, setControllingPeer] = useState<string | null>(null)
  const [controlledBy, setControlledBy] = useState<string | null>(null)
  const [incomingControlReq, setIncomingControlReq] = useState<{ from: string; fromName: string } | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [callSettingsOpen, setCallSettingsOpen] = useState(false)
  const [recordingActive, setRecordingActive] = useState(false)
  const [recordingBusy, setRecordingBusy] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatUnread, setChatUnread] = useState(0)
  const [chatHasMore, setChatHasMore] = useState(false)
  const [chatLoadingMore, setChatLoadingMore] = useState(false)
  const [hostJoinRequests, setHostJoinRequests] = useState<{ requestId: string; name: string }[]>([])
  const [isHostInCall, setIsHostInCall] = useState(false)
  const [hostPeerId, setHostPeerId] = useState<string | null>(null)
  const [participantRoster, setParticipantRoster] = useState<Record<string, ParticipantRosterEntry>>({})
  const [callLocalSocketId, setCallLocalSocketId] = useState<string | null>(null)
  const [whiteboardOpen, setWhiteboardOpen] = useState(false)
  const [whiteboardColor, setWhiteboardColor] = useState('#ffffff')
  const [whiteboardWidth, setWhiteboardWidth] = useState(3)
  const [whiteboardOwnerId, setWhiteboardOwnerId] = useState<string | null>(null)
  const [whiteboardEditors, setWhiteboardEditors] = useState<string[]>([])
  const [whiteboardRevokeUserId, setWhiteboardRevokeUserId] = useState('')
  const [incomingWhiteboardReq, setIncomingWhiteboardReq] = useState<{ from: string; fromName: string } | null>(null)
  const [cameraBgMode, setCameraBgMode] = useState<CameraBackgroundUiMode>('none')
  const [localCameraDevices, setLocalCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [remoteCameras, setRemoteCameras] = useState<Map<string, { label: string; ready: boolean }>>(new Map())
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null) // null = default | 'local:deviceId' | 'remote:socketId'
  const activeCameraIdRef = useRef<string | null>(null)
  const [showCameraPanel, setShowCameraPanel] = useState(false)
  const [cameraShareUrl, setCameraShareUrl] = useState<string | null>(null)

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
  const controlUnavailableNotifiedRef = useRef<Set<string>>(new Set())
  const lastMouseSendRef = useRef(0)
  const iceRestartTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const autoVideoPausedRef = useRef(false)
  const swipeContainerRef = useRef<HTMLDivElement>(null)
  const whiteboardCanvasRef = useRef<HTMLCanvasElement>(null)
  const whiteboardLastPointRef = useRef<{ x: number; y: number } | null>(null)
  const whiteboardDrawingRef = useRef(false)
  const cameraModerationFiredRef = useRef(false)
  const cameraModerationStreakRef = useRef(0)
  const applyContentPolicyViolationRef = useRef<() => void>(() => {})
  const cameraBgPipelineRef = useRef<CameraBackgroundPipeline | null>(null)
  const remoteCameraPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const remoteCameraStreamsRef = useRef<Map<string, MediaStream>>(new Map())
  const cameraBgImageElRef = useRef<HTMLImageElement | null>(null)
  const cameraBgImageObjectUrlRef = useRef<string | null>(null)
  const cameraBgFileInputRef = useRef<HTMLInputElement>(null)
  const recordingRootRef = useRef<HTMLDivElement>(null)
  const hostRecorderRef = useRef<HostMeetingRecorder | null>(null)
  const recordingStartedAtRef = useRef(0)

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

  useEffect(() => {
    if (!callSettingsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCallSettingsOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [callSettingsOpen])

  // auto-start camera when lobby opens
  useEffect(() => {
    if (callView !== 'lobby') return
    ensureStream().catch(() => setPreviewCamOff(true))
  }, [callView])

  useEffect(() => {
    preloadModerationModel()
  }, [])

  useEffect(() => {
    if (callView === 'lobby') {
      cameraModerationFiredRef.current = false
      cameraModerationStreakRef.current = 0
    }
  }, [callView])

  // Sync local video elements whenever layout mounts or screen share starts/stops.
  // localPresenterRef and localStripRef live inside the conditionally-rendered swipe
  // container, so they mount only when presenterMode becomes true — we must re-run
  // this effect then, not just on callView change.
  useEffect(() => {
    if (callView !== 'call') return
    const camStream = localStreamRef.current
    const screenStream = screenStreamRef.current

    // PiP: show screen + audio while sharing, otherwise camera
    if (localPipRef.current) {
      if (screenSharing && screenStream) {
        const s = new MediaStream([
          ...screenStream.getVideoTracks(),
          ...(camStream?.getAudioTracks() ?? []),
        ])
        localPipRef.current.srcObject = s
      } else if (camStream) {
        localPipRef.current.srcObject = camStream
      }
      void localPipRef.current.play().catch(() => {})
    }

    // Presenter full-screen tile: show screen share when local user is sharing
    if (localPresenterRef.current) {
      localPresenterRef.current.srcObject =
        (screenSharing && screenStream) ? screenStream : camStream ?? null
      void localPresenterRef.current.play().catch(() => {})
    }

    // Participants page strip tile: always show camera
    if (localStripRef.current && camStream) {
      localStripRef.current.srcObject = camStream
      void localStripRef.current.play().catch(() => {})
    }
    // screenSharingPeers (Set identity) + screenSharing: re-run when presenter mode changes.
  }, [callView, screenSharing, screenSharingPeers])

  // keep chat pinned to latest message
  useEffect(() => {
    if (!chatOpen) return
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chatMessages, chatOpen])

  useEffect(() => {
    if (chatOpen) setChatUnread(0)
  }, [chatOpen])

  // Reset to presenter page when screen share starts/stops
  useEffect(() => {
    setPresenterPage(0)
    const el = swipeContainerRef.current
    if (el) el.scrollLeft = 0
  }, [screenSharing, screenSharingPeers])

  // Re-sync peer streams to video elements after any layout change (grid ↔ presenter).
  // ontrack may fire while the element is mid-transition and miss the assignment.
  useEffect(() => {
    for (const [id, stream] of peerStreamRefs.current.entries()) {
      const el = peerVideoRefs.current.get(id)
      if (el && el.srcObject !== stream) {
        el.srcObject = stream
        void el.play().catch(() => {})
      }
    }
  }, [peerIds, screenSharingPeers])

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
    const peersMap = peersRef.current
    const iceTimersMap = iceRestartTimersRef.current
    return () => {
      if (cameraBgImageObjectUrlRef.current) {
        URL.revokeObjectURL(cameraBgImageObjectUrlRef.current)
        cameraBgImageObjectUrlRef.current = null
      }
      const unmountPipedRaw = cameraBgPipelineRef.current?.getRawTrack() ?? null
      cameraBgPipelineRef.current?.stop()
      cameraBgPipelineRef.current = null
      socketRef.current?.disconnect()
      localStreamRef.current?.getTracks().forEach(t => t.stop())
      if (unmountPipedRaw?.readyState === 'live') unmountPipedRaw.stop()
      screenStreamRef.current?.getTracks().forEach(t => t.stop())
      for (const s of peersMap.values()) s.pc.close()
      peersMap.clear()
      for (const t of iceTimersMap.values()) clearTimeout(t)
      iceTimersMap.clear()
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current)
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

  /** Stops the ML background pipeline; returns the raw camera track if it was only wired through the pipeline (caller may still be using it). */
  function teardownCameraBackgroundPipeline(): MediaStreamTrack | null {
    const p = cameraBgPipelineRef.current
    if (!p) return null
    const raw = p.getRawTrack()
    const ls = localStreamRef.current
    const proc = p.getProcessedTrack()
    if (ls) {
      for (const t of ls.getVideoTracks()) {
        if (t.id === proc.id) ls.removeTrack(t)
      }
    }
    p.stop()
    cameraBgPipelineRef.current = null
    return raw
  }

  /** Inbound tracks from phone/camera-source WebRTC must never be .stop()'d — that kills the receiver and shows black. */
  function isInboundRemoteCameraVideoTrack(track: MediaStreamTrack): boolean {
    if (track.kind !== 'video') return false
    for (const stream of remoteCameraStreamsRef.current.values()) {
      if (stream.getVideoTracks().some(t => t.id === track.id)) return true
    }
    return false
  }

  async function pushLocalVideoToPeersAndPreview(videoTrack: MediaStreamTrack) {
    const ls = localStreamRef.current
    if (!ls) return
    if (!screenSharingRef.current) {
      for (const [remoteId, { pc }] of peersRef.current.entries()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        if (sender) {
          await sender.replaceTrack(videoTrack)
        } else {
          pc.addTrack(videoTrack, ls)
          void renegotiate(remoteId)
        }
      }
    }
    if (localPreviewRef.current) {
      localPreviewRef.current.srcObject = ls
      void localPreviewRef.current.play().catch(() => {})
    }
    if (localPipRef.current && !screenSharingRef.current) {
      localPipRef.current.srcObject = ls
      void localPipRef.current.play().catch(() => {})
    }
    if (localStripRef.current) {
      localStripRef.current.srcObject = ls
      void localStripRef.current.play().catch(() => {})
    }
  }

  async function applyCameraWithBackgroundSettings(
    rawTrack: MediaStreamTrack,
    mode: CameraBackgroundUiMode,
    bgImageEl: HTMLImageElement | null,
  ) {
    teardownCameraBackgroundPipeline()
    const ls = localStreamRef.current ?? await ensureStream()
    for (const t of [...ls.getVideoTracks()]) {
      ls.removeTrack(t)
      if (t.id !== rawTrack.id && !isInboundRemoteCameraVideoTrack(t)) t.stop()
    }

    if (mode === 'none') {
      ls.addTrack(rawTrack)
      await pushLocalVideoToPeersAndPreview(rawTrack)
      return
    }
    if (mode === 'image' && !bgImageEl) {
      showToast('Choose a background image first')
      ls.addTrack(rawTrack)
      await pushLocalVideoToPeersAndPreview(rawTrack)
      return
    }
    try {
      showToast('Loading background effect…', 2200)
      const pipeline = await startCameraBackgroundPipeline(
        rawTrack,
        isBlurMode(mode) ? 'blur' : 'image',
        mode === 'image' ? bgImageEl : null,
        isBlurMode(mode) ? { blurAmount: blurAmountForMode(mode) } : undefined,
      )
      cameraBgPipelineRef.current = pipeline
      const out = pipeline.getProcessedTrack()
      ls.addTrack(out)
      await pushLocalVideoToPeersAndPreview(out)
    } catch (e) {
      appendLog('background pipeline', String(e))
      showToast('Background effect failed — using normal camera')
      ls.addTrack(rawTrack)
      await pushLocalVideoToPeersAndPreview(rawTrack)
    }
  }

  async function reapplyCameraBackgroundWithMode(mode: CameraBackgroundUiMode) {
    if (!camEnabled) return
    const img = cameraBgImageElRef.current
    const p = cameraBgPipelineRef.current
    const raw = p?.getRawTrack() ?? localStreamRef.current?.getVideoTracks()[0]
    if (!raw || raw.kind !== 'video') return

    if (p && mode !== 'none') {
      if (mode === 'image' && !img) {
        showToast('Choose a background image')
        return
      }
      p.setMode(isBlurMode(mode) ? 'blur' : 'image')
      p.setBackgroundImage(mode === 'image' ? img : null)
      if (isBlurMode(mode)) p.setBlurAmount(blurAmountForMode(mode))
      return
    }

    await applyCameraWithBackgroundSettings(raw, mode, img)
  }

  function handleCameraBackgroundFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f?.type.startsWith('image/')) {
      showToast('Choose an image file')
      return
    }
    if (cameraBgImageObjectUrlRef.current) {
      URL.revokeObjectURL(cameraBgImageObjectUrlRef.current)
      cameraBgImageObjectUrlRef.current = null
    }
    const url = URL.createObjectURL(f)
    cameraBgImageObjectUrlRef.current = url
    const img = new Image()
    img.onload = () => {
      cameraBgImageElRef.current = img
      setCameraBgMode('image')
      void reapplyCameraBackgroundWithMode('image')
    }
    img.onerror = () => {
      showToast('Could not load image')
      URL.revokeObjectURL(url)
      cameraBgImageObjectUrlRef.current = null
    }
    img.src = url
  }

  // ── Multi-camera ──────────────────────────────────────────────────────────

  async function enumerateLocalCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setLocalCameraDevices(devices.filter(d => d.kind === 'videoinput'))
    } catch { /* ignore */ }
  }

  async function generateCameraToken() {
    const socket = socketRef.current
    if (!socket) return
    socket.emit('camera:generate-token', {}, (res: { ok: boolean; token?: string; error?: string }) => {
      if (!res.ok || !res.token) { showToast(res.error ?? 'Could not generate camera link'); return }
      const url = `${window.location.origin}/camera/${res.token}`
      setCameraShareUrl(url)
    })
  }

  async function switchCamera(sourceId: string | null) {
    let newTrack: MediaStreamTrack | null = null

    if (sourceId === null || sourceId.startsWith('local:')) {
      const deviceId = sourceId?.slice(6)
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : true,
      }).catch(() => null)
      if (!stream) { showToast('Could not access camera'); return }
      newTrack = stream.getVideoTracks()[0] ?? null
    } else if (sourceId.startsWith('remote:')) {
      const camId = sourceId.slice(7)
      newTrack = remoteCameraStreamsRef.current.get(camId)?.getVideoTracks()[0] ?? null
      // Allow switching even if track is not flowing yet — markReady will push it again when media starts
      if (!newTrack) {
        // Track hasn't arrived yet — mark as selected so markReady will auto-apply it
        activeCameraIdRef.current = sourceId
        setActiveCameraId(sourceId)
        showToast('Connecting camera… video will appear shortly')
        return
      }
    }

    if (!newTrack) { showToast('Camera track unavailable'); return }

    activeCameraIdRef.current = sourceId
    teardownCameraBackgroundPipeline()
    const ls = localStreamRef.current
    if (ls) {
      for (const t of [...ls.getVideoTracks()]) {
        ls.removeTrack(t)
        if (!isInboundRemoteCameraVideoTrack(t)) t.stop()
      }
      ls.addTrack(newTrack)
    }
    await pushLocalVideoToPeersAndPreview(newTrack)
    setActiveCameraId(sourceId)
    if (isBlurMode(cameraBgMode) || cameraBgMode === 'image') {
      void applyCameraWithBackgroundSettings(newTrack, cameraBgMode, cameraBgImageElRef.current)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

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
      if (screenSharingRef.current && screenStreamRef.current) {
        // Screen share is active — send screen video to the new peer instead of camera
        for (const t of localStreamRef.current.getAudioTracks()) {
          pc.addTrack(t, localStreamRef.current)
        }
        const screenTrack = screenStreamRef.current.getVideoTracks()[0]
        if (screenTrack) pc.addTrack(screenTrack, localStreamRef.current)
      } else {
        for (const t of localStreamRef.current.getTracks()) pc.addTrack(t, localStreamRef.current)
      }
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

    pc.onconnectionstatechange = () => {
      const cs = pc.connectionState
      appendLog('pc[' + shortId(remoteId) + ']', cs)
      if (cs === 'failed') {
        const existing = iceRestartTimersRef.current.get(remoteId)
        if (existing) clearTimeout(existing)
        iceRestartTimersRef.current.delete(remoteId)
        void iceRestart(remoteId)
      } else if (cs === 'disconnected') {
        if (!iceRestartTimersRef.current.has(remoteId)) {
          const timer = setTimeout(() => {
            iceRestartTimersRef.current.delete(remoteId)
            const s = peersRef.current.get(remoteId)
            if (s && (s.pc.connectionState === 'disconnected' || s.pc.connectionState === 'failed')) {
              void iceRestart(remoteId)
            }
          }, 2000)
          iceRestartTimersRef.current.set(remoteId, timer)
        }
      } else if (cs === 'connected') {
        const existing = iceRestartTimersRef.current.get(remoteId)
        if (existing) { clearTimeout(existing); iceRestartTimersRef.current.delete(remoteId) }
        setHasWeakNetwork(false)
        void applyBitrateCaps(pc)
      }
    }

    const state: PeerState = { pc, pendingIce, remoteDescriptionReady: false }
    peersRef.current.set(remoteId, state)

    const early = preConnectIceRef.current.get(remoteId)
    if (early) { for (const c of early) pendingIce.push(c); preConnectIceRef.current.delete(remoteId) }

    setPeerIds(prev => [...prev, remoteId])
    return state
  }

  function removePeer(remoteId: string) {
    const timer = iceRestartTimersRef.current.get(remoteId)
    if (timer) { clearTimeout(timer); iceRestartTimersRef.current.delete(remoteId) }
    peersRef.current.get(remoteId)?.pc.close()
    peersRef.current.delete(remoteId)
    preConnectIceRef.current.delete(remoteId)
    peerVideoRefs.current.delete(remoteId)
    peerVideoCallbackRefs.current.delete(remoteId)
    peerStreamRefs.current.delete(remoteId)
    setPeerIds(prev => prev.filter(id => id !== remoteId))
  }

  function resetAllPeers() {
    for (const timer of iceRestartTimersRef.current.values()) clearTimeout(timer)
    iceRestartTimersRef.current.clear()
    for (const s of peersRef.current.values()) s.pc.close()
    peersRef.current.clear()
    preConnectIceRef.current.clear()
    peerVideoRefs.current.clear()
    peerVideoCallbackRefs.current.clear()
    peerStreamRefs.current.clear()
    setPeerIds([])
    setParticipantRoster({})
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
      const p = payload as { peerId?: unknown; userName?: unknown; userId?: unknown }
      const peerId = p.peerId
      if (typeof peerId !== 'string' || peerId === mySocketIdRef.current) return
      const userName = typeof p.userName === 'string' ? p.userName : 'Guest'
      const userId = typeof p.userId === 'string' ? p.userId : ''
      setParticipantRoster(prev => ({ ...prev, [peerId]: { userName, userId } }))
      appendLog('peer-joined', shortId(peerId))
      showToast(`${userName} joined the call`)
      if (shouldInitiateOffer(peerId)) void createAndSendOffer(peerId).catch(e => appendLog('offer error', String(e)))
      // Re-announce screen share so the newly joined peer learns the current state
      if (screenSharingRef.current) {
        socket.emit('meeting:screenshare', { sharing: true })
      }
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
      const newHostUserId = p.hostUserId
      setMeeting(prev => (prev ? { ...prev, hostId: newHostUserId } : prev))
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
    // ── Multi-camera source events ────────────────────────────────────────
    socket.on('camera:source-connected', async ({ cameraId, label }: { cameraId: string; label: string }) => {
      // Clean up any stale PC from a previous connection with the same camera ID
      remoteCameraPcsRef.current.get(cameraId)?.close()
      remoteCameraPcsRef.current.delete(cameraId)
      remoteCameraStreamsRef.current.delete(cameraId)
      setRemoteCameras(prev => new Map(prev).set(cameraId, { label: label || 'Remote Camera', ready: false }))
      showToast(`Camera "${label || 'Remote Camera'}" connected`)
      // Tell camera source to send us an offer
      socket.emit('camera:request-offer', { to: cameraId, hostId: socket.id })
    })

    socket.on('camera:source-disconnected', ({ cameraId }: { cameraId: string }) => {
      setRemoteCameras(prev => { const m = new Map(prev); m.delete(cameraId); return m })
      remoteCameraPcsRef.current.get(cameraId)?.close()
      remoteCameraPcsRef.current.delete(cameraId)
      remoteCameraStreamsRef.current.delete(cameraId)
      setActiveCameraId(prev => {
        const next = prev === `remote:${cameraId}` ? null : prev
        activeCameraIdRef.current = next
        return next
      })
      showToast('A camera source disconnected')
    })

    socket.on('camera:offer', async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      // Offer from a camera source — close any stale PC, create recvonly PC, answer it
      remoteCameraPcsRef.current.get(from)?.close()
      const pc = new RTCPeerConnection({ iceServers: iceServersRef.current })
      remoteCameraPcsRef.current.set(from, pc)
      pc.ontrack = ev => {
        const stream = ev.streams[0] ?? new MediaStream([ev.track])
        remoteCameraStreamsRef.current.set(from, stream)
        // Mark ready when track unmutes (media actually flowing), not just on ontrack
        const track = ev.track
        const markReady = () => {
          setRemoteCameras(prev => {
            const entry = prev.get(from)
            if (!entry || entry.ready) return prev
            return new Map(prev).set(from, { ...entry, ready: true })
          })
          // If user already selected this camera, apply the track now that media flows
          if (activeCameraIdRef.current === `remote:${from}`) {
            const ls = localStreamRef.current
            if (ls) {
              for (const vt of [...ls.getVideoTracks()]) {
                if (vt.id === track.id) continue
                ls.removeTrack(vt)
                if (!isInboundRemoteCameraVideoTrack(vt)) vt.stop()
              }
              if (!ls.getVideoTracks().some(vt => vt.id === track.id)) ls.addTrack(track)
            }
            void pushLocalVideoToPeersAndPreview(track)
          }
        }
        if (!track.muted) {
          markReady()
        } else {
          track.addEventListener('unmute', markReady, { once: true })
          // Fallback: mark ready after 4 s even if unmute never fires
          setTimeout(markReady, 4000)
        }
      }
      pc.onicecandidate = ev => {
        if (ev.candidate) socket.emit('camera:ice', { to: from, candidate: ev.candidate.toJSON() })
      }
      await pc.setRemoteDescription(new RTCSessionDescription(sdp))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      socket.emit('camera:answer', { to: from, sdp: pc.localDescription })
    })

    socket.on('camera:ice', async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = remoteCameraPcsRef.current.get(from)
      if (pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
    })
    // ─────────────────────────────────────────────────────────────────────

    socket.on('meeting:peer-left', (payload: unknown) => {
      const peerId =
        payload && typeof payload === 'object' && 'peerId' in (payload as object)
          ? (payload as { peerId: unknown }).peerId
          : undefined
      if (typeof peerId === 'string') {
        appendLog('peer-left', shortId(peerId))
        removePeer(peerId)
        setParticipantRoster(prev => {
          const next = { ...prev }
          delete next[peerId]
          return next
        })
        setScreenSharingPeers(prev => { const s = new Set(prev); s.delete(peerId); return s })
        showToast('A participant left')
      } else {
        appendLog('peer-left (full reset)')
        resetAllPeers()
        setParticipantRoster({})
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
      } else if (typeof p.from === 'string' && !controlUnavailableNotifiedRef.current.has(p.from)) {
        // Notify the requester once that companion is not running on this machine
        controlUnavailableNotifiedRef.current.add(p.from)
        socket.emit('meeting:control-unavailable', { to: p.from })
        controlledByRef.current = null
        setControlledBy(null)
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
    socket.on('meeting:control-unavailable', () => {
      setControllingPeer(null)
      controllingPeerRef.current = null
      showToast('Remote control requires the Bandr Companion app on the other machine — ask them to install and run it', 6000)
    })
    socket.on('meeting:screenshare', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { peerId, sharing } = payload as { peerId?: unknown; sharing?: unknown }
      if (typeof peerId !== 'string' || typeof sharing !== 'boolean') return
      setScreenSharingPeers(prev => {
        const s = new Set(prev)
        if (sharing) s.add(peerId)
        else s.delete(peerId)
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
    setCallLocalSocketId(mySocketIdRef.current || null)
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
    {
      const nextRoster: Record<string, ParticipantRosterEntry> = {}
      const roster = a.peerRoster
      if (Array.isArray(roster)) {
        for (const row of roster) {
          if (!row || typeof row !== 'object') continue
          const r = row as { peerId?: unknown; userId?: unknown; userName?: unknown }
          if (typeof r.peerId !== 'string') continue
          nextRoster[r.peerId] = {
            userId: typeof r.userId === 'string' ? r.userId : '',
            userName: typeof r.userName === 'string' ? r.userName : 'Guest',
          }
        }
      }
      const sid = mySocketIdRef.current
      if (sid) {
        const selfName = typeof a.selfName === 'string' ? a.selfName : 'You'
        nextRoster[sid] = { userName: selfName, userId: myUserIdRef.current }
      }
      setParticipantRoster(nextRoster)
    }
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
    startNetworkStats()
    const n = typeof a.peerCount === 'number' ? a.peerCount : peerList.length + 1
    showToast(n <= 1 ? "You're the only one here" : `${n} people in this call`)

    const focus = (location.state as { meetingFocus?: string } | null)?.meetingFocus
    if (focus === 'Whiteboard') {
      queueMicrotask(() => { openWhiteboard() })
    } else if (focus === 'Chat') {
      setChatOpen(true)
    } else if (focus === 'Screen Share') {
      queueMicrotask(() => { void toggleScreenShare() })
    }
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
    const hr = hostRecorderRef.current
    hostRecorderRef.current = null
    if (hr) void hr.stop().catch(() => {})
    setRecordingActive(false)

    const leavePipedRaw = teardownCameraBackgroundPipeline()
    if (leavePipedRaw && leavePipedRaw.readyState === 'live') leavePipedRaw.stop()
    if (cameraBgImageObjectUrlRef.current) {
      URL.revokeObjectURL(cameraBgImageObjectUrlRef.current)
      cameraBgImageObjectUrlRef.current = null
    }
    cameraBgImageElRef.current = null

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
    controlUnavailableNotifiedRef.current.clear()
    setControllingPeer(null)
    setControlledBy(null)
    setIncomingControlReq(null)
    setConnectBtnDisabled(false)
    stopTimer()
    stopNetworkStats()
    setChatMessages([])
    setChatHasMore(false)
    setChatUnread(0)
    setChatOpen(false)
    setCallSettingsOpen(false)
    setChatDraft('')
    setIsHostInCall(false)
    setHostPeerId(null)
    setParticipantRoster({})
    setCallLocalSocketId(null)
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
    setHasWeakNetwork(false)
    setCallView('lobby')
    showToast('You left the call')
  }

  function collectRecordingAudioStreams(): MediaStream[] {
    const streams: MediaStream[] = []
    const local = localStreamRef.current
    if (local?.getAudioTracks().some(t => t.readyState === 'live')) {
      streams.push(local)
    }
    const screen = screenStreamRef.current
    if (screen?.getAudioTracks().some(t => t.readyState === 'live')) {
      streams.push(screen)
    }
    for (const s of peerStreamRefs.current.values()) {
      if (s.getAudioTracks().some(t => t.readyState === 'live')) {
        streams.push(s)
      }
    }
    return streams
  }

  function startHostRecording() {
    if (!isHostInCall || hostRecorderRef.current) {
      return
    }
    const root = recordingRootRef.current
    if (!root) {
      showToast('Recording area not ready')
      return
    }
    const rec = new HostMeetingRecorder()
    try {
      rec.start(root, collectRecordingAudioStreams())
      hostRecorderRef.current = rec
      recordingStartedAtRef.current = Date.now()
      setRecordingActive(true)
      showToast('Recording…')
    } catch (e: unknown) {
      showToast(errorMessage(e))
    }
  }

  async function stopHostRecordingAndUpload() {
    const rec = hostRecorderRef.current
    hostRecorderRef.current = null
    if (!rec) {
      setRecordingActive(false)
      return
    }
    setRecordingBusy(true)
    try {
      const blob = await rec.stop()
      setRecordingActive(false)
      if (blob.size < 2048) {
        showToast('Recording was empty')
        return
      }
      const meetingCode = activeMeetingCode.trim()
      if (!meetingCode) {
        showToast('No meeting code')
        return
      }
      const uploaded = await uploadMeetingRecordingViaApi(meetingCode, blob)
      const durationSec = Math.max(1, Math.round((Date.now() - recordingStartedAtRef.current) / 1000))
      await completeMeetingRecording(meetingCode, {
        key: uploaded.key,
        sizeBytes: blob.size,
        durationSec,
        mimeType: uploaded.contentType,
      })
      showToast('Recording saved')
    } catch (e: unknown) {
      showToast(errorMessage(e))
    } finally {
      setRecordingBusy(false)
    }
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
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        })
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
      const pipedRaw = teardownCameraBackgroundPipeline()
      for (const t of localStream.getVideoTracks()) {
        t.enabled = false
        t.stop()
        localStream.removeTrack(t)
      }
      if (pipedRaw && pipedRaw.readyState === 'live') pipedRaw.stop()
      setCamEnabled(false)
      setPipCamOff(!screenSharingRef.current)
      setPreviewCamOff(true)
      showToast('Camera off')
      return
    }

    try {
      await ensureStream()
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 15, max: 30 } },
        audio: false,
      })
      const newVideoTrack = cameraStream.getVideoTracks()[0]
      if (!newVideoTrack) throw new Error('No camera track available')
      newVideoTrack.enabled = true

      await applyCameraWithBackgroundSettings(newVideoTrack, cameraBgMode, cameraBgImageElRef.current)

      setCamEnabled(true)
      setPipCamOff(false)
      setPreviewCamOff(false)
      showToast('Camera on')
      void enumerateLocalCameras()
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
    controlUnavailableNotifiedRef.current.delete(from)
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
    const objectFit = videoEl.style.objectFit
    const scale = objectFit === 'contain'
      ? Math.min(rect.width / videoWidth, rect.height / videoHeight)
      : Math.max(rect.width / videoWidth, rect.height / videoHeight)
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

  function scrollToPresenterPage(page: number) {
    const el = swipeContainerRef.current
    if (!el) return
    el.scrollTo({ left: page * el.clientWidth, behavior: 'smooth' })
    setPresenterPage(page)
  }

  function handleSwipeScroll() {
    const el = swipeContainerRef.current
    if (!el) return
    setPresenterPage(Math.round(el.scrollLeft / el.clientWidth))
  }

  async function setVideoSendersActive(pc: RTCPeerConnection, active: boolean) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue
      const params = sender.getParameters()
      if (!params.encodings?.length) continue
      for (const enc of params.encodings) enc.active = active
      try { await sender.setParameters(params) } catch { /* ignore */ }
    }
  }

  async function checkNetworkStats() {
    for (const [, { pc }] of peersRef.current.entries()) {
      if (pc.connectionState !== 'connected') continue
      try {
        const stats = await pc.getStats()
        for (const report of stats.values()) {
          if (report.type !== 'candidate-pair') continue
          const pair = report as { nominated?: boolean; availableOutgoingBitrate?: number }
          if (!pair.nominated || pair.availableOutgoingBitrate === undefined) continue
          const avail = pair.availableOutgoingBitrate
          if (avail < 80_000 && !autoVideoPausedRef.current) {
            autoVideoPausedRef.current = true
            setHasWeakNetwork(true)
            showToast('Weak network — video paused to keep audio')
            for (const [, peer] of peersRef.current.entries()) {
              void setVideoSendersActive(peer.pc, false)
            }
          } else if (avail > 300_000 && autoVideoPausedRef.current) {
            autoVideoPausedRef.current = false
            showToast('Network improved — video resumed')
            for (const [, peer] of peersRef.current.entries()) {
              void setVideoSendersActive(peer.pc, true)
            }
          }
          return // only need one nominated pair
        }
      } catch { /* ignore */ }
      return // checked one connected peer, that's enough
    }
  }

  function startNetworkStats() {
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current)
    autoVideoPausedRef.current = false
    statsIntervalRef.current = setInterval(() => { void checkNetworkStats() }, 5000)
  }

  function stopNetworkStats() {
    if (statsIntervalRef.current) { clearInterval(statsIntervalRef.current); statsIntervalRef.current = null }
    autoVideoPausedRef.current = false
  }

  async function iceRestart(remoteId: string) {
    const state = peersRef.current.get(remoteId)
    if (!state || !socketRef.current?.connected) return
    setHasWeakNetwork(true)
    try {
      appendLog('ice restart →', shortId(remoteId))
      const offer = await state.pc.createOffer({ iceRestart: true })
      await state.pc.setLocalDescription(offer)
      const sdp = state.pc.localDescription?.toJSON()
      if (sdp) socketRef.current.emit('webrtc:offer', { to: remoteId, sdp })
    } catch (e) {
      appendLog('ice restart error', String(e))
    }
  }

  async function applyBitrateCaps(pc: RTCPeerConnection) {
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      const maxBitrate = sender.track.kind === 'video' ? 500_000 : 48_000
      for (const enc of params.encodings) enc.maxBitrate = maxBitrate
      try { await sender.setParameters(params) } catch { /* browser may not support */ }
    }
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

  async function stopScreenShare(opts?: { silent?: boolean }) {
    const stream = screenStreamRef.current
    if (stream) stream.getTracks().forEach(t => t.stop())
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
    if (!opts?.silent) showToast('Screen sharing stopped')
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
        } else {
          // No video sender yet (camera was off) — add the track and negotiate
          pc.addTrack(screenTrack, localStreamRef.current!)
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

  async function applyContentPolicyViolation() {
    if (cameraModerationFiredRef.current) return
    cameraModerationFiredRef.current = true
    try {
      socketRef.current?.emit('meeting:policy-violation', { code: 'camera_nsfw_local' })
    } catch {
      /* ignore */
    }

    if (screenSharingRef.current) {
      await stopScreenShare({ silent: true }).catch(() => {})
    }

    const modPipedRaw = teardownCameraBackgroundPipeline()
    const localStream = localStreamRef.current
    if (localStream) {
      for (const t of localStream.getVideoTracks()) {
        t.enabled = false
        t.stop()
        localStream.removeTrack(t)
      }
    }
    if (modPipedRaw && modPipedRaw.readyState === 'live') modPipedRaw.stop()
    setCamEnabled(false)
    setPipCamOff(true)
    setPreviewCamOff(true)
    if (localPreviewRef.current) localPreviewRef.current.srcObject = localStreamRef.current

    showToast('Nudity and sexual content on camera are not allowed. You will be disconnected.', 8000)
    appendLog('content policy', 'local camera moderated')
    window.setTimeout(() => {
      leave()
    }, 600)
  }

  applyContentPolicyViolationRef.current = () => {
    void applyContentPolicyViolation()
  }

  // Sample outgoing camera frames during calls (local preview). Two consecutive hits reduce false positives.
  useEffect(() => {
    if (callView !== 'call' || !camEnabled) {
      cameraModerationStreakRef.current = 0
      return
    }
    if ((import.meta.env as Record<string, string | undefined>).VITE_CAMERA_MODERATION === 'false') return

    let cancelled = false
    const tick = async () => {
      if (cancelled || cameraModerationFiredRef.current) return
      const video = localPreviewRef.current
      if (!video || video.videoWidth < 16) return
      const { violation } = await classifyCameraFrame(video)
      if (cancelled || cameraModerationFiredRef.current) return
      if (violation) {
        cameraModerationStreakRef.current += 1
        if (cameraModerationStreakRef.current >= 2) {
          applyContentPolicyViolationRef.current()
        }
      } else {
        cameraModerationStreakRef.current = 0
      }
    }

    const id = window.setInterval(() => { void tick() }, 2800)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [callView, camEnabled])

  const shareUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return `${window.location.origin}/m/${encodeURIComponent(code)}`
  }, [code])

  const timerDisplay = `${Math.floor(timerSeconds / 60)}:${String(timerSeconds % 60).padStart(2, '0')}`
  const rosterCount = Object.keys(participantRoster).length
  const participantCount = rosterCount > 0 ? rosterCount : peerIds.length + 1
  const rosterRemoteIdsSorted = useMemo(() => {
    const me = callLocalSocketId ?? ''
    return Object.keys(participantRoster)
      .filter(id => id !== me)
      .sort((a, b) =>
        participantRoster[a].userName.localeCompare(participantRoster[b].userName, undefined, { sensitivity: 'base' }),
      )
  }, [participantRoster, callLocalSocketId])

  function rosterLabel(peerId: string) {
    const e = participantRoster[peerId]
    if (e?.userName) return e.userName
    return `Peer ${shortId(peerId)}`
  }
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

  const stripTileCount = stripPeerIds.length + (presenterIsLocal ? 0 : 1)
  const stripGridStyle: React.CSSProperties =
    stripTileCount <= 1 ? {} :
    stripTileCount <= 2 ? { gridTemplateColumns: 'repeat(2,1fr)', gridTemplateRows: '1fr' } :
    stripTileCount <= 4 ? { gridTemplateColumns: 'repeat(2,1fr)', gridTemplateRows: 'repeat(2,1fr)' } :
    { gridTemplateColumns: 'repeat(3,1fr)', gridTemplateRows: `repeat(${Math.ceil(stripTileCount / 3)},1fr)` }

  return (
    <>
      {/* ── Meeting detail ── */}
      {callView === 'detail' && (
        <div
          className="meeting-route-root fixed inset-0 flex flex-col overflow-hidden"
          style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
        >
        {/* background */}
        <img src="/image.png" alt="" aria-hidden draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover" />

        {/* header */}
        <div className="relative z-20 flex items-center justify-between gap-3 px-4 py-3 sm:px-8 sm:py-4 lg:px-10">
          <Link to="/">
            <img src="/nexivo_logo.svg" alt="Nexivo" className="h-10 w-auto sm:h-14" draggable={false} />
          </Link>
          <Link to="/" className="shrink-0 rounded-full border border-black/10 bg-white/60 px-3 py-1.5 text-xs font-medium text-gray-600 backdrop-blur-sm transition hover:bg-white/80 sm:px-4 sm:text-sm">
            <span className="sm:hidden">Back</span>
            <span className="hidden sm:inline">← Back home</span>
          </Link>
        </div>

        {/* centered card */}
        <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-6 sm:py-8">
          <div className="w-full max-w-md rounded-[22px] bg-[#1c1c1e]/95 p-5 backdrop-blur-xl sm:p-7 md:min-h-[560px]">

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
                  <div className="flex flex-col gap-3 rounded-2xl border border-white/7 bg-white/5 p-4">
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

                  <div className="flex items-center gap-2 rounded-2xl border border-white/7 bg-white/5 p-3">
                    <code className="flex-1 truncate text-xs text-white/50">{shareUrl}</code>
                    <button
                      type="button"
                      className="rounded-xl border border-white/10 bg-white/8 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:bg-white/14"
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
          className="meeting-route-root fixed inset-0 z-100 flex flex-col overflow-hidden"
          style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
        >
          <img
            src="/image.png"
            alt=""
            aria-hidden
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full select-none object-cover"
          />

          <div className="relative z-20 flex items-center justify-between gap-3 px-4 py-3 sm:px-8 sm:py-4 lg:px-10">
            <Link to="/">
              <img src="/nexivo_logo.svg" alt="Nexivo" className="h-10 w-auto sm:h-14" draggable={false} />
            </Link>
            <Link
              to="/"
              className="shrink-0 rounded-full border border-black/10 bg-white/60 px-3 py-1.5 text-xs font-medium text-gray-600 backdrop-blur-sm transition hover:bg-white/80 sm:px-4 sm:text-sm"
            >
              <span className="sm:hidden">Back</span>
              <span className="hidden sm:inline">← Back home</span>
            </Link>
          </div>

          <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 py-6 sm:min-h-[calc(100vh-80px)]">
            <div className="w-full max-w-4xl rounded-[22px] bg-[#1c1c1e]/95 p-5 backdrop-blur-xl sm:p-6 md:min-h-[560px] md:p-7">
              <p className="text-[0.6rem] font-bold uppercase tracking-[0.2em] text-white/30">Video call</p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-white/90">Ready to join?</h2>
              <p className="mt-1 font-mono text-sm text-white/50">{code.length > 0 ? code : '—'}</p>

              <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-stretch">
                <div className="relative w-full flex-1 overflow-hidden rounded-2xl border border-white/7 bg-black/35 aspect-video lg:aspect-auto lg:min-h-[380px]">
                  <video
                    ref={localPreviewRef}
                    playsInline
                    autoPlay
                    muted
                    className="absolute h-full w-full -scale-x-100 object-cover"
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
        <div className="meeting-route-root fixed inset-0 z-100 bg-[#111]">
          <div ref={recordingRootRef} className="absolute inset-0">
          {/* Video grid — regular mode */}
          {!presenterMode && (
            <div className="absolute inset-0 grid gap-1.5 bg-[#111]" style={gridStyle}>
              {peerIds.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 text-sm text-[#9aa0a6]">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#2d2e30]">
                    <svg viewBox="0 0 24 24" fill="#9aa0a6" width="32" height="32">
                      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
                    </svg>
                  </div>
                  <p>Waiting for others to join&hellip;</p>
                </div>
              )}
              {peerIds.map(id => (
                <div key={id} className="group relative min-h-0 min-w-0 overflow-hidden rounded-[10px] bg-[#2d2e30]">
                  <video
                    ref={getPeerVideoRef(id)}
                    playsInline
                    autoPlay
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: screenSharingPeers.has(id) ? 'none' : 'scaleX(-1)' }}
                  />
                  <div className="absolute bottom-2.5 left-3 max-w-[calc(100%-16px)] truncate rounded bg-black/55 px-2 py-0.5 text-[13px] text-white">{rosterLabel(id)}</div>
                  {screenSharingPeers.has(id) && !controllingPeer && !controlledBy && (
                    <button
                      type="button"
                      className="absolute bottom-2.5 left-1/2 z-10 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-white/20 bg-[#111]/75 px-3.5 py-1.5 text-xs font-semibold text-white opacity-0 backdrop-blur-sm transition-[opacity,background] hover:border-sky-400/40 hover:bg-blue-600/85 group-hover:opacity-100"
                      onClick={() => requestControl(id)}
                      title={companionAvailable ? 'Request control' : 'Requires Bandr Companion app'}
                    >
                      <RemoteConnectionIcon size={13} />
                      {companionAvailable ? 'Request Control' : 'Needs Companion'}
                    </button>
                  )}
                  {controllingPeer === id && (
                    <div
                      className="absolute inset-0 z-10 cursor-crosshair outline-3 -outline-offset-[3px] outline-blue-600/70 focus:outline-blue-500"
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
              ))}
            </div>
          )}

          {/* Presenter mode — swipe between full-screen share and participant tiles */}
          {presenterMode && (
            <div className="absolute inset-0">
              <div
                ref={swipeContainerRef}
                className="absolute inset-0 flex snap-x snap-mandatory overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                onScroll={handleSwipeScroll}
              >
                {/* Page 1: full-screen shared screen */}
                <div className="relative h-full w-full shrink-0 grow-0 basis-full snap-start bg-black">
                  {remotePresenterId ? (
                    <div className="group absolute inset-0 min-h-0 min-w-0 overflow-hidden rounded-none bg-[#2d2e30]">
                      <video
                        ref={getPeerVideoRef(remotePresenterId)}
                        playsInline
                        autoPlay
                        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
                      />
                      <div className="absolute bottom-2.5 left-3 max-w-[calc(100%-16px)] truncate rounded bg-black/55 px-2 py-0.5 text-[13px] text-white">{rosterLabel(remotePresenterId)} · Presenting</div>
                      {!controllingPeer && !controlledBy && (
                        <button
                          type="button"
                          className="absolute bottom-2.5 left-1/2 z-10 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-white/20 bg-[#111]/75 px-3.5 py-1.5 text-xs font-semibold text-white opacity-100 backdrop-blur-sm transition-[opacity,background] hover:border-sky-400/40 hover:bg-blue-600/85"
                          onClick={() => requestControl(remotePresenterId)}
                          title={companionAvailable ? 'Request control' : 'Requires Bandr Companion app'}
                        >
                          <RemoteConnectionIcon size={13} />
                          {companionAvailable ? 'Request Control' : 'Needs Companion'}
                        </button>
                      )}
                      {controllingPeer === remotePresenterId && (
                        <div
                          className="absolute inset-0 z-10 cursor-crosshair outline-3 -outline-offset-[3px] outline-blue-600/70 focus:outline-blue-500"
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
                    <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden rounded-none bg-[#2d2e30]">
                      <video ref={localPresenterRef} playsInline autoPlay muted style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }} />
                      <div className="absolute bottom-2.5 left-3 rounded bg-black/55 px-2 py-0.5 text-[13px] text-white">You · Presenting</div>
                    </div>
                  )}
                </div>

                {/* Page 2: participant tiles */}
                <div className="relative flex h-full w-full shrink-0 grow-0 basis-full snap-start flex-col gap-2.5 overflow-y-auto bg-[#111] px-4 pt-16 pb-24 max-sm:px-2.5 max-sm:pt-[52px] max-sm:pb-[92px]">
                  <p className="mb-1 shrink-0 text-center text-[13px] font-semibold text-white/40">Participants ({stripTileCount})</p>
                  <div className="grid min-h-0 flex-1 gap-2" style={stripGridStyle}>
                    {!presenterIsLocal && (
                      <div className="group relative min-h-0 min-w-0 overflow-hidden rounded-[10px] bg-[#2d2e30]">
                        <video ref={localStripRef} playsInline autoPlay muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: 'scaleX(-1)' }} />
                        <div className="absolute bottom-2.5 left-3 rounded bg-black/55 px-2 py-0.5 text-[13px] text-white">You</div>
                        {pipCamOff && (
                          <div className="absolute inset-0 flex items-center justify-center bg-[#2d2e30]">
                            <svg viewBox="0 0 24 24" fill="#9aa0a6" width="28" height="28"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" /></svg>
                          </div>
                        )}
                      </div>
                    )}
                    {stripPeerIds.map(id => (
                      <div key={id} className="group relative min-h-0 min-w-0 overflow-hidden rounded-[10px] bg-[#2d2e30]">
                        <video
                          ref={getPeerVideoRef(id)}
                          playsInline
                          autoPlay
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: 'scaleX(-1)' }}
                        />
                        <div className="absolute bottom-2.5 left-3 max-w-[calc(100%-16px)] truncate rounded bg-black/55 px-2 py-0.5 text-[13px] text-white">{rosterLabel(id)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Swipe page dots */}
              <div className="pointer-events-auto absolute bottom-[88px] left-1/2 z-25 flex -translate-x-1/2 items-center gap-2 max-sm:bottom-24">
                <button
                  type="button"
                  className={cx(
                    'h-2 w-2 cursor-pointer rounded-full border-0 p-0 transition-all hover:bg-white/60',
                    presenterPage === 0 ? 'w-[22px] rounded bg-white' : 'bg-white/30',
                  )}
                  onClick={() => scrollToPresenterPage(0)}
                  aria-label="View screen share"
                />
                <button
                  type="button"
                  className={cx(
                    'h-2 w-2 cursor-pointer rounded-full border-0 p-0 transition-all hover:bg-white/60',
                    presenterPage === 1 ? 'w-[22px] rounded bg-white' : 'bg-white/30',
                  )}
                  onClick={() => scrollToPresenterPage(1)}
                  aria-label="View participants"
                />
              </div>
            </div>
          )}

          {/* Local PiP */}
          <div
            className={cx(
              'z-15 overflow-hidden rounded-xl border border-white/12 bg-[#2d2e30] shadow-2xl',
              presenterMode && 'hidden',
              isSoloInCall
                ? 'absolute top-14 right-2.5 bottom-[104px] left-2.5 sm:top-[62px] sm:right-6 sm:bottom-[108px] sm:left-6'
                : 'absolute right-2.5 bottom-[88px] aspect-video w-[min(168px,40vw)] sm:bottom-24 sm:right-4 sm:w-[196px]',
            )}
          >
            <video ref={localPipRef} playsInline autoPlay muted className={screenSharing ? 'block h-full w-full object-cover' : 'block h-full w-full -scale-x-100 object-cover'} />
            {pipCamOff && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#2d2e30]">
                <svg viewBox="0 0 24 24" fill="#9aa0a6" width="28" height="28">
                  <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
                </svg>
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between bg-linear-to-t from-black/65 to-transparent px-2.5 py-1.5 text-xs text-white">
              <span>You</span>
              {!micEnabled && (
                <svg viewBox="0 0 24 24" fill="#ea4335" width="12" height="12">
                  <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                </svg>
              )}
            </div>
          </div>
          </div>

          {/* Top bar */}
          <div className="pointer-events-none absolute top-0 right-0 left-0 z-20 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 bg-linear-to-b from-black/55 to-transparent px-5 py-3.5 max-sm:px-3 max-sm:py-2.5">
            <div className="pointer-events-auto flex flex-wrap items-center gap-3 max-sm:gap-y-1.5">
              <span className="text-base font-semibold max-sm:text-sm">Meet</span>
              <span className="text-[13px] text-[#9aa0a6] tabular-nums">{timerDisplay}</span>
              {recordingActive && (
                <span className="rounded-full bg-red-600/90 px-2 py-0.5 text-[11px] font-bold tracking-wide text-white">REC</span>
              )}
            </div>
            <div className="pointer-events-auto flex flex-wrap items-center gap-2.5 max-sm:gap-y-1.5">
              <details className="relative">
                <summary className="cursor-pointer list-none text-[13px] text-[#9aa0a6] hover:text-white/80 [&::-webkit-details-marker]:hidden">
                  {participantCount === 1 ? '1 in call' : `${participantCount} in call`}
                  <span className="text-white/40"> · People</span>
                </summary>
                <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[min(calc(100vw-24px),280px)] rounded-xl border border-white/10 bg-[#1c1c1e]/98 py-2 shadow-2xl backdrop-blur-xl">
                  <p className="px-3 pb-2 text-[0.65rem] font-bold uppercase tracking-wider text-white/35">In this meeting</p>
                  <ul className="max-h-[min(50vh,320px)] overflow-y-auto px-1">
                    {callLocalSocketId && (
                      <li className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-2 text-left text-sm text-white/90">
                        <span className="min-w-0 truncate font-medium">
                          {participantRoster[callLocalSocketId]?.userName ?? 'You'}
                          <span className="font-normal text-white/40"> (you)</span>
                        </span>
                        {hostPeerId === callLocalSocketId && (
                          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">Host</span>
                        )}
                      </li>
                    )}
                    {rosterRemoteIdsSorted.map(id => (
                      <li
                        key={id}
                        className="flex items-center justify-between gap-2 border-t border-white/8 px-2 py-2 text-left text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate text-white/90">
                          {rosterLabel(id)}
                          {hostPeerId === id && (
                            <span className="ml-2 inline-flex shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">Host</span>
                          )}
                        </span>
                        {isHostInCall && id !== hostPeerId && (
                          <button
                            type="button"
                            className="shrink-0 rounded-lg border border-white/15 bg-white/8 px-2 py-1 text-[11px] font-semibold text-white/90 hover:bg-amber-500/20 hover:text-amber-200"
                            onClick={() => transferHost(id)}
                          >
                            Make host
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
              {companionAvailable && (
                <span className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-400/12 px-2 py-0.5 text-[11px] font-semibold text-emerald-400" title="Bandr Companion connected">
                  <RemoteConnectionIcon size={11} />
                  Companion
                </span>
              )}
              {hasWeakNetwork && (
                <span className="rounded-full bg-red-500/85 px-2.5 py-0.5 text-[11px] text-white animate-pulse" title="Network issues detected — attempting to reconnect">
                  Reconnecting…
                </span>
              )}
              <span className="rounded-full bg-[#3c4043]/85 px-2.5 py-0.5 font-mono text-[11px] text-white">{activeMeetingCode}</span>
            </div>
          </div>

          {whiteboardOpen && (
            <div className="absolute top-[52px] right-4 bottom-24 left-4 z-26 overflow-hidden rounded-[14px] border border-white/16 bg-[#0c0c0e]/92 shadow-2xl backdrop-blur-sm max-sm:top-12 max-sm:right-2 max-sm:bottom-[92px] max-sm:left-2">
              <div className="absolute top-2.5 left-2.5 z-2 inline-flex flex-wrap items-center gap-2 rounded-full border border-white/14 bg-[#141416]/85 px-2.5 py-1.5">
                <span className="mr-1 text-xs font-bold text-white">Whiteboard</span>
                {!whiteboardCanEdit && (
                  <button type="button" className="cursor-pointer rounded-full border border-white/15 bg-white/8 px-2.5 py-1 text-xs text-white hover:bg-white/16" onClick={requestWhiteboardEdit}>Ask to collaborate</button>
                )}
                {whiteboardIsOwner && whiteboardOtherEditors.length > 0 && (
                  <>
                    <select
                      className="cursor-pointer rounded-full border border-white/15 bg-white/8 px-2 py-1 text-xs text-white"
                      value={whiteboardRevokeUserId}
                      onChange={e => setWhiteboardRevokeUserId(e.target.value)}
                      title="Select collaborator to remove"
                    >
                      {whiteboardOtherEditors.map(id => (
                        <option key={id} value={id}>{`Editor ${shortId(id)}`}</option>
                      ))}
                    </select>
                    <button type="button" className="cursor-pointer rounded-full border border-white/15 bg-white/8 px-2.5 py-1 text-xs text-white hover:bg-white/16" onClick={revokeWhiteboardEdit} disabled={!whiteboardRevokeUserId}>
                      Remove access
                    </button>
                  </>
                )}
                <input
                  type="color"
                  className="h-6 w-6 cursor-pointer border-0 bg-transparent p-0"
                  value={whiteboardColor}
                  onChange={e => setWhiteboardColor(e.target.value)}
                  title="Brush color"
                  disabled={!whiteboardCanEdit}
                />
                <input
                  type="range"
                  className="w-[90px] max-sm:w-16"
                  min={1}
                  max={12}
                  value={whiteboardWidth}
                  onChange={e => setWhiteboardWidth(Number(e.target.value))}
                  title="Brush size"
                  disabled={!whiteboardCanEdit}
                />
                <button type="button" className="cursor-pointer rounded-full border border-white/15 bg-white/8 px-2.5 py-1 text-xs text-white hover:bg-white/16" onClick={clearWhiteboard} disabled={!whiteboardCanEdit}>Clear</button>
                {whiteboardIsOwner && <button type="button" className="cursor-pointer rounded-full border border-white/15 bg-white/8 px-2.5 py-1 text-xs text-white hover:bg-white/16" onClick={closeWhiteboard}>Close</button>}
              </div>
              <canvas
                ref={whiteboardCanvasRef}
                className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
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
            <div className="absolute bottom-[90px] left-1/2 z-40 w-[min(360px,calc(100vw-32px))] -translate-x-1/2 rounded-[14px] border border-white/14 bg-[#161618]/97 p-4 shadow-2xl backdrop-blur-md">
              <p className="mb-2 text-[13px] font-bold text-white">Whiteboard collaboration request</p>
              <p className="mb-3.5 text-[13px] leading-snug text-white/70">
                <strong>{incomingWhiteboardReq.fromName}</strong> wants to edit the whiteboard.
              </p>
              <div className="flex gap-2">
                <button type="button" className="flex-1 cursor-pointer rounded-lg border-0 bg-blue-600 py-2 text-[13px] font-semibold text-white hover:bg-blue-700" onClick={() => respondWhiteboardEditRequest(true)}>Allow</button>
                <button type="button" className="flex-1 cursor-pointer rounded-lg border border-white/15 bg-white/7 py-2 text-[13px] font-semibold text-white/75 hover:bg-white/12" onClick={() => respondWhiteboardEditRequest(false)}>Deny</button>
              </div>
            </div>
          )}

          {callSettingsOpen && (
            <aside
              className="absolute top-4 bottom-4 left-4 z-25 flex w-[min(320px,85vw)] flex-col overflow-hidden rounded-[22px] border border-white/7 bg-[#1c1c1e]/95 shadow-2xl backdrop-blur-xl max-[900px]:w-[min(300px,90vw)] max-[480px]:top-auto max-[480px]:right-0 max-[480px]:bottom-0 max-[480px]:left-0 max-[480px]:h-[70vh] max-[480px]:w-full max-[480px]:rounded-t-[18px] max-[480px]:rounded-b-none max-[480px]:border-x-0 max-[480px]:border-b-0 max-[480px]:border-t max-[480px]:border-white/10"
              aria-label="Call settings"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-white/7 px-4 pb-3.5 pt-4 text-[13px] font-semibold text-white/90">
                <span>Call settings</span>
                <button
                  type="button"
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/6 text-base leading-none text-white/60 transition hover:border-white/16 hover:bg-white/12 hover:text-white"
                  onClick={() => setCallSettingsOpen(false)}
                  aria-label="Close settings"
                >
                  ✕
                </button>
              </div>
              <div className="flex flex-1 flex-col gap-4 overflow-auto px-4 py-4 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20">
                <div>
                  <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Camera background</p>
                  <input
                    ref={cameraBgFileInputRef}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={handleCameraBackgroundFile}
                    aria-hidden
                    tabIndex={-1}
                  />
                  <label htmlFor="meeting-camera-bg-mode-panel" className="sr-only">
                    Camera background
                  </label>
                  <select
                    id="meeting-camera-bg-mode-panel"
                    value={cameraBgMode}
                    onChange={e => {
                      const v = e.target.value as CameraBackgroundUiMode
                      setCameraBgMode(v)
                      void reapplyCameraBackgroundWithMode(v)
                    }}
                    className="w-full cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[13px] font-medium text-white outline-none focus:border-amber-500/45 focus:bg-white/8"
                  >
                    <option value="none">None</option>
                    <option value="blur-low">Blur – Soft</option>
                    <option value="blur-high">Blur – Strong</option>
                    <option value="image">Image</option>
                  </select>
                  {cameraBgMode === 'image' && (
                    <button
                      type="button"
                      onClick={() => cameraBgFileInputRef.current?.click()}
                      className="mt-2.5 w-full cursor-pointer rounded-xl border border-white/12 bg-white/8 py-2.5 text-[13px] font-semibold text-white/90 transition hover:border-amber-500/35 hover:bg-white/12"
                    >
                      Upload background image
                    </button>
                  )}
                </div>
                {isHostInCall && (
                  <div className="border-t border-white/10 pt-4">
                    <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Recording</p>
                    <p className="mb-3 text-[12px] leading-snug text-white/45">
                      Records what is on screen (tiles + your preview) and mixes participant audio. Stopping uploads the file for you as host.
                    </p>
                    {recordingActive ? (
                      <button
                        type="button"
                        disabled={recordingBusy}
                        onClick={() => void stopHostRecordingAndUpload()}
                        className="w-full cursor-pointer rounded-xl border-0 bg-red-600 py-2.5 text-[13px] font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {recordingBusy ? 'Saving…' : 'Stop and upload'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={recordingBusy}
                        onClick={startHostRecording}
                        className="w-full cursor-pointer rounded-xl border border-white/12 bg-white/8 py-2.5 text-[13px] font-semibold text-white/90 hover:border-amber-500/35 hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        Start recording
                      </button>
                    )}
                    {recordingActive && !recordingBusy && (
                      <p className="mt-2 flex items-center gap-2 text-[12px] font-medium text-red-400">
                        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />
                        Recording
                      </p>
                    )}
                    <Link
                      to="/recordings"
                      className="mt-3 block text-center text-[12px] font-medium text-amber-400/90 no-underline hover:text-amber-300"
                    >
                      My recordings
                    </Link>
                  </div>
                )}
              </div>
            </aside>
          )}

          {chatOpen && (
            <aside
              className="absolute top-4 right-4 bottom-4 z-25 flex w-[min(320px,85vw)] flex-col overflow-hidden rounded-[22px] border border-white/7 bg-[#1c1c1e]/95 shadow-2xl backdrop-blur-xl max-[900px]:w-[min(300px,90vw)] max-[480px]:top-auto max-[480px]:right-0 max-[480px]:bottom-0 max-[480px]:left-0 max-[480px]:h-[70vh] max-[480px]:w-full max-[480px]:rounded-t-[18px] max-[480px]:rounded-b-none max-[480px]:border-x-0 max-[480px]:border-b-0 max-[480px]:border-t max-[480px]:border-white/10"
              aria-label="Meeting chat"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-white/7 px-4 pb-3.5 pt-4 text-[13px] font-semibold text-white/90">
                <div className="flex flex-col gap-px">
                  <span>Meeting chat</span>
                  <small className="text-[11px] font-medium text-white/45">{participantCount === 1 ? 'Just you' : `${participantCount} participants`}</small>
                </div>
                <button type="button" className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/6 text-base leading-none text-white/60 transition hover:border-white/16 hover:bg-white/12 hover:text-white" onClick={() => setChatOpen(false)} aria-label="Close chat">
                  ✕
                </button>
              </div>
              <div className="flex flex-1 flex-col gap-2.5 overflow-auto px-3 py-3 pb-2.5 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20">
                {chatHasMore && (
                  <button
                    type="button"
                    className="self-center cursor-pointer rounded-xl border border-white/10 bg-white/6 px-2.5 py-1.5 text-xs text-white/80 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={loadOlderChat}
                    disabled={chatLoadingMore}
                  >
                    {chatLoadingMore ? 'Loading…' : 'Load older messages'}
                  </button>
                )}
                {chatMessages.length === 0 ? (
                  <p className="m-auto text-[13px] text-white/40">No messages yet</p>
                ) : (
                  chatMessages.map(m => {
                    const mine = m.senderId === mySocketIdRef.current || (m.senderUserId != null && m.senderUserId === myUserIdRef.current)
                    return (
                      <div
                        key={m.id}
                        className={cx(
                          'max-w-[88%] rounded-xl border px-2.5 py-2 text-white/90',
                          mine ? 'ml-auto border-amber-500/35 bg-amber-500/20' : 'border-white/8 bg-white/6',
                        )}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2.5 text-[11px] text-white/72">
                          <span>{mine ? 'You' : (m.senderName || `Peer ${shortId(m.senderId)}`)}</span>
                          <time>{formatChatTime(m.createdAt)}</time>
                        </div>
                        <p className="m-0 whitespace-pre-wrap wrap-break-word text-[13px] leading-snug">{m.text}</p>
                      </div>
                    )
                  })
                )}
                <div ref={chatBottomRef} />
              </div>
              <form
                className="flex gap-2 border-t border-white/7 bg-white/2 px-3 pb-3 pt-2.5"
                onSubmit={e => {
                  e.preventDefault()
                  sendChatMessage()
                }}
              >
                <input
                  type="text"
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[13px] text-white/90 outline-none placeholder:text-white/30 focus:border-amber-500/45 focus:bg-white/8"
                  value={chatDraft}
                  onChange={e => setChatDraft(e.target.value)}
                  placeholder="Send a message"
                  maxLength={500}
                />
                <button type="submit" className="cursor-pointer rounded-xl border-0 bg-amber-500 px-3 text-[13px] font-semibold text-neutral-900 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-45" disabled={chatDraft.trim().length === 0}>Send</button>
              </form>
            </aside>
          )}

          {/* Incoming control request dialog (browser fallback — shown when companion is not running) */}
          {incomingControlReq && (
            <div className="absolute bottom-[90px] left-1/2 z-40 w-[min(360px,calc(100vw-32px))] -translate-x-1/2 rounded-[14px] border border-white/14 bg-[#161618]/97 p-4 shadow-2xl backdrop-blur-md">
              <p className="mb-2 flex items-center gap-2 text-[13px] font-bold text-white">
                <RemoteConnectionIcon size={16} />
                Remote control request
              </p>
              <p className="mb-3.5 text-[13px] leading-snug text-white/70">
                <strong>{incomingControlReq.fromName}</strong> wants to control your computer.
                {!companionAvailable && <span className="text-amber-300"> Download the Companion app for OS-level control.</span>}
              </p>
              <div className="flex gap-2">
                <button type="button" className="flex-1 cursor-pointer rounded-lg border-0 bg-blue-600 py-2 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50" onClick={() => respondControl(incomingControlReq.from, true)} disabled={!companionAvailable} title={!companionAvailable ? 'Companion app required to allow control' : undefined}>Allow</button>
                <button type="button" className="flex-1 cursor-pointer rounded-lg border border-white/15 bg-white/7 py-2 text-[13px] font-semibold text-white/75 hover:bg-white/12" onClick={() => respondControl(incomingControlReq.from, false)}>Deny</button>
              </div>
            </div>
          )}

          {isHostInCall && hostJoinRequests.length > 0 && (
            <div className="absolute left-1/2 z-40 w-[min(360px,calc(100vw-32px))] -translate-x-1/2 rounded-[14px] border border-white/14 bg-[#161618]/97 p-4 shadow-2xl backdrop-blur-md" style={{ bottom: incomingControlReq ? 248 : 90 }}>
              <p className="mb-2 text-[13px] font-bold text-white">Join request</p>
              <p className="mb-3.5 text-[13px] leading-snug text-white/70">
                <strong>{hostJoinRequests[0]?.name ?? 'Someone'}</strong> wants to join this meeting.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 cursor-pointer rounded-lg border-0 bg-blue-600 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
                  onClick={() => hostJoinRequests[0] && respondJoinRequest(hostJoinRequests[0].requestId, true)}
                >
                  Allow
                </button>
                <button
                  type="button"
                  className="flex-1 cursor-pointer rounded-lg border border-white/15 bg-white/7 py-2 text-[13px] font-semibold text-white/75 hover:bg-white/12"
                  onClick={() => hostJoinRequests[0] && respondJoinRequest(hostJoinRequests[0].requestId, false)}
                >
                  Deny
                </button>
              </div>
            </div>
          )}

          {/* Active control banner */}
          {(controllingPeer || controlledBy) && (
            <div className="absolute top-[58px] left-1/2 z-30 flex max-w-[calc(100vw-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-2.5 rounded-full border border-sky-400/30 bg-blue-600/90 px-4 py-1.5 text-center text-xs font-semibold text-white shadow-lg backdrop-blur-sm max-[480px]:rounded-2xl max-[480px]:px-3 max-[480px]:py-2 max-[480px]:whitespace-normal">
              {controllingPeer
                ? (
                  <>
                    You are controlling a peer&apos;s computer —{' '}
                    <button type="button" className="rounded-full border border-white/35 bg-white/15 px-2.5 py-0.5 text-[11px] font-bold text-white hover:bg-white/28" onClick={releaseControl}>Stop</button>
                  </>
                  )
                : <>Your computer is being remotely controlled</>}
            </div>
          )}

          {/* Bottom controls */}
          <div className="absolute bottom-0 left-0 right-0 z-20 flex flex-wrap items-center justify-center gap-3 bg-linear-to-t from-black/65 to-transparent px-5 pt-5 pb-7 max-sm:gap-2 max-sm:px-2.5 max-sm:pb-[max(1.125rem,env(safe-area-inset-bottom,0px))]">
            <button
              type="button"
              onClick={toggleMic}
              className={cx(
                'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 transition active:scale-95',
                micEnabled ? 'bg-[#3c4043] hover:bg-[#4a4d50]' : 'bg-red-500 hover:bg-[#d33828]',
              )}
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
              type="button"
              onClick={toggleCam}
              className={cx(
                'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 transition active:scale-95',
                camEnabled ? 'bg-[#3c4043] hover:bg-[#4a4d50]' : 'bg-red-500 hover:bg-[#d33828]',
              )}
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
              type="button"
              className={cx(
                'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border text-white transition active:scale-95',
                callSettingsOpen
                  ? 'border-sky-400/40 bg-blue-600/85 hover:bg-blue-600'
                  : 'border-white/18 bg-[#3c4043]/90 hover:border-white/28 hover:bg-[#505458]',
              )}
              onClick={() => setCallSettingsOpen(v => !v)}
              title={callSettingsOpen ? 'Close settings' : 'Call settings'}
              aria-label={callSettingsOpen ? 'Close settings' : 'Open call settings'}
              aria-expanded={callSettingsOpen}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22" aria-hidden>
                <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => void toggleScreenShare()}
              className={cx(
                'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 transition active:scale-95',
                screenSharing ? 'bg-red-500 hover:bg-[#d33828]' : 'bg-[#3c4043] hover:bg-[#4a4d50]',
              )}
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
              className={cx(
                'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-45',
                whiteboardOpen ? 'bg-red-500 hover:bg-[#d33828]' : 'bg-[#3c4043] hover:bg-[#4a4d50]',
              )}
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
                type="button"
                onClick={() => controllingPeer ? releaseControl() : requestControl([...screenSharingPeers][0]!)}
                className={cx(
                  'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 transition active:scale-95',
                  controllingPeer ? 'bg-red-500 hover:bg-[#d33828]' : 'bg-[#3c4043] hover:bg-[#4a4d50]',
                )}
                title={controllingPeer ? 'Stop controlling' : 'Request control of shared screen'}
              >
                <svg viewBox="0 0 24 24" fill="white" width="22" height="22">
                  <path d="M13.64 21.97C11.27 24.34 7.58 24.57 4.94 22.63L8.08 19.5c1.56.7 3.49.45 4.79-.85 1.62-1.62 1.62-4.25 0-5.87L9.7 9.6l1.41-1.41 3.54 3.54c2.34 2.34 2.34 6.09-.01 8.24zM10.36 2.03C12.73-.34 16.42-.57 19.06 1.37l-3.14 3.13c-1.56-.7-3.49-.45-4.79.85-1.62 1.62-1.62 4.25 0 5.87l3.17 3.18-1.41 1.41-3.54-3.54c-2.34-2.34-2.34-6.1.01-8.24z"/>
                </svg>
              </button>
            )}
            <button
              type="button"
              className={cx(
                'relative inline-flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border text-white transition',
                chatOpen
                  ? 'border-sky-400/40 bg-blue-600/85 hover:bg-blue-600'
                  : 'border-white/18 bg-[#3c4043]/90 hover:border-white/28 hover:bg-[#505458]',
              )}
              onClick={() => setChatOpen(prev => !prev)}
              aria-label={chatOpen ? 'Hide chat' : 'Show chat'}
              aria-pressed={chatOpen}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
              </svg>
              {chatUnread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#ea4335] px-1 text-[10px] text-white">
                  {chatUnread > 99 ? '99+' : chatUnread}
                </span>
              )}
            </button>
            {/* Camera switcher button */}
            {camEnabled && (
              <button
                type="button"
                onClick={() => { setShowCameraPanel(p => !p); void enumerateLocalCameras() }}
                className={cx(
                  'relative flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 transition active:scale-95',
                  showCameraPanel ? 'bg-amber-500 hover:bg-amber-400' : 'bg-[#3c4043] hover:bg-[#4a4d50]',
                )}
                title="Switch camera / add camera source"
              >
                <svg viewBox="0 0 24 24" fill="white" width="22" height="22">
                  <path d="M20 5h-3.17L15 3H9L7.17 5H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 14H4V7h4.05l.59-.65L9.88 5h4.24l1.24 1.35.59.65H20v12zM12 8c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 8c-1.65 0-3-1.35-3-3s1.35-3 3-3 3 1.35 3 3-1.35 3-3 3z"/>
                  <circle cx="18" cy="9" r="1.5" fill="white"/>
                </svg>
                {remoteCameras.size > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[9px] font-bold text-black">
                    {remoteCameras.size + 1}
                  </span>
                )}
              </button>
            )}
            <button type="button" onClick={leave} className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 bg-red-500 transition hover:bg-[#d33828] active:scale-95" title="Leave call">
              <svg viewBox="0 0 24 24" fill="white" width="24" height="24">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Camera switcher panel */}
      {callView === 'call' && showCameraPanel && camEnabled && (
        <div className="fixed bottom-[88px] left-1/2 z-[110] w-[min(340px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/10 bg-[#1c1c1e]/97 shadow-2xl backdrop-blur-xl sm:bottom-24">
          <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
            <p className="text-[13px] font-semibold text-white/90">Camera Sources</p>
            <button type="button" onClick={() => setShowCameraPanel(false)} className="flex h-6 w-6 items-center justify-center rounded-full bg-white/8 text-xs text-white/60 hover:bg-white/14">✕</button>
          </div>
          <div className="max-h-72 overflow-y-auto px-3 py-2.5 flex flex-col gap-1.5">
            {/* Local cameras */}
            {localCameraDevices.map((cam, i) => {
              const sid = `local:${cam.deviceId}`
              const isActive = activeCameraId === sid || (activeCameraId === null && i === 0)
              return (
                <button
                  key={cam.deviceId}
                  type="button"
                  onClick={() => void switchCamera(sid)}
                  className={cx(
                    'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-[13px] transition',
                    isActive
                      ? 'border-amber-500/40 bg-amber-500/12 text-white'
                      : 'border-white/8 bg-white/4 text-white/70 hover:border-white/14 hover:bg-white/8',
                  )}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" className="shrink-0">
                    <path d="M12 15.2A3.2 3.2 0 0 1 8.8 12 3.2 3.2 0 0 1 12 8.8a3.2 3.2 0 0 1 3.2 3.2 3.2 3.2 0 0 1-3.2 3.2M12 7a5 5 0 0 0-5 5 5 5 0 0 0 5 5 5 5 0 0 0 5-5 5 5 0 0 0-5-5m0-3.5c-3.86 0-7 3.14-7 7s3.14 7 7 7 7-3.14 7-7-3.14-7-7-7z" />
                  </svg>
                  <span className="min-w-0 flex-1 truncate">{cam.label || `Camera ${i + 1}`}</span>
                  {isActive && <span className="shrink-0 rounded-full bg-amber-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">Active</span>}
                </button>
              )
            })}
            {/* Remote camera sources */}
            {[...remoteCameras.entries()].map(([cameraId, { label, ready }]) => {
              const sid = `remote:${cameraId}`
              const isActive = activeCameraId === sid
              return (
                <button
                  key={cameraId}
                  type="button"
                  onClick={() => void switchCamera(sid)}
                  className={cx(
                    'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-[13px] transition',
                    isActive
                      ? 'border-amber-500/40 bg-amber-500/12 text-white'
                      : 'border-white/8 bg-white/4 text-white/70 hover:border-white/14 hover:bg-white/8',
                  )}
                >
                  {/* Live thumbnail preview */}
                  <RemoteCameraThumb cameraId={cameraId} streamsRef={remoteCameraStreamsRef} ready={ready} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {ready
                    ? <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-green-400" />
                    : <span className="shrink-0 text-[10px] text-white/40 italic">connecting…</span>
                  }
                  {isActive && <span className="shrink-0 rounded-full bg-amber-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">Active</span>}
                </button>
              )
            })}
          </div>
          {isHostInCall && (
            <div className="border-t border-white/8 px-3 py-3">
              <button
                type="button"
                onClick={() => void generateCameraToken()}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/6 py-2.5 text-[13px] font-medium text-white/80 transition hover:border-amber-500/30 hover:bg-amber-500/10 hover:text-white"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                  <path d="M19 3H5c-1.11 0-2 .89-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2m-7 3a3 3 0 0 1 3 3 3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3m6 13H6v-1c0-2 4-3.1 6-3.1s6 1.1 6 3.1v1z"/>
                </svg>
                Add camera source (phone / device)
              </button>
            </div>
          )}
        </div>
      )}

      {/* Camera share URL modal */}
      {callView === 'call' && cameraShareUrl && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setCameraShareUrl(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#1c1c1e] p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <p className="font-semibold text-white">Connect Camera Source</p>
              <button type="button" onClick={() => setCameraShareUrl(null)} className="flex h-7 w-7 items-center justify-center rounded-full bg-white/8 text-xs text-white/60 hover:bg-white/14">✕</button>
            </div>

            {/* QR code — client-generated (Google Chart QR API is discontinued) */}
            <div className="mb-4 flex justify-center">
              <div className="rounded-xl bg-white p-3">
                <QRCodeSVG
                  value={cameraShareUrl}
                  size={180}
                  level="M"
                  className="block h-[180px] w-[180px]"
                  aria-label="QR code"
                />
              </div>
            </div>

            <p className="mb-3 text-center text-[13px] text-white/55">Scan with your phone camera to connect as a live camera source</p>

            <div className="mb-3 flex gap-2">
              <input
                readOnly
                value={cameraShareUrl}
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-white/70 outline-none"
              />
              <button
                type="button"
                onClick={() => { void navigator.clipboard.writeText(cameraShareUrl); showToast('Copied!') }}
                className="shrink-0 rounded-xl border border-white/10 bg-white/8 px-3 py-2 text-xs font-semibold text-white hover:bg-white/14"
              >
                Copy
              </button>
            </div>
            <p className="text-center text-[11px] text-white/30">Link expires in 1 hour · keep the camera page open to stay connected</p>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed top-5 left-1/2 z-50 max-w-[calc(100vw-24px)] -translate-x-1/2 rounded-lg bg-[#3c4043] px-[18px] py-2.5 text-center text-[13px] whitespace-nowrap text-[#e8eaed] shadow-xl max-[480px]:whitespace-normal max-[480px]:px-3.5 max-[480px]:text-xs">
          <span>{toast}</span>
        </div>
      )}

      {/* Debug log (Shift+D) */}
      {showDebug && (
        <pre className="fixed bottom-[100px] left-3 right-3 z-40 max-h-[140px] overflow-auto rounded-[10px] bg-black/85 p-2.5 font-mono text-[11px] whitespace-pre-wrap text-emerald-400" aria-live="polite">
          {debugLog}
        </pre>
      )}
    </>
  )
}
