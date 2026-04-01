import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'
import {
  completeMeetingRecording,
  errorMessage,
  fetchMeetingCaptions,
  fetchMeetingPolls,
  getLiveKitJoinToken,
  getMeeting,
  hostAgentTranscribe,
  hostAgentChat,
  hostAgentTts,
  uploadMeetingRecordingViaApi,
  type HostAgentChatTurn,
} from '../lib/api'
import { getToken } from '../lib/auth'
import { getIceServers } from '../lib/ice'
import { startCameraBackgroundPipeline, type CameraBackgroundPipeline } from '../lib/cameraBackgroundPipeline'
import { HostMeetingRecorder } from '../lib/hostMeetingRecorder'
import {
  playMeetingNotificationSound,
  primeMeetingNotificationAudio,
} from '../lib/meetingNotificationSounds'
import { HostAgendaPanel } from '../components/HostAgendaPanel'
import { HostAgentPanel } from '../components/HostAgentPanel'
import { MeetingAttentionWarningModal } from '../components/MeetingAttentionWarningModal'
import { MeetingVoteOverlay, type MeetingVoteChoice } from '../components/MeetingVoteOverlay'
import { useVoteGestureRecognition } from '../lib/useVoteGestureRecognition'
import { ShellBackgroundLayer } from '../components/ShellBackgroundLayer'
import { MeetingNotesPanel } from '../components/MeetingNotesPanel'
import { MeetingSpeechLanguageSelect } from '../components/MeetingSpeechLanguageSelect'
import { captionLinesFromHistory, mergeCaptionMessage, type CaptionLine } from '../lib/meetingCaptions'
import { useMeetingSpeechLanguage } from '../lib/meetingLanguages'
import { useMeetingCaptionRecognition } from '../lib/useMeetingCaptionRecognition'
import { classifyCameraFrame, preloadModerationModel } from '../lib/videoContentModeration'
import type { Meeting, MeetingPollSaved } from '../lib/types'
import {
  DefaultReconnectPolicy,
  DisconnectReason,
  Room,
  RoomEvent,
  type RemoteParticipant,
  type RemoteTrack,
} from 'livekit-client'
import { LIVEKIT_CAMERA_VIDEO_ENCODING } from '../lib/livekitCameraEncoding'
import {
  LIVEKIT_FULL_RECONNECT_MAX_ATTEMPTS,
  liveKitFullReconnectDelayMs,
  shouldAttemptFullLiveKitReconnect,
} from '../lib/livekitReconnection'
import { resolvedRtcMode, writeRtcModeToStorage, type RtcMode } from '../lib/rtcMode'
import { LiveBroadcastCompositor } from '../lib/liveBroadcastCompositor'

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
  userEmail?: string
}

const WHITEBOARD_DRAWING_ACTIVE_MS = 900

/** Mirrors signaling `buildAttentionRoster` rows (keyed by userId in client state). */
interface AttentionRosterRow {
  userId: string
  userName: string
  hasSignal: boolean
  tabVisible: boolean
  lastAt: number
  stale: boolean
  needsAttention: boolean
}

function attentionStatusTooltip(row: AttentionRosterRow | null): string {
  if (!row || !row.hasSignal) return 'No tab visibility signal yet (just joined or still connecting)'
  if (row.stale) return 'No recent update — tab may be in the background'
  if (!row.tabVisible) return 'Meeting tab is hidden or not focused'
  return 'Meeting tab appears visible'
}

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

function shortId(id: string) {
  return id.length <= 8 ? id : id.slice(0, 6) + '\u2026'
}

/**
 * Browsers (especially on phones) often list many `videoinput` entries for one physical camera
 * (same `groupId`, different internal modes). The OS also limits how many cameras can be open at once.
 * Collapse duplicates so the picker matches what users can actually switch between.
 */
function dedupeVideoInputsForUi(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const inputs = devices.filter(d => d.kind === 'videoinput' && d.deviceId)
  const byGroup = new Map<string, MediaDeviceInfo>()
  const noGroupById = new Map<string, MediaDeviceInfo>()
  for (const d of inputs) {
    const gid = d.groupId?.trim()
    if (gid) {
      const existing = byGroup.get(gid)
      if (!existing) {
        byGroup.set(gid, d)
      } else {
        const a = (existing.label ?? '').length
        const b = (d.label ?? '').length
        byGroup.set(gid, b > a ? d : existing)
      }
    } else {
      noGroupById.set(d.deviceId, d)
    }
  }
  const merged = [...byGroup.values(), ...noGroupById.values()]
  merged.sort((a, b) => {
    const la = a.label ?? ''
    const lb = b.label ?? ''
    if (la && !lb) return -1
    if (!la && lb) return 1
    return la.localeCompare(lb, undefined, { sensitivity: 'base' })
  })
  return merged
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

function getJwtProfile(token: string): { userId: string; email: string; name: string } {
  try {
    const payload = token.split('.')[1]
    if (!payload) return { userId: '', email: '', name: '' }
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: unknown
      userId?: unknown
      email?: unknown
      name?: unknown
    }
    const userId =
      typeof json.sub === 'string' ? json.sub : typeof json.userId === 'string' ? json.userId : ''
    return {
      userId,
      email: typeof json.email === 'string' ? json.email : '',
      name: typeof json.name === 'string' ? json.name : '',
    }
  } catch {
    return { userId: '', email: '', name: '' }
  }
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) {
    const w = parts[0]!
    return w.length >= 2 ? w.slice(0, 2).toUpperCase() : w.toUpperCase()
  }
  const a = parts[0]![0] ?? ''
  const b = parts[parts.length - 1]![0] ?? ''
  return `${a}${b}`.toUpperCase()
}

