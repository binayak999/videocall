import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ParticipantEvent,
  Room,
  RoomEvent,
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client'
import { errorMessage, getLiveKitJoinToken, getMeeting } from '../lib/api'
import { getToken } from '../lib/auth'
import type { Meeting } from '../lib/types'

function attachVideo(el: HTMLVideoElement, track: LocalVideoTrack | undefined | null) {
  if (!track) return
  track.attach(el)
}

function detachVideo(el: HTMLVideoElement, track: LocalVideoTrack | undefined | null) {
  if (!track) return
  track.detach(el)
}

function attachRemote(el: HTMLMediaElement, track: RemoteTrack | undefined | null) {
  if (!track) return
  track.attach(el)
}

function detachRemote(el: HTMLMediaElement, track: RemoteTrack | undefined | null) {
  if (!track) return
  track.detach(el)
}

export function LiveKitMeetingPage() {
  const params = useParams()
  const navigate = useNavigate()
  const meetingCode = (params.code ?? '').trim()

  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [connected, setConnected] = useState(false)
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [remotes, setRemotes] = useState<RemoteParticipant[]>([])

  const room = useMemo(() => new Room({ adaptiveStream: true, dynacast: true }), [])
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const localAudioRef = useRef<LocalAudioTrack | null>(null)
  const localVideoTrackRef = useRef<LocalVideoTrack | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setBusy(true)
      setErr(null)
      try {
        const m = await getMeeting(meetingCode)
        if (!cancelled) setMeeting(m.meeting)
      } catch (e: unknown) {
        if (!cancelled) setErr(errorMessage(e))
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [meetingCode])

  useEffect(() => {
    const onConnected = () => setConnected(true)
    const onDisconnected = () => setConnected(false)
    const sync = () => setRemotes(Array.from(room.remoteParticipants.values()))

    room.on(RoomEvent.Connected, onConnected)
    room.on(RoomEvent.Disconnected, onDisconnected)
    room.on(RoomEvent.ParticipantConnected, sync)
    room.on(RoomEvent.ParticipantDisconnected, sync)
    // Tracks change after a participant connects; trigger re-render so tiles can attach.
    room.on(RoomEvent.TrackPublished, sync)
    room.on(RoomEvent.TrackUnpublished, sync)
    room.on(RoomEvent.TrackSubscribed, sync)
    room.on(RoomEvent.TrackUnsubscribed, sync)

    return () => {
      room.off(RoomEvent.Connected, onConnected)
      room.off(RoomEvent.Disconnected, onDisconnected)
      room.off(RoomEvent.ParticipantConnected, sync)
      room.off(RoomEvent.ParticipantDisconnected, sync)
      room.off(RoomEvent.TrackPublished, sync)
      room.off(RoomEvent.TrackUnpublished, sync)
      room.off(RoomEvent.TrackSubscribed, sync)
      room.off(RoomEvent.TrackUnsubscribed, sync)
    }
  }, [room])

  useEffect(() => {
    const el = localVideoRef.current
    if (!el) return
    attachVideo(el, localVideoTrackRef.current)
    return () => detachVideo(el, localVideoTrackRef.current)
  }, [])

  const connect = async () => {
    setErr(null)
    const jwt = getToken()
    if (!jwt) {
      navigate('/login?redirect=' + encodeURIComponent(`/m/${meetingCode}`), { replace: true })
      return
    }

    try {
      if (room.state === 'connected') return
      const join = await getLiveKitJoinToken(meetingCode)

      // Create local tracks before connect so they publish quickly.
      if (!localAudioRef.current) localAudioRef.current = await createLocalAudioTrack()
      if (!localVideoTrackRef.current) localVideoTrackRef.current = await createLocalVideoTrack()

      await room.connect(join.url, join.token)
      await room.localParticipant.publishTrack(localAudioRef.current)
      await room.localParticipant.publishTrack(localVideoTrackRef.current)

      // Ensure preview is attached
      if (localVideoRef.current && localVideoTrackRef.current) {
        attachVideo(localVideoRef.current, localVideoTrackRef.current)
      }

      setMicOn(true)
      setCamOn(true)
    } catch (e: unknown) {
      setErr(errorMessage(e))
    }
  }

  const leave = async () => {
    try {
      // Unpublish before disconnect to avoid RTCPeerConnection removeTrack warnings.
      const lp = room.localParticipant
      const a = localAudioRef.current
      const v = localVideoTrackRef.current
      if (room.state === 'connected') {
        if (a) {
          try {
            await lp.unpublishTrack(a)
          } catch {
            // ignore
          }
        }
        if (v) {
          try {
            await lp.unpublishTrack(v)
          } catch {
            // ignore
          }
        }
      }
      room.disconnect()
    } finally {
      localAudioRef.current?.stop()
      localAudioRef.current = null
      localVideoTrackRef.current?.stop()
      localVideoTrackRef.current = null
      setRemotes([])
    }
  }

  const toggleMic = async () => {
    const next = !micOn
    setMicOn(next)
    await room.localParticipant.setMicrophoneEnabled(next)
  }

  const toggleCam = async () => {
    const next = !camOn
    setCamOn(next)
    await room.localParticipant.setCameraEnabled(next)
  }

  if (busy) {
    return <div className="fixed inset-0 flex items-center justify-center text-sm text-(--nexivo-text-muted)">Loading…</div>
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">LiveKit</div>
          <div className="truncate text-xs text-white/60">
            Room {meetingCode}{meeting?.title ? ` — ${meeting.title}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!connected ? (
            <button className="h-9 rounded-lg bg-amber-400 px-3 text-sm font-semibold text-black" onClick={() => void connect()}>
              Join
            </button>
          ) : (
            <button className="h-9 rounded-lg bg-white/10 px-3 text-sm" onClick={() => void leave()}>
              Leave
            </button>
          )}
        </div>
      </div>

      {err && <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-200">{err}</div>}

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          <div className="relative overflow-hidden rounded-xl border border-white/10 bg-white/5">
            <video ref={localVideoRef} autoPlay playsInline muted className="aspect-video w-full object-cover" />
            <div className="absolute bottom-2 left-2 rounded-md bg-black/50 px-2 py-1 text-xs">You</div>
          </div>

          {remotes.map(p => (
            <RemoteTile key={p.identity} participant={p} />
          ))}
        </div>
      </div>

      {connected && (
        <div className="flex items-center justify-center gap-2 border-t border-white/10 px-4 py-3">
          <button
            className="h-9 rounded-lg bg-white/10 px-3 text-sm"
            onClick={() => void toggleMic()}
          >
            {micOn ? 'Mute' : 'Unmute'}
          </button>
          <button
            className="h-9 rounded-lg bg-white/10 px-3 text-sm"
            onClick={() => void toggleCam()}
          >
            {camOn ? 'Camera off' : 'Camera on'}
          </button>
        </div>
      )}
    </div>
  )
}

function RemoteTile({ participant }: { participant: RemoteParticipant }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [tick, setTick] = useState(0)

  // Re-render on participant track events, since pub.track becomes available asynchronously.
  useEffect(() => {
    const bump = () => setTick(t => t + 1)
    participant.on(ParticipantEvent.TrackPublished, bump)
    participant.on(ParticipantEvent.TrackUnpublished, bump)
    participant.on(ParticipantEvent.TrackSubscribed, bump)
    participant.on(ParticipantEvent.TrackUnsubscribed, bump)
    return () => {
      participant.off(ParticipantEvent.TrackPublished, bump)
      participant.off(ParticipantEvent.TrackUnpublished, bump)
      participant.off(ParticipantEvent.TrackSubscribed, bump)
      participant.off(ParticipantEvent.TrackUnsubscribed, bump)
    }
  }, [participant])

  const videoPub = useMemo<RemoteTrackPublication | undefined>(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const pub of participant.videoTrackPublications.values()) return pub
    return undefined
  }, [participant, tick])

  const audioPub = useMemo<RemoteTrackPublication | undefined>(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const pub of participant.audioTrackPublications.values()) return pub
    return undefined
  }, [participant, tick])

  const videoTrack = (videoPub?.track as RemoteTrack | undefined) ?? undefined
  const audioTrack = (audioPub?.track as RemoteTrack | undefined) ?? undefined

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    attachRemote(el, videoTrack)
    return () => detachRemote(el, videoTrack)
  }, [videoTrack])

  useEffect(() => {
    // subscribe to first video track if needed
    const pubs = [videoPub, audioPub].filter(Boolean) as RemoteTrackPublication[]
    for (const pub of pubs) {
      if (!pub.isSubscribed) void pub.setSubscribed(true)
    }
  }, [videoPub, audioPub])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    attachRemote(el, audioTrack)
    // browsers require user gesture; audio will start after Join button click
    el.autoplay = true
    return () => detachRemote(el, audioTrack)
  }, [audioTrack])

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-white/5">
      <video ref={videoRef} autoPlay playsInline className="aspect-video w-full object-cover" />
      <audio ref={audioRef} />
      <div className="absolute bottom-2 left-2 rounded-md bg-black/50 px-2 py-1 text-xs">
        {participant.name || participant.identity}
      </div>
    </div>
  )
}

