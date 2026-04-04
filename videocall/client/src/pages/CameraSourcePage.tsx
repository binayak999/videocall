import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'
import { getIceServers } from '../lib/ice'

type Status = 'connecting' | 'waiting' | 'live' | 'error'

export function CameraSourcePage() {
  const { token } = useParams<{ token: string }>()
  const [status, setStatus] = useState<Status>('connecting')
  const [errorMsg, setErrorMsg] = useState('')
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [activeCamId, setActiveCamId] = useState<string>('')
  const [micErr, setMicErr] = useState<string>('')
  const [speakerOutDevices, setSpeakerOutDevices] = useState<MediaDeviceInfo[]>([])
  const [speakerOutDeviceId, setSpeakerOutDeviceId] = useState<string | null>(null)
  const [speakerVolume, setSpeakerVolume] = useState(1)
  const [pttTalking, setPttTalking] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const socketRef = useRef<Socket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const inboundAudioStreamRef = useRef<MediaStream | null>(null)
  const hostIdRef = useRef<string>('')

  function setOutgoingMicEnabled(enabled: boolean) {
    const s = streamRef.current
    if (!s) return
    for (const t of s.getAudioTracks()) t.enabled = enabled
  }

  function emitPtt(event: 'camera:ptt-mic', on: boolean) {
    socketRef.current?.emit(event, { on })
  }

  function supportsSetSinkId(
    el: HTMLMediaElement,
  ): el is HTMLMediaElement & { setSinkId: (deviceId: string) => Promise<void> } {
    return typeof (el as unknown as { setSinkId?: unknown }).setSinkId === 'function'
  }

  async function refreshSpeakerOutputs() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      setSpeakerOutDevices(devs.filter(d => d.kind === 'audiooutput'))
    } catch { /* ignore */ }
  }

  async function applySpeakerSink() {
    const el = audioRef.current
    if (!el) return
    el.volume = speakerVolume
    if (!speakerOutDeviceId) return
    if (!supportsSetSinkId(el)) return
    try {
      await el.setSinkId(speakerOutDeviceId)
    } catch {
      // ignore (unsupported / permission)
    }
  }

  async function startCamera(deviceId?: string) {
    try {
      const prev = streamRef.current
      const constraints: MediaStreamConstraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      // Walkie-talkie: don't transmit until the user holds "Talk to host".
      for (const t of stream.getAudioTracks()) t.enabled = false
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        void videoRef.current.play().catch(() => {})
      }
      if (prev) for (const t of prev.getTracks()) t.stop()

      // Replace track in existing peer connection if live
      const pc = pcRef.current
      if (pc) {
        const newTrack = stream.getVideoTracks()[0]
        const sender = pc.getSenders().find(s => s.track?.kind === 'video')
        if (sender && newTrack) await sender.replaceTrack(newTrack)
        const newAudio = stream.getAudioTracks()[0]
        if (newAudio) newAudio.enabled = false
        const audioSender = pc.getSenders().find(s => s.track?.kind === 'audio')
        if (audioSender && newAudio) await audioSender.replaceTrack(newAudio)
      }

      const devs = await navigator.mediaDevices.enumerateDevices()
      const cams = devs.filter(d => d.kind === 'videoinput')
      setCameras(cams)
      setActiveCamId(stream.getVideoTracks()[0]?.getSettings().deviceId ?? '')
      setMicErr('')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // If audio permission fails, still show a useful error
      setErrorMsg(`Device error: ${msg}`)
      setMicErr(msg)
      setStatus('error')
    }
  }

  async function connect() {
    if (!token) { setErrorMsg('Missing token'); setStatus('error'); return }

    await startCamera()

    const iceServers = await getIceServers().catch(() => [{ urls: 'stun:stun.l.google.com:19302' }])

    const socket = io({ path: '/socket.io', auth: { cameraToken: token } })
    socketRef.current = socket

    socket.on('connect_error', (err) => {
      setErrorMsg(err.message)
      setStatus('error')
    })

    socket.on('connect', () => {
      setStatus('waiting')
      socket.emit('camera:ready', (res: { ok: boolean; error?: string }) => {
        if (!res.ok) {
          setErrorMsg(res.error ?? 'Server rejected connection')
          setStatus('error')
        }
      })
    })

    socket.on('camera:answer', async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      hostIdRef.current = from
      const pc = pcRef.current
      // Only apply answer if we're waiting for one — ignore duplicates
      if (!pc || pc.signalingState !== 'have-local-offer') return
      await pc.setRemoteDescription(new RTCSessionDescription(sdp))
      setStatus('live')
    })

    socket.on('camera:ice', async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      const pc = pcRef.current
      if (!pc || !candidate) return
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
    })

    // Host sends a "please offer" signal — close any stale PC then create a fresh offer
    socket.on('camera:request-offer', async ({ hostId }: { hostId: string }) => {
      hostIdRef.current = hostId
      pcRef.current?.close()
      pcRef.current = null
      await sendOffer(socket, iceServers, hostId)
    })

    socket.on('disconnect', () => {
      if (status !== 'error') setStatus('connecting')
    })
  }

  async function sendOffer(socket: Socket, iceServers: RTCIceServer[], hostId: string) {
    const stream = streamRef.current
    if (!stream) return

    const pc = new RTCPeerConnection({ iceServers })
    pcRef.current = pc

    pc.ontrack = ev => {
      // Host may send meeting audio back to this device (speaker mode)
      const inbound = inboundAudioStreamRef.current ?? new MediaStream()
      inboundAudioStreamRef.current = inbound
      if (ev.track.kind === 'audio') {
        if (!inbound.getAudioTracks().some(t => t.id === ev.track.id)) inbound.addTrack(ev.track)
        if (audioRef.current) {
          audioRef.current.srcObject = inbound
          void applySpeakerSink()
          void audioRef.current.play().catch(() => {})
        }
      }
    }

    for (const track of stream.getTracks()) pc.addTrack(track, stream)

    pc.onicecandidate = ev => {
      if (ev.candidate) {
        socket.emit('camera:ice', { to: hostId, candidate: ev.candidate.toJSON() })
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    socket.emit('camera:offer', { sdp: pc.localDescription })
  }

  useEffect(() => {
    void refreshSpeakerOutputs()
    const onDev = () => void refreshSpeakerOutputs()
    navigator.mediaDevices.addEventListener('devicechange', onDev)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onDev)
  }, [])

  useEffect(() => {
    void applySpeakerSink()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakerOutDeviceId, speakerVolume])

  useEffect(() => {
    void connect()
    return () => {
      emitPtt('camera:ptt-mic', false)
      setOutgoingMicEnabled(false)
      socketRef.current?.disconnect()
      pcRef.current?.close()
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statusLabel: Record<Status, string> = {
    connecting: 'Connecting…',
    waiting: 'Waiting for host to connect…',
    live: 'Live',
    error: 'Error',
  }

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-5 bg-[#111] text-white">
      <div className="relative w-full max-w-sm overflow-hidden rounded-2xl bg-black aspect-video">
        <video
          ref={videoRef}
          playsInline
          autoPlay
          muted
          className="h-full w-full -scale-x-100 object-cover"
        />
        <audio ref={audioRef} autoPlay playsInline className="hidden" />
        <div className={`absolute top-3 left-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${
          status === 'live' ? 'bg-red-600' : 'bg-black/60'
        }`}>
          {status === 'live' && <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />}
          {statusLabel[status]}
        </div>
      </div>

      {errorMsg && (
        <p className="max-w-xs text-center text-sm text-red-400">{errorMsg}</p>
      )}
      {micErr && status !== 'error' && (
        <p className="max-w-xs text-center text-xs text-white/40">{micErr}</p>
      )}

      <div className="w-full max-w-sm space-y-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Hear the host on this device</p>
        <p className="text-[11px] leading-snug text-white/45">
          When the host enables “send meeting audio” to this camera, their voice plays here. Pick the speaker and volume on this phone or tablet.
        </p>
        <label className="mb-1 block text-[11px] font-semibold text-white/55">Speaker output</label>
        <select
          value={speakerOutDeviceId ?? ''}
          onChange={e => setSpeakerOutDeviceId(e.target.value ? e.target.value : null)}
          onClick={() => void refreshSpeakerOutputs()}
          className="w-full cursor-pointer rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-[13px] font-medium text-white outline-none focus:border-amber-500/45"
          aria-label="Speaker output device"
        >
          <option value="">Default speaker</option>
          {speakerOutDevices.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Speaker ${i + 1}`}
            </option>
          ))}
        </select>
        <label className="mt-2 mb-1 block text-[11px] font-semibold text-white/55">Volume</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={speakerVolume}
          onChange={e => setSpeakerVolume(Number(e.target.value))}
          className="w-full accent-amber-400"
          aria-label="Host audio volume"
        />
      </div>

      <div className="w-full max-w-sm space-y-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Walkie‑talkie</p>
        <p className="text-[11px] leading-snug text-white/45">
          Hold a button to send audio. Release to stop.
        </p>
        <div className="grid grid-cols-1 gap-2">
          <button
            type="button"
            onPointerDown={e => {
              ;(e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId)
              setPttTalking(true)
              setOutgoingMicEnabled(true)
              emitPtt('camera:ptt-mic', true)
            }}
            onPointerUp={() => {
              setPttTalking(false)
              setOutgoingMicEnabled(false)
              emitPtt('camera:ptt-mic', false)
            }}
            onPointerCancel={() => {
              setPttTalking(false)
              setOutgoingMicEnabled(false)
              emitPtt('camera:ptt-mic', false)
            }}
            className={`w-full select-none rounded-xl border px-3 py-3 text-[13px] font-semibold transition ${
              pttTalking ? 'border-amber-400 bg-amber-400/15 text-amber-200' : 'border-white/12 bg-black/30 text-white/80 hover:border-white/18'
            }`}
          >
            {pttTalking ? 'Talking…' : 'Hold to talk to host'}
          </button>
        </div>
      </div>

      {cameras.length > 1 && (
        <div className="flex gap-2">
          {cameras.map(cam => (
            <button
              key={cam.deviceId}
              type="button"
              onClick={() => void startCamera(cam.deviceId).then(() => setActiveCamId(cam.deviceId))}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                activeCamId === cam.deviceId
                  ? 'border-amber-400 bg-amber-400/15 text-amber-400'
                  : 'border-white/20 text-white/60 hover:border-white/40'
              }`}
            >
              {cam.label || `Camera ${cameras.indexOf(cam) + 1}`}
            </button>
          ))}
        </div>
      )}

      <p className="text-xs text-white/30">Keep this page open to stay connected</p>
    </div>
  )
}
