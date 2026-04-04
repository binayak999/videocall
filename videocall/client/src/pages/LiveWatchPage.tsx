import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'
import { errorMessage, getMeeting } from '../lib/api'
import { defaultSignalingUrl } from '../lib/signalingUrl'
import { getToken } from '../lib/auth'
import { getIceServers, rtcConfiguration } from '../lib/ice'
import { MeetingVoteOverlay, type MeetingVoteChoice } from '../components/MeetingVoteOverlay'
import { ShellBackgroundLayer } from '../components/ShellBackgroundLayer'
import { useAuthToken } from '../lib/useAuthToken'
import {
  captionLinesFromHistory,
  mergeCaptionMessage,
  type CaptionLine,
} from '../lib/meetingCaptions'
import type { Meeting } from '../lib/types'

interface ChatRow {
  id: string
  senderId: string
  senderUserId?: string
  senderName?: string
  text: string
  createdAt: string
}

function formatChatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

const inputChatClass =
  'min-w-0 flex-1 rounded-xl border border-(--nexivo-input-border) bg-(--nexivo-input-bg) px-3 py-2 text-sm text-(--nexivo-text) outline-none transition placeholder:text-(--nexivo-placeholder) focus:border-[#f59e0b]/45 focus:ring-1 focus:ring-[#f59e0b]/25'