function VideoOffParticipantCard({
  name,
  email,
  compact,
}: {
  name: string
  email: string
  compact?: boolean
}) {
  const initials = initialsFromName(name || '?')
  const mail = email.trim()
  return (
    <div
      className={cx(
        'absolute inset-0 z-1 flex flex-col items-center justify-center bg-[#1a1b1d]/95 px-2',
        compact && 'px-1',
      )}
    >
      <div
        className={cx(
          'flex shrink-0 items-center justify-center rounded-full border border-white/20 bg-linear-to-br from-amber-500/40 via-amber-600/25 to-sky-600/30 font-semibold text-white shadow-lg ring-1 ring-white/10',
          compact ? 'h-11 w-11 text-xs' : 'h-16 w-16 text-base sm:h-18 sm:text-lg',
        )}
      >
        {initials}
      </div>
      {!compact && (
        <p className="mt-2.5 max-w-[95%] truncate text-center text-[13px] font-medium text-white/90">{name || 'Guest'}</p>
      )}
      {mail.length > 0 && (
        <p
          className={cx(
            'max-w-[95%] truncate text-center font-normal text-white/50',
            compact ? 'mt-1 text-[9px] leading-tight' : 'mt-1 text-[11px] sm:text-xs',
          )}
          title={mail}
        >
          {mail}
        </p>
      )}
    </div>
  )
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
  const navigate = useNavigate()
  const code = (params.code ?? '').trim()
  const [speechLang, setSpeechLang] = useMeetingSpeechLanguage(code)
  const [captionLines, setCaptionLines] = useState<CaptionLine[]>([])
  const captionOverlayRecordingRef = useRef<{ speakerName: string; text: string } | null>(null)
  const latestCaptionLine = captionLines.length > 0 ? captionLines[captionLines.length - 1]! : null
  captionOverlayRecordingRef.current =
    latestCaptionLine && (latestCaptionLine.text.trim().length > 0 || latestCaptionLine.speakerName.trim().length > 0)
      ? { speakerName: latestCaptionLine.speakerName, text: latestCaptionLine.text }
      : null
  const [liveCaptionsEnabled, setLiveCaptionsEnabled] = useState(false)
  const liveCaptionsEnabledRef = useRef(false)
  liveCaptionsEnabledRef.current = liveCaptionsEnabled
  const [captionExportBusy, setCaptionExportBusy] = useState(false)

  // meeting detail
  const [busy, setBusy] = useState(true)
  const [fetchErr, setFetchErr] = useState<string | null>(null)
  const [meeting, setMeeting] = useState<Meeting | null>(null)

  // call UI state
  const [callView, setCallView] = useState<CallView>('lobby')
  const callViewRef = useRef<CallView>('lobby')
  callViewRef.current = callView
  const [micEnabled, setMicEnabled] = useState(false)
  const micEnabledRef = useRef(micEnabled)
  micEnabledRef.current = micEnabled
  const [camEnabled, setCamEnabled] = useState(false)
  const [statusLine, setStatusLine] = useState('')
  const [peerIds, setPeerIds] = useState<string[]>([])
  const [activeMeetingCode, setActiveMeetingCode] = useState('')
  const [timerSeconds, setTimerSeconds] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [inputSignal, setInputSignal] = useState('')
  const [connectBtnDisabled, setConnectBtnDisabled] = useState(false)
  const [waitingForHost, setWaitingForHost] = useState(false)
  const [previewCamOff, setPreviewCamOff] = useState(true)
  const [pipCamOff, setPipCamOff] = useState(true)
  const [showDebug, setShowDebug] = useState(false)
  const [debugLog, setDebugLog] = useState('')
  const [hasWeakNetwork, setHasWeakNetwork] = useState(false)
  const [presenterPage, setPresenterPage] = useState(0)
  const [screenSharing, setScreenSharing] = useState(false)
  const [screenSharingPeers, setScreenSharingPeers] = useState<Set<string>>(new Set())
  const [peerShowVideoFallback, setPeerShowVideoFallback] = useState<Record<string, boolean>>({})
  const screenSharingPeersRef = useRef<Set<string>>(new Set())
  const syncPeerCameraOverlayRef = useRef<(remoteId: string) => void>(() => {})
  const [companionAvailable, setCompanionAvailable] = useState(false)
  const [controllingPeer, setControllingPeer] = useState<string | null>(null)
  const [controlledBy, setControlledBy] = useState<string | null>(null)
  const [incomingControlReq, setIncomingControlReq] = useState<{ from: string; fromName: string } | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [agendaOpen, setAgendaOpen] = useState(false)
  const [hostAgentOpen, setHostAgentOpen] = useState(false)
  const [, setAiVoiceActive] = useState(false)
  const aiVoiceTrackRef = useRef<MediaStreamTrack | null>(null)
  const aiVoiceStopRef = useRef<(() => void) | null>(null)
  /** Mic UI / caption STT should treat mic as off during AI TTS; restore after. */
  const micEnabledBeforeAiVoiceRef = useRef<boolean | null>(null)
  /** Bumped on each new AI playback so a superseded session does not restore the mic. */
  const aiVoiceSessionGenRef = useRef(0)
  const [hostAgentAutopilotEnabled, setHostAgentAutopilotEnabled] = useState(false)
  const hostAgentKbRef = useRef('')
  const hostAgentAutopilotBusyRef = useRef(false)
  const hostAgentAutopilotLastKeyRef = useRef<string | null>(null)
  const hostAgentAutopilotLastAtRef = useRef(0)
  const hostAgentAutopilotRecorderRef = useRef<MediaRecorder | null>(null)
  const hostAgentAutopilotTranscriptRef = useRef('')
  const hostAgentAutopilotLastSpokenAtRef = useRef(0)
  /** Incremented to cancel in-flight autopilot STT/chat/TTS when new speech interrupts. */
  const hostAgentAutopilotGenRef = useRef(0)
  /** Prior user/assistant turns for autopilot LLM continuity (separate from Host AI panel). */
  const hostAgentConversationRef = useRef<HostAgentChatTurn[]>([])
  const [callSettingsOpen, setCallSettingsOpen] = useState(false)
  const [callSettingsTab, setCallSettingsTab] = useState<'features' | 'settings'>('features')
  const [recordingActive, setRecordingActive] = useState(false)
  const [roomRecordingActive, setRoomRecordingActive] = useState(false)
  const [recordingBusy, setRecordingBusy] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatUnread, setChatUnread] = useState(0)
  const [chatHasMore, setChatHasMore] = useState(false)
  const [chatLoadingMore, setChatLoadingMore] = useState(false)
  const [hostJoinRequests, setHostJoinRequests] = useState<{ requestId: string; name: string }[]>([])
  const [hostLiveCollabRequests, setHostLiveCollabRequests] = useState<
    { requestId: string; name: string; userId: string }[]
  >([])
  const [hostMutedPeerIds, setHostMutedPeerIds] = useState<Record<string, boolean>>({})
  const [isHostInCall, setIsHostInCall] = useState(false)
  const [liveStreamPublic, setLiveStreamPublic] = useState(false)
  const [livePublicViewerCount, setLivePublicViewerCount] = useState(0)
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
  const [whiteboardActiveDrawersAt, setWhiteboardActiveDrawersAt] = useState<Record<string, number>>({})
  const [handRaisedByPeerId, setHandRaisedByPeerId] = useState<Record<string, boolean>>({})
  const [myHandRaised, setMyHandRaised] = useState(false)
  const myHandRaisedRef = useRef(false)
  myHandRaisedRef.current = myHandRaised
  const [voteSession, setVoteSession] = useState<{
    sessionId: string
    title: string
    anonymous: boolean
  } | null>(null)
  const [voteUp, setVoteUp] = useState(0)
  const [voteDown, setVoteDown] = useState(0)
  const [voteBreakdown, setVoteBreakdown] = useState<
    { peerId: string; userName: string; choice: MeetingVoteChoice }[] | null
  >(null)
  const [myVote, setMyVote] = useState<MeetingVoteChoice | null>(null)
  const [voteTitleDraft, setVoteTitleDraft] = useState('')
  const [voteAnonymousDraft, setVoteAnonymousDraft] = useState(true)
  const [savedPolls, setSavedPolls] = useState<MeetingPollSaved[] | null>(null)
  const [savedPollsBusy, setSavedPollsBusy] = useState(false)
  const [savedPollsErr, setSavedPollsErr] = useState<string | null>(null)
  const [attentionRoster, setAttentionRoster] = useState<Record<string, AttentionRosterRow>>({})
  const [attentionWarning, setAttentionWarning] = useState<{ fromName: string; message: string } | null>(null)
  const [attentionWarnCompose, setAttentionWarnCompose] = useState<{ userId: string; name: string } | null>(null)
  const [attentionWarnDraft, setAttentionWarnDraft] = useState('')
  const activeVoteSessionIdRef = useRef<string | null>(null)
  const attentionBadPrevRef = useRef<Set<string>>(new Set())
  const [cameraBgMode, setCameraBgMode] = useState<CameraBackgroundUiMode>('none')
  const cameraBgModeRef = useRef<CameraBackgroundUiMode>('none')
  const [localCameraDevices, setLocalCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [localMicDevices, setLocalMicDevices] = useState<MediaDeviceInfo[]>([])
  const [localSpeakerDevices, setLocalSpeakerDevices] = useState<MediaDeviceInfo[]>([])
  const [remoteCameras, setRemoteCameras] = useState<Map<string, { label: string; ready: boolean }>>(new Map())
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null) // null = default | 'local:deviceId' | 'remote:socketId'
  const activeCameraIdRef = useRef<string | null>(null)
  const [activeMicDeviceId, setActiveMicDeviceId] = useState<string | null>(null) // null = default
  const [activeSpeakerDeviceId, setActiveSpeakerDeviceId] = useState<string | null>(null) // null = default
  const [remoteMicCameraId, setRemoteMicCameraId] = useState<string | null>(null) // cameraId or null (local mic)
  const remoteMicCameraIdRef = useRef<string | null>(null)
  const [remoteSpeakerCameraId, setRemoteSpeakerCameraId] = useState<string | null>(null) // cameraId or null (no remote speaker)
  const remoteSpeakerCameraIdRef = useRef<string | null>(null)
  const [monitorRemoteDeviceMic, setMonitorRemoteDeviceMic] = useState(true)
  const [showCameraPanel, setShowCameraPanel] = useState(false)
  const [cameraShareUrl, setCameraShareUrl] = useState<string | null>(null)

  // refs
  const socketRef = useRef<Socket | null>(null)
  const mySocketIdRef = useRef('')
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const getSignalingSocket = useCallback(() => socketRef.current, [])

  useMeetingCaptionRecognition({
    enabled: liveCaptionsEnabled,
    micEnabled,
    speechLang,
    inCall: callView === 'call',
    localSocketId: callLocalSocketId,
    getSocket: getSignalingSocket,
  })
  const localStreamRef = useRef<MediaStream | null>(null)
  /** Dedicated stream for gesture recognition — always carries the raw camera track so
   *  background blur / image-replacement does not degrade hand-pose detection. */
  const rawGestureStreamRef = useRef<MediaStream | null>(null)
  const getLocalCameraStream = useCallback(() => {
    // When a background pipeline is active the raw (unprocessed) camera track lives
    // in the pipeline, not in localStreamRef.  Feed it directly to MediaPipe so that
    // blurred / replaced backgrounds don't reduce hand-gesture detection accuracy.
    // cameraBgPipelineRef is declared later in this component function, but closures
    // capture the binding (not the value), so it is fully initialised by call time.
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const rawTrack = cameraBgPipelineRef.current?.getRawTrack()
    if (rawTrack && rawTrack.readyState === 'live') {
      const existing = rawGestureStreamRef.current
      if (existing?.getVideoTracks()[0]?.id === rawTrack.id) return existing
      const s = new MediaStream([rawTrack])
      rawGestureStreamRef.current = s
      return s
    }
    rawGestureStreamRef.current = null
    return localStreamRef.current
  }, [])
  const submitMeetingVote = useCallback((choice: MeetingVoteChoice) => {
    const sid = activeVoteSessionIdRef.current
    if (!sid) return
    socketRef.current?.emit('meeting:vote-submit', { sessionId: sid, choice })
    setMyVote(choice)
  }, [])
  const raiseHandFromOpenPalm = useCallback(() => {
    const socket = socketRef.current
    if (!socket?.connected) return
    const me = mySocketIdRef.current
    if (!me) return
    const next = !myHandRaisedRef.current
    setMyHandRaised(next)
    setHandRaisedByPeerId(prev => {
      if (prev[me] === next) return prev
      return { ...prev, [me]: next }
    })
    socket.emit('meeting:hand-raise', { raised: next })
    setToast(next ? 'Hand raised' : 'Hand lowered')
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 1800)
  }, [])
  const { status: voteGestureStatus } = useVoteGestureRecognition({
    enabled: callView === 'call' && camEnabled,
    getStream: getLocalCameraStream,
    onGesture: submitMeetingVote,
    thumbGesturesEnabled: voteSession !== null,
    onOpenPalm: raiseHandFromOpenPalm,
  })
  const peersRef = useRef<Map<string, PeerState>>(new Map())
  const preConnectIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const isHostInCallRef = useRef(false)
  const liveStreamPublicRef = useRef(false)
  const liveViewerPeerIdsRef = useRef<Set<string>>(new Set())
  const broadcastCompositorRef = useRef<LiveBroadcastCompositor | null>(null)
  const liveBroadcastSyncTimerRef = useRef<number | null>(null)
  const syncLiveBroadcastCompositorFnRef = useRef<() => void>(() => {})
  const micLockedByHostRef = useRef(false)
  const micWasEnabledBeforeHostMuteRef = useRef<boolean | null>(null)
  const collabAutoConnectDoneRef = useRef(false)
  const connectRef = useRef<(() => Promise<void>) | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerSecondsRef = useRef(0)
  const peerVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map())
  const peerVideoCallbackRefs = useRef<Map<string, (el: HTMLVideoElement | null) => void>>(new Map())
  const peerStreamRefs = useRef<Map<string, MediaStream>>(new Map())
  const participantRosterRef = useRef<Record<string, ParticipantRosterEntry>>({})
  const liveKitRoomRef = useRef<Room | null>(null)
  const liveKitPublishedTracksRef = useRef<{ video: MediaStreamTrack | null; audio: MediaStreamTrack | null }>({
    video: null,
    audio: null,
  })
  const pendingLiveKitTracksByUserIdRef = useRef<Map<string, RemoteTrack[]>>(new Map())
  const liveKitPeerIdsRef = useRef<string[]>([])
  const liveKitIntentionalDisconnectRef = useRef(false)
  const liveKitReconnectTimerRef = useRef<number | null>(null)
  const liveKitReconnectFailuresRef = useRef(0)
  const liveKitReconnectInFlightRef = useRef(false)
  const mediaModeRef = useRef<'mesh' | 'livekit'>(resolvedRtcMode())
  mediaModeRef.current = resolvedRtcMode()
  const localPreviewRef = useRef<HTMLVideoElement>(null)
  const localPipRef = useRef<HTMLVideoElement>(null)
  const localPresenterRef = useRef<HTMLVideoElement>(null)
  const localStripRef = useRef<HTMLVideoElement>(null)
  const remoteMicMonitorAudioRef = useRef<HTMLAudioElement>(null)
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
  const remoteCameraSpeakerSenderRef = useRef<Map<string, RTCRtpSender>>(new Map())
  const cameraBgImageElRef = useRef<HTMLImageElement | null>(null)
  const cameraBgImageObjectUrlRef = useRef<string | null>(null)
  const cameraBgFileInputRef = useRef<HTMLInputElement>(null)
  const recordingRootRef = useRef<HTMLDivElement>(null)
  const hostRecorderRef = useRef<HostMeetingRecorder | null>(null)
  const recordingStartedAtRef = useRef(0)
  const speakerMixCtxRef = useRef<AudioContext | null>(null)
  const speakerMixDestRef = useRef<MediaStreamAudioDestinationNode | null>(null)
  const speakerMixInputNodesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map())
  const speakerMixSilentTrackRef = useRef<MediaStreamTrack | null>(null)

  // ── Active speaker detection ──────────────────────────────────────────────
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null)
  const activeSpeakerIdRef = useRef<string | null>(null)
  const [speakingPeerIds, setSpeakingPeerIds] = useState<Set<string>>(new Set())
  const speakerAudioCtxRef = useRef<AudioContext | null>(null)
  type AnalyserEntry = { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> }
  const speakerAnalyserMapRef = useRef<Map<string, AnalyserEntry>>(new Map())
  const localSpeakerAnalyserRef = useRef<AnalyserEntry | null>(null)
  const activeSpeakerHoldRef = useRef<{ id: string | null; since: number }>({ id: null, since: 0 })
  const speakerMainVideoRef = useRef<HTMLVideoElement>(null)

  function ensureSpeakerMixGraph(): { dest: MediaStreamAudioDestinationNode; silentTrack: MediaStreamTrack } {
    if (!speakerMixCtxRef.current) speakerMixCtxRef.current = new AudioContext()
    const ctx = speakerMixCtxRef.current
    if (!speakerMixDestRef.current) speakerMixDestRef.current = ctx.createMediaStreamDestination()
    const dest = speakerMixDestRef.current
    if (!speakerMixSilentTrackRef.current) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      gain.gain.value = 0
      osc.connect(gain)
      gain.connect(dest)
      osc.start()
      speakerMixSilentTrackRef.current = dest.stream.getAudioTracks()[0] ?? null
    }
    return { dest, silentTrack: speakerMixSilentTrackRef.current! }
  }

  function syncSpeakerMixInputs(): MediaStreamTrack | null {
    const { dest, silentTrack } = ensureSpeakerMixGraph()
    const current = new Map<string, MediaStreamTrack>()
    for (const s of peerStreamRefs.current.values()) {
      for (const t of s.getAudioTracks()) {
        if (t.readyState === 'live') current.set(t.id, t)
      }
    }

    // Add new sources
    for (const [id, t] of current.entries()) {
      if (speakerMixInputNodesRef.current.has(id)) continue
      try {
        const src = speakerMixCtxRef.current!.createMediaStreamSource(new MediaStream([t]))
        src.connect(dest)
        speakerMixInputNodesRef.current.set(id, src)
      } catch {
        // ignore unsupported tracks
      }
    }

    // Remove missing sources
    for (const [id, node] of [...speakerMixInputNodesRef.current.entries()]) {
      if (current.has(id)) continue
      try { node.disconnect() } catch { /* ignore */ }
      speakerMixInputNodesRef.current.delete(id)
    }

    // If no inputs, keep silence (prevents some browsers from glitching)
    const mixed = dest.stream.getAudioTracks()[0] ?? null
    return mixed ?? silentTrack
  }

  function getSpeakerAudioCtx(): AudioContext {
    if (!speakerAudioCtxRef.current || speakerAudioCtxRef.current.state === 'closed') {
      speakerAudioCtxRef.current = new AudioContext()
    }
    if (speakerAudioCtxRef.current.state === 'suspended') void speakerAudioCtxRef.current.resume()
    return speakerAudioCtxRef.current
  }

  function setupSpeakerAnalyser(id: string, stream: MediaStream) {
    const existing = speakerAnalyserMapRef.current.get(id)
    if (existing) existing.source.disconnect()
    try {
      const ctx = getSpeakerAudioCtx()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.4
      source.connect(analyser)
      speakerAnalyserMapRef.current.set(id, {
        source,
        analyser,
        buf: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
      })
    } catch { /* ignore */ }
  }

  function teardownSpeakerAnalyser(id: string) {
    const entry = speakerAnalyserMapRef.current.get(id)
    if (entry) { entry.source.disconnect(); speakerAnalyserMapRef.current.delete(id) }
  }

  function getByteRms(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) { const d = (v - 128) / 128; sum += d * d }
    return Math.sqrt(sum / buf.length)
  }

  async function applyRemoteSpeakerTracks() {
    const track = syncSpeakerMixInputs()
    try { await speakerMixCtxRef.current?.resume() } catch { /* ignore */ }
    for (const [cameraId, sender] of remoteCameraSpeakerSenderRef.current.entries()) {
      const want = remoteSpeakerCameraId === cameraId
      const nextTrack = want ? track : ensureSpeakerMixGraph().silentTrack
      if (sender.track?.id === nextTrack?.id) continue
      await sender.replaceTrack(nextTrack).catch(() => {})
    }
  }

  function supportsSetSinkId(
    el: HTMLMediaElement,
  ): el is HTMLMediaElement & { setSinkId: (deviceId: string) => Promise<void> } {
    return typeof (el as unknown as { setSinkId?: unknown }).setSinkId === 'function'
  }

  const applySpeakerSinkIdToEl = useCallback(async (el: HTMLMediaElement) => {
    if (!activeSpeakerDeviceId) return
    if (!supportsSetSinkId(el)) return
    try {
      await el.setSinkId(activeSpeakerDeviceId)
    } catch {
      // ignore (unsupported browser / permissions / invalid device)
    }
  }, [activeSpeakerDeviceId])

  const applySpeakerSinkIdToAllPeerMedia = useCallback(async () => {
    if (!activeSpeakerDeviceId) return
    const els = [...peerVideoRefs.current.values()]
    await Promise.allSettled(els.map(el => applySpeakerSinkIdToEl(el)))
  }, [activeSpeakerDeviceId, applySpeakerSinkIdToEl])

  const syncPeerCameraOverlay = useCallback((remoteId: string) => {
    setPeerShowVideoFallback(prev => {
      if (screenSharingPeersRef.current.has(remoteId)) {
        if (prev[remoteId] === false) return prev
        return { ...prev, [remoteId]: false }
      }
      const stream = peerStreamRefs.current.get(remoteId)
      const hasVideo =
        stream?.getVideoTracks().some(
          t => t.kind === 'video' && t.readyState === 'live' && t.enabled && !t.muted,
        ) ?? false
      const next = !hasVideo
      if (prev[remoteId] === next) return prev
      return { ...prev, [remoteId]: next }
    })
  }, [])

  useEffect(() => {
    syncPeerCameraOverlayRef.current = syncPeerCameraOverlay
  }, [syncPeerCameraOverlay])

  useEffect(() => {
    void applySpeakerSinkIdToAllPeerMedia()
  }, [applySpeakerSinkIdToAllPeerMedia])

  useEffect(() => {
    remoteMicCameraIdRef.current = remoteMicCameraId
  }, [remoteMicCameraId])

  useEffect(() => {
    remoteSpeakerCameraIdRef.current = remoteSpeakerCameraId
  }, [remoteSpeakerCameraId])

  useEffect(() => {
    const el = remoteMicMonitorAudioRef.current
    if (!el) return

    if (!monitorRemoteDeviceMic || !remoteMicCameraId) {
      try { el.pause() } catch { /* ignore */ }
      el.srcObject = null
      return
    }

    const remoteStream = remoteCameraStreamsRef.current.get(remoteMicCameraId)
    const remoteTrack = remoteStream?.getAudioTracks()[0] ?? null
    if (!remoteTrack) {
      try { el.pause() } catch { /* ignore */ }
      el.srcObject = null
      return
    }

    el.srcObject = new MediaStream([remoteTrack])
    void applySpeakerSinkIdToEl(el)
    void el.play().catch(() => {})
  }, [monitorRemoteDeviceMic, remoteMicCameraId, applySpeakerSinkIdToEl])

  useEffect(() => {
    void applyRemoteSpeakerTracks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteSpeakerCameraId, remoteMicCameraId, micEnabled])

  useEffect(() => {
    screenSharingPeersRef.current = new Set(screenSharingPeers)
    for (const id of peerIds) {
      syncPeerCameraOverlay(id)
    }
  }, [screenSharingPeers, peerIds, syncPeerCameraOverlay])

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

  useEffect(() => {
    if (callView !== 'call' || !whiteboardOpen) return
    const t = window.setInterval(() => {
      const now = Date.now()
      setWhiteboardActiveDrawersAt(prev => {
        let changed = false
        const next: Record<string, number> = {}
        for (const [id, at] of Object.entries(prev)) {
          if (now - at <= WHITEBOARD_DRAWING_ACTIVE_MS) next[id] = at
          else changed = true
        }
        return changed ? next : prev
      })
    }, 400)
    return () => window.clearInterval(t)
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
      void disconnectLiveKitMedia()
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

  useEffect(() => {
    participantRosterRef.current = participantRoster
  }, [participantRoster])

  useEffect(() => {
    isHostInCallRef.current = isHostInCall
  }, [isHostInCall])

  useEffect(() => {
    liveStreamPublicRef.current = liveStreamPublic
  }, [liveStreamPublic])

  useEffect(() => {
    cameraBgModeRef.current = cameraBgMode
  }, [cameraBgMode])

  const syncLiveBroadcastCompositor = useCallback(() => {
    const comp = broadcastCompositorRef.current
    if (!comp || !liveStreamPublicRef.current || !isHostInCallRef.current) return
    const myId = mySocketIdRef.current
    const roster = participantRosterRef.current
    const selfLabel =
      (myId && roster[myId]?.userName?.trim()) ||
      meeting?.host?.name?.trim() ||
      'You'
    const tiles: { key: string; label: string; stream: MediaStream | null }[] = [
      {
        key: `local:${myId || 'self'}`,
        label: selfLabel,
        stream: localStreamRef.current,
      },
    ]
    // Use signaling roster (everyone in the meeting), not `peerIds`. In mesh mode `peerIds`
    // fills only as WebRTC PCs are created; roster is complete at join and on peer-joined, so
    // the public stream layout includes all participants (black tile until media connects).
    const remoteSocketIds = Object.keys(roster).filter(id => id !== myId)
    remoteSocketIds.sort((a, b) => {
      const na = roster[a]?.userName ?? ''
      const nb = roster[b]?.userName ?? ''
      const c = na.localeCompare(nb, undefined, { sensitivity: 'base' })
      if (c !== 0) return c
      return a.localeCompare(b)
    })
    for (const id of remoteSocketIds) {
      tiles.push({
        key: `peer:${id}`,
        label: roster[id]?.userName?.trim() || 'Guest',
        stream: peerStreamRefs.current.get(id) ?? null,
      })
    }
    const screen =
      screenSharingRef.current && screenStreamRef.current
        ? { stream: screenStreamRef.current, label: 'Screen share' }
        : null
    comp.setSources(tiles, screen)
  }, [meeting?.host?.name])

  async function upgradeLiveViewerToCompositeTracks(viewerId: string) {
    const outbound = broadcastCompositorRef.current?.getStream()
    const vIn = outbound?.getVideoTracks()[0]
    const aIn = outbound?.getAudioTracks()[0]
    if (!outbound || !vIn || !aIn) return
    if (!liveViewerPeerIdsRef.current.has(viewerId)) return
    const state = peersRef.current.get(viewerId)
    if (!state || !socketRef.current?.connected) return
    try {
      const vClone = vIn.clone()
      const aClone = aIn.clone()
      for (const s of state.pc.getSenders()) {
        if (s.track?.kind === 'video') await s.replaceTrack(vClone)
        else if (s.track?.kind === 'audio') await s.replaceTrack(aClone)
      }
      await renegotiate(viewerId)
    } catch (e) {
      appendLog('live viewer composite upgrade failed', String(e))
    }
  }

  useEffect(() => {
    syncLiveBroadcastCompositorFnRef.current = syncLiveBroadcastCompositor
  }, [syncLiveBroadcastCompositor])

  const scheduleLiveBroadcastCompositorSyncRef = useRef<() => void>(() => {})
  useEffect(() => {
    scheduleLiveBroadcastCompositorSyncRef.current = () => {
      if (!liveStreamPublicRef.current || !isHostInCallRef.current) return
      if (liveBroadcastSyncTimerRef.current != null) {
        window.clearTimeout(liveBroadcastSyncTimerRef.current)
      }
      liveBroadcastSyncTimerRef.current = window.setTimeout(() => {
        liveBroadcastSyncTimerRef.current = null
        syncLiveBroadcastCompositorFnRef.current()
      }, 100)
    }
  }, [syncLiveBroadcastCompositor])

  useEffect(() => {
    if (!liveStreamPublic || !isHostInCall || callView !== 'call') {
      if (liveBroadcastSyncTimerRef.current != null) {
        window.clearTimeout(liveBroadcastSyncTimerRef.current)
        liveBroadcastSyncTimerRef.current = null
      }
      broadcastCompositorRef.current?.stop()
      broadcastCompositorRef.current = null
      return
    }
    const comp = new LiveBroadcastCompositor()
    comp.start()
    broadcastCompositorRef.current = comp
    syncLiveBroadcastCompositorFnRef.current()
    for (const vid of [...liveViewerPeerIdsRef.current]) {
      void upgradeLiveViewerToCompositeTracks(vid)
    }
    return () => {
      if (liveBroadcastSyncTimerRef.current != null) {
        window.clearTimeout(liveBroadcastSyncTimerRef.current)
        liveBroadcastSyncTimerRef.current = null
      }
      comp.stop()
      broadcastCompositorRef.current = null
    }
  }, [liveStreamPublic, isHostInCall, callView])

  useEffect(() => {
    if (!liveStreamPublic || !isHostInCall || callView !== 'call') return
    scheduleLiveBroadcastCompositorSyncRef.current()
  }, [
    liveStreamPublic,
    isHostInCall,
    callView,
    peerIds,
    screenSharing,
    participantRoster,
    camEnabled,
    micEnabled,
  ])

  useEffect(() => {
    collabAutoConnectDoneRef.current = false
  }, [code])

  useEffect(() => {
    const st = location.state as { afterCollabApprove?: boolean } | null
    if (!st?.afterCollabApprove || collabAutoConnectDoneRef.current) return
    if (!getToken()) return
    collabAutoConnectDoneRef.current = true
    navigate(location.pathname, { replace: true, state: {} })
    queueMicrotask(() => {
      void connectRef.current?.()
    })
  }, [location.state, location.pathname, navigate, code])

  useEffect(() => {
    if (callView !== 'call') return
    const tick = () => {
      const s = socketRef.current
      if (!s?.connected) return
      const attentive = !document.hidden && document.visibilityState === 'visible'
      s.emit('meeting:attention-report', { attentive })
    }
    tick()
    const onVis = () => tick()
    document.addEventListener('visibilitychange', onVis)
    const id = window.setInterval(tick, 20_000)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.clearInterval(id)
    }
  }, [callView, callLocalSocketId])

  // ── Local mic analyser – set up / tear down with mic state ────────────────
  useEffect(() => {
    if (callView !== 'call' || !micEnabled) {
      if (localSpeakerAnalyserRef.current) {
        localSpeakerAnalyserRef.current.source.disconnect()
        localSpeakerAnalyserRef.current = null
      }
      return
    }
    const stream = localStreamRef.current
    if (!stream) return
    try {
      const ctx = getSpeakerAudioCtx()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.4
      source.connect(analyser)
      if (localSpeakerAnalyserRef.current) localSpeakerAnalyserRef.current.source.disconnect()
      localSpeakerAnalyserRef.current = {
        source,
        analyser,
        buf: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
      }
    } catch { /* ignore */ }
    return () => {
      if (localSpeakerAnalyserRef.current) {
        localSpeakerAnalyserRef.current.source.disconnect()
        localSpeakerAnalyserRef.current = null
      }
    }
  }, [callView, micEnabled])

  // ── Active speaker polling ────────────────────────────────────────────────
  useEffect(() => {
    if (callView !== 'call') {
      setActiveSpeakerId(null)
      activeSpeakerIdRef.current = null
      setSpeakingPeerIds(new Set())
      activeSpeakerHoldRef.current = { id: null, since: 0 }
      return
    }
    const SILENCE_THRESHOLD = 0.015
    const HOLD_MS = 2500

    const interval = setInterval(() => {
      const now = Date.now()
      const levels = new Map<string, number>()

      const localEntry = localSpeakerAnalyserRef.current
      if (localEntry) {
        const myId = mySocketIdRef.current
        if (myId) levels.set(myId, getByteRms(localEntry.analyser, localEntry.buf))
      }
      for (const [id, entry] of speakerAnalyserMapRef.current) {
        levels.set(id, getByteRms(entry.analyser, entry.buf))
      }

      let loudestId: string | null = null
      let loudestLevel = SILENCE_THRESHOLD
      const speaking = new Set<string>()
      for (const [id, lvl] of levels) {
        if (lvl > SILENCE_THRESHOLD) speaking.add(id)
        if (lvl > loudestLevel) { loudestLevel = lvl; loudestId = id }
      }

      setSpeakingPeerIds(prev => {
        if (prev.size === speaking.size && [...speaking].every(id => prev.has(id))) return prev
        return speaking
      })

      const hold = activeSpeakerHoldRef.current
      if (loudestId !== null && loudestId !== hold.id) {
        if (hold.id === null || now - hold.since > HOLD_MS) {
          activeSpeakerHoldRef.current = { id: loudestId, since: now }
          activeSpeakerIdRef.current = loudestId
          setActiveSpeakerId(loudestId)
        }
      } else if (loudestId === null && hold.id !== null && now - hold.since > HOLD_MS) {
        activeSpeakerHoldRef.current = { id: null, since: now }
        activeSpeakerIdRef.current = null
        setActiveSpeakerId(null)
      }
    }, 150)

    return () => {
      clearInterval(interval)
      setActiveSpeakerId(null)
      setSpeakingPeerIds(new Set())
      activeSpeakerHoldRef.current = { id: null, since: 0 }
      if (speakerAudioCtxRef.current?.state !== 'closed') {
        void speakerAudioCtxRef.current?.close()
        speakerAudioCtxRef.current = null
      }
      speakerAnalyserMapRef.current.clear()
    }
  }, [callView])

  // ── Sync main speaker video element ──────────────────────────────────────
  useEffect(() => {
    const el = speakerMainVideoRef.current
    if (!el) return
    if (!activeSpeakerId) { el.srcObject = null; return }
    const isLocal = activeSpeakerId === mySocketIdRef.current
    const stream = isLocal ? localStreamRef.current : (peerStreamRefs.current.get(activeSpeakerId) ?? null)
    if (el.srcObject !== stream) {
      el.srcObject = stream
      if (stream) void el.play().catch(() => {})
    }
  }, [activeSpeakerId])

  useEffect(() => {
    if (!isHostInCall || callView !== 'call') {
      attentionBadPrevRef.current = new Set()
      return
    }
    const bad = new Set<string>()
    for (const row of Object.values(attentionRoster)) {
      if (row.needsAttention) bad.add(row.userId)
    }
    const prev = attentionBadPrevRef.current
    const selfId = myUserIdRef.current
    for (const uid of bad) {
      if (!prev.has(uid) && uid !== selfId) {
        const name = attentionRoster[uid]?.userName ?? 'Someone'
        showToast(`${name} may not be focused on the meeting`, 5000)
      }
    }
    attentionBadPrevRef.current = bad
  }, [attentionRoster, isHostInCall, callView, showToast])

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

  /** Inbound mic from camera-source WebRTC must not be stopped when swapping the local send track. */
  function isInboundRemoteCameraAudioTrack(track: MediaStreamTrack): boolean {
    if (track.kind !== 'audio') return false
    for (const stream of remoteCameraStreamsRef.current.values()) {
      if (stream.getAudioTracks().some(t => t.id === track.id)) return true
    }
    return false
  }

  async function pushLocalVideoToPeersAndPreview(videoTrack: MediaStreamTrack) {
    const ls = localStreamRef.current
    if (!ls) return
    if (mediaModeRef.current === 'livekit' && !screenSharingRef.current) {
      const room = liveKitRoomRef.current
      if (room?.state === 'connected') {
        const lp = room.localParticipant
        const prev = liveKitPublishedTracksRef.current.video
        if (prev && prev !== videoTrack) {
          try {
            await lp.unpublishTrack(prev, false)
          } catch {
            // ignore
          }
        }
        try {
          await lp.publishTrack(videoTrack, { videoEncoding: LIVEKIT_CAMERA_VIDEO_ENCODING })
          liveKitPublishedTracksRef.current.video = videoTrack
        } catch (e) {
          appendLog('livekit publish video', String(e))
        }
      }
    }
    if (!screenSharingRef.current) {
      for (const [remoteId, { pc }] of peersRef.current.entries()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        if (sender) {
          const prevId = sender.track?.id
          await sender.replaceTrack(videoTrack)
          // Some browsers can stall/black-frame when swapping camera ↔ canvas.captureStream
          // without an SDP refresh (especially when resolution/fps changes). Renegotiate
          // only when the actual outbound track identity changes.
          if (prevId && prevId !== videoTrack.id) {
            void renegotiate(remoteId)
          }
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
        isBlurMode(mode)
          ? {
              blurAmount: blurAmountForMode(mode),
              onFrameError: (e) => {
                appendLog('background pipeline frame', String(e))
                showToast(`Background effect failed while running (${errorMessage(e)})`, 7000)
              },
            }
          : {
              onFrameError: (e) => {
                appendLog('background pipeline frame', String(e))
                showToast(`Background effect failed while running (${errorMessage(e)})`, 7000)
              },
            },
      )
      cameraBgPipelineRef.current = pipeline
      const out = pipeline.getProcessedTrack()
      ls.addTrack(out)
      await pushLocalVideoToPeersAndPreview(out)
    } catch (e) {
      appendLog('background pipeline', String(e))
      showToast(`Background effect failed — using normal camera (${errorMessage(e)})`, 6000)
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
      setLocalCameraDevices(dedupeVideoInputsForUi(devices))
    } catch { /* ignore */ }
  }

  async function enumerateLocalAudioDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setLocalMicDevices(devices.filter(d => d.kind === 'audioinput'))
      setLocalSpeakerDevices(devices.filter(d => d.kind === 'audiooutput'))
    } catch { /* ignore */ }
  }

  async function switchMicDevice(deviceId: string | null) {
    setActiveMicDeviceId(deviceId)
    setRemoteMicCameraId(null)
    if (!micEnabled) return
    const localStream = localStreamRef.current ?? await ensureStream()
    if (micLockedByHostRef.current) {
      showToast('The host has muted your microphone')
      return
    }
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
      const newAudioTrack = micStream.getAudioTracks()[0] ?? null
      if (!newAudioTrack) throw new Error('No microphone track available')

      for (const t of [...localStream.getAudioTracks()]) {
        localStream.removeTrack(t)
        if (!isInboundRemoteCameraAudioTrack(t)) t.stop()
      }
      localStream.addTrack(newAudioTrack)
      newAudioTrack.enabled = true

      for (const [remoteId, { pc }] of peersRef.current.entries()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
        if (sender) {
          await sender.replaceTrack(newAudioTrack)
        } else {
          pc.addTrack(newAudioTrack, localStream)
          void renegotiate(remoteId)
        }
      }
      showToast('Microphone switched')
      void applyRemoteSpeakerTracks()
    } catch (e) {
      appendLog('mic switch error', String(e))
      showToast('Unable to switch microphone')
    }
  }

  async function restoreLocalMicrophone(expectedGen?: number): Promise<void> {
    if (expectedGen !== undefined && expectedGen !== aiVoiceSessionGenRef.current) return

    const wantEnabled = micEnabledBeforeAiVoiceRef.current
    micEnabledBeforeAiVoiceRef.current = null

    const localStream = localStreamRef.current ?? (await ensureStream())

    for (const t of [...localStream.getAudioTracks()]) {
      localStream.removeTrack(t)
      if (!isInboundRemoteCameraAudioTrack(t)) t.stop()
    }

    async function clearOutboundAudio(): Promise<void> {
      for (const [, { pc }] of peersRef.current.entries()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
        if (sender) await sender.replaceTrack(null).catch(() => {})
      }
      const room = liveKitRoomRef.current
      if (room?.state === 'connected' && liveKitPublishedTracksRef.current.audio) {
        try {
          await room.localParticipant.unpublishTrack(liveKitPublishedTracksRef.current.audio, false)
        } catch {
          /* ignore */
        }
        liveKitPublishedTracksRef.current = {
          ...liveKitPublishedTracksRef.current,
          audio: null,
        }
      }
      void applyRemoteSpeakerTracks()
    }

    if (!wantEnabled) {
      setMicEnabled(false)
      await clearOutboundAudio()
      return
    }

    if (micLockedByHostRef.current) {
      showToast('The host has muted your microphone')
      setMicEnabled(false)
      await clearOutboundAudio()
      return
    }

    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: activeMicDeviceId ? { exact: activeMicDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })
    const newAudioTrack = micStream.getAudioTracks()[0] ?? null
    if (!newAudioTrack) throw new Error('No microphone track available')

    localStream.addTrack(newAudioTrack)
    newAudioTrack.enabled = true
    for (const [remoteId, { pc }] of peersRef.current.entries()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
      if (sender) {
        await sender.replaceTrack(newAudioTrack)
      } else {
        pc.addTrack(newAudioTrack, localStream)
        void renegotiate(remoteId)
      }
    }
    await republishLiveKitLocalTracks()
    setMicEnabled(true)
    setRemoteMicCameraId(null)
    showToast('Microphone restored')
  }

  async function speakAudioBlobInMeeting(audio: Blob): Promise<void> {
    // Stop any existing AI voice playback.
    aiVoiceStopRef.current?.()
    aiVoiceStopRef.current = null
    aiVoiceTrackRef.current = null

    const sessionGen = ++aiVoiceSessionGenRef.current
    if (micEnabledBeforeAiVoiceRef.current === null) {
      micEnabledBeforeAiVoiceRef.current = micEnabledRef.current
    }
    // Keep mic "off" in UI / caption pipeline while AI speaks (TTS is not the host mic).
    setMicEnabled(false)

    const localStream = localStreamRef.current ?? (await ensureStream())

    const audioCtx = new AudioContext()
    const arr = await audio.arrayBuffer()
    const buf = await audioCtx.decodeAudioData(arr.slice(0))
    const src = audioCtx.createBufferSource()
    src.buffer = buf
    const dest = audioCtx.createMediaStreamDestination()
    src.connect(dest)
    src.start(0)

    const newTrack = dest.stream.getAudioTracks()[0] ?? null
    if (!newTrack) {
      try { audioCtx.close() } catch { /* ignore */ }
      throw new Error('Could not create TTS audio track')
    }

    // Replace outgoing audio with TTS track (mesh + LiveKit).
    for (const t of [...localStream.getAudioTracks()]) {
      localStream.removeTrack(t)
      // Don't stop inbound remote camera audio tracks; do stop previous local tracks.
      if (!isInboundRemoteCameraAudioTrack(t)) t.stop()
    }
    localStream.addTrack(newTrack)
    newTrack.enabled = true

    for (const [remoteId, { pc }] of peersRef.current.entries()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
      if (sender) {
        await sender.replaceTrack(newTrack)
      } else {
        pc.addTrack(newTrack, localStream)
        void renegotiate(remoteId)
      }
    }
    await republishLiveKitLocalTracks()

    aiVoiceTrackRef.current = newTrack
    setAiVoiceActive(true)

    return new Promise<void>((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }

      const stopNow = () => {
        try { src.stop() } catch { /* ignore */ }
        try { newTrack.stop() } catch { /* ignore */ }
        try { audioCtx.close() } catch { /* ignore */ }
        setAiVoiceActive(false)
        aiVoiceStopRef.current = null
        aiVoiceTrackRef.current = null
        // Best-effort restore mic.
        void restoreLocalMicrophone(sessionGen).catch(() => {
          showToast('AI voice stopped (mic restore failed)')
        })
        settle()
      }
      aiVoiceStopRef.current = stopNow

      src.onended = () => {
        stopNow()
      }
      showToast('AI voice is live (your mic is replaced)')
    })
  }

  /**
   * Autopilot trigger: in a 1:1 call (host + one remote), respond to almost every remark.
   * In larger calls, only respond when the utterance seems directed at the host.
   */
  function shouldAutopilotRespondTo(text: string, duoOneOnOne = false): boolean {
    const raw = text.trim()
    if (!raw) return false
    if (duoOneOnOne) return raw.length >= 3
    const t = raw.toLowerCase()

    // Strong signals
    if (t.includes('@host') || t.includes('host,')) return true

    // Questions directed at "you"
    if (t.includes('can you') || t.includes('could you') || t.includes('would you') || t.includes('will you')) return true
    if (t.includes('do you') || t.includes('did you') || t.includes('are you') || t.includes('is it ok if we')) return true
    if (t.includes('what do you think') || t.includes('should we') || t.includes('do we want to')) return true

    // Fallback: question mark + direct-address hint.
    if (t.endsWith('?') && (t.includes('you') || t.includes('your') || t.includes('we'))) return true

    return false
  }

  function buildRecentMeetingContext(lines: CaptionLine[], maxLines: number): string {
    const finals = lines.filter(l => l.final && l.text.trim().length > 0)
    const tail = finals.slice(-maxLines)
    return tail.map(l => `[${l.speakerName}]: ${l.text}`).join('\n')
  }

  useEffect(() => {
    hostAgentConversationRef.current = []
  }, [code])

  useEffect(() => {
    if (!hostAgentAutopilotEnabled) hostAgentConversationRef.current = []
  }, [hostAgentAutopilotEnabled])

  useEffect(() => {
    if (!hostAgentAutopilotEnabled) return
    if (callView !== 'call') return
    if (!isHostInCall) return
    if (!liveCaptionsEnabled) return
    if (hostAgentAutopilotBusyRef.current) return

    const duoHostAutopilot = peerIds.length === 1

    const last = captionLines.length > 0 ? captionLines[captionLines.length - 1] : null
    if (!last || !last.final) return
    if (last.userId === myUserIdRef.current) return
    if (hostAgentAutopilotLastKeyRef.current === last.key) return

    const now = Date.now()
    if (now - hostAgentAutopilotLastAtRef.current < 2200) return

    // Mark as seen even if we skip (prevents re-processing the same last line).
    hostAgentAutopilotLastKeyRef.current = last.key
    if (!shouldAutopilotRespondTo(last.text, duoHostAutopilot)) return

    hostAgentAutopilotBusyRef.current = true
    hostAgentAutopilotLastAtRef.current = now

    void (async () => {
      try {
        if (aiVoiceStopRef.current) return
        const kb = hostAgentKbRef.current.trim()
        if (kb.length === 0) {
          showToast('Autopilot needs a knowledge base (paste it in Host AI stand-in).')
          return
        }
        const ctx = buildRecentMeetingContext(captionLines, 18)
        const userLine = `${last.speakerName}: ${last.text}`
        const history = [...hostAgentConversationRef.current]
        const r = await hostAgentChat(code, {
          message: duoHostAutopilot
            ? `The participant said:\n${userLine}`
            : `You must respond as the host. Answer this question in one concise spoken paragraph:\n${userLine}`,
          knowledgeBase: kb,
          meetingContext: ctx.length > 0 ? ctx : undefined,
          conversationHistory: history.length > 0 ? history : undefined,
          duoHostMode: duoHostAutopilot,
          autopilotFast: true,
        })
        const answer = r.reply.trim()
        if (!answer) return
        hostAgentConversationRef.current = (
          [
            ...history,
            { role: 'user' as const, content: userLine.slice(0, 4000) },
            { role: 'assistant' as const, content: answer.slice(0, 4000) },
          ] satisfies HostAgentChatTurn[]
        ).slice(-24)
        const audio = await hostAgentTts(code, { text: answer })
        await speakAudioBlobInMeeting(audio)
      } catch (e: unknown) {
        showToast(errorMessage(e))
      } finally {
        hostAgentAutopilotBusyRef.current = false
      }
    })()
  }, [captionLines, callView, code, hostAgentAutopilotEnabled, isHostInCall, liveCaptionsEnabled, peerIds])

  // Autopilot without captions: VAD on remote mix → record utterance → STT → reply; barge-in interrupts TTS / pending work.
  useEffect(() => {
    if (!hostAgentAutopilotEnabled) return
    if (callView !== 'call') return
    if (!isHostInCall) return
    if (liveCaptionsEnabled) return

    const kb = hostAgentKbRef.current.trim()
    if (kb.length === 0) {
      showToast('Autopilot needs a knowledge base (paste it in Host AI stand-in).')
      return
    }

    let syncTimer: number | null = null
    const startSyncLoop = () => {
      if (syncTimer != null) return
      syncTimer = window.setInterval(() => {
        try { syncSpeakerMixInputs() } catch { /* ignore */ }
      }, 1500)
    }
    const stopSyncLoop = () => {
      if (syncTimer == null) return
      window.clearInterval(syncTimer)
      syncTimer = null
    }

    const { dest } = ensureSpeakerMixGraph()
    const track = syncSpeakerMixInputs()
    const ctx = speakerMixCtxRef.current
    try { void ctx?.resume() } catch { /* ignore */ }
    startSyncLoop()

    const stream = dest.stream
    const mixTrack = stream.getAudioTracks()[0]
    if (!track || !mixTrack || !ctx) {
      showToast('Autopilot: waiting for participant audio…')
      stopSyncLoop()
      return
    }

    const recorderMime =
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

    // VAD thresholds (RMS 0–1 from getByteRms).
    const THRESH_ON = 0.022
    const THRESH_OFF = 0.014
    const SPEECH_START_MS = 140
    const SILENCE_END_MS = 520
    const MIN_UTTER_MS = 420
    const MAX_UTTER_MS = 28_000
    const BARGE_IN_COOLDOWN_MS = 320

    let cancelled = false
    type ListenState = 'idle' | 'recording' | 'busy'
    let listenState: ListenState = 'idle'
    let mr: MediaRecorder | null = null
    let recordChunks: BlobPart[] = []
    let recordStartAt = 0
    let loudMs = 0
    let quietMs = 0
    let vadRaf: number | null = null
    let lastVadTs = performance.now()
    let bargeInCooldownUntil = 0

    const vadAnalyser = ctx.createAnalyser()
    vadAnalyser.fftSize = 512
    vadAnalyser.smoothingTimeConstant = 0.35
    const vadSrc = ctx.createMediaStreamSource(new MediaStream([mixTrack]))
    vadSrc.connect(vadAnalyser)
    const vadBuf = new Uint8Array(new ArrayBuffer(vadAnalyser.frequencyBinCount))

    function stopCurrentRecorder() {
      if (!mr) return
      try { mr.stop() } catch { /* ignore */ }
      mr = null
      hostAgentAutopilotRecorderRef.current = null
    }

    function startRecording(fromInterrupt: boolean) {
      if (fromInterrupt) {
        hostAgentAutopilotGenRef.current += 1
        if (aiVoiceStopRef.current) {
          try { aiVoiceStopRef.current() } catch { /* ignore */ }
          aiVoiceStopRef.current = null
          bargeInCooldownUntil = performance.now() + BARGE_IN_COOLDOWN_MS
        }
      }
      stopCurrentRecorder()
      recordChunks = []
      let next: MediaRecorder
      try {
        next = new MediaRecorder(stream, { mimeType: recorderMime })
      } catch {
        showToast('Autopilot: audio recording is not supported in this browser.')
        return
      }
      mr = next
      hostAgentAutopilotRecorderRef.current = next
      next.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunks.push(e.data)
      }
      next.onstop = () => {
        hostAgentAutopilotRecorderRef.current = null
        mr = null
        if (cancelled) return
        const blob = new Blob(recordChunks, { type: recorderMime })
        recordChunks = []
        const captureGen = hostAgentAutopilotGenRef.current
        listenState = 'busy'
        void processUtterance(blob, captureGen)
      }
      try {
        next.start()
        listenState = 'recording'
        recordStartAt = performance.now()
        loudMs = 0
        quietMs = 0
      } catch {
        mr = null
        hostAgentAutopilotRecorderRef.current = null
        listenState = 'idle'
        showToast('Autopilot: could not start recording.')
      }
    }

    async function processUtterance(blob: Blob, captureGen: number) {
      if (blob.size < 2000) {
        listenState = 'idle'
        return
      }
      try {
        showToast('Autopilot: transcribing…')
        hostAgentAutopilotBusyRef.current = true
        const stt = await hostAgentTranscribe(code, blob)
        if (captureGen !== hostAgentAutopilotGenRef.current) return
        const text = stt.text.trim()
        if (!text) {
          listenState = 'idle'
          return
        }
        hostAgentAutopilotTranscriptRef.current = text.slice(-6000)

        const duoHostAutopilot = peerIds.length === 1
        if (!shouldAutopilotRespondTo(text, duoHostAutopilot)) {
          listenState = 'idle'
          return
        }

        if (captureGen !== hostAgentAutopilotGenRef.current) return
        showToast('Autopilot: speaking…')
        const history = [...hostAgentConversationRef.current]
        const r = await hostAgentChat(code, {
          message: duoHostAutopilot
            ? `The participant said:\n"${text}"`
            : `You must respond as the host. Respond in one concise spoken paragraph.\n\nHeard:\n"${text}"`,
          knowledgeBase: kb,
          meetingContext: `Latest utterance:\n${text}`,
          conversationHistory: history.length > 0 ? history : undefined,
          duoHostMode: duoHostAutopilot,
          autopilotFast: true,
        })
        if (captureGen !== hostAgentAutopilotGenRef.current) return
        const answer = r.reply.trim()
        if (!answer) {
          listenState = 'idle'
          return
        }
        hostAgentConversationRef.current = (
          [
            ...history,
            { role: 'user' as const, content: text.slice(0, 4000) },
            { role: 'assistant' as const, content: answer.slice(0, 4000) },
          ] satisfies HostAgentChatTurn[]
        ).slice(-24)
        const audio = await hostAgentTts(code, { text: answer })
        if (captureGen !== hostAgentAutopilotGenRef.current) return
        hostAgentAutopilotLastSpokenAtRef.current = Date.now()
        await speakAudioBlobInMeeting(audio)
      } catch (err: unknown) {
        if (captureGen === hostAgentAutopilotGenRef.current) showToast(errorMessage(err))
      } finally {
        hostAgentAutopilotBusyRef.current = false
        if (captureGen === hostAgentAutopilotGenRef.current) listenState = 'idle'
      }
    }

    function tick() {
      if (cancelled) return
      const now = performance.now()
      const dt = Math.min(now - lastVadTs, 80)
      lastVadTs = now

      const rms = getByteRms(vadAnalyser, vadBuf)
      if (rms > THRESH_ON) {
        loudMs += dt
        quietMs = 0
      } else if (rms < THRESH_OFF) {
        quietMs += dt
        loudMs = 0
      } else {
        loudMs = 0
        quietMs = 0
      }

      const speechStart = loudMs >= SPEECH_START_MS && now >= bargeInCooldownUntil

      if (listenState === 'idle' && speechStart) {
        startRecording(false)
      } else if (listenState === 'recording') {
        const elapsed = now - recordStartAt
        if (elapsed >= MAX_UTTER_MS) {
          stopCurrentRecorder()
        } else if (elapsed >= MIN_UTTER_MS && quietMs >= SILENCE_END_MS) {
          stopCurrentRecorder()
        }
      } else if (listenState === 'busy' && speechStart) {
        showToast('Autopilot: new speech — stopping reply…')
        startRecording(true)
      }

      vadRaf = requestAnimationFrame(tick)
    }

    showToast('Autopilot: listening for participants (audio)')
    vadRaf = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      hostAgentAutopilotGenRef.current += 1
      if (vadRaf != null) cancelAnimationFrame(vadRaf)
      vadRaf = null
      try { vadSrc.disconnect() } catch { /* ignore */ }
      try { vadAnalyser.disconnect() } catch { /* ignore */ }
      stopSyncLoop()
      stopCurrentRecorder()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostAgentAutopilotEnabled, callView, isHostInCall, liveCaptionsEnabled, code, meeting?.host?.name, peerIds])

  async function switchSpeakerDevice(deviceId: string | null) {
    setActiveSpeakerDeviceId(deviceId)
    if (!deviceId) {
      showToast('Speaker set to default')
      return
    }
    await applySpeakerSinkIdToAllPeerMedia()
    showToast('Speaker switched')
  }

  async function switchRemoteMicCamera(cameraId: string | null) {
    setRemoteMicCameraId(cameraId)
    remoteMicCameraIdRef.current = cameraId
    const localStream = localStreamRef.current ?? await ensureStream()

    if (!cameraId) {
      for (const t of [...localStream.getAudioTracks()]) {
        localStream.removeTrack(t)
        if (!isInboundRemoteCameraAudioTrack(t)) t.stop()
      }
      if (!micEnabled) return
      if (micLockedByHostRef.current) {
        showToast('The host has muted your microphone')
        return
      }
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: activeMicDeviceId ? { exact: activeMicDeviceId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        })
        const newAudioTrack = micStream.getAudioTracks()[0] ?? null
        if (!newAudioTrack) throw new Error('No microphone track available')
        localStream.addTrack(newAudioTrack)
        for (const [remoteId, { pc }] of peersRef.current.entries()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
          if (sender) {
            await sender.replaceTrack(newAudioTrack)
          } else {
            pc.addTrack(newAudioTrack, localStream)
            void renegotiate(remoteId)
          }
        }
        newAudioTrack.enabled = true
        showToast('Local microphone restored')
      } catch (e) {
        appendLog('mic restore error', String(e))
        setMicEnabled(false)
        showToast('Unable to restore local microphone')
      }
      void applyRemoteSpeakerTracks()
      return
    }

    if (micLockedByHostRef.current) {
      showToast('The host has muted your microphone')
      return
    }
    const remoteStream = remoteCameraStreamsRef.current.get(cameraId)
    const remoteTrack = remoteStream?.getAudioTracks()[0] ?? null
    if (!remoteTrack) {
      showToast('Remote device microphone not available yet')
      return
    }

    for (const t of [...localStream.getAudioTracks()]) {
      localStream.removeTrack(t)
      if (!isInboundRemoteCameraAudioTrack(t)) t.stop()
    }
    localStream.addTrack(remoteTrack)

    for (const [remoteId, { pc }] of peersRef.current.entries()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
      if (sender) {
        await sender.replaceTrack(remoteTrack)
      } else {
        pc.addTrack(remoteTrack, localStream)
        void renegotiate(remoteId)
      }
    }

    remoteTrack.enabled = true
    setMicEnabled(true)
    showToast('Remote device mic selected')
    void applyRemoteSpeakerTracks()
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
      let stream: MediaStream | null = null
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 30, max: 60 } }
            : { width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 30, max: 60 } },
        })
      } catch (e) {
        const err = e as DOMException
        if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          showToast('Camera busy or not available — close other apps using the camera or pick another.')
        } else if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
          showToast('This camera is not available in the current mode — try another listed camera.')
        } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showToast('Camera permission denied')
        } else {
          showToast('Could not access camera')
        }
        appendLog('camera switch', String(e))
        return
      }
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

  function ensurePeerState(remoteId: string, opts?: { omitFromCallGrid?: boolean }): PeerState {
    const existing = peersRef.current.get(remoteId)
    if (existing) return existing

    const pendingIce: RTCIceCandidateInit[] = []
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current })

    let usedLiveBroadcastComposite = false
    if (opts?.omitFromCallGrid && liveStreamPublicRef.current) {
      const outbound = broadcastCompositorRef.current?.getStream()
      const ov = outbound?.getVideoTracks()[0]
      const oa = outbound?.getAudioTracks()[0]
      if (outbound && ov && oa) {
        for (const t of outbound.getTracks()) {
          try {
            pc.addTrack(t.clone(), outbound)
          } catch (e) {
            appendLog('live broadcast clone/add failed', String(e))
          }
        }
        usedLiveBroadcastComposite = true
      }
    }
    if (!usedLiveBroadcastComposite && localStreamRef.current) {
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
      const runSync = () => syncPeerCameraOverlayRef.current(remoteId)
      runSync()
      if (ev.track.kind === 'audio') {
        void applyRemoteSpeakerTracks()
        setupSpeakerAnalyser(remoteId, s)
      }
      if (ev.track.kind === 'video') {
        ev.track.addEventListener('ended', runSync)
        ev.track.addEventListener('mute', runSync)
        ev.track.addEventListener('unmute', runSync)
      }
      const videoEl = peerVideoRefs.current.get(remoteId)
      if (videoEl) {
        videoEl.srcObject = s
        void applySpeakerSinkIdToEl(videoEl)
        void videoEl.play().catch(() => {})
      } else if (activeSpeakerIdRef.current === remoteId && speakerMainVideoRef.current) {
        speakerMainVideoRef.current.srcObject = s
        void speakerMainVideoRef.current.play().catch(() => {})
      }
      if (!opts?.omitFromCallGrid) {
        scheduleLiveBroadcastCompositorSyncRef.current()
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
        void applyBitrateCaps(pc, remoteId)
      }
    }

    const state: PeerState = { pc, pendingIce, remoteDescriptionReady: false }
    peersRef.current.set(remoteId, state)

    const early = preConnectIceRef.current.get(remoteId)
    if (early) { for (const c of early) pendingIce.push(c); preConnectIceRef.current.delete(remoteId) }

    if (!opts?.omitFromCallGrid) {
      setPeerIds(prev => (prev.includes(remoteId) ? prev : [...prev, remoteId]))
    }
    return state
  }

  function findPeerIdForUserId(roster: Record<string, ParticipantRosterEntry>, userId: string): string | undefined {
    for (const [peerId, entry] of Object.entries(roster)) {
      if (entry.userId === userId) return peerId
    }
    return undefined
  }

  function attachLiveKitRemoteTrack(peerId: string, track: RemoteTrack) {
    const mst = track.mediaStreamTrack
    const stream = peerStreamRefs.current.get(peerId) ?? new MediaStream()
    for (const existing of stream.getTracks()) {
      if (existing.kind === mst.kind) {
        stream.removeTrack(existing)
      }
    }
    stream.addTrack(mst)
    peerStreamRefs.current.set(peerId, stream)
    const videoEl = peerVideoRefs.current.get(peerId)
    if (videoEl) {
      videoEl.srcObject = stream
      void applySpeakerSinkIdToEl(videoEl)
      void videoEl.play().catch(() => {})
    } else if (activeSpeakerIdRef.current === peerId && speakerMainVideoRef.current) {
      speakerMainVideoRef.current.srcObject = stream
      void speakerMainVideoRef.current.play().catch(() => {})
    }
    void applyRemoteSpeakerTracks()
    if (mst.kind === 'audio') {
      setupSpeakerAnalyser(peerId, stream)
    }
    if (mst.kind === 'video') {
      queueMicrotask(() => syncPeerCameraOverlayRef.current(peerId))
      mst.addEventListener('ended', () => syncPeerCameraOverlayRef.current(peerId))
      mst.addEventListener('mute', () => syncPeerCameraOverlayRef.current(peerId))
      mst.addEventListener('unmute', () => syncPeerCameraOverlayRef.current(peerId))
    }
    scheduleLiveBroadcastCompositorSyncRef.current()
  }

  function flushPendingLiveKitTracksForUser(userId: string) {
    const pending = pendingLiveKitTracksByUserIdRef.current.get(userId)
    if (!pending || pending.length === 0) return
    const peerId = findPeerIdForUserId(participantRosterRef.current, userId)
    if (!peerId) return
    pendingLiveKitTracksByUserIdRef.current.delete(userId)
    for (const t of pending) attachLiveKitRemoteTrack(peerId, t)
  }

  function clearLiveKitReconnectTimer() {
    const id = liveKitReconnectTimerRef.current
    if (id != null) {
      window.clearTimeout(id)
      liveKitReconnectTimerRef.current = null
    }
  }

  function scheduleLiveKitReconnect() {
    if (liveKitReconnectTimerRef.current != null) return
    if (liveKitReconnectInFlightRef.current) return
    if (liveKitReconnectFailuresRef.current >= LIVEKIT_FULL_RECONNECT_MAX_ATTEMPTS) {
      showToast('Could not reconnect to media server. Leave the call and join again.', 8000)
      appendLog('livekit reconnect aborted', 'max attempts')
      return
    }
    const delay = liveKitFullReconnectDelayMs(liveKitReconnectFailuresRef.current)
    appendLog('livekit reconnect scheduled in ms', String(delay))
    liveKitReconnectTimerRef.current = window.setTimeout(() => {
      liveKitReconnectTimerRef.current = null
      void (async () => {
        if (liveKitReconnectInFlightRef.current) return
        liveKitReconnectInFlightRef.current = true
        try {
          if (
            callViewRef.current !== 'call' ||
            mediaModeRef.current !== 'livekit' ||
            !socketRef.current?.connected
          ) {
            liveKitReconnectFailuresRef.current = 0
            return
          }
          const ok = await tryLiveKitFullReconnect()
          if (ok) {
            liveKitReconnectFailuresRef.current = 0
            appendLog('livekit', 'full session reconnect ok')
            showToast('Media connection restored', 3000)
          } else if (
            callViewRef.current === 'call' &&
            mediaModeRef.current === 'livekit' &&
            socketRef.current?.connected
          ) {
            liveKitReconnectFailuresRef.current++
            scheduleLiveKitReconnect()
          }
        } finally {
          liveKitReconnectInFlightRef.current = false
        }
      })()
    }, delay)
  }

  async function abandonLiveKitSessionForReconnect() {
    const room = liveKitRoomRef.current
    liveKitRoomRef.current = null
    pendingLiveKitTracksByUserIdRef.current.clear()
    liveKitPublishedTracksRef.current = { video: null, audio: null }
    if (!room) return
    try {
      if (room.state !== 'disconnected') await room.disconnect(false)
    } catch {
      /* ignore */
    }
  }

  async function tryLiveKitFullReconnect(): Promise<boolean> {
    if (
      callViewRef.current !== 'call' ||
      mediaModeRef.current !== 'livekit' ||
      !socketRef.current?.connected
    ) {
      return false
    }
    const peerIdsSnapshot = [...liveKitPeerIdsRef.current]
    await abandonLiveKitSessionForReconnect()
    try {
      await establishLiveKitRoom(peerIdsSnapshot)
      return true
    } catch (e: unknown) {
      appendLog('livekit reconnect error', String(e))
      return false
    }
  }

  async function establishLiveKitRoom(peerList: string[]) {
    const { url, token } = await getLiveKitJoinToken(code)
    await ensureStream()
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: false,
      reconnectPolicy: new DefaultReconnectPolicy(),
    })
    liveKitRoomRef.current = room
    const onRemoteTrack = (track: RemoteTrack, participant: RemoteParticipant) => {
      if (participant.identity === room.localParticipant.identity) return
      const uid = participant.identity
      const peerId = findPeerIdForUserId(participantRosterRef.current, uid)
      if (!peerId) {
        const cur = pendingLiveKitTracksByUserIdRef.current.get(uid) ?? []
        cur.push(track)
        pendingLiveKitTracksByUserIdRef.current.set(uid, cur)
        return
      }
      attachLiveKitRemoteTrack(peerId, track)
    }
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      onRemoteTrack(track, participant)
    })
    room.on(RoomEvent.ParticipantDisconnected, p => {
      const uid = p.identity
      const peerId = findPeerIdForUserId(participantRosterRef.current, uid)
      if (peerId) removeLiveKitPeerMedia(peerId)
      pendingLiveKitTracksByUserIdRef.current.delete(uid)
    })
    room.on(RoomEvent.Reconnecting, () => {
      appendLog('livekit', 'sdk reconnecting')
      showToast('Restoring media connection…', 3500)
    })
    room.on(RoomEvent.Reconnected, () => {
      liveKitReconnectFailuresRef.current = 0
      appendLog('livekit', 'sdk reconnected')
      showToast('Media connection restored', 2500)
    })
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (liveKitRoomRef.current !== room) return
      if (liveKitIntentionalDisconnectRef.current) return
      if (callViewRef.current !== 'call' || mediaModeRef.current !== 'livekit') return
      if (!socketRef.current?.connected) return
      if (!shouldAttemptFullLiveKitReconnect(reason)) {
        appendLog('livekit disconnected (no retry)', String(reason ?? ''))
        showToast('Disconnected from media server', 5000)
        return
      }
      appendLog('livekit disconnected', String(reason ?? ''))
      showToast('Media server interrupted — reconnecting…', 4500)
      scheduleLiveKitReconnect()
    })
    await room.connect(url, token)
    const ls = localStreamRef.current
    if (!ls) throw new Error('No local stream')
    const lp = room.localParticipant
    for (const t of ls.getAudioTracks()) {
      await lp.publishTrack(t)
      liveKitPublishedTracksRef.current.audio = t
    }
    for (const t of ls.getVideoTracks()) {
      await lp.publishTrack(t, { videoEncoding: LIVEKIT_CAMERA_VIDEO_ENCODING })
      liveKitPublishedTracksRef.current.video = t
    }
    for (const p of room.remoteParticipants.values()) {
      if (p.identity === lp.identity) continue
      for (const pub of p.trackPublications.values()) {
        if (pub.isSubscribed && pub.track) onRemoteTrack(pub.track, p)
      }
    }
    for (const pid of peerList) {
      const entry = participantRosterRef.current[pid]
      if (entry?.userId) flushPendingLiveKitTracksForUser(entry.userId)
    }
    appendLog('livekit', 'connected')
  }

  async function disconnectLiveKitMedia() {
    clearLiveKitReconnectTimer()
    liveKitReconnectFailuresRef.current = 0
    liveKitIntentionalDisconnectRef.current = true
    const room = liveKitRoomRef.current
    liveKitRoomRef.current = null
    pendingLiveKitTracksByUserIdRef.current.clear()
    liveKitPublishedTracksRef.current = { video: null, audio: null }
    try {
      if (room) {
        const lp = room.localParticipant
        const ls = localStreamRef.current
        if (room.state === 'connected' && ls) {
          for (const t of ls.getTracks()) {
            try {
              await lp.unpublishTrack(t, false)
            } catch {
              // ignore
            }
          }
        }
        room.disconnect(false)
      }
    } catch {
      /* ignore */
    } finally {
      queueMicrotask(() => {
        liveKitIntentionalDisconnectRef.current = false
      })
    }
  }

  async function connectLiveKitMedia(peerList: string[]) {
    liveKitPeerIdsRef.current = [...peerList]
    clearLiveKitReconnectTimer()
    liveKitReconnectFailuresRef.current = 0
    if (liveKitRoomRef.current) {
      await disconnectLiveKitMedia()
    }
    try {
      await establishLiveKitRoom(peerList)
    } catch (e: unknown) {
      appendLog('livekit error', String(e))
      showToast(errorMessage(e))
      const leaked = liveKitRoomRef.current
      liveKitRoomRef.current = null
      if (leaked && leaked.state !== 'disconnected') {
        try { leaked.disconnect(false) } catch { /* ignore */ }
      }
    }
  }

  async function republishLiveKitLocalTracks() {
    const room = liveKitRoomRef.current
    if (!room || room.state !== 'connected') return
    const lp = room.localParticipant
    const ls = localStreamRef.current
    if (!ls) return
    const a = ls.getAudioTracks()[0]
    const v = ls.getVideoTracks()[0]
    if (a && liveKitPublishedTracksRef.current.audio !== a) {
      if (liveKitPublishedTracksRef.current.audio) {
        try {
          await lp.unpublishTrack(liveKitPublishedTracksRef.current.audio, false)
        } catch {
          // ignore
        }
      }
      await lp.publishTrack(a)
      liveKitPublishedTracksRef.current.audio = a
    }
    if (v && liveKitPublishedTracksRef.current.video !== v) {
      if (liveKitPublishedTracksRef.current.video) {
        try {
          await lp.unpublishTrack(liveKitPublishedTracksRef.current.video, false)
        } catch {
          // ignore
        }
      }
      await lp.publishTrack(v, { videoEncoding: LIVEKIT_CAMERA_VIDEO_ENCODING })
      liveKitPublishedTracksRef.current.video = v
    }
  }

  function removeLiveKitPeerMedia(peerId: string) {
    peerVideoRefs.current.delete(peerId)
    peerVideoCallbackRefs.current.delete(peerId)
    peerStreamRefs.current.delete(peerId)
    teardownSpeakerAnalyser(peerId)
    void applyRemoteSpeakerTracks()
    setPeerShowVideoFallback(prev => {
      if (!(peerId in prev)) return prev
      const next = { ...prev }
      delete next[peerId]
      return next
    })
    setPeerIds(prev => {
      const next = prev.filter(id => id !== peerId)
      if (mediaModeRef.current === 'livekit') liveKitPeerIdsRef.current = next
      return next
    })
  }

  function removePeer(remoteId: string) {
    if (mediaModeRef.current === 'livekit') {
      removeLiveKitPeerMedia(remoteId)
      return
    }
    const timer = iceRestartTimersRef.current.get(remoteId)
    if (timer) { clearTimeout(timer); iceRestartTimersRef.current.delete(remoteId) }
    peersRef.current.get(remoteId)?.pc.close()
    peersRef.current.delete(remoteId)
    preConnectIceRef.current.delete(remoteId)
    peerVideoRefs.current.delete(remoteId)
    peerVideoCallbackRefs.current.delete(remoteId)
    peerStreamRefs.current.delete(remoteId)
    teardownSpeakerAnalyser(remoteId)
    // Keep remote speaker mix in sync when peers change
    void applyRemoteSpeakerTracks()
    setPeerShowVideoFallback(prev => {
      if (!(remoteId in prev)) return prev
      const next = { ...prev }
      delete next[remoteId]
      return next
    })
    setPeerIds(prev => prev.filter(id => id !== remoteId))
    scheduleLiveBroadcastCompositorSyncRef.current()
  }

  function resetAllPeers() {
    void disconnectLiveKitMedia()
    for (const timer of iceRestartTimersRef.current.values()) clearTimeout(timer)
    iceRestartTimersRef.current.clear()
    for (const s of peersRef.current.values()) s.pc.close()
    peersRef.current.clear()
    preConnectIceRef.current.clear()
    peerVideoRefs.current.clear()
    peerVideoCallbackRefs.current.clear()
    peerStreamRefs.current.clear()
    void applyRemoteSpeakerTracks()
    liveKitPeerIdsRef.current = []
    setPeerIds([])
    participantRosterRef.current = {}
    setParticipantRoster({})
    setPeerShowVideoFallback({})
    setHandRaisedByPeerId({})
    setMyHandRaised(false)
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
        queueMicrotask(() => syncPeerCameraOverlayRef.current(remoteId))
      } else {
        peerVideoRefs.current.delete(remoteId)
      }
    }

    peerVideoCallbackRefs.current.set(remoteId, callback)
    return callback
  }

  async function createAndSendOffer(remoteId: string, opts?: { omitFromCallGrid?: boolean }) {
    await ensureStream()
    const state = ensurePeerState(remoteId, opts)
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
      setCallLocalSocketId(socket.id ?? null)
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
      const p = payload as { peerId?: unknown; userName?: unknown; userId?: unknown; userEmail?: unknown }
      const peerId = p.peerId
      if (typeof peerId !== 'string' || peerId === mySocketIdRef.current) return
      const userName = typeof p.userName === 'string' ? p.userName : 'Guest'
      const userId = typeof p.userId === 'string' ? p.userId : ''
      const userEmail = typeof p.userEmail === 'string' ? p.userEmail : undefined
      setParticipantRoster(prev => {
        const next = {
          ...prev,
          [peerId]: { userName, userId, ...(userEmail ? { userEmail } : {}) },
        }
        // Keep ref in sync immediately so LiveKit TrackSubscribed + flush see the new mapping
        // (useEffect runs too late; otherwise tracks stay stuck in pendingLiveKitTracksByUserIdRef).
        participantRosterRef.current = next
        return next
      })
      appendLog('peer-joined', shortId(peerId))
      playMeetingNotificationSound('join')
      showToast(`${userName} joined the call`)
      if (mediaModeRef.current === 'mesh' && shouldInitiateOffer(peerId)) {
        void createAndSendOffer(peerId).catch(e => appendLog('offer error', String(e)))
      }
      if (mediaModeRef.current === 'livekit') {
        setPeerIds(prev => {
          const next = prev.includes(peerId) ? prev : [...prev, peerId]
          liveKitPeerIdsRef.current = next
          return next
        })
        if (userId) flushPendingLiveKitTracksForUser(userId)
      }
      // Re-announce screen share so the newly joined peer learns the current state
      if (screenSharingRef.current) {
        socket.emit('meeting:screenshare', { sharing: true })
      }
      // Re-announce our RTC mode so the new peer can detect any mismatch
      socketRef.current?.emit('meeting:rtc-mode', { mode: resolvedRtcMode() })
    })
    socket.on('meeting:rtc-mode', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { peerId?: unknown; mode?: unknown; isHost?: unknown }
      if (typeof p.mode !== 'string' || p.isHost !== true) return
      const hostMode = p.mode as RtcMode
      if (hostMode !== 'mesh' && hostMode !== 'livekit') return
      const myMode = resolvedRtcMode()
      if (hostMode === myMode) return
      // Host announced a different mode. If still in lobby, auto-switch silently.
      // If already in an active call, ask them to rejoin.
      const inActiveCall = peersRef.current.size > 0 || liveKitRoomRef.current?.state === 'connected'
      if (inActiveCall) {
        showToast(
          `Host switched to ${hostMode} mode. Leave and rejoin to match.`,
          8000,
        )
      } else {
        writeRtcModeToStorage(hostMode)
        mediaModeRef.current = hostMode
        showToast(`Host is using ${hostMode} mode — switching automatically`, 4000)
      }
    })
    socket.on('meeting:hand-raise', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { peerId?: unknown; raised?: unknown }
      if (typeof p.peerId !== 'string' || typeof p.raised !== 'boolean') return
      const peerId = p.peerId
      const raised = p.raised
      setHandRaisedByPeerId(prev => {
        if (prev[peerId] === raised) return prev
        return { ...prev, [peerId]: raised }
      })
      if (peerId === mySocketIdRef.current) setMyHandRaised(raised)
    })
    socket.on('meeting:live-viewer-joined', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { peerId?: unknown }
      if (typeof p.peerId !== 'string') return
      if (!isHostInCallRef.current) return
      const peerId = p.peerId
      liveViewerPeerIdsRef.current.add(peerId)
      void createAndSendOffer(peerId, { omitFromCallGrid: true }).catch(e =>
        appendLog('live viewer offer error', String(e)),
      )
    })
    socket.on('meeting:live-viewer-request-reoffer', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const peerId = (payload as { peerId?: unknown }).peerId
      if (typeof peerId !== 'string') return
      if (!isHostInCallRef.current) return
      if (!liveViewerPeerIdsRef.current.has(peerId)) return
      const state = peersRef.current.get(peerId)
      if (state) void iceRestart(peerId)
      else void createAndSendOffer(peerId, { omitFromCallGrid: true }).catch(e =>
        appendLog('live viewer re-offer error', String(e)),
      )
    })
    socket.on('meeting:live-state', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const live = (payload as { live?: unknown }).live === true
      if (isHostInCallRef.current) {
        setLiveStreamPublic(live)
        if (!live) setLivePublicViewerCount(0)
      }
    })
    socket.on('meeting:live-viewer-count', (payload: unknown) => {
      if (!isHostInCallRef.current) return
      if (!payload || typeof payload !== 'object') return
      const c = (payload as { count?: unknown }).count
      setLivePublicViewerCount(typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0)
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
      playMeetingNotificationSound('joinRequest')
      showToast('Join request received')
    })
    socket.on('meeting:live-collab-request', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { requestId?: unknown; name?: unknown; userId?: unknown }
      if (typeof p.requestId !== 'string') return
      const requestId = p.requestId
      const name = typeof p.name === 'string' ? p.name : 'Someone'
      const userId = typeof p.userId === 'string' ? p.userId : ''
      setHostLiveCollabRequests(prev => {
        if (prev.some(r => r.requestId === requestId)) return prev
        return [...prev, { requestId, name, userId }]
      })
      playMeetingNotificationSound('joinRequest')
      showToast('Broadcast collaboration request')
    })
    socket.on('meeting:join-approved', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      setWaitingForHost(false)
      finalizeJoin(payload as Record<string, unknown>)
    })
    socket.on('meeting:join-denied', (payload: unknown) => {
      const p = payload && typeof payload === 'object' ? payload as { message?: unknown } : {}
      const msg = typeof p.message === 'string' ? p.message : 'Could not join the meeting.'
      setStatusLine(msg)
      setWaitingForHost(false)
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
      if (!iAmHost) {
        setAttentionRoster({})
        attentionBadPrevRef.current = new Set()
        setLiveStreamPublic(false)
        setLivePublicViewerCount(0)
      }
      const newHostUserId = p.hostUserId
      setMeeting(prev => (prev ? { ...prev, hostId: newHostUserId } : prev))
      showToast(iAmHost ? 'You are now the host' : 'Host changed')
    })
    socket.on('meeting:host-mic-state', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const muted = (payload as { muted?: unknown }).muted === true

      if (muted) {
        if (micWasEnabledBeforeHostMuteRef.current === null) micWasEnabledBeforeHostMuteRef.current = micEnabled
        micLockedByHostRef.current = true
        setMicEnabled(false)
        const localStream = localStreamRef.current
        if (localStream) {
          for (const t of localStream.getAudioTracks()) t.enabled = false
        }
        showToast('The host has muted your microphone')
        return
      }

      micLockedByHostRef.current = false
      const restore = micWasEnabledBeforeHostMuteRef.current
      micWasEnabledBeforeHostMuteRef.current = null
      if (restore) {
        const localStream = localStreamRef.current
        const tracks = localStream?.getAudioTracks() ?? []
        if (tracks.length > 0) {
          for (const t of tracks) t.enabled = true
          setMicEnabled(true)
          showToast('The host unmuted your microphone')
        } else {
          showToast('The host unmuted you — turn your mic back on')
        }
      } else {
        showToast('The host unmuted you')
      }
    })
    socket.on('webrtc:offer', async (msg: unknown) => {
      if (mediaModeRef.current === 'livekit') return
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
            queueMicrotask(() => syncPeerCameraOverlayRef.current(from))
          }
        }
      } catch (e) { appendLog('offer handler error', String(e)) }
    })
    socket.on('webrtc:answer', async (msg: unknown) => {
      if (mediaModeRef.current === 'livekit') return
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
      if (mediaModeRef.current === 'livekit') return
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
      remoteCameraSpeakerSenderRef.current.delete(cameraId)
      setRemoteMicCameraId(prev => (prev === cameraId ? null : prev))
      setRemoteSpeakerCameraId(prev => (prev === cameraId ? null : prev))
      setActiveCameraId(prev => {
        const next = prev === `remote:${cameraId}` ? null : prev
        activeCameraIdRef.current = next
        return next
      })
      showToast('A camera source disconnected')
    })

    // Push-to-talk: device requests host audio be sent to it while held.
    socket.on('camera:ptt-speaker', ({ cameraId, on }: { cameraId: string; on: boolean }) => {
      if (on) {
        setRemoteSpeakerCameraId(cameraId)
        showToast('Sending audio to device…')
        return
      }
      if (remoteSpeakerCameraIdRef.current === cameraId) {
        setRemoteSpeakerCameraId(null)
        showToast('Stopped sending audio to device')
      }
    })

    // Push-to-talk: device is transmitting mic (host can auto-monitor it while held).
    socket.on('camera:ptt-mic', ({ cameraId, on }: { cameraId: string; on: boolean }) => {
      if (on) {
        setRemoteMicCameraId(cameraId)
        setMonitorRemoteDeviceMic(true)
        showToast('Listening to device mic…')
        return
      }
      if (remoteMicCameraIdRef.current === cameraId) {
        setRemoteMicCameraId(null)
        showToast('Stopped listening to device mic')
      }
    })

    socket.on('camera:offer', async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      // Offer from a camera source — close any stale PC, create recvonly PC, answer it
      remoteCameraPcsRef.current.get(from)?.close()
      const pc = new RTCPeerConnection({ iceServers: iceServersRef.current })
      remoteCameraPcsRef.current.set(from, pc)
      // Prepare a sendonly audio m-line so we can later route meeting audio to the device without renegotiation.
      try {
        const tx = pc.addTransceiver('audio', { direction: 'sendonly' })
        remoteCameraSpeakerSenderRef.current.set(from, tx.sender)
        void tx.sender.replaceTrack(ensureSpeakerMixGraph().silentTrack)
      } catch {
        // ignore (browser may not support)
      }
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
          if (activeCameraIdRef.current === `remote:${from}` && track.kind === 'video') {
            const ls = localStreamRef.current
            if (ls) {
              teardownCameraBackgroundPipeline()
              for (const vt of [...ls.getVideoTracks()]) {
                if (vt.id === track.id) continue
                ls.removeTrack(vt)
                if (!isInboundRemoteCameraVideoTrack(vt)) vt.stop()
              }
              if (!ls.getVideoTracks().some(vt => vt.id === track.id)) ls.addTrack(track)
            }
            const mode = cameraBgModeRef.current
            if (isBlurMode(mode) || mode === 'image') {
              void applyCameraWithBackgroundSettings(track, mode, cameraBgImageElRef.current)
            } else {
              void pushLocalVideoToPeersAndPreview(track)
            }
          }
        }
        if (!track.muted) {
          markReady()
        } else {
          track.addEventListener('unmute', markReady, { once: true })
          // Fallback: mark ready after 4 s even if unmute never fires
          setTimeout(markReady, 4000)
        }

        if (track.kind === 'audio') {
          void applyRemoteSpeakerTracks()
          if (remoteMicCameraIdRef.current === from) {
            void switchRemoteMicCamera(from)
          }
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
        const wasLiveViewerOnly = liveViewerPeerIdsRef.current.has(peerId)
        liveViewerPeerIdsRef.current.delete(peerId)
        appendLog('peer-left', shortId(peerId))
        removePeer(peerId)
        setHostMutedPeerIds(prev => {
          if (!(peerId in prev)) return prev
          const next = { ...prev }
          delete next[peerId]
          return next
        })
        setParticipantRoster(prev => {
          const next = { ...prev }
          delete next[peerId]
          participantRosterRef.current = next
          return next
        })
        setHandRaisedByPeerId(prev => {
          if (!(peerId in prev)) return prev
          const next = { ...prev }
          delete next[peerId]
          return next
        })
        setScreenSharingPeers(prev => {
          const wasSharing = prev.has(peerId)
          const s = new Set(prev)
          s.delete(peerId)
          if (wasSharing) playMeetingNotificationSound('screenShareEnd')
          return s
        })
        if (!wasLiveViewerOnly) showToast('A participant left')
      } else {
        appendLog('peer-left (full reset)')
        resetAllPeers()
        participantRosterRef.current = {}
        setParticipantRoster({})
        setHostMutedPeerIds({})
        setScreenSharingPeers(new Set())
        setHandRaisedByPeerId({})
        setMyHandRaised(false)
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
      if (peerId !== mySocketIdRef.current) {
        playMeetingNotificationSound(sharing ? 'screenShare' : 'screenShareEnd')
      }
      setScreenSharingPeers(prev => {
        const s = new Set(prev)
        if (sharing) s.add(peerId)
        else s.delete(peerId)
        return s
      })
    })
    socket.on('meeting:recording-state', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { active?: unknown; by?: unknown }
      if (typeof p.active !== 'boolean') return
      setRoomRecordingActive(p.active)
      playMeetingNotificationSound(p.active ? 'recordingStart' : 'recordingStop')
      const by = typeof p.by === 'string' ? p.by : ''
      if (by !== mySocketIdRef.current) {
        showToast(p.active ? 'This meeting is being recorded' : 'Recording stopped')
      }
    })
    socket.on('meeting:chat', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const { id, senderId, senderUserId, senderName, text, createdAt } =
        payload as { id?: unknown; senderId?: unknown; senderUserId?: unknown; senderName?: unknown; text?: unknown; createdAt?: unknown }
      if (typeof senderId !== 'string' || typeof text !== 'string') return
      const stamp = typeof createdAt === 'string' ? createdAt : new Date().toISOString()
      const suid = typeof senderUserId === 'string' ? senderUserId : undefined
      const mine =
        senderId === mySocketIdRef.current ||
        (suid != null && suid.length > 0 && suid === myUserIdRef.current)
      pushChatMessage({
        id: typeof id === 'string' ? id : undefined,
        senderId,
        senderUserId: suid,
        senderName: typeof senderName === 'string' ? senderName : undefined,
        text,
        createdAt: stamp,
      })
      if (!mine) playMeetingNotificationSound('chat')
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
        by?: unknown
      }
      if (
        typeof p.x0 !== 'number' ||
        typeof p.y0 !== 'number' ||
        typeof p.x1 !== 'number' ||
        typeof p.y1 !== 'number'
      ) return
      if (typeof p.by === 'string' && p.by.length > 0) {
        const at = Date.now()
        setWhiteboardActiveDrawersAt(prev => (prev[p.by as string] === at ? prev : { ...prev, [p.by as string]: at }))
      }
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

    socket.on('meeting:vote-started', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { sessionId?: unknown; title?: unknown; anonymous?: unknown }
      if (typeof p.sessionId !== 'string' || typeof p.title !== 'string' || typeof p.anonymous !== 'boolean') return
      activeVoteSessionIdRef.current = p.sessionId
      setVoteSession({ sessionId: p.sessionId, title: p.title, anonymous: p.anonymous })
      setVoteUp(0)
      setVoteDown(0)
      setVoteBreakdown(null)
      setMyVote(null)
      playMeetingNotificationSound('voteStart')
      showToast('The host started a vote — tap 👍 or 👎')
    })
    socket.on('meeting:vote-update', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        sessionId?: unknown
        up?: unknown
        down?: unknown
        breakdown?: unknown
      }
      if (typeof p.sessionId !== 'string' || typeof p.up !== 'number' || typeof p.down !== 'number') return
      if (activeVoteSessionIdRef.current !== p.sessionId) return
      setVoteUp(p.up)
      setVoteDown(p.down)
      if (Array.isArray(p.breakdown)) {
        const rows = p.breakdown.flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return []
          const r = item as { peerId?: unknown; userName?: unknown; choice?: unknown }
          if (
            typeof r.peerId !== 'string' ||
            typeof r.userName !== 'string' ||
            (r.choice !== 'up' && r.choice !== 'down')
          ) {
            return []
          }
          return [{ peerId: r.peerId, userName: r.userName, choice: r.choice as MeetingVoteChoice }]
        })
        setVoteBreakdown(rows.length > 0 ? rows : null)
        const self = rows.find(r => r.peerId === mySocketIdRef.current)
        setMyVote(self ? self.choice : null)
      } else {
        setVoteBreakdown(null)
      }
    })
    socket.on('meeting:vote-ended', (payload: unknown) => {
      activeVoteSessionIdRef.current = null
      const p =
        payload && typeof payload === 'object'
          ? (payload as { title?: unknown; up?: unknown; down?: unknown; reason?: unknown })
          : {}
      const title = typeof p.title === 'string' ? p.title : 'Vote'
      const up = typeof p.up === 'number' ? p.up : 0
      const down = typeof p.down === 'number' ? p.down : 0
      const reason = typeof p.reason === 'string' ? p.reason : ''
      setVoteSession(null)
      setVoteUp(0)
      setVoteDown(0)
      setVoteBreakdown(null)
      setMyVote(null)
      if (reason === 'host-left') {
        showToast('Vote ended — host left the call')
      } else {
        showToast(`Vote closed: "${title}" — 👍 ${up} · 👎 ${down}`)
      }
      playMeetingNotificationSound('voteEnd')
    })

    socket.on('meeting:attention-sync', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { roster?: unknown }
      if (!Array.isArray(p.roster)) return
      const next: Record<string, AttentionRosterRow> = {}
      for (const item of p.roster) {
        if (!item || typeof item !== 'object') continue
        const r = item as Record<string, unknown>
        if (typeof r.userId !== 'string') continue
        if (typeof r.userName !== 'string') continue
        if (typeof r.hasSignal !== 'boolean') continue
        if (typeof r.tabVisible !== 'boolean') continue
        if (typeof r.lastAt !== 'number') continue
        if (typeof r.stale !== 'boolean') continue
        if (typeof r.needsAttention !== 'boolean') continue
        next[r.userId] = {
          userId: r.userId,
          userName: r.userName,
          hasSignal: r.hasSignal,
          tabVisible: r.tabVisible,
          lastAt: r.lastAt,
          stale: r.stale,
          needsAttention: r.needsAttention,
        }
      }
      setAttentionRoster(next)
    })

    socket.on('meeting:attention-warning', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const w = payload as { fromName?: unknown; message?: unknown }
      const fromName = typeof w.fromName === 'string' ? w.fromName : 'Host'
      const message = typeof w.message === 'string' ? w.message : ''
      void primeMeetingNotificationAudio()
      playMeetingNotificationSound('attentionWarning')
      setAttentionWarning({ fromName, message })
    })

    socket.on('meeting:caption', (payload: unknown) => {
      if (!liveCaptionsEnabledRef.current) return
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        speakerUserId?: unknown
        speakerName?: unknown
        text?: unknown
        interim?: unknown
        id?: unknown
        createdAt?: unknown
      }
      if (
        typeof p.speakerUserId !== 'string' ||
        typeof p.speakerName !== 'string' ||
        typeof p.text !== 'string' ||
        typeof p.interim !== 'boolean'
      ) {
        return
      }
      const speakerUserId = p.speakerUserId
      const speakerName = p.speakerName
      const capText = p.text
      const interim = p.interim
      setCaptionLines(prev =>
        mergeCaptionMessage(prev, {
          speakerUserId,
          speakerName,
          text: capText,
          interim,
          id: typeof p.id === 'string' ? p.id : undefined,
          createdAt: typeof p.createdAt === 'string' ? p.createdAt : undefined,
        }),
      )
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
    setActiveMeetingCode(code)
    setChatMessages(history)
    const capHist = Array.isArray(a.captionHistory)
      ? (a.captionHistory as unknown[]).flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const row = item as {
            id?: unknown
            speakerUserId?: unknown
            speakerName?: unknown
            text?: unknown
            createdAt?: unknown
          }
          if (
            typeof row.id !== 'string' ||
            typeof row.speakerUserId !== 'string' ||
            typeof row.speakerName !== 'string' ||
            typeof row.text !== 'string' ||
            typeof row.createdAt !== 'string'
          ) {
            return []
          }
          return [
            {
              id: row.id,
              speakerUserId: row.speakerUserId,
              speakerName: row.speakerName,
              text: row.text,
              createdAt: row.createdAt,
            },
          ]
        })
      : []
    setCaptionLines(liveCaptionsEnabledRef.current ? captionLinesFromHistory(capHist) : [])
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
          const r = row as { peerId?: unknown; userId?: unknown; userName?: unknown; userEmail?: unknown }
          if (typeof r.peerId !== 'string') continue
          const userEmail = typeof r.userEmail === 'string' ? r.userEmail : undefined
          nextRoster[r.peerId] = {
            userId: typeof r.userId === 'string' ? r.userId : '',
            userName: typeof r.userName === 'string' ? r.userName : 'Guest',
            ...(userEmail ? { userEmail } : {}),
          }
        }
      }
      const sid = mySocketIdRef.current
      if (sid) {
        const selfName = typeof a.selfName === 'string' ? a.selfName : 'You'
        const selfEmailRaw = typeof a.selfEmail === 'string' ? a.selfEmail : ''
        const selfEmail = selfEmailRaw.trim() || getJwtProfile(getToken() ?? '').email
        nextRoster[sid] = {
          userName: selfName,
          userId: myUserIdRef.current,
          ...(selfEmail ? { userEmail: selfEmail } : {}),
        }
      }
      participantRosterRef.current = nextRoster
      setParticipantRoster(nextRoster)
    }
    if (resolvedRtcMode() === 'mesh') {
      for (const pid of peerList) {
        if (shouldInitiateOffer(pid)) void createAndSendOffer(pid).catch(e => appendLog('offer error', String(e)))
      }
    } else {
      liveKitPeerIdsRef.current = [...peerList]
      setPeerIds(peerList)
      void connectLiveKitMedia(peerList)
    }
    // Announce our RTC mode so peers can detect a mismatch
    socketRef.current?.emit('meeting:rtc-mode', { mode: resolvedRtcMode() })
    {
      const raised = Array.isArray(a.handRaisedPeerIds)
        ? (a.handRaisedPeerIds as unknown[]).filter((id): id is string => typeof id === 'string')
        : []
      const next: Record<string, boolean> = {}
      for (const pid of raised) next[pid] = true
      const selfSid = mySocketIdRef.current
      setHandRaisedByPeerId(next)
      setMyHandRaised(Boolean(selfSid && next[selfSid]))
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
    setRoomRecordingActive(a.meetingRecordingActive === true)
    {
      const av = a.activeVote
      if (av && typeof av === 'object' && av !== null) {
        const o = av as Record<string, unknown>
        if (
          typeof o.sessionId === 'string' &&
          typeof o.title === 'string' &&
          typeof o.anonymous === 'boolean'
        ) {
          activeVoteSessionIdRef.current = o.sessionId
          setVoteSession({ sessionId: o.sessionId, title: o.title, anonymous: o.anonymous })
        } else {
          activeVoteSessionIdRef.current = null
          setVoteSession(null)
        }
      } else {
        activeVoteSessionIdRef.current = null
        setVoteSession(null)
      }
      setVoteUp(typeof a.voteUp === 'number' ? a.voteUp : 0)
      setVoteDown(typeof a.voteDown === 'number' ? a.voteDown : 0)
      const bd = a.voteBreakdown
      if (Array.isArray(bd)) {
        const rows = bd.flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return []
          const r = item as { peerId?: unknown; userName?: unknown; choice?: unknown }
          if (
            typeof r.peerId !== 'string' ||
            typeof r.userName !== 'string' ||
            (r.choice !== 'up' && r.choice !== 'down')
          ) {
            return []
          }
          return [{ peerId: r.peerId, userName: r.userName, choice: r.choice as MeetingVoteChoice }]
        })
        setVoteBreakdown(rows.length > 0 ? rows : null)
      } else {
        setVoteBreakdown(null)
      }
      const mv = a.myVote
      setMyVote(mv === 'up' || mv === 'down' ? mv : null)
    }
    primeMeetingNotificationAudio()
    // peer-joined only fires for *others* when someone new arrives — play when you enter too
    playMeetingNotificationSound('join')
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
    } else if (focus === 'Note Taker') {
      setHostAgentOpen(false)
      setAgendaOpen(false)
      setNotesOpen(true)
    }
  }

  function respondJoinRequest(requestId: string, accepted: boolean) {
    socketRef.current?.emit('meeting:join-decision', { requestId, accepted })
    setHostJoinRequests(prev => prev.filter(r => r.requestId !== requestId))
  }

  function respondLiveCollabRequest(requestId: string, accepted: boolean) {
    socketRef.current?.emit('live:collab-decision', { requestId, accepted })
    setHostLiveCollabRequests(prev => prev.filter(r => r.requestId !== requestId))
  }

  function transferHost(toPeerId: string) {
    if (!isHostInCall) return
    socketRef.current?.emit('meeting:host-transfer', { to: toPeerId })
  }

  function endMeetingVote() {
    if (!isHostInCall) return
    socketRef.current?.emit('meeting:vote-end')
  }

  function startMeetingVoteFromDraft() {
    if (!isHostInCall) return
    const t = voteTitleDraft.trim()
    if (t.length === 0) {
      showToast('Add a title or question for the vote first')
      return
    }
    socketRef.current?.emit('meeting:vote-start', {
      title: t.slice(0, 200),
      anonymous: voteAnonymousDraft,
    })
    setCallSettingsOpen(false)
  }

  async function loadSavedPollsForMeeting() {
    if (!code.trim() || !isHostInCall) return
    setSavedPollsErr(null)
    setSavedPollsBusy(true)
    try {
      const r = await fetchMeetingPolls(code)
      setSavedPolls(r.polls)
    } catch (e: unknown) {
      setSavedPollsErr(errorMessage(e))
    } finally {
      setSavedPollsBusy(false)
    }
  }

  async function connect() {
    micLockedByHostRef.current = false
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
          const msg = typeof a.message === 'string' ? a.message : 'Waiting for host to admit you.'
          setStatusLine(msg)
          setWaitingForHost(true)
          showToast(msg)
          return
        }
        const msg = typeof a.error === 'string' ? a.error : 'Join failed'
        setStatusLine(msg); showToast(msg); appendLog(ack)
        setConnectBtnDisabled(false)
        socketRef.current?.disconnect()
        return
      }
      // If we are NOT the host and the host has already chosen a mode, adopt it.
      if (a.isHost !== true && (a.hostMode === 'mesh' || a.hostMode === 'livekit')) {
        const hostMode = a.hostMode as RtcMode
        if (hostMode !== resolvedRtcMode()) {
          writeRtcModeToStorage(hostMode)
          mediaModeRef.current = hostMode
          showToast(`Host is using ${hostMode} mode — switching automatically`, 4000)
        }
      }
      finalizeJoin(a)
    })
  }

  function leave(notification?: string) {
    const hr = hostRecorderRef.current
    hostRecorderRef.current = null
    const wasRecording = !!hr
    if (hr) void hr.stop().catch(() => {})
    setRecordingActive(false)
    const sockEarly = socketRef.current
    if (wasRecording && sockEarly?.connected) {
      sockEarly.emit('meeting:recording-state', { active: false })
    }
    setRoomRecordingActive(false)

    const leavePipedRaw = teardownCameraBackgroundPipeline()
    if (leavePipedRaw && leavePipedRaw.readyState === 'live') leavePipedRaw.stop()
    if (cameraBgImageObjectUrlRef.current) {
      URL.revokeObjectURL(cameraBgImageObjectUrlRef.current)
      cameraBgImageObjectUrlRef.current = null
    }
    cameraBgImageElRef.current = null

    const socket = socketRef.current
    if (liveStreamPublicRef.current && socket?.connected && isHostInCallRef.current) {
      socket.emit('meeting:live-stream', { live: false })
    }
    if (socket?.connected) {
      // Clear raised-hand state promptly (server will also clear on disconnect).
      socket.emit('meeting:hand-raise', { raised: false })
    }
    liveViewerPeerIdsRef.current = new Set()
    setLiveStreamPublic(false)
    setLivePublicViewerCount(0)
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
    setWaitingForHost(false)
    stopTimer()
    stopNetworkStats()
    setChatMessages([])
    setCaptionLines([])
    setChatHasMore(false)
    setChatUnread(0)
    setChatOpen(false)
    setNotesOpen(false)
    setAgendaOpen(false)
    setHostAgentOpen(false)
    setCallSettingsOpen(false)
    setChatDraft('')
    setIsHostInCall(false)
    setHostPeerId(null)
    participantRosterRef.current = {}
    liveKitPeerIdsRef.current = []
    setParticipantRoster({})
    setAttentionRoster({})
    setAttentionWarning(null)
    setAttentionWarnCompose(null)
    setAttentionWarnDraft('')
    setMyHandRaised(false)
    setHandRaisedByPeerId({})
    attentionBadPrevRef.current = new Set()
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
    setHostLiveCollabRequests([])
    setHostMutedPeerIds({})
    micLockedByHostRef.current = false
    showToast(notification ?? 'You left the call')
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
      rec.start(root, collectRecordingAudioStreams(), {
        getCaptionOverlay: () => {
          if (!liveCaptionsEnabledRef.current) return null
          return captionOverlayRecordingRef.current
        },
      })
      hostRecorderRef.current = rec
      recordingStartedAtRef.current = Date.now()
      setRecordingActive(true)
      socketRef.current?.emit('meeting:recording-state', { active: true })
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
    let blob: Blob
    try {
      blob = await rec.stop()
    } catch (e: unknown) {
      setRecordingActive(false)
      socketRef.current?.emit('meeting:recording-state', { active: false })
      showToast(errorMessage(e))
      setRecordingBusy(false)
      return
    }
    setRecordingActive(false)
    socketRef.current?.emit('meeting:recording-state', { active: false })
    try {
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

  async function downloadSavedCaptions() {
    const meetingCode = activeMeetingCode.trim() || code.trim()
    if (!meetingCode) {
      showToast('No meeting code')
      return
    }
    setCaptionExportBusy(true)
    try {
      const { captions } = await fetchMeetingCaptions(meetingCode)
      const body =
        captions.length === 0
          ? '(No saved lines yet. Turn on Live captions (CC) in call settings so speech is transcribed; final phrases are stored after each pause while participants have CC on.)\n'
          : captions.map(c => `[${c.createdAt}] ${c.speakerName}: ${c.text}`).join('\n')
      const blob = new Blob([body], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `meeting-${meetingCode}-transcript.txt`
      a.click()
      URL.revokeObjectURL(url)
      showToast('Transcript downloaded')
    } catch (e: unknown) {
      showToast(errorMessage(e))
    } finally {
      setCaptionExportBusy(false)
    }
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
    if (next && micLockedByHostRef.current) {
      showToast('The host has muted your microphone')
      return
    }
    const localStream = localStreamRef.current ?? await ensureStream()

    if (!next) {
      setMicEnabled(false)
      for (const t of localStream.getAudioTracks()) t.enabled = false
      showToast('Microphone muted')
      void applyRemoteSpeakerTracks()
      return
    }

    try {
      if (remoteMicCameraId) {
        if (mediaModeRef.current === 'livekit') {
          showToast('Remote device mic is not available in LiveKit mode yet')
          return
        }
        const remoteStream = remoteCameraStreamsRef.current.get(remoteMicCameraId)
        const remoteTrack = remoteStream?.getAudioTracks()[0] ?? null
        if (!remoteTrack) throw new Error('Remote device microphone not available')

        // Replace local audio tracks with the inbound remote track (do NOT stop inbound camera tracks).
        for (const t of [...localStream.getAudioTracks()]) {
          localStream.removeTrack(t)
          if (!isInboundRemoteCameraAudioTrack(t)) t.stop()
        }
        localStream.addTrack(remoteTrack)
        remoteTrack.enabled = true

        for (const [remoteId, { pc }] of peersRef.current.entries()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
          if (sender) {
            await sender.replaceTrack(remoteTrack)
          } else {
            pc.addTrack(remoteTrack, localStream)
            void renegotiate(remoteId)
          }
        }
        setMicEnabled(true)
        showToast('Remote device mic on')
        void applyRemoteSpeakerTracks()
        return
      }

      let audioTrack = localStream.getAudioTracks()[0] ?? null
      if (!audioTrack) {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: activeMicDeviceId ? { exact: activeMicDeviceId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
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
        void republishLiveKitLocalTracks()
      }

      audioTrack.enabled = true
      setMicEnabled(true)
      showToast('Microphone on')
      void applyRemoteSpeakerTracks()
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
      if (mediaModeRef.current === 'livekit') {
        const room = liveKitRoomRef.current
        const v = liveKitPublishedTracksRef.current.video
        if (room?.state === 'connected' && v) {
          try {
            await room.localParticipant.unpublishTrack(v)
          } catch {
            // ignore
          }
          liveKitPublishedTracksRef.current.video = null
        }
      }
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
        video: { width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 30, max: 60 } },
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
    if (mediaModeRef.current === 'livekit') return
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
    if (mediaModeRef.current === 'livekit' && !liveViewerPeerIdsRef.current.has(remoteId)) return
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

  async function applyBitrateCaps(pc: RTCPeerConnection, remoteId?: string) {
    const publicViewer =
      remoteId !== undefined && liveViewerPeerIdsRef.current.has(remoteId)
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      const maxBitrate =
        sender.track.kind === 'video'
          ? publicViewer
            ? 800_000
            : 2_000_000
          : publicViewer
            ? 40_000
            : 64_000
      for (const enc of params.encodings) enc.maxBitrate = maxBitrate
      try { await sender.setParameters(params) } catch { /* browser may not support */ }
    }
  }

  async function renegotiate(remoteId: string) {
    if (mediaModeRef.current === 'livekit' && !liveViewerPeerIdsRef.current.has(remoteId)) return
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
      if (
        liveViewerPeerIdsRef.current.has(remoteId) &&
        liveStreamPublicRef.current &&
        broadcastCompositorRef.current?.getStream()
      ) {
        continue
      }
      const sender = pc.getSenders().find(s => s.track?.kind === 'video')
      if (sender) {
        await sender.replaceTrack(cameraTrack)
        void renegotiate(remoteId)
      }
    }
    scheduleLiveBroadcastCompositorSyncRef.current()
    if (localPipRef.current && localStreamRef.current) {
      localPipRef.current.srcObject = localStreamRef.current
    }
    setPipCamOff(!cameraTrack)
    setScreenSharing(false)
    if (!opts?.silent) {
      playMeetingNotificationSound('screenShareEnd')
      showToast('Screen sharing stopped')
    }
  }

  async function toggleScreenShare() {
    if (mediaModeRef.current === 'livekit') {
      showToast('Screen sharing is not available in LiveKit mode yet')
      return
    }
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
        if (
          liveViewerPeerIdsRef.current.has(remoteId) &&
          liveStreamPublicRef.current &&
          broadcastCompositorRef.current?.getStream()
        ) {
          continue
        }
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
      scheduleLiveBroadcastCompositorSyncRef.current()
      if (localPipRef.current) {
        const pipStream = new MediaStream([screenTrack])
        for (const t of (localStreamRef.current?.getAudioTracks() ?? [])) pipStream.addTrack(t)
        localPipRef.current.srcObject = pipStream
      }
      setScreenSharing(true)
      playMeetingNotificationSound('screenShare')
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

  function toggleHandRaise() {
    const socket = socketRef.current
    if (!socket?.connected) {
      showToast('Not connected')
      return
    }
    const next = !myHandRaised
    setMyHandRaised(next)
    setHandRaisedByPeerId(prev => {
      const me = mySocketIdRef.current
      if (!me) return prev
      if (prev[me] === next) return prev
      return { ...prev, [me]: next }
    })
    socket.emit('meeting:hand-raise', { raised: next })
    showToast(next ? 'Hand raised' : 'Hand lowered', 1800)
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

  const myRosterUserId = callLocalSocketId ? participantRoster[callLocalSocketId]?.userId : undefined
  const myAttentionRow = myRosterUserId ? attentionRoster[myRosterUserId] : null

  function rosterLabel(peerId: string) {
    const e = participantRoster[peerId]
    if (e?.userName) return e.userName
    return `Peer ${shortId(peerId)}`
  }

  function rosterEntryEmail(peerId: string): string {
    const ro = participantRoster[peerId]
    const fromRoster = ro?.userEmail?.trim()
    if (fromRoster) return fromRoster
    if (peerId === (callLocalSocketId ?? '')) {
      return getJwtProfile(getToken() ?? '').email.trim()
    }
    return ''
  }

  const youEmailLine = callLocalSocketId ? rosterEntryEmail(callLocalSocketId) : ''

  function showPeerVideoFallbackForPeer(peerId: string): boolean {
    if (screenSharingPeers.has(peerId)) return false
    return peerShowVideoFallback[peerId] !== false
  }

  const isSoloInCall = peerIds.length === 0
  const remotePresenterId = peerIds.find(id => screenSharingPeers.has(id)) ?? null
  const presenterIsLocal = !remotePresenterId && screenSharing
  const presenterMode = Boolean(remotePresenterId || presenterIsLocal)
  const stripPeerIds = presenterMode
    ? peerIds.filter(id => id !== remotePresenterId)
    : peerIds

  // Speaker spotlight: active when someone is speaking, no screen share, 2+ people in call
  const speakerMode = !presenterMode && !isSoloInCall && activeSpeakerId !== null
  const speakerIsLocal = speakerMode && activeSpeakerId === callLocalSocketId
  const nonSpeakerPeerIds = speakerMode
    ? peerIds.filter(id => id !== activeSpeakerId)
    : peerIds
  const whiteboardCanEdit = whiteboardEditors.includes(mySocketIdRef.current)
  const whiteboardIsOwner = whiteboardOwnerId === mySocketIdRef.current
  const whiteboardOtherEditors = whiteboardEditors.filter(id => id !== whiteboardOwnerId)
  const whiteboardActiveDrawerNames = Object.entries(whiteboardActiveDrawersAt)
    .filter(([, at]) => Date.now() - at <= WHITEBOARD_DRAWING_ACTIVE_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([peerId]) => participantRoster[peerId]?.userName ?? `Peer ${shortId(peerId)}`)
  const raisedHandPeerIds = Object.entries(handRaisedByPeerId)
    .filter(([, raised]) => raised)
    .map(([peerId]) => peerId)
  const raisedHandCount = raisedHandPeerIds.length

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

  connectRef.current = connect

  return (
    <>
      <audio ref={remoteMicMonitorAudioRef} autoPlay playsInline className="hidden" />
      {/* ── Meeting detail ── */}
      {callView === 'detail' && (
        <div
          className="meeting-route-root fixed inset-0 flex flex-col overflow-hidden"
          style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
        >
        {/* background */}
        <ShellBackgroundLayer />

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
          <ShellBackgroundLayer />

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
                    <VideoOffParticipantCard
                      name={getJwtProfile(getToken() ?? '').name || 'You'}
                      email={getJwtProfile(getToken() ?? '').email}
                    />
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
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                          <path
                            fill="currentColor"
                            fillOpacity={0.45}
                            d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"
                          />
                          <path fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" d="M4.5 4.5l15 15" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex w-full flex-col justify-center gap-4 lg:w-[min(100%,280px)] lg:shrink-0">
                  {waitingForHost ? (
                    <div className="flex items-center gap-2 rounded-xl border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-2.5">
                      <span className="relative flex h-2.5 w-2.5 shrink-0">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f59e0b] opacity-60" />
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#f59e0b]" />
                      </span>
                      <p className="text-sm text-[#f59e0b]/90">{statusLine}</p>
                    </div>
                  ) : (
                    <p className="min-h-5 text-sm text-white/40">{statusLine}</p>
                  )}

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
                    {waitingForHost ? 'Waiting for host…' : 'Join now'}
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
          {/* Video grid — regular mode (no screen share, nobody speaking yet) */}
          {!presenterMode && !speakerMode && (
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
                  {showPeerVideoFallbackForPeer(id) && (
                    <VideoOffParticipantCard name={rosterLabel(id)} email={rosterEntryEmail(id)} />
                  )}
                  {speakingPeerIds.has(id) && (
                    <div className="pointer-events-none absolute inset-0 z-2 rounded-[10px] ring-[3px] ring-inset ring-green-400/80" />
                  )}
                  {handRaisedByPeerId[id] && (
                    <div className="absolute top-2 right-2 z-3 flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/50 bg-amber-500/95 text-lg shadow-lg" title="Raised hand">
                      ✋
                    </div>
                  )}
                  <div className="absolute bottom-2.5 left-3 z-2 max-w-[calc(100%-16px)] truncate rounded bg-black/55 px-2 py-0.5 text-[13px] text-white">{rosterLabel(id)}</div>
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

          {/* Speaker spotlight — active speaker large, everyone else in a strip */}
          {speakerMode && (
            <div className="absolute inset-0 flex flex-col bg-[#111]">
              {/* Main speaker view */}
              <div className="relative min-h-0 flex-1 overflow-hidden">
                <video
                  ref={speakerMainVideoRef}
                  playsInline
                  autoPlay
                  muted={speakerIsLocal}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: speakerIsLocal && !screenSharing ? 'scaleX(-1)' : 'none' }}
                />
                {speakerIsLocal && pipCamOff && (
                  <VideoOffParticipantCard
                    name={participantRoster[callLocalSocketId ?? '']?.userName || getJwtProfile(getToken() ?? '').name || 'You'}
                    email={rosterEntryEmail(callLocalSocketId ?? '')}
                  />
                )}
                {!speakerIsLocal && activeSpeakerId && showPeerVideoFallbackForPeer(activeSpeakerId) && (
                  <VideoOffParticipantCard name={rosterLabel(activeSpeakerId)} email={rosterEntryEmail(activeSpeakerId)} />
                )}
                {/* Green speaking ring */}
                <div className="pointer-events-none absolute inset-0 ring-[3px] ring-inset ring-green-400/70" />
                {/* Name + speaking indicator */}
                <div className="absolute bottom-4 left-4 z-2 flex items-center gap-2">
                  <div className="flex items-center gap-2 rounded-xl bg-black/60 px-3 py-1.5 backdrop-blur-sm">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-green-400" />
                    <span className="text-sm font-semibold text-white">
                      {speakerIsLocal ? 'You' : rosterLabel(activeSpeakerId!)}
                    </span>
                  </div>
                </div>
                {activeSpeakerId && handRaisedByPeerId[activeSpeakerId] && (
                  <div className="absolute top-2 right-2 z-3 flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/50 bg-amber-500/95 text-lg shadow-lg">✋</div>
                )}
              </div>

              {/* Thumbnail strip */}
              <div className="flex h-[104px] shrink-0 items-center gap-2 overflow-x-auto bg-[#0d0d0d] px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {/* Local tile (when not the speaker) */}
                {!speakerIsLocal && (
                  <div className="relative h-full shrink-0 overflow-hidden rounded-xl bg-[#2d2e30]" style={{ aspectRatio: '16/9' }}>
                    <video ref={localStripRef} playsInline autoPlay muted className="h-full w-full object-cover -scale-x-100" />
                    {pipCamOff && (
                      <VideoOffParticipantCard compact
                        name={participantRoster[callLocalSocketId ?? '']?.userName || 'You'}
                        email={rosterEntryEmail(callLocalSocketId ?? '')}
                      />
                    )}
                    {callLocalSocketId && speakingPeerIds.has(callLocalSocketId) && (
                      <div className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-inset ring-green-400/80" />
                    )}
                    {callLocalSocketId && handRaisedByPeerId[callLocalSocketId] && (
                      <div className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/95 text-sm">✋</div>
                    )}
                    <div className="absolute bottom-1 left-2 truncate rounded bg-black/55 px-1.5 py-px text-[11px] text-white">You</div>
                  </div>
                )}
                {/* Non-speaker peer tiles */}
                {nonSpeakerPeerIds.map(id => (
                  <div key={id} className="relative h-full shrink-0 overflow-hidden rounded-xl bg-[#2d2e30]" style={{ aspectRatio: '16/9' }}>
                    <video
                      ref={getPeerVideoRef(id)}
                      playsInline
                      autoPlay
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: 'scaleX(-1)' }}
                    />
                    {showPeerVideoFallbackForPeer(id) && (
                      <VideoOffParticipantCard compact name={rosterLabel(id)} email={rosterEntryEmail(id)} />
                    )}
                    {speakingPeerIds.has(id) && (
                      <div className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-inset ring-green-400/80" />
                    )}
                    {handRaisedByPeerId[id] && (
                      <div className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/95 text-sm">✋</div>
                    )}
                    <div className="absolute bottom-1 left-2 max-w-[calc(100%-8px)] truncate rounded bg-black/55 px-1.5 py-px text-[11px] text-white">{rosterLabel(id)}</div>
                  </div>
                ))}
              </div>
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
                      {handRaisedByPeerId[remotePresenterId] && (
                        <div className="absolute top-2 right-2 z-3 flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/50 bg-amber-500/95 text-lg shadow-lg" title="Raised hand">
                          ✋
                        </div>
                      )}
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
                      {callLocalSocketId && handRaisedByPeerId[callLocalSocketId] && (
                        <div className="absolute top-2 right-2 z-3 flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/50 bg-amber-500/95 text-lg shadow-lg" title="Raised hand">
                          ✋
                        </div>
                      )}
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
                        <div className="absolute bottom-2.5 left-3 z-2 rounded bg-black/55 px-2 py-0.5 text-[13px] text-white">You</div>
                        {callLocalSocketId && handRaisedByPeerId[callLocalSocketId] && (
                          <div className="absolute top-2 right-2 z-3 flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/50 bg-amber-500/95 text-lg shadow-lg" title="Raised hand">
                            ✋
                          </div>
                        )}
                        {pipCamOff && (
                          <VideoOffParticipantCard
                            compact
                            name={
                              participantRoster[callLocalSocketId ?? '']?.userName
                              || getJwtProfile(getToken() ?? '').name
                              || 'You'
                            }
                            email={rosterEntryEmail(callLocalSocketId ?? '')}
                          />
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
                        {showPeerVideoFallbackForPeer(id) && (
                          <VideoOffParticipantCard
                            compact
                            name={rosterLabel(id)}
                            email={rosterEntryEmail(id)}
                          />
                        )}
                        {handRaisedByPeerId[id] && (
                          <div className="absolute top-2 right-2 z-3 flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/50 bg-amber-500/95 text-lg shadow-lg" title="Raised hand">
                            ✋
                          </div>
                        )}
                        <div className="absolute bottom-2.5 left-3 z-2 max-w-[calc(100%-16px)] truncate rounded bg-black/55 px-2 py-0.5 text-[13px] text-white">{rosterLabel(id)}</div>
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
              (presenterMode || speakerMode) && 'hidden',
              isSoloInCall
                ? 'absolute top-14 right-2.5 bottom-[104px] left-2.5 sm:top-[62px] sm:right-6 sm:bottom-[108px] sm:left-6'
                : 'absolute right-2.5 bottom-[88px] aspect-video w-[min(168px,40vw)] sm:bottom-24 sm:right-4 sm:w-[196px]',
            )}
          >
            <video ref={localPipRef} playsInline autoPlay muted className={screenSharing ? 'block h-full w-full object-cover' : 'block h-full w-full -scale-x-100 object-cover'} />
            {pipCamOff && (
              <VideoOffParticipantCard
                compact
                name={
                  participantRoster[callLocalSocketId ?? '']?.userName
                  || getJwtProfile(getToken() ?? '').name
                  || 'You'
                }
                email={rosterEntryEmail(callLocalSocketId ?? '')}
              />
            )}
            {callLocalSocketId && handRaisedByPeerId[callLocalSocketId] && (
              <div className="absolute top-1.5 right-1.5 z-3 flex h-7 w-7 items-center justify-center rounded-full border border-amber-300/50 bg-amber-500/95 text-base shadow-lg" title="Raised hand">
                ✋
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
              {(recordingActive || roomRecordingActive) && (
                <span className="rounded-full bg-red-600/90 px-2 py-0.5 text-[11px] font-bold tracking-wide text-white">REC</span>
              )}
              {isHostInCall && liveStreamPublic && (
                <span
                  className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[11px] font-semibold text-sky-200"
                  title="People on the public watch link (/watch/…), not counting meeting participants"
                >
                  {livePublicViewerCount === 0
                    ? 'Live · 0 watching'
                    : `${livePublicViewerCount} watching live`}
                </span>
              )}
            </div>
            <div className="pointer-events-auto flex flex-wrap items-center gap-2.5 max-sm:gap-y-1.5">
              <details className="relative">
                <summary className="cursor-pointer list-none text-[13px] text-[#9aa0a6] hover:text-white/80 [&::-webkit-details-marker]:hidden">
                  {participantCount === 1 ? '1 in call' : `${participantCount} in call`}
                  <span className="text-white/40"> · People</span>
                </summary>
                <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[min(calc(100vw-24px),400px)] rounded-xl border border-white/10 bg-[#1c1c1e]/98 py-2 shadow-2xl backdrop-blur-xl">
                  <p className="px-3 pb-2 text-[0.65rem] font-bold uppercase tracking-wider text-white/35">In this meeting</p>
                  {isHostInCall && (
                    <p className="px-3 pb-2 text-[11px] leading-snug text-white/40">
                      Dots show whether each person’s meeting tab looks visible (browser only). Nudge sends a private full-screen alert on their device. Remove ends their call; Mute forces their mic off until you unmute them.
                    </p>
                  )}
                  <ul className="max-h-[min(50vh,360px)] overflow-y-auto px-1">
                    {callLocalSocketId && (
                      <li className="px-2 py-2.5 text-left">
                        <div className="flex gap-2.5">
                          {isHostInCall && (
                            <span
                              className={cx(
                                'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                                !myAttentionRow || !myAttentionRow.hasSignal
                                  ? 'bg-white/30'
                                  : myAttentionRow.needsAttention
                                    ? 'bg-amber-400'
                                    : 'bg-emerald-400',
                              )}
                              title={attentionStatusTooltip(myAttentionRow)}
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <span
                                className="text-[13px] font-medium leading-snug wrap-break-word text-white/90"
                                title={participantRoster[callLocalSocketId]?.userName ?? 'You'}
                              >
                                {participantRoster[callLocalSocketId]?.userName ?? 'You'}
                                <span className="font-normal text-white/40"> (you)</span>
                              </span>
                              {hostPeerId === callLocalSocketId && (
                                <span className="inline-flex shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                                  Host
                                </span>
                              )}
                              {callLocalSocketId && handRaisedByPeerId[callLocalSocketId] && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300" title="Hand raised">
                                  ✋ Hand raised
                                </span>
                              )}
                            </div>
                            {youEmailLine ? (
                              <p className="mt-0.5 break-all text-[11px] leading-snug text-white/38">{youEmailLine}</p>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    )}
                    {rosterRemoteIdsSorted.map(id => {
                      const remoteUserId = participantRoster[id]?.userId
                      const attRow = remoteUserId ? attentionRoster[remoteUserId] : null
                      const displayName = rosterLabel(id)
                      const emailLine = rosterEntryEmail(id)
                      return (
                        <li key={id} className="border-t border-white/8 px-2 py-2.5 text-left">
                          <div className="flex gap-2.5">
                            {isHostInCall && (
                              <span
                                className={cx(
                                  'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                                  !attRow || !attRow.hasSignal
                                    ? 'bg-white/30'
                                    : attRow.needsAttention
                                      ? 'bg-amber-400'
                                      : 'bg-emerald-400',
                                )}
                                title={attentionStatusTooltip(attRow)}
                              />
                            )}
                            <div className="min-w-0 flex-1 space-y-2">
                              <div>
                                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                  <span
                                    className="text-[13px] font-medium leading-snug wrap-break-word text-white/90"
                                    title={displayName}
                                  >
                                    {displayName}
                                  </span>
                                  {hostPeerId === id && (
                                    <span className="inline-flex shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                                      Host
                                    </span>
                                  )}
                                  {handRaisedByPeerId[id] && (
                                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300" title="Hand raised">
                                      ✋ Hand raised
                                    </span>
                                  )}
                                </div>
                                {emailLine ? (
                                  <p className="mt-0.5 break-all text-[11px] leading-snug text-white/38">{emailLine}</p>
                                ) : null}
                              </div>
                              {isHostInCall && id !== hostPeerId && (
                                <div className="flex flex-wrap gap-1.5">
                                  <button
                                    type="button"
                                    className="rounded-lg border border-white/15 bg-white/8 px-2.5 py-1.5 text-[11px] font-semibold text-white/90 hover:bg-amber-500/20 hover:text-amber-200"
                                    onClick={() => transferHost(id)}
                                  >
                                    Make host
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-lg border border-red-500/35 bg-red-600/22 px-2.5 py-1.5 text-[11px] font-semibold text-red-100 hover:bg-red-600/38"
                                    onClick={() => {
                                      socketRef.current?.emit('meeting:host-remove-peer', { peerId: id })
                                      showToast(`Removing ${displayName} from the call`)
                                    }}
                                  >
                                    Remove
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-lg border border-white/15 bg-white/8 px-2.5 py-1.5 text-[11px] font-semibold text-white/90 hover:bg-white/14"
                                    onClick={() => {
                                      const nextMuted = !hostMutedPeerIds[id]
                                      socketRef.current?.emit('meeting:host-mute-peer', {
                                        peerId: id,
                                        muted: nextMuted,
                                      })
                                      setHostMutedPeerIds(prev => ({ ...prev, [id]: nextMuted }))
                                      showToast(nextMuted ? `Muted ${displayName}` : `Unmuted ${displayName}`)
                                    }}
                                  >
                                    {hostMutedPeerIds[id] ? 'Unmute' : 'Mute mic'}
                                  </button>
                                  {remoteUserId ? (
                                    <>
                                      <button
                                        type="button"
                                        className="rounded-lg border border-amber-500/35 bg-amber-600/25 px-2.5 py-1.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-600/40"
                                        onClick={() => {
                                          socketRef.current?.emit('meeting:attention-warn', {
                                            userId: remoteUserId,
                                            message: '',
                                          })
                                          showToast('Attention nudge sent')
                                        }}
                                      >
                                        Nudge
                                      </button>
                                      <button
                                        type="button"
                                        className="rounded-lg border border-white/15 bg-white/8 px-2.5 py-1.5 text-[11px] font-semibold text-white/90 hover:bg-white/14"
                                        onClick={() => {
                                          setAttentionWarnCompose({ userId: remoteUserId, name: displayName })
                                          setAttentionWarnDraft('')
                                        }}
                                      >
                                        Message…
                                      </button>
                                    </>
                                  ) : null}
                                </div>
                              )}
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </details>
              {companionAvailable && (
                <span className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-emerald-400/25 bg-emerald-400/12 px-2 py-0.5 text-[11px] font-semibold text-emerald-400" title="Bandr Companion connected">
                  <RemoteConnectionIcon size={11} />
                  Companion
                </span>
              )}
              {raisedHandCount > 0 && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-amber-300/25 bg-amber-300/12 px-2 py-0.5 text-[11px] font-semibold text-amber-200"
                  title="Raised hands"
                >
                  ✋ {raisedHandCount}
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
                {whiteboardActiveDrawerNames.length > 0 && (
                  <span
                    className="inline-flex items-center rounded-full border border-white/10 bg-white/6 px-2.5 py-1 text-[11px] font-semibold text-white/80"
                    title={`Currently drawing: ${whiteboardActiveDrawerNames.join(', ')}`}
                  >
                    Drawing: {whiteboardActiveDrawerNames.join(', ')}
                  </span>
                )}
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
                  const me = mySocketIdRef.current
                  if (me) {
                    const at = Date.now()
                    setWhiteboardActiveDrawersAt(prev => (prev[me] === at ? prev : { ...prev, [me]: at }))
                  }
                }}
                onPointerMove={e => {
                  if (!whiteboardCanEdit) return
                  if (!whiteboardDrawingRef.current) return
                  const me = mySocketIdRef.current
                  if (me) {
                    const at = Date.now()
                    setWhiteboardActiveDrawersAt(prev => (prev[me] === at ? prev : { ...prev, [me]: at }))
                  }
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
                <span>Meeting</span>
                <button
                  type="button"
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-white/6 text-base leading-none text-white/60 transition hover:border-white/16 hover:bg-white/12 hover:text-white"
                  onClick={() => setCallSettingsOpen(false)}
                  aria-label="Close settings"
                >
                  ✕
                </button>
              </div>
              <div
                role="tablist"
                aria-label="Meeting settings sections"
                className="flex shrink-0 gap-1 border-b border-white/10 px-3 py-2"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={callSettingsTab === 'features'}
                  className={cx(
                    'flex-1 rounded-lg px-2 py-2 text-[11px] font-bold uppercase tracking-wider transition',
                    callSettingsTab === 'features'
                      ? 'bg-white/12 text-white'
                      : 'text-white/45 hover:bg-white/6 hover:text-white/75',
                  )}
                  onClick={() => setCallSettingsTab('features')}
                >
                  Features
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={callSettingsTab === 'settings'}
                  className={cx(
                    'flex-1 rounded-lg px-2 py-2 text-[11px] font-bold uppercase tracking-wider transition',
                    callSettingsTab === 'settings'
                      ? 'bg-white/12 text-white'
                      : 'text-white/45 hover:bg-white/6 hover:text-white/75',
                  )}
                  onClick={() => setCallSettingsTab('settings')}
                >
                  Settings
                </button>
              </div>
              <div className="flex flex-1 flex-col gap-4 overflow-auto px-4 py-4 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20">
                {callSettingsTab === 'features' && (
                  <div role="tabpanel" className="flex flex-col gap-4" aria-label="Features">
                    <div>
                      <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Notes board</p>
                      <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                        Scratchpad for this meeting — stored on this device. Use the same speech language as in Settings for dictation-related features.
                      </p>
                      <button
                        type="button"
                        className={cx(
                          'w-full cursor-pointer rounded-xl border py-2.5 text-[13px] font-semibold transition',
                          notesOpen
                            ? 'border-sky-400/45 bg-blue-600/40 text-white'
                            : 'border-white/12 bg-white/8 text-white/90 hover:border-sky-500/35 hover:bg-white/12',
                        )}
                        onClick={() => {
                          setAgendaOpen(false)
                          setHostAgentOpen(false)
                          setCallSettingsOpen(false)
                          setNotesOpen(prev => !prev)
                        }}
                      >
                        {notesOpen ? 'Close notes board' : 'Open notes board'}
                      </button>
                    </div>
                    {isHostInCall && (
                      <div className="border-t border-white/10 pt-4">
                        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Public live stream</p>
                        <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                          Share a public watch link: anyone can watch a combined view of everyone in the call (grid, or your screen share with participant thumbnails). Viewers don’t need an account unless they comment, react, vote, or ask to join — you approve collaboration requests. Chat is filtered; your outgoing camera is checked locally for unsafe content.
                        </p>
                        <button
                          type="button"
                          className={cx(
                            'mb-2 w-full cursor-pointer rounded-xl border py-2.5 text-[13px] font-semibold transition',
                            liveStreamPublic
                              ? 'border-red-500/40 bg-red-600/28 text-white hover:bg-red-600/40'
                              : 'border-emerald-500/40 bg-emerald-600/25 text-white hover:bg-emerald-600/38',
                          )}
                          onClick={() => {
                            const next = !liveStreamPublic
                            setLiveStreamPublic(next)
                            if (!next) setLivePublicViewerCount(0)
                            socketRef.current?.emit('meeting:live-stream', { live: next })
                            showToast(next ? 'Public stream is on' : 'Public stream is off')
                          }}
                        >
                          {liveStreamPublic ? 'Stop public stream' : 'Start public stream'}
                        </button>
                        <button
                          type="button"
                          className="w-full cursor-pointer rounded-xl border border-white/12 bg-white/8 py-2.5 text-[13px] font-semibold text-white/90 transition hover:border-sky-500/35 hover:bg-white/12"
                          onClick={() => {
                            const url = `${window.location.origin}/watch/${encodeURIComponent(code)}`
                            void navigator.clipboard.writeText(url).then(
                              () => showToast('Watch link copied'),
                              () => showToast(url),
                            )
                          }}
                        >
                          Copy watch link
                        </button>
                      </div>
                    )}
                    {isHostInCall && (
                      <div className="border-t border-white/10 pt-4">
                        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Live vote</p>
                        <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                          Run a quick 👍 / 👎 poll. Participants tap the bar at the bottom or hold a thumbs-up / thumbs-down to the camera (with video on). You choose the title and whether results show names or only totals.
                        </p>
                        {voteSession ? (
                          <>
                            <p className="mb-2 truncate text-[12px] font-medium text-amber-300/90" title={voteSession.title}>
                              Active: {voteSession.title}
                            </p>
                            <button
                              type="button"
                              className="w-full cursor-pointer rounded-xl border border-red-500/40 bg-red-600/28 py-2.5 text-[13px] font-semibold text-white transition hover:bg-red-600/40"
                              onClick={() => {
                                endMeetingVote()
                                setCallSettingsOpen(false)
                              }}
                            >
                              End vote
                            </button>
                          </>
                        ) : (
                          <>
                            <label className="mb-1 block text-[0.65rem] font-bold uppercase tracking-wider text-white/35">
                              Vote title or question
                            </label>
                            <input
                              type="text"
                              className="mb-2.5 w-full rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-[13px] text-white/90 outline-none placeholder:text-white/28 focus:border-amber-500/45"
                              placeholder="e.g. Approve the new timeline?"
                              maxLength={200}
                              value={voteTitleDraft}
                              onChange={e => setVoteTitleDraft(e.target.value)}
                              aria-label="Vote title or question"
                            />
                            <label className="mb-3 flex cursor-pointer items-start gap-2.5 text-[13px] text-white/80">
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 accent-amber-500"
                                checked={voteAnonymousDraft}
                                onChange={e => setVoteAnonymousDraft(e.target.checked)}
                              />
                              <span>Anonymous (hide who voted; show counts only)</span>
                            </label>
                            <button
                              type="button"
                              className="w-full cursor-pointer rounded-xl border border-amber-500/40 bg-amber-600/30 py-2.5 text-[13px] font-semibold text-white transition hover:border-amber-400/55 hover:bg-amber-600/42"
                              onClick={startMeetingVoteFromDraft}
                            >
                              Start vote
                            </button>
                          </>
                        )}
                        <div className="mt-3 border-t border-white/8 pt-3">
                          <p className="mb-2 text-[11px] leading-snug text-white/48">
                            Votes are stored in the database for this meeting (host can review below).
                          </p>
                          <button
                            type="button"
                            disabled={savedPollsBusy || !code.trim()}
                            onClick={() => void loadSavedPollsForMeeting()}
                            className="w-full cursor-pointer rounded-xl border border-white/12 bg-white/6 py-2 text-[12px] font-semibold text-white/88 transition hover:border-white/18 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            {savedPollsBusy ? 'Loading…' : 'Refresh saved polls'}
                          </button>
                          {savedPollsErr && (
                            <p className="mt-2 text-[12px] text-red-400/90">{savedPollsErr}</p>
                          )}
                          {savedPolls && savedPolls.length === 0 && (
                            <p className="mt-2 text-[12px] text-white/40">No saved polls yet.</p>
                          )}
                          {savedPolls && savedPolls.length > 0 && (
                            <ul className="mt-2 max-h-36 space-y-2 overflow-y-auto text-[12px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15">
                              {savedPolls.map(p => (
                                <li
                                  key={p.id}
                                  className="rounded-lg border border-white/10 bg-white/4 px-2.5 py-2 text-white/85"
                                >
                                  <div className="font-semibold text-white/92">{p.title}</div>
                                  <div className="mt-0.5 text-white/50">
                                    👍 {p.upCount} · 👎 {p.downCount}
                                    {p.active ? ' · Active' : ''}
                                    {' · '}
                                    {formatDate(p.createdAt)}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    )}
                    {isHostInCall && (
                      <div className="border-t border-white/10 pt-4">
                        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Attention</p>
                        <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                          Open People in the call bar to see who likely has this meeting tab visible. Amber means hidden, stale, or quiet. Use Nudge or Message… to show them a private full-screen prompt. This uses tab visibility only — not eye tracking.
                        </p>
                      </div>
                    )}
                    {isHostInCall && (
                      <div className="border-t border-white/10 pt-4">
                        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Agenda &amp; AI check</p>
                        <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                          Host-only: paste your agenda and run an AI check against the meeting transcript saved for this room.
                        </p>
                        <button
                          type="button"
                          className={cx(
                            'w-full cursor-pointer rounded-xl border py-2.5 text-[13px] font-semibold transition',
                            agendaOpen
                              ? 'border-amber-400/50 bg-amber-600/35 text-white'
                              : 'border-white/12 bg-white/8 text-white/90 hover:border-amber-500/40 hover:bg-white/12',
                          )}
                          onClick={() => {
                            setNotesOpen(false)
                            setHostAgentOpen(false)
                            setCallSettingsOpen(false)
                            setAgendaOpen(prev => !prev)
                          }}
                        >
                          {agendaOpen ? 'Close agenda & AI' : 'Open agenda & AI check'}
                        </button>
                      </div>
                    )}
                    {isHostInCall && (
                      <div className="border-t border-white/10 pt-4">
                        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">
                          Host AI stand-in
                        </p>
                        <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                          Free-tier Hugging Face LLM + Whisper STT: paste a knowledge base, pull captions, then ask for a suggested reply. Voice into the room comes later.
                        </p>
                        <button
                          type="button"
                          className={cx(
                            'w-full cursor-pointer rounded-xl border py-2.5 text-[13px] font-semibold transition',
                            hostAgentOpen
                              ? 'border-violet-400/50 bg-violet-600/30 text-white'
                              : 'border-white/12 bg-white/8 text-white/90 hover:border-violet-500/40 hover:bg-white/12',
                          )}
                          onClick={() => {
                            setNotesOpen(false)
                            setAgendaOpen(false)
                            setCallSettingsOpen(false)
                            setHostAgentOpen(prev => !prev)
                          }}
                        >
                          {hostAgentOpen ? 'Close host AI stand-in' : 'Open host AI stand-in'}
                        </button>
                      </div>
                    )}
                    <div className="border-t border-white/10 pt-4">
                      <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Whiteboard</p>
                      <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                        Shared drawing canvas for everyone in the call. Whoever opens it becomes the board owner and can close it or let others collaborate from the board toolbar.
                      </p>
                      <button
                        type="button"
                        disabled={whiteboardOpen && !whiteboardIsOwner}
                        className={cx(
                          'w-full cursor-pointer rounded-xl border py-2.5 text-[13px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45',
                          whiteboardOpen
                            ? 'border-red-500/40 bg-red-600/30 text-white hover:bg-red-600/45'
                            : 'border-white/12 bg-white/8 text-white/90 hover:border-white/20 hover:bg-white/12',
                        )}
                        onClick={() => {
                          if (whiteboardOpen && whiteboardIsOwner) {
                            closeWhiteboard()
                          } else if (!whiteboardOpen) {
                            openWhiteboard()
                          }
                          setCallSettingsOpen(false)
                        }}
                      >
                        {whiteboardOpen
                          ? whiteboardIsOwner
                            ? 'Close whiteboard'
                            : 'Whiteboard active (host can close)'
                          : 'Open whiteboard'}
                      </button>
                    </div>
                    <div className="border-t border-white/10 pt-4">
                      <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Live captions</p>
                      <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                        When this is on, subtitles appear on screen for you, your speech is sent for others to see (with their own setting on), and each finished phrase is saved to the meeting. Host screen recordings include subtitles only while this stays on. Works best in Chrome or Edge.
                      </p>
                      <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-white/85">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/20 accent-amber-500"
                          checked={liveCaptionsEnabled}
                          onChange={e => setLiveCaptionsEnabled(e.target.checked)}
                        />
                        <span>Live captions (CC) — show, share, and save</span>
                      </label>
                      {isHostInCall && (
                        <button
                          type="button"
                          disabled={captionExportBusy || !code.trim()}
                          onClick={() => void downloadSavedCaptions()}
                          className="mt-3 w-full cursor-pointer rounded-xl border border-white/12 bg-white/8 py-2.5 text-[13px] font-semibold text-white/90 transition hover:border-sky-500/35 hover:bg-white/12 disabled:opacity-45"
                        >
                          {captionExportBusy ? 'Preparing…' : 'Download saved transcript (.txt)'}
                        </button>
                      )}
                    </div>
                    {isHostInCall && (
                      <div className="border-t border-white/10 pt-4">
                        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Recording</p>
                        <p className="mb-3 text-[12px] leading-snug text-white/45">
                          Records what is on screen (tiles + your preview) and mixes participant audio. Live subtitles are burned into the video only while Live captions (CC) is enabled above. Stopping uploads the file for you as host.
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
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-3 block text-center text-[12px] font-medium text-amber-400/90 no-underline hover:text-amber-300"
                        >
                          My recordings
                        </Link>
                      </div>
                    )}
                    {!isHostInCall && roomRecordingActive && (
                      <div className="border-t border-white/10 pt-4">
                        <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Recording</p>
                        <p className="flex items-center gap-2 text-[12px] font-medium text-red-400">
                          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />
                          The host is recording this meeting
                        </p>
                      </div>
                    )}
                  </div>
                )}
                {callSettingsTab === 'settings' && (
                  <div role="tabpanel" className="flex flex-col gap-4" aria-label="Settings">
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
                    <div className="border-t border-white/10 pt-4">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Audio devices</p>
                        <button
                          type="button"
                          onClick={() => void enumerateLocalAudioDevices()}
                          className="shrink-0 cursor-pointer rounded-full border border-white/12 bg-white/8 px-2.5 py-1 text-[11px] font-semibold text-white/70 hover:border-white/18 hover:bg-white/12 hover:text-white"
                          title="Refresh device list"
                        >
                          Refresh
                        </button>
                      </div>
                      <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                        Pick which connected mic and speaker to use for this tab. Speaker selection requires a supported browser (Chrome/Edge).
                      </p>

                      <label className="mb-1 block text-[11px] font-semibold text-white/55">Microphone</label>
                      <select
                        value={activeMicDeviceId ?? ''}
                        onChange={e => void switchMicDevice(e.target.value ? e.target.value : null)}
                        onClick={() => void enumerateLocalAudioDevices()}
                        className="w-full cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[13px] font-medium text-white outline-none focus:border-amber-500/45 focus:bg-white/8"
                        aria-label="Microphone device"
                      >
                        <option value="">Default microphone</option>
                        {localMicDevices.map((d, i) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label || `Microphone ${i + 1}`}
                          </option>
                        ))}
                      </select>

                      <label className="mt-3 mb-1 block text-[11px] font-semibold text-white/55">Remote device mic</label>
                      <select
                        value={remoteMicCameraId ?? ''}
                        onChange={e => void switchRemoteMicCamera(e.target.value ? e.target.value : null)}
                        className="w-full cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[13px] font-medium text-white outline-none focus:border-amber-500/45 focus:bg-white/8"
                        aria-label="Remote device microphone"
                      >
                        <option value="">Off (use local mic)</option>
                        {[...remoteCameras.entries()].map(([id, c]) => (
                          <option key={id} value={id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] font-medium text-white/70">
                        <input
                          type="checkbox"
                          checked={monitorRemoteDeviceMic}
                          onChange={e => setMonitorRemoteDeviceMic(e.target.checked)}
                          className="h-4 w-4 cursor-pointer accent-amber-400"
                        />
                        Hear remote device mic on this speaker
                      </label>

                      <label className="mt-3 mb-1 block text-[11px] font-semibold text-white/55">Speaker</label>
                      <select
                        value={activeSpeakerDeviceId ?? ''}
                        onChange={e => void switchSpeakerDevice(e.target.value ? e.target.value : null)}
                        onClick={() => void enumerateLocalAudioDevices()}
                        className="w-full cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[13px] font-medium text-white outline-none focus:border-amber-500/45 focus:bg-white/8"
                        aria-label="Speaker device"
                      >
                        <option value="">Default speaker</option>
                        {localSpeakerDevices.map((d, i) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label || `Speaker ${i + 1}`}
                          </option>
                        ))}
                      </select>

                      <label className="mt-3 mb-1 block text-[11px] font-semibold text-white/55">Send meeting audio to device (speaker)</label>
                      <p className="mb-1.5 text-[11px] leading-snug text-white/35">
                        Sends your mic plus other participants to that phone or tablet so it can play it on its speaker (enable below after the camera connects).
                      </p>
                      <select
                        value={remoteSpeakerCameraId ?? ''}
                        onChange={e => setRemoteSpeakerCameraId(e.target.value ? e.target.value : null)}
                        className="w-full cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[13px] font-medium text-white outline-none focus:border-amber-500/45 focus:bg-white/8"
                        aria-label="Remote device speaker"
                      >
                        <option value="">Off</option>
                        {[...remoteCameras.entries()].map(([id, c]) => (
                          <option key={id} value={id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="border-t border-white/10 pt-4">
                      <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/35">Voice &amp; translation</p>
                      <p className="mb-2.5 text-[12px] leading-snug text-white/45">
                        Language for mic capture in Notes and Agenda (this meeting, this device). You can translate text afterward in those panels.
                      </p>
                      <label htmlFor="call-settings-speech-lang" className="sr-only">
                        Speech language for this meeting
                      </label>
                      <MeetingSpeechLanguageSelect
                        id="call-settings-speech-lang"
                        value={speechLang}
                        onChange={setSpeechLang}
                        className="w-full cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[13px] font-medium text-white outline-none focus:border-amber-500/45 focus:bg-white/8"
                      />
                    </div>
                    <div className="border-t border-white/10 pt-3">
                      <Link
                        to="/settings"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[12px] font-medium text-amber-400/90 no-underline hover:text-amber-300"
                      >
                        App settings &amp; help — opens in new tab
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            </aside>
          )}

          <MeetingNotesPanel
            meetingCode={code}
            meetingTitle={meeting?.title ?? undefined}
            open={notesOpen}
            onClose={() => setNotesOpen(false)}
            speechLang={speechLang}
            onSpeechLangChange={setSpeechLang}
          />

          {isHostInCall && (
            <HostAgendaPanel
              meetingCode={code}
              open={agendaOpen}
              onClose={() => setAgendaOpen(false)}
              speechLang={speechLang}
              onSpeechLangChange={setSpeechLang}
            />
          )}

          {isHostInCall && (
            <HostAgentPanel
              meetingCode={code}
              open={hostAgentOpen}
              onClose={() => setHostAgentOpen(false)}
              speechLang={speechLang}
              onSpeechLangChange={setSpeechLang}
              onSpeakInCall={speakAudioBlobInMeeting}
              onAutopilotConfigChange={(cfg) => {
                hostAgentKbRef.current = cfg.knowledgeBase
                setHostAgentAutopilotEnabled(cfg.enabled)
              }}
            />
          )}

          {callView === 'call' && voteSession && callLocalSocketId && (
            <MeetingVoteOverlay
              title={voteSession.title}
              anonymous={voteSession.anonymous}
              up={voteUp}
              down={voteDown}
              breakdown={voteBreakdown}
              myVote={myVote}
              localPeerId={callLocalSocketId}
              isHost={isHostInCall}
              onVote={submitMeetingVote}
              onEndVote={endMeetingVote}
              gestureStatus={voteGestureStatus}
              cameraOn={camEnabled}
            />
          )}

          {callView === 'call' && (
            <MeetingAttentionWarningModal
              open={attentionWarning !== null}
              fromName={attentionWarning?.fromName ?? ''}
              message={attentionWarning?.message ?? ''}
              onDismiss={() => setAttentionWarning(null)}
            />
          )}

          {callView === 'call' && attentionWarnCompose && (
            <div
              className="fixed inset-0 z-101 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="attention-compose-title"
            >
              <div className="w-full max-w-md rounded-2xl border border-white/12 bg-[#1c1c1e]/98 p-5 shadow-2xl">
                <p id="attention-compose-title" className="text-sm font-semibold text-white">
                  Message for {attentionWarnCompose.name}
                </p>
                <p className="mt-1 text-[12px] text-white/45">They’ll see this with a full-screen attention prompt.</p>
                <textarea
                  className="mt-3 min-h-[88px] w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-white/90 outline-none placeholder:text-white/28 focus:border-amber-500/45"
                  maxLength={400}
                  value={attentionWarnDraft}
                  onChange={e => setAttentionWarnDraft(e.target.value)}
                  placeholder="Optional note…"
                  aria-label="Attention message"
                />
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="cursor-pointer rounded-xl border border-white/14 bg-white/8 px-4 py-2 text-[13px] font-semibold text-white/88 hover:bg-white/12"
                    onClick={() => {
                      setAttentionWarnCompose(null)
                      setAttentionWarnDraft('')
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer rounded-xl border border-amber-500/40 bg-amber-600/35 px-4 py-2 text-[13px] font-semibold text-white hover:bg-amber-600/48"
                    onClick={() => {
                      socketRef.current?.emit('meeting:attention-warn', {
                        userId: attentionWarnCompose.userId,
                        message: attentionWarnDraft,
                      })
                      showToast('Attention message sent')
                      setAttentionWarnCompose(null)
                      setAttentionWarnDraft('')
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
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

          {isHostInCall && (hostJoinRequests.length > 0 || hostLiveCollabRequests.length > 0) && (
            <div
              className="absolute left-1/2 z-40 flex w-[min(360px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-3"
              style={{ bottom: incomingControlReq ? 248 : 90 }}
            >
              {hostJoinRequests[0] && (
                <div className="rounded-[14px] border border-white/14 bg-[#161618]/97 p-4 shadow-2xl backdrop-blur-md">
                  <p className="mb-2 text-[13px] font-bold text-white">Join request</p>
                  <p className="mb-3.5 text-[13px] leading-snug text-white/70">
                    <strong>{hostJoinRequests[0].name}</strong> wants to join this meeting.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="flex-1 cursor-pointer rounded-lg border-0 bg-blue-600 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
                      onClick={() => respondJoinRequest(hostJoinRequests[0]!.requestId, true)}
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      className="flex-1 cursor-pointer rounded-lg border border-white/15 bg-white/7 py-2 text-[13px] font-semibold text-white/75 hover:bg-white/12"
                      onClick={() => respondJoinRequest(hostJoinRequests[0]!.requestId, false)}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              )}
              {hostLiveCollabRequests[0] && (
                <div className="rounded-[14px] border border-amber-500/25 bg-[#161618]/97 p-4 shadow-2xl backdrop-blur-md">
                  <p className="mb-2 text-[13px] font-bold text-white">Broadcast collaboration</p>
                  <p className="mb-3.5 text-[13px] leading-snug text-white/70">
                    <strong>{hostLiveCollabRequests[0].name}</strong> asked to leave the watch page and join this call as a participant.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="flex-1 cursor-pointer rounded-lg border-0 bg-blue-600 py-2 text-[13px] font-semibold text-white hover:bg-blue-700"
                      onClick={() => respondLiveCollabRequest(hostLiveCollabRequests[0]!.requestId, true)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="flex-1 cursor-pointer rounded-lg border border-white/15 bg-white/7 py-2 text-[13px] font-semibold text-white/75 hover:bg-white/12"
                      onClick={() => respondLiveCollabRequest(hostLiveCollabRequests[0]!.requestId, false)}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              )}
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

          {/* Live captions — full-bleed subtitle strip over video, just above bottom controls (z above tiles & side panels) */}
          {liveCaptionsEnabled && (
            <div
              className="pointer-events-none absolute inset-0 z-22 flex flex-col justify-end bg-transparent"
              aria-live="polite"
              role="region"
              aria-label="Live captions"
            >
              <div
                className="w-full px-3 sm:px-5"
                style={{
                  paddingBottom: 'max(5.75rem, calc(4.5rem + env(safe-area-inset-bottom, 0px)))',
                }}
              >
                <div
                  className={cx(
                    'mx-auto w-full max-w-[min(42rem,calc(100vw-1.5rem))] rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5',
                    'border border-white/25 bg-linear-to-br from-white/18 via-white/8 to-white/5',
                    'shadow-[0_8px_32px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.22)]',
                    'backdrop-blur-2xl backdrop-saturate-150 ring-1 ring-white/15',
                  )}
                >
                  {latestCaptionLine ? (
                    <p
                      key={latestCaptionLine.key}
                      className={cx(
                        'text-center text-[13px] leading-relaxed [text-shadow:0_1px_3px_rgba(0,0,0,0.45)] sm:text-[15px]',
                        latestCaptionLine.final ? 'text-white' : 'text-white/75 italic',
                      )}
                    >
                      <span className="font-semibold text-amber-200">{latestCaptionLine.speakerName}</span>
                      <span className="text-white/50"> · </span>
                      <span>{latestCaptionLine.text}</span>
                    </p>
                  ) : (
                    <p className="text-center text-[12px] leading-relaxed text-white/70 sm:text-[13px]">
                      {!micEnabled ? (
                        <>
                          <span className="font-semibold tracking-wide text-amber-200/95">CC</span>
                          {' · '}
                          Unmute your mic so your speech can appear here as subtitles.
                        </>
                      ) : (
                        <>
                          <span className="font-semibold tracking-wide text-amber-200/95">CC</span>
                          {' · '}
                          Speak — your words will show here for everyone (Chrome or Edge works best).
                        </>
                      )}
                    </p>
                  )}
                </div>
              </div>
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
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden>
                  <path
                    fill="white"
                    fillOpacity={0.45}
                    d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"
                  />
                  <path fill="none" stroke="white" strokeWidth="2.25" strokeLinecap="round" d="M4.5 4.5l15 15" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={toggleHandRaise}
              className={cx(
                'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 text-xl transition active:scale-95',
                myHandRaised ? 'bg-amber-500 hover:bg-amber-400' : 'bg-[#3c4043] hover:bg-[#4a4d50]',
              )}
              title={myHandRaised ? 'Lower hand' : 'Raise hand (or show open palm to camera)'}
              aria-pressed={myHandRaised}
            >
              ✋
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
                'flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 transition active:scale-95 max-sm:hidden',
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
            <button type="button" onClick={() => leave()} className="flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border-0 bg-red-500 transition hover:bg-[#d33828] active:scale-95" title="Leave call">
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden className="origin-center rotate-135">
                <path
                  fill="white"
                  d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Camera switcher panel */}
      {callView === 'call' && showCameraPanel && camEnabled && (
        <div className="fixed bottom-[88px] left-1/2 z-110 w-[min(340px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/10 bg-[#1c1c1e]/97 shadow-2xl backdrop-blur-xl sm:bottom-24">
          <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
            <p className="text-[13px] font-semibold text-white/90">Camera Sources</p>
            <button type="button" onClick={() => setShowCameraPanel(false)} className="flex h-6 w-6 items-center justify-center rounded-full bg-white/8 text-xs text-white/60 hover:bg-white/14">✕</button>
          </div>
          <p className="border-b border-white/8 px-4 pb-2.5 text-[11px] leading-snug text-white/45">
            Phones often expose duplicate camera names in the browser. Only one stream is sent at a time, and the OS may allow just one or two physical cameras to be active.
          </p>
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
                <div
                  key={cameraId}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-[13px] transition',
                    isActive
                      ? 'border-amber-500/40 bg-amber-500/12 text-white'
                      : 'border-white/8 bg-white/4 text-white/70 hover:border-white/14 hover:bg-white/8',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void switchCamera(sid)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
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

                  <button
                    type="button"
                    disabled={!ready}
                    title={ready ? 'Hold to send host audio to this device' : 'Waiting for device media…'}
                    onPointerDown={e => {
                      e.stopPropagation()
                      ;(e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId)
                      setRemoteSpeakerCameraId(cameraId)
                    }}
                    onPointerUp={e => {
                      e.stopPropagation()
                      if (remoteSpeakerCameraIdRef.current === cameraId) setRemoteSpeakerCameraId(null)
                    }}
                    onPointerCancel={e => {
                      e.stopPropagation()
                      if (remoteSpeakerCameraIdRef.current === cameraId) setRemoteSpeakerCameraId(null)
                    }}
                    className={cx(
                      'shrink-0 rounded-lg border px-2.5 py-2 text-[11px] font-semibold transition select-none',
                      !ready
                        ? 'cursor-not-allowed border-white/8 bg-white/4 text-white/35'
                        : remoteSpeakerCameraId === cameraId
                          ? 'border-sky-300/50 bg-sky-300/15 text-sky-100'
                          : 'border-white/12 bg-black/25 text-white/75 hover:border-white/18 hover:bg-black/35',
                    )}
                    aria-label="Hold to send audio to device"
                  >
                    Hold
                  </button>
                </div>
              )
            })}
          </div>
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
        </div>
      )}

      {/* Camera share URL modal */}
      {callView === 'call' && cameraShareUrl && (
        <div className="fixed inset-0 z-120 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setCameraShareUrl(null)}>
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
