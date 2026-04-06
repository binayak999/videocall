import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { Socket } from 'socket.io-client'
import { MeetingLiveKitView } from '../../components/MeetingLiveKitView'
import { errorMessage, getLiveKitJoinToken, getMeeting } from '../../lib/api'
import { getToken } from '../../lib/auth'
import { getJwtProfile, getUserIdFromToken } from '../../lib/jwtProfile'
import { parseMeetingJoinPayload, type ParsedJoinPayload } from '../../lib/meetingJoinPayload'
import { connectAndJoinMeetingRoom, leaveMeetingRoom } from '../../lib/meetingSignaling'
import type { Meeting } from '../../lib/types'

export default function MeetingScreen() {
  const { code: raw } = useLocalSearchParams<{ code: string }>()
  const router = useRouter()
  const code = typeof raw === 'string' ? decodeURIComponent(raw) : ''

  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [err, setErr] = useState<string | null>(null)
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [lk, setLk] = useState<{ url: string; token: string } | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [parsedJoin, setParsedJoin] = useState<ParsedJoinPayload | null>(null)
  const [waitingForHost, setWaitingForHost] = useState(false)

  const signalingRef = useRef<Socket | null>(null)

  const teardownSignaling = useCallback(() => {
    leaveMeetingRoom(signalingRef.current)
    signalingRef.current = null
  }, [])

  const load = useCallback(async () => {
    setPhase('loading')
    setErr(null)
    setWaitingForHost(false)
    teardownSignaling()
    try {
      const token = await getToken()
      if (!token) {
        setErr('Sign in to join meetings.')
        setPhase('error')
        return
      }

      const { meeting: m } = await getMeeting(code)

      const { socket, joinPayload } = await connectAndJoinMeetingRoom(token, code, {
        onWaitingForHost: () => setWaitingForHost(true),
      })
      signalingRef.current = socket
      setWaitingForHost(false)

      const sid = socket.id
      if (!sid) throw new Error('Signaling socket has no id')
      const prof = getJwtProfile(token)
      const pj = parseMeetingJoinPayload(joinPayload, {
        mySocketId: sid,
        myUserId: getUserIdFromToken(token),
        selfName: prof.name?.trim() || 'You',
        selfEmail: prof.email,
      })

      const join = await getLiveKitJoinToken(code)
      setMeeting(m)
      setAuthToken(token)
      setParsedJoin(pj)
      setLk(join)
      setPhase('ready')
    } catch (e) {
      teardownSignaling()
      setAuthToken(null)
      setParsedJoin(null)
      setErr(errorMessage(e))
      setPhase('error')
    }
  }, [code, teardownSignaling])

  useEffect(() => {
    if (!code) {
      setErr('Invalid meeting code.')
      setPhase('error')
      return
    }
    void load()
    return () => {
      teardownSignaling()
    }
  }, [code, load, teardownSignaling])

  const onLeave = () => {
    teardownSignaling()
    router.replace('/')
  }

  if (phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#93c5fd" />
        <Text style={styles.hint}>
          {waitingForHost ? 'Waiting for host to admit you…' : 'Connecting…'}
        </Text>
      </View>
    )
  }

  if (phase === 'error' || !lk || !meeting || !authToken || !parsedJoin) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{err ?? 'Could not join meeting.'}</Text>
        <Pressable style={styles.btn} onPress={() => router.replace('/login')}>
          <Text style={styles.btnText}>Sign in</Text>
        </Pressable>
        <Pressable style={styles.btnSecondary} onPress={() => void load()}>
          <Text style={styles.btnSecondaryText}>Retry</Text>
        </Pressable>
        <Pressable style={styles.btnSecondary} onPress={onLeave}>
          <Text style={styles.btnSecondaryText}>Back home</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <MeetingLiveKitView
      serverUrl={lk.url}
      token={lk.token}
      authToken={authToken}
      meeting={meeting}
      socket={signalingRef.current!}
      parsedJoin={parsedJoin}
      meetingTitle={meeting.title}
      meetingCode={meeting.code}
      onLeave={onLeave}
    />
  )
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: '#0b0f14',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 16,
  },
  hint: {
    marginTop: 12,
    color: 'rgba(244,247,251,0.55)',
    fontSize: 15,
  },
  error: {
    color: '#fca5a5',
    fontSize: 15,
    textAlign: 'center',
  },
  btn: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  btnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  btnSecondary: {
    paddingVertical: 8,
  },
  btnSecondaryText: {
    color: 'rgba(147,197,253,0.95)',
    fontSize: 15,
  },
})