export function LiveWatchPage() {
  const { code: rawCode } = useParams()
  const code = (rawCode ?? '').trim()
  const navigate = useNavigate()
  const authToken = useAuthToken()

  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [meetErr, setMeetErr] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState('Connecting…')
  const [streamLive, setStreamLive] = useState<boolean | null>(null)
  const [videoMuted, setVideoMuted] = useState(true)
  /** Host screen share should not be mirrored (same rule as in-meeting tiles). */
  const [hostScreenSharing, setHostScreenSharing] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const socketRef = useRef<Socket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const liveWatchPendingIceRef = useRef<RTCIceCandidateInit[]>([])
  const liveWatchRemoteReadyRef = useRef(false)
  const liveWatchStuckTimerRef = useRef<number | null>(null)
  const liveWatchDiscTimerRef = useRef<number | null>(null)
  const liveWatchLastReofferRef = useRef(0)
  const hostPeerIdRef = useRef<string | null>(null)
  const mySocketIdRef = useRef('')
  const activeVoteSessionIdRef = useRef<string | null>(null)

  const [chatMessages, setChatMessages] = useState<ChatRow[]>([])
  const [chatDraft, setChatDraft] = useState('')
  const [captionLines, setCaptionLines] = useState<CaptionLine[]>([])

  const [localSocketId, setLocalSocketId] = useState('')
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
  const [collabPending, setCollabPending] = useState(false)
  const [collabBusy, setCollabBusy] = useState(false)
  const [watchToast, setWatchToast] = useState<string | null>(null)
  const watchToastTimerRef = useRef<number | null>(null)

  const canInteract = Boolean(authToken)
  const loginRedirect = `/login?redirect=${encodeURIComponent(`/watch/${encodeURIComponent(code)}`)}`

  const showWatchToast = useCallback((msg: string) => {
    setWatchToast(msg)
    if (watchToastTimerRef.current != null) window.clearTimeout(watchToastTimerRef.current)
    watchToastTimerRef.current = window.setTimeout(() => setWatchToast(null), 4200)
  }, [])

  const teardownPc = useCallback(() => {
    if (liveWatchStuckTimerRef.current != null) {
      window.clearTimeout(liveWatchStuckTimerRef.current)
      liveWatchStuckTimerRef.current = null
    }
    if (liveWatchDiscTimerRef.current != null) {
      window.clearTimeout(liveWatchDiscTimerRef.current)
      liveWatchDiscTimerRef.current = null
    }
    pcRef.current?.close()
    pcRef.current = null
    liveWatchPendingIceRef.current = []
    liveWatchRemoteReadyRef.current = false
    setHostScreenSharing(false)
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const applyJoinPayload = useCallback((a: Record<string, unknown>) => {
    mySocketIdRef.current = socketRef.current?.id ?? ''
    hostPeerIdRef.current = typeof a.hostPeerId === 'string' ? a.hostPeerId : null

    const ch = Array.isArray(a.chatHistory)
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
          ) {
            return []
          }
          return [
            {
              id: row.id,
              senderId: row.senderUserId,
              senderUserId: row.senderUserId,
              senderName: row.senderName,
              text: row.text,
              createdAt: row.createdAt,
            },
          ]
        })
      : []
    setChatMessages(ch)

    const capHist = Array.isArray(a.captionHistory)
      ? captionLinesFromHistory(
          (a.captionHistory as unknown[]).flatMap(item => {
            if (!item || typeof item !== 'object') return []
            const c = item as {
              speakerUserId?: unknown
              speakerName?: unknown
              text?: unknown
              createdAt?: unknown
            }
            if (
              typeof c.speakerUserId !== 'string' ||
              typeof c.speakerName !== 'string' ||
              typeof c.text !== 'string' ||
              typeof c.createdAt !== 'string'
            ) {
              return []
            }
            const id = `${c.createdAt}-${c.speakerUserId}`
            return [
              {
                id,
                speakerUserId: c.speakerUserId,
                speakerName: c.speakerName,
                text: c.text,
                createdAt: c.createdAt,
              },
            ]
          }),
        )
      : []
    setCaptionLines(capHist)

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
          const self = rows.find(r => r.peerId === mySocketIdRef.current)
          setMyVote(self ? self.choice : (typeof a.myVote === 'string' && (a.myVote === 'up' || a.myVote === 'down') ? a.myVote : null))
        } else {
          setVoteBreakdown(null)
          setMyVote(typeof a.myVote === 'string' && (a.myVote === 'up' || a.myVote === 'down') ? a.myVote : null)
        }
      }
    } else {
      activeVoteSessionIdRef.current = null
      setVoteSession(null)
      setVoteUp(0)
      setVoteDown(0)
      setVoteBreakdown(null)
      setMyVote(null)
    }
  }, [])

  useEffect(() => {
    if (code.length === 0) return
    let cancelled = false
    void (async () => {
      try {
        const r = await getMeeting(code)
        if (!cancelled) setMeeting(r.meeting)
      } catch (e: unknown) {
        if (!cancelled) setMeetErr(errorMessage(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code])

  useEffect(() => {
    if (code.length === 0) return

    let cancelled = false
    const socketAuth: Record<string, string> = { liveWatchCode: code }
    const t = getToken()
    if (t) socketAuth.token = t

    void (async () => {
      try {
        const ice = await getIceServers()
        if (cancelled) return

        const socket = io(defaultSignalingUrl(), {
          auth: socketAuth,
          transports: ['polling', 'websocket'],
        })
        socketRef.current = socket

        const requestLiveWatchReoffer = () => {
          if (!socket.connected || cancelled) return
          const now = Date.now()
          if (now - liveWatchLastReofferRef.current < 8_000) return
          liveWatchLastReofferRef.current = now
          socket.emit('live:viewer-request-reoffer')
        }

        const flushLiveWatchIce = (pc: RTCPeerConnection) => {
          const q = liveWatchPendingIceRef.current
          liveWatchPendingIceRef.current = []
          for (const c of q) {
            void pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})
          }
        }

        const armLiveWatchStuckTimer = () => {
          if (liveWatchStuckTimerRef.current != null) {
            window.clearTimeout(liveWatchStuckTimerRef.current)
          }
          liveWatchStuckTimerRef.current = window.setTimeout(() => {
            liveWatchStuckTimerRef.current = null
            if (cancelled) return
            const p = pcRef.current
            if (!p) return
            const iceSt = p.iceConnectionState
            if (iceSt !== 'connected' && iceSt !== 'completed') {
              setStatusLine('Still connecting — trying another path…')
              requestLiveWatchReoffer()
            }
          }, 22_000)
        }

        const ensurePc = () => {
          if (pcRef.current) return pcRef.current
          liveWatchRemoteReadyRef.current = false
          const pc = new RTCPeerConnection(rtcConfiguration(ice))
          pc.addTransceiver('audio', { direction: 'recvonly' })
          pc.addTransceiver('video', { direction: 'recvonly' })
          pc.ontrack = ev => {
            const v = videoRef.current
            if (!v) return
            const s = ev.streams[0] ?? new MediaStream([ev.track])
            v.srcObject = s
            void v.play().catch(() => {})
            if (ev.track.kind === 'video') {
              const hint = ev.track.contentHint
              if (hint === 'detail') setHostScreenSharing(true)
              else if (hint === 'motion') setHostScreenSharing(false)
            }
          }
          pc.onicecandidate = ev => {
            const hp = hostPeerIdRef.current
            if (ev.candidate && hp && socket.connected) {
              socket.emit('webrtc:ice', { to: hp, candidate: ev.candidate.toJSON() })
            }
          }
          pc.onconnectionstatechange = () => {
            if (cancelled) return
            const s = pc.connectionState
            if (s === 'failed') {
              setStatusLine('Network issue — retrying media…')
              requestLiveWatchReoffer()
            } else if (s === 'disconnected') {
              if (liveWatchDiscTimerRef.current != null) {
                window.clearTimeout(liveWatchDiscTimerRef.current)
              }
              liveWatchDiscTimerRef.current = window.setTimeout(() => {
                liveWatchDiscTimerRef.current = null
                if (cancelled) return
                const p = pcRef.current
                if (!p) return
                if (p.connectionState === 'disconnected' || p.connectionState === 'failed') {
                  setStatusLine('Reconnecting stream…')
                  requestLiveWatchReoffer()
                }
              }, 3_500)
            } else if (s === 'connected') {
              if (liveWatchDiscTimerRef.current != null) {
                window.clearTimeout(liveWatchDiscTimerRef.current)
                liveWatchDiscTimerRef.current = null
              }
              setStatusLine('Connected')
            }
          }
          pc.oniceconnectionstatechange = () => {
            if (cancelled) return
            const iceSt = pc.iceConnectionState
            if (iceSt === 'connected' || iceSt === 'completed') {
              if (liveWatchStuckTimerRef.current != null) {
                window.clearTimeout(liveWatchStuckTimerRef.current)
                liveWatchStuckTimerRef.current = null
              }
              return
            }
            if (iceSt === 'failed') requestLiveWatchReoffer()
          }
          pcRef.current = pc
          return pc
        }

        socket.on('connect', () => {
          const sid = socket.id ?? ''
          mySocketIdRef.current = sid
          setLocalSocketId(sid)
          socket.emit('live:join', code, (ack: unknown) => {
            if (cancelled) return
            if (!ack || typeof ack !== 'object') {
              setStatusLine('Could not join live stream')
              return
            }
            const a = ack as Record<string, unknown>
            if (a.ok !== true) {
              const msg = typeof a.error === 'string' ? a.error : 'Join failed'
              setStatusLine(msg)
              if (a.streamLive === false) setStreamLive(false)
              else if (a.streamLive === true) setStreamLive(true)
              else setStreamLive(null)
              return
            }
            setStreamLive(true)
            setStatusLine('Connected')
            mySocketIdRef.current = socket.id ?? ''
            applyJoinPayload(a)
            const hp = typeof a.hostPeerId === 'string' ? a.hostPeerId : null
            hostPeerIdRef.current = hp
            setHostScreenSharing(false)
            if (!hp) return
            ensurePc()
          })
        })

        socket.on('meeting:screenshare', (payload: unknown) => {
          if (!payload || typeof payload !== 'object') return
          const { peerId, sharing } = payload as { peerId?: unknown; sharing?: unknown }
          if (typeof peerId !== 'string' || typeof sharing !== 'boolean') return
          if (peerId !== hostPeerIdRef.current) return
          setHostScreenSharing(sharing)
        })

        socket.on('webrtc:offer', async (msg: unknown) => {
          if (!msg || typeof msg !== 'object') return
          const { from, sdp } = msg as { from?: unknown; sdp?: unknown }
          if (typeof from !== 'string' || !sdp || typeof sdp !== 'object') return
          if (from !== hostPeerIdRef.current) return
          const pc = ensurePc()
          try {
            liveWatchRemoteReadyRef.current = false
            await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            liveWatchRemoteReadyRef.current = true
            flushLiveWatchIce(pc)
            armLiveWatchStuckTimer()
            const local = pc.localDescription?.toJSON()
            if (local && socket.connected) {
              socket.emit('webrtc:answer', { to: from, sdp: local })
            }
          } catch {
            liveWatchRemoteReadyRef.current = false
          }
        })

        socket.on('webrtc:ice', async (msg: unknown) => {
          if (!msg || typeof msg !== 'object') return
          const { from, candidate } = msg as { from?: unknown; candidate?: unknown }
          if (typeof from !== 'string' || !candidate || typeof candidate !== 'object') return
          if (from !== hostPeerIdRef.current) return
          const init = candidate as RTCIceCandidateInit
          const pc = pcRef.current
          if (!pc) {
            liveWatchPendingIceRef.current.push(init)
            return
          }
          if (!liveWatchRemoteReadyRef.current) {
            liveWatchPendingIceRef.current.push(init)
            return
          }
          await pc.addIceCandidate(new RTCIceCandidate(init)).catch(() => {})
        })

        socket.on('meeting:chat-rejected', (payload: unknown) => {
          const p = payload && typeof payload === 'object' ? payload as { reason?: unknown } : {}
          showWatchToast(
            typeof p.reason === 'string' ? p.reason : 'Message not sent — keep chat respectful.',
          )
        })

        socket.on('live:collab-approved', (payload: unknown) => {
          const p = payload && typeof payload === 'object' ? payload as { meetingCode?: unknown } : {}
          const mc = typeof p.meetingCode === 'string' && p.meetingCode.trim().length > 0 ? p.meetingCode : code
          setCollabPending(false)
          showWatchToast('Host accepted — joining the meeting…')
          socket.disconnect()
          navigate(`/m/${encodeURIComponent(mc)}`, { state: { afterCollabApprove: true } })
        })

        socket.on('live:collab-denied', (payload: unknown) => {
          setCollabPending(false)
          const p = payload && typeof payload === 'object' ? payload as { message?: unknown } : {}
          showWatchToast(typeof p.message === 'string' ? p.message : 'The host declined your request.')
        })

        socket.on('meeting:chat', (payload: unknown) => {
          if (!payload || typeof payload !== 'object') return
          const p = payload as {
            id?: unknown
            senderId?: unknown
            senderUserId?: unknown
            senderName?: unknown
            text?: unknown
            createdAt?: unknown
          }
          if (
            typeof p.id !== 'string' ||
            typeof p.senderId !== 'string' ||
            typeof p.text !== 'string' ||
            typeof p.createdAt !== 'string'
          ) {
            return
          }
          const row: ChatRow = {
            id: p.id,
            senderId: p.senderId,
            senderUserId: typeof p.senderUserId === 'string' ? p.senderUserId : undefined,
            senderName: typeof p.senderName === 'string' ? p.senderName : undefined,
            text: p.text,
            createdAt: p.createdAt,
          }
          setChatMessages(prev => [...prev, row])
        })

        socket.on('meeting:caption', (payload: unknown) => {
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
          const text = p.text
          const interim = p.interim
          setCaptionLines(prev =>
            mergeCaptionMessage(prev, {
              speakerUserId,
              speakerName,
              text,
              interim,
              id: typeof p.id === 'string' ? p.id : undefined,
              createdAt: typeof p.createdAt === 'string' ? p.createdAt : undefined,
            }),
          )
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

        socket.on('meeting:vote-ended', () => {
          activeVoteSessionIdRef.current = null
          setVoteSession(null)
          setVoteUp(0)
          setVoteDown(0)
          setVoteBreakdown(null)
          setMyVote(null)
        })

        socket.on('meeting:live-state', (payload: unknown) => {
          const live =
            payload != null &&
            typeof payload === 'object' &&
            (payload as { live?: unknown }).live === true
          setStreamLive(live)
          if (!live) {
            setStatusLine('Live stream paused by host')
            teardownPc()
            hostPeerIdRef.current = null
            return
          }

          // Host restarted the broadcast. Re-join to receive a fresh host peerId and trigger a new offer.
          if (!socket.connected || cancelled) return
          setStatusLine('Live stream resumed — reconnecting…')
          socket.emit('live:join', code, (ack: unknown) => {
            if (cancelled) return
            if (!ack || typeof ack !== 'object') {
              setStatusLine('Could not re-join live stream')
              return
            }
            const a = ack as Record<string, unknown>
            if (a.ok !== true) {
              const msg = typeof a.error === 'string' ? a.error : 'Re-join failed'
              setStatusLine(msg)
              if (a.streamLive === false) setStreamLive(false)
              else if (a.streamLive === true) setStreamLive(true)
              else setStreamLive(null)
              return
            }
            setStreamLive(true)
            mySocketIdRef.current = socket.id ?? ''
            applyJoinPayload(a)
            const hp = typeof a.hostPeerId === 'string' ? a.hostPeerId : null
            hostPeerIdRef.current = hp
            setHostScreenSharing(false)
            if (!hp) return
            ensurePc()
            requestLiveWatchReoffer()
          })
        })

        socket.on('disconnect', () => {
          setStatusLine('Disconnected')
          setLocalSocketId('')
          setCollabPending(false)
          setCollabBusy(false)
          teardownPc()
        })
      } catch {
        if (!cancelled) setStatusLine('Could not load network settings')
      }
    })()

    return () => {
      cancelled = true
      teardownPc()
      socketRef.current?.disconnect()
      socketRef.current = null
    }
  }, [code, authToken, applyJoinPayload, teardownPc, navigate, showWatchToast])

  function requestBroadcastCollab() {
    if (!canInteract || !socketRef.current?.connected) return
    setCollabBusy(true)
    socketRef.current.emit('live:collab-request', (ack: unknown) => {
      setCollabBusy(false)
      if (!ack || typeof ack !== 'object') {
        showWatchToast('Could not send request')
        return
      }
      const a = ack as Record<string, unknown>
      if (a.ok !== true) {
        showWatchToast(typeof a.error === 'string' ? a.error : 'Request failed')
        return
      }
      setCollabPending(true)
      showWatchToast('Request sent — waiting for the host')
    })
  }

  function sendChat(e: React.FormEvent) {
    e.preventDefault()
    if (!canInteract) return
    const t = chatDraft.trim()
    if (t.length === 0) return
    socketRef.current?.emit('meeting:chat', { text: t })
    setChatDraft('')
  }

  function submitVote(choice: MeetingVoteChoice) {
    if (!canInteract) return
    const sid = activeVoteSessionIdRef.current
    if (!sid) return
    socketRef.current?.emit('meeting:vote-submit', { sessionId: sid, choice })
    setMyVote(choice)
  }

  const latestCaption = captionLines.length > 0 ? captionLines[captionLines.length - 1]! : null

  if (code.length === 0) {
    return (
      <div
        className="live-watch-root fixed inset-0 flex items-center justify-center px-4"
        style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
      >
        <ShellBackgroundLayer />
        <div className="relative z-10 max-w-sm rounded-[22px] border border-(--nexivo-border-subtle) bg-(--nexivo-panel) px-8 py-10 text-center shadow-lg backdrop-blur-xl">
          <p className="text-sm font-medium text-(--nexivo-text)">Invalid watch link</p>
          <Link
            to="/"
            className="mt-5 inline-flex items-center justify-center rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-amber-400"
          >
            Back to home
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div
      className="live-watch-root nexivo-chrome-root fixed inset-0 flex flex-col overflow-hidden text-(--nexivo-text)"
      style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
    >
      <ShellBackgroundLayer />

      {watchToast && (
        <div
          className="pointer-events-none fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-60 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-(--nexivo-toast-border) bg-(--nexivo-toast-bg) px-4 py-3 text-center text-sm text-(--nexivo-text-secondary) shadow-xl backdrop-blur-xl"
          role="status"
        >
          {watchToast}
        </div>
      )}

      <div className="relative z-20 mx-auto w-full max-w-8xl shrink-0 px-3 pt-3 sm:px-6 sm:pt-4">
        <header
          className="rounded-[22px] border border-(--nexivo-border-subtle) bg-(--nexivo-panel) shadow-sm backdrop-blur-xl"
          aria-label="Live broadcast"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:gap-4 sm:px-5 sm:py-4">
            <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center sm:gap-5">
              <Link to="/" className="shrink-0 rounded-xl opacity-95 transition hover:opacity-100" aria-label="Nexivo home">
                <img src="/nexivo_logo.svg" alt="Nexivo" className="h-9 w-auto sm:h-11" draggable={false} />
              </Link>
              <div className="hidden h-10 w-px shrink-0 bg-(--nexivo-border-subtle) sm:block" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cx(
                      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                      streamLive === true
                        ? 'border-red-500/35 bg-red-500/15 text-red-200'
                        : 'border-(--nexivo-border) bg-(--nexivo-muted-surface) text-(--nexivo-text-muted)',
                    )}
                  >
                    {streamLive === true ? (
                      <>
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]" />
                        Live
                      </>
                    ) : (
                      'Off air'
                    )}
                  </span>
                  <h1 className="truncate text-sm font-semibold text-(--nexivo-text) sm:text-base">
                    {meeting?.title?.trim() || `Broadcast · ${code}`}
                  </h1>
                </div>
                <p className="mt-0.5 text-[11px] text-(--nexivo-text-muted)">{statusLine}</p>
                {!canInteract ? (
                  <p className="mt-1.5 max-w-xl text-[10px] leading-relaxed text-(--nexivo-text-subtle)">
                    Watch free — no account needed. Log in only to comment, react, vote, or ask to join the broadcast.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
              {!canInteract ? (
                <>
                  <Link
                    to={loginRedirect}
                    className="rounded-xl border border-amber-500/40 bg-linear-to-b from-amber-400 to-amber-600 px-3 py-2 text-xs font-semibold text-neutral-900 shadow-sm hover:from-amber-300 hover:to-amber-500"
                  >
                    Log in to comment
                  </Link>
                  <Link
                    to={`/register?redirect=${encodeURIComponent(`/watch/${encodeURIComponent(code)}`)}`}
                    className="rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) px-3 py-2 text-xs font-semibold text-(--nexivo-text-secondary) transition hover:bg-(--nexivo-nav-hover)"
                  >
                    Create account
                  </Link>
                </>
              ) : null}
              <Link
                to={`/m/${encodeURIComponent(code)}`}
                className="rounded-xl border border-(--nexivo-border-subtle) px-3 py-2 text-[11px] font-medium text-(--nexivo-text-muted) transition hover:border-(--nexivo-border) hover:text-(--nexivo-text-secondary)"
                title="Open the full meeting room if you were invited (camera, mic, and full features)."
              >
                Full meeting
              </Link>
              {canInteract && streamLive === true && (
                <button
                  type="button"
                  disabled={collabBusy || collabPending}
                  onClick={requestBroadcastCollab}
                  className="rounded-xl border border-sky-500/35 bg-sky-500/15 px-3 py-2 text-xs font-semibold text-sky-100 hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {collabPending ? 'Waiting for host…' : collabBusy ? 'Sending…' : 'Ask to join broadcast'}
                </button>
              )}
            </div>
          </div>
        </header>

        {meetErr ? (
          <p
            className="mt-3 rounded-[22px] border border-red-500/25 bg-red-500/10 px-4 py-3 text-center text-sm text-red-300 backdrop-blur-sm"
            role="alert"
          >
            {meetErr}
          </p>
        ) : null}
      </div>

      <div className="relative z-10 mx-auto flex min-h-0 w-full max-w-8xl flex-1 flex-col gap-4 overflow-hidden px-3 pb-4 pt-2 sm:px-6 lg:flex-row lg:items-stretch lg:gap-5 lg:pb-6 lg:pt-3">
        <section
          className="relative flex min-h-[min(58dvh,720px)] flex-1 flex-col overflow-hidden rounded-[22px] border border-(--nexivo-border-subtle) bg-(--nexivo-panel) shadow-sm backdrop-blur-xl lg:min-h-0 lg:flex-[1.35_1_0%]"
          aria-label="Live video"
        >
          <div className="relative isolate min-h-0 flex-1 overflow-hidden bg-black">
            <div
              className="pointer-events-none absolute inset-0 bg-linear-to-b from-[#12121a]/90 via-black to-black"
              aria-hidden
            />
            <div
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_45%,transparent_20%,rgba(0,0,0,0.65)_100%)]"
              aria-hidden
            />
            <video
              ref={videoRef}
              playsInline
              autoPlay
              muted={videoMuted}
              className={cx(
                'absolute inset-0 z-1 h-full w-full object-cover shadow-2xl ring-1 ring-white/10',
                !hostScreenSharing && '-scale-x-100',
              )}
            />
            {videoMuted && streamLive !== false && (
              <button
                type="button"
                className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-(--nexivo-border) bg-(--nexivo-panel-solid)/95 px-6 py-3 text-sm font-semibold text-(--nexivo-text) shadow-xl backdrop-blur-xl transition hover:border-[#f59e0b]/40 hover:ring-2 hover:ring-[#f59e0b]/20"
                onClick={() => setVideoMuted(false)}
              >
                Tap for sound
              </button>
            )}
            {streamLive === false && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-(--nexivo-dialog-scrim) px-6 text-center backdrop-blur-sm">
                <div className="max-w-md rounded-2xl border border-(--nexivo-border-subtle) bg-(--nexivo-panel) px-6 py-8 shadow-xl backdrop-blur-xl">
                  <p className="text-sm font-medium text-(--nexivo-text)">The host hasn’t started the public stream yet.</p>
                  <p className="mt-2 text-xs leading-relaxed text-(--nexivo-text-muted)">
                    Open this page again after they go live from the meeting, or refresh below.
                  </p>
                  <button
                    type="button"
                    className="mt-6 rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) px-5 py-2.5 text-xs font-semibold text-(--nexivo-text) transition hover:bg-(--nexivo-nav-hover)"
                    onClick={() => window.location.reload()}
                  >
                    Refresh
                  </button>
                </div>
              </div>
            )}
            {latestCaption && latestCaption.text.trim().length > 0 && (
              <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-5 rounded-2xl border border-(--nexivo-border-subtle) bg-(--nexivo-panel-solid)/92 px-4 py-3 text-center shadow-lg backdrop-blur-xl">
                <span className="text-[11px] font-semibold text-[#fbbf24]">{latestCaption.speakerName}</span>
                <p className="mt-1 text-sm leading-snug text-(--nexivo-text)">{latestCaption.text}</p>
              </div>
            )}
          </div>
        </section>

        <aside
          className="flex h-[min(36vh,320px)] w-full shrink-0 flex-col overflow-hidden rounded-[22px] border border-(--nexivo-border-subtle) bg-(--nexivo-panel) shadow-sm backdrop-blur-xl lg:h-auto lg:min-h-0 lg:max-w-md xl:max-w-lg"
          aria-label="Live chat"
        >
          <div className="border-b border-(--nexivo-border-subtle) px-4 py-3">
            <p className="text-[0.65rem] font-bold uppercase tracking-wider text-(--nexivo-nav-label)">Live chat</p>
            <p className="mt-1.5 text-[10px] leading-relaxed text-(--nexivo-text-subtle)">
              Anyone can read. Sending requires an account. Be respectful — harassment and slurs are blocked.
            </p>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2 text-left text-sm [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-(--nexivo-scroll-thumb)">
            {chatMessages.length === 0 ? (
              <p className="py-8 text-center text-xs text-(--nexivo-text-subtle)">No messages yet</p>
            ) : (
              chatMessages.map(m => (
                <div
                  key={m.id}
                  className="rounded-xl border border-(--nexivo-border-subtle) bg-(--nexivo-muted-surface) px-3 py-2"
                >
                  <div className="flex justify-between gap-2 text-[10px] text-(--nexivo-text-muted)">
                    <span className="font-medium text-(--nexivo-text-secondary)">{m.senderName ?? 'Someone'}</span>
                    <time>{formatChatTime(m.createdAt)}</time>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-snug text-(--nexivo-text)">{m.text}</p>
                </div>
              ))
            )}
          </div>
          {canInteract ? (
            <form className="border-t border-(--nexivo-border-subtle) p-3" onSubmit={sendChat}>
              <div className="flex gap-2">
                <input
                  value={chatDraft}
                  onChange={e => setChatDraft(e.target.value)}
                  placeholder="Message everyone…"
                  maxLength={500}
                  className={inputChatClass}
                />
                <button
                  type="submit"
                  className="shrink-0 rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-neutral-900 shadow-sm hover:bg-amber-400"
                >
                  Send
                </button>
              </div>
            </form>
          ) : (
            <div className="border-t border-(--nexivo-border-subtle) p-4 text-center text-xs text-(--nexivo-text-muted)">
              <p className="mb-2 text-[11px] text-(--nexivo-text-subtle)">You’re watching as a guest.</p>
              <Link to={loginRedirect} className="font-semibold text-(--nexivo-link) hover:underline">
                Log in
              </Link>{' '}
              or{' '}
              <Link
                to={`/register?redirect=${encodeURIComponent(`/watch/${encodeURIComponent(code)}`)}`}
                className="font-semibold text-(--nexivo-link) hover:underline"
              >
                create an account
              </Link>{' '}
              to comment, react, vote, or ask to join the broadcast.
            </div>
          )}
        </aside>
      </div>

      {voteSession && localSocketId ? (
        canInteract ? (
          <MeetingVoteOverlay
            title={voteSession.title}
            anonymous={voteSession.anonymous}
            up={voteUp}
            down={voteDown}
            breakdown={voteBreakdown}
            myVote={myVote}
            localPeerId={localSocketId}
            isHost={false}
            onVote={submitVote}
            onEndVote={() => {}}
            gestureStatus="off"
            cameraOn={false}
          />
        ) : (
          <div className="pointer-events-auto fixed bottom-[calc(5.75rem+env(safe-area-inset-bottom,0px))] left-1/2 z-30 w-[min(360px,calc(100vw-28px))] -translate-x-1/2 rounded-2xl border border-(--nexivo-border-subtle) bg-(--nexivo-panel-solid)/95 px-4 py-4 text-center shadow-2xl backdrop-blur-xl sm:bottom-[calc(6.25rem+env(safe-area-inset-bottom,0px))]">
            <p className="text-sm font-medium text-(--nexivo-text)">The host is running a vote.</p>
            <p className="mt-1 text-[11px] text-(--nexivo-text-muted)">Log in to cast your vote — watching stays free.</p>
            <Link
              to={loginRedirect}
              className="mt-3 inline-block rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-amber-400"
            >
              Log in to vote
            </Link>
          </div>
        )
      ) : null}
    </div>
  )
}
