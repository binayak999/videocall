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

  const videoRef = useRef<HTMLVideoElement>(null)
  const socketRef = useRef<Socket | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const hostIdRef = useRef<string>('')

  async function startCamera(deviceId?: string) {
    try {
      const prev = streamRef.current
      const constraints: MediaStreamConstraints = {
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' },
        audio: false,
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
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
      }

      const devs = await navigator.mediaDevices.enumerateDevices()
      const cams = devs.filter(d => d.kind === 'videoinput')
      setCameras(cams)
      setActiveCamId(stream.getVideoTracks()[0]?.getSettings().deviceId ?? '')
    } catch (e) {
      setErrorMsg(`Camera error: ${e instanceof Error ? e.message : String(e)}`)
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

    for (const track of stream.getVideoTracks()) {
      pc.addTrack(track, stream)
    }

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
    void connect()
    return () => {
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
