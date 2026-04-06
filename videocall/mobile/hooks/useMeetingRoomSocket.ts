import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { getUserIdFromToken } from '../lib/jwtProfile'
import type { ParsedJoinPayload } from '../lib/meetingJoinPayload'
import type {
  ChatMessage,
  JoinRequest,
  LiveCollabRequest,
  RosterEntry,
  VoteBreakdownRow,
  VoteChoice,
  VoteSession,
} from '../lib/meetingTypes'

export type { ChatMessage, RosterEntry, VoteChoice, VoteSession, VoteBreakdownRow } from '../lib/meetingTypes'

export function useMeetingRoomSocket(
  socket: Socket | null,
  authToken: string,
  opts?: {
    onHostMicMuted?: (muted: boolean) => void
    initialJoin?: ParsedJoinPayload | null
    meetingHostUserId?: string
  },
) {
  const myUserId = useMemo(() => getUserIdFromToken(authToken), [authToken])
  const mySocketIdRef = useRef<string | null>(null)
  const [mySocketId, setMySocketId] = useState<string | null>(null)
  const onHostMicMutedRef = useRef(opts?.onHostMicMuted)
  onHostMicMutedRef.current = opts?.onHostMicMuted

  const init = opts?.initialJoin
  const [roster, setRoster] = useState<Record<string, RosterEntry>>(() => init?.roster ?? {})
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => init?.chatMessages ?? [])
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([])
  const [liveCollabRequests, setLiveCollabRequests] = useState<LiveCollabRequest[]>([])
  const [handRaisedByPeerId, setHandRaisedByPeerId] = useState<Record<string, boolean>>(() => {
    if (!init?.handRaisedPeerIds?.length) return {}
    const o: Record<string, boolean> = {}
    for (const id of init.handRaisedPeerIds) o[id] = true
    return o
  })
  const [myHandRaised, setMyHandRaised] = useState(false)
  const [roomRecordingActive, setRoomRecordingActive] = useState(init?.roomRecordingActive ?? false)
  const [voteSession, setVoteSession] = useState<VoteSession | null>(null)
  const [voteUp, setVoteUp] = useState(0)
  const [voteDown, setVoteDown] = useState(0)
  const [voteBreakdown, setVoteBreakdown] = useState<VoteBreakdownRow[] | null>(null)
  const [myVote, setMyVote] = useState<VoteChoice | null>(null)
  const activeVoteSessionIdRef = useRef<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [hostPeerId, setHostPeerId] = useState<string | null>(init?.hostPeerId ?? null)
  const [meetingHostUserId, setMeetingHostUserId] = useState<string | null>(opts?.meetingHostUserId ?? null)

  useEffect(() => {
    if (opts?.meetingHostUserId) setMeetingHostUserId(opts.meetingHostUserId)
  }, [opts?.meetingHostUserId])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3200)
  }, [])

  const pushChat = useCallback((m: ChatMessage) => {
    setChatMessages((prev) => {
      if (m.id && prev.some((x) => x.id === m.id)) return prev
      return [...prev, m]
    })
  }, [])

  useEffect(() => {
    if (!socket) return
    const syncId = () => {
      const id = socket.id ?? null
      mySocketIdRef.current = id
      setMySocketId(id)
    }
    socket.on('connect', syncId)
    syncId()
    return () => {
      socket.off('connect', syncId)
    }
  }, [socket])

  useEffect(() => {
    if (!socket) return

    const onPeerJoined = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { peerId?: unknown; userName?: unknown; userId?: unknown; userEmail?: unknown }
      const peerId = p.peerId
      if (typeof peerId !== 'string') return
      if (peerId === mySocketIdRef.current) return
      const userName = typeof p.userName === 'string' ? p.userName : 'Guest'
      const userId = typeof p.userId === 'string' ? p.userId : ''
      const userEmail = typeof p.userEmail === 'string' ? p.userEmail : undefined
      setRoster((prev) => ({
        ...prev,
        [peerId]: { userName, userId, ...(userEmail ? { userEmail } : {}) },
      }))
      showToast(`${userName} joined`)
    }

    const onPeerLeft = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { peerId?: unknown }
      const peerId = p.peerId
      if (typeof peerId !== 'string') return
      setRoster((prev) => {
        const next = { ...prev }
        delete next[peerId]
        return next
      })
      setHandRaisedByPeerId((prev) => {
        const n = { ...prev }
        delete n[peerId]
        return n
      })
    }

    const onChat = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        id?: unknown
        senderId?: unknown
        senderUserId?: unknown
        senderName?: unknown
        text?: unknown
        createdAt?: unknown
      }
      if (typeof p.senderId !== 'string' || typeof p.text !== 'string') return
      const stamp = typeof p.createdAt === 'string' ? p.createdAt : new Date().toISOString()
      const suid = typeof p.senderUserId === 'string' ? p.senderUserId : undefined
      pushChat({
        id: typeof p.id === 'string' ? p.id : undefined,
        senderId: p.senderId,
        senderUserId: suid,
        senderName: typeof p.senderName === 'string' ? p.senderName : undefined,
        text: p.text,
        createdAt: stamp,
      })
    }

    const onJoinRequest = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { requestId?: unknown; name?: unknown }
      const requestId = p.requestId
      if (typeof requestId !== 'string') return
      setJoinRequests((prev) => {
        if (prev.some((r) => r.requestId === requestId)) return prev
        return [...prev, { requestId, name: typeof p.name === 'string' ? p.name : 'Someone' }]
      })
      showToast('Join request received')
    }

    const onLiveCollabRequest = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { requestId?: unknown; name?: unknown; userId?: unknown }
      const requestId = p.requestId
      if (typeof requestId !== 'string') return
      setLiveCollabRequests((prev) => {
        if (prev.some((r) => r.requestId === requestId)) return prev
        return [
          ...prev,
          {
            requestId,
            name: typeof p.name === 'string' ? p.name : 'Someone',
            userId: typeof p.userId === 'string' ? p.userId : '',
          },
        ]
      })
      showToast('Broadcast collaboration request')
    }

    const onHandRaise = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { peerId?: unknown; raised?: unknown }
      const peerId = p.peerId
      const raised = p.raised
      if (typeof peerId !== 'string' || typeof raised !== 'boolean') return
      setHandRaisedByPeerId((prev) => ({ ...prev, [peerId]: raised }))
    }

    const onRecordingState = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { active?: unknown }
      if (typeof p.active !== 'boolean') return
      setRoomRecordingActive(p.active)
      showToast(p.active ? 'This meeting is being recorded' : 'Recording stopped')
    }

    const onVoteStarted = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { sessionId?: unknown; title?: unknown; anonymous?: unknown }
      if (typeof p.sessionId !== 'string' || typeof p.title !== 'string' || typeof p.anonymous !== 'boolean') return
      activeVoteSessionIdRef.current = p.sessionId
      setVoteSession({ sessionId: p.sessionId, title: p.title, anonymous: p.anonymous })
      setVoteUp(0)
      setVoteDown(0)
      setVoteBreakdown(null)
      setMyVote(null)
      showToast('Host started a vote')
    }

    const onVoteUpdate = (payload: unknown) => {
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
        const rows: VoteBreakdownRow[] = []
        for (const item of p.breakdown) {
          if (!item || typeof item !== 'object') continue
          const r = item as { peerId?: unknown; userName?: unknown; choice?: unknown }
          if (
            typeof r.peerId !== 'string' ||
            typeof r.userName !== 'string' ||
            (r.choice !== 'up' && r.choice !== 'down')
          ) {
            continue
          }
          rows.push({ peerId: r.peerId, userName: r.userName, choice: r.choice })
        }
        setVoteBreakdown(rows.length > 0 ? rows : null)
        const self = rows.find((r) => r.peerId === mySocketIdRef.current)
        setMyVote(self ? self.choice : null)
      } else {
        setVoteBreakdown(null)
      }
    }

    const onVoteEnded = (payload: unknown) => {
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
        showToast('Vote ended — host left')
      } else {
        showToast(`Vote closed: "${title}" — 👍 ${up} · 👎 ${down}`)
      }
    }

    const onHostChanged = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as { hostPeerId?: unknown; hostUserId?: unknown }
      if (typeof p.hostPeerId !== 'string' || typeof p.hostUserId !== 'string') return
      setHostPeerId(p.hostPeerId)
      setMeetingHostUserId(p.hostUserId)
      showToast(p.hostUserId === myUserId ? 'You are now the host' : 'Host changed')
    }

    const onHostMicState = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const muted = (payload as { muted?: unknown }).muted === true
      onHostMicMutedRef.current?.(muted)
      showToast(muted ? 'The host muted your microphone' : 'The host unmuted your microphone')
    }

    socket.on('meeting:peer-joined', onPeerJoined)
    socket.on('meeting:peer-left', onPeerLeft)
    socket.on('meeting:chat', onChat)
    socket.on('meeting:join-request', onJoinRequest)
    socket.on('meeting:live-collab-request', onLiveCollabRequest)
    socket.on('meeting:hand-raise', onHandRaise)
    socket.on('meeting:recording-state', onRecordingState)
    socket.on('meeting:vote-started', onVoteStarted)
    socket.on('meeting:vote-update', onVoteUpdate)
    socket.on('meeting:vote-ended', onVoteEnded)
    socket.on('meeting:host-changed', onHostChanged)
    socket.on('meeting:host-mic-state', onHostMicState)

    return () => {
      socket.off('meeting:peer-joined', onPeerJoined)
      socket.off('meeting:peer-left', onPeerLeft)
      socket.off('meeting:chat', onChat)
      socket.off('meeting:join-request', onJoinRequest)
      socket.off('meeting:live-collab-request', onLiveCollabRequest)
      socket.off('meeting:hand-raise', onHandRaise)
      socket.off('meeting:recording-state', onRecordingState)
      socket.off('meeting:vote-started', onVoteStarted)
      socket.off('meeting:vote-update', onVoteUpdate)
      socket.off('meeting:vote-ended', onVoteEnded)
      socket.off('meeting:host-changed', onHostChanged)
      socket.off('meeting:host-mic-state', onHostMicState)
    }
  }, [socket, pushChat, showToast, myUserId])

  const sendChat = useCallback(
    (text: string) => {
      const t = text.trim()
      if (!socket?.connected || t.length === 0 || t.length > 500) return
      socket.emit('meeting:chat', { text: t })
    },
    [socket],
  )

  const toggleHandRaise = useCallback(() => {
    if (!socket?.connected) return
    const next = !myHandRaised
    setMyHandRaised(next)
    socket.emit('meeting:hand-raise', { raised: next })
  }, [socket, myHandRaised])

  const respondJoinRequest = useCallback((requestId: string, accepted: boolean) => {
    socket?.emit('meeting:join-decision', { requestId, accepted })
    setJoinRequests((prev) => prev.filter((r) => r.requestId !== requestId))
  }, [socket])

  const respondLiveCollabRequest = useCallback((requestId: string, accepted: boolean) => {
    socket?.emit('live:collab-decision', { requestId, accepted })
    setLiveCollabRequests((prev) => prev.filter((r) => r.requestId !== requestId))
  }, [socket])

  const submitVote = useCallback(
    (choice: VoteChoice) => {
      const sid = activeVoteSessionIdRef.current
      if (!socket?.connected || !sid) return
      socket.emit('meeting:vote-submit', { sessionId: sid, choice })
    },
    [socket],
  )

  const endVote = useCallback(() => {
    socket?.emit('meeting:vote-end')
  }, [socket])

  const startVote = useCallback(
    (title: string, anonymous: boolean) => {
      const t = title.trim()
      if (!socket?.connected || t.length === 0) return
      socket.emit('meeting:vote-start', { title: t.slice(0, 200), anonymous })
    },
    [socket],
  )

  const transferHost = useCallback(
    (toPeerId: string) => {
      socket?.emit('meeting:host-transfer', { to: toPeerId })
    },
    [socket],
  )

  return {
    myUserId,
    mySocketId,
    roster,
    chatMessages,
    joinRequests,
    liveCollabRequests,
    handRaisedByPeerId,
    myHandRaised,
    roomRecordingActive,
    voteSession,
    voteUp,
    voteDown,
    voteBreakdown,
    myVote,
    toast,
    hostPeerId,
    meetingHostUserId,
    sendChat,
    toggleHandRaise,
    respondJoinRequest,
    respondLiveCollabRequest,
    submitVote,
    endVote,
    startVote,
    transferHost,
    showToast,
  }
}
