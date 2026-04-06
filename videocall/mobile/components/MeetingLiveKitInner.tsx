import '../lib/livekitPolyfills'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Modal,
  TextInput,
  FlatList,
  Switch,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { RTCView } from '@livekit/react-native-webrtc'
import {
  LiveKitRoom,
  VideoTrack,
  useRemoteParticipants,
  useTracks,
  ParticipantContext,
  useParticipantContext,
  useParticipantTracks,
  registerGlobals,
  useRoomContext,
} from '@livekit/react-native'
import type { TrackReference } from '@livekit/components-core'
import {
  RoomEvent,
  Track,
  TrackEvent,
  RemoteVideoTrack,
  type RemoteParticipant,
  type RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client'
import { useMeetingRoomSocket } from '../hooks/useMeetingRoomSocket'
import type { MeetingLiveKitProps } from './meetingLiveKitTypes'

let globalsRegistered = false
function ensureLiveKitGlobals() {
  if (!globalsRegistered) {
    registerGlobals()
    globalsRegistered = true
  }
}

function formatChatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const REMOTE_VIDEO_SOURCES = [Track.Source.Camera, Track.Source.ScreenShare] as const

function rnMediaStreamUrl(ms: MediaStream | undefined): string {
  if (!ms) return ''
  const u = (ms as unknown as { toURL?: () => string }).toURL
  return typeof u === 'function' ? u.call(ms) : ''
}

/** Stock `VideoTrack` often misses updates when `mediaStream` / `toURL()` becomes valid on the same track ref. */
function RemoteRtcVideo({ trackRef }: { trackRef: TrackReference }) {
  const vt = trackRef.publication.track
  const [streamUrl, setStreamUrl] = useState('')

  useEffect(() => {
    if (!vt || !(vt instanceof RemoteVideoTrack)) {
      setStreamUrl('')
      return
    }
    const sync = () => {
      setStreamUrl(rnMediaStreamUrl(vt.mediaStream))
    }
    sync()
    const pub = trackRef.publication as RemoteTrackPublication
    const onPub = () => sync()
    vt.on(TrackEvent.VideoDimensionsChanged, sync)
    vt.on(TrackEvent.VideoPlaybackStarted, sync)
    vt.on(TrackEvent.Unmuted, sync)
    vt.on(TrackEvent.Muted, sync)
    pub.on(TrackEvent.Subscribed, onPub)
    return () => {
      vt.off(TrackEvent.VideoDimensionsChanged, sync)
      vt.off(TrackEvent.VideoPlaybackStarted, sync)
      vt.off(TrackEvent.Unmuted, sync)
      vt.off(TrackEvent.Muted, sync)
      pub.off(TrackEvent.Subscribed, onPub)
    }
  }, [vt, trackRef.publication])

  return (
    <RTCView style={styles.video} streamURL={streamUrl} objectFit="cover" zOrder={0} />
  )
}

function applyRemoteVideoLayerHints(publication: RemoteTrackPublication) {
  if (publication.kind !== Track.Kind.Video) return
  if (publication.source !== Track.Source.Camera && publication.source !== Track.Source.ScreenShare) {
    return
  }
  // Request a concrete layer for simulcast; do not call setVideoQuality here — it clears requestedVideoDimensions.
  publication.setVideoDimensions({ width: 1280, height: 720 })
}

/**
 * Prefer publications that already have `publication.track`, then screen share over camera.
 * Per-participant `useParticipantTracks` (via `ParticipantContext`) avoids grouping bugs where
 * `useTracks` + Map by `identity` did not line up with `useRemoteParticipants`.
 */
function RemoteParticipantTile({ participant }: { participant: RemoteParticipant }) {
  return (
    <ParticipantContext.Provider value={participant}>
      <RemoteParticipantTileInner />
    </ParticipantContext.Provider>
  )
}

function RemoteParticipantTileInner() {
  const participant = useParticipantContext()
  const identity = participant.identity
  const tracks = useParticipantTracks([...REMOTE_VIDEO_SOURCES], {})

  const preferred = useMemo(() => {
    const ready = tracks.filter((r) => r.publication.track)
    const screen = ready.find((r) => r.source === Track.Source.ScreenShare)
    if (screen) return screen
    return ready.find((r) => r.source === Track.Source.Camera)
  }, [tracks])

  const trackSid = preferred?.publication.trackSid ?? 'none'

  useEffect(() => {
    const pub = preferred?.publication
    if (!pub || !(pub instanceof RemoteTrackPublication)) return
    if (!pub.track) return
    applyRemoteVideoLayerHints(pub)
  }, [preferred?.publication, trackSid])

  return (
    <View style={styles.tile}>
      {preferred?.publication.track ? (
        <RemoteRtcVideo trackRef={preferred} />
      ) : tracks.length > 0 ? (
        <View style={styles.tilePlaceholder}>
          <Text style={styles.tilePlaceholderTitle} numberOfLines={1}>
            {identity}
          </Text>
          <Text style={styles.tilePlaceholderHint}>Connecting video…</Text>
        </View>
      ) : (
        <View style={styles.tilePlaceholder}>
          <Text style={styles.tilePlaceholderTitle} numberOfLines={1}>
            {identity}
          </Text>
          <Text style={styles.tilePlaceholderHint}>No camera or screen share</Text>
        </View>
      )}
    </View>
  )
}

function RoomInner({
  meetingTitle,
  meetingCode,
  meeting,
  authToken,
  socket,
  parsedJoin,
  onLeave,
}: MeetingLiveKitProps) {
  const room = useRoomContext()
  const remoteParticipants = useRemoteParticipants()

  useEffect(() => {
    if (!room) return
    const onSubscribed = (track: RemoteTrack, publication: RemoteTrackPublication) => {
      if (track.kind !== Track.Kind.Video) return
      applyRemoteVideoLayerHints(publication)
    }
    const flushExisting = () => {
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub instanceof RemoteTrackPublication && pub.track) applyRemoteVideoLayerHints(pub)
        }
      }
    }
    room.on(RoomEvent.TrackSubscribed, onSubscribed)
    room.on(RoomEvent.Connected, flushExisting)
    room.on(RoomEvent.ParticipantConnected, flushExisting)
    flushExisting()
    return () => {
      room.off(RoomEvent.TrackSubscribed, onSubscribed)
      room.off(RoomEvent.Connected, flushExisting)
      room.off(RoomEvent.ParticipantConnected, flushExisting)
    }
  }, [room])

  const trackRefs = useTracks([...REMOTE_VIDEO_SOURCES], {
    onlySubscribed: true,
    updateOnlyOn: [RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackSubscribed],
  })

  const localTiles = useMemo(
    () => trackRefs.filter((t) => t.participant?.isLocal),
    [trackRefs],
  )

  const onHostMicMuted = useCallback(
    (muted: boolean) => {
      const lp = room?.localParticipant
      if (!lp) return
      void lp.setMicrophoneEnabled(!muted)
    },
    [room],
  )

  const roomSocket = useMeetingRoomSocket(socket, authToken, {
    initialJoin: parsedJoin,
    meetingHostUserId: meeting.hostId,
    onHostMicMuted,
  })

  const {
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
    myVote,
    toast,
    sendChat,
    toggleHandRaise,
    respondJoinRequest,
    respondLiveCollabRequest,
    submitVote,
    endVote,
    startVote,
    transferHost,
  } = roomSocket

  const isHost = meeting.hostId === myUserId

  const [chatOpen, setChatOpen] = useState(false)
  const [peopleOpen, setPeopleOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [voteTitleDraft, setVoteTitleDraft] = useState('')
  const [voteAnonymous, setVoteAnonymous] = useState(true)
  const [mediaTick, setMediaTick] = useState(0)

  useEffect(() => {
    if (!room) return
    const bump = () => setMediaTick((t) => t + 1)
    room.on(RoomEvent.LocalTrackPublished, bump)
    room.on(RoomEvent.LocalTrackUnpublished, bump)
    room.on(RoomEvent.TrackMuted, bump)
    room.on(RoomEvent.TrackUnmuted, bump)
    return () => {
      room.off(RoomEvent.LocalTrackPublished, bump)
      room.off(RoomEvent.LocalTrackUnpublished, bump)
      room.off(RoomEvent.TrackMuted, bump)
      room.off(RoomEvent.TrackUnmuted, bump)
    }
  }, [room])

  const lp = room?.localParticipant
  const micOn = lp?.isMicrophoneEnabled ?? false
  const camOn = lp?.isCameraEnabled ?? false

  const toggleMic = useCallback(() => {
    if (!lp) return
    void lp.setMicrophoneEnabled(!micOn)
  }, [lp, micOn])

  const toggleCam = useCallback(() => {
    if (!lp) return
    void lp.setCameraEnabled(!camOn)
  }, [lp, camOn])

  const rosterRows = useMemo(() => {
    return Object.entries(roster).sort((a, b) =>
      (a[1]?.userName ?? '').localeCompare(b[1]?.userName ?? '', undefined, { sensitivity: 'base' }),
    )
  }, [roster])

  const participantCount = rosterRows.length

  void mediaTick

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.headerSafe}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{meetingTitle ?? 'Meeting'}</Text>
            <Text style={styles.subtitle}>
              {meetingCode}
              {roomRecordingActive ? ' · REC' : ''}
            </Text>
            <Text style={styles.meta}>
              {participantCount} in call{isHost ? ' · Host' : ''}
            </Text>
          </View>
          <Pressable style={styles.leaveBtn} onPress={onLeave}>
            <Text style={styles.leaveBtnText}>Leave</Text>
          </Pressable>
        </View>
      </SafeAreaView>

      {isHost && joinRequests.length > 0 ? (
        <View style={styles.hostBanner}>
          <Text style={styles.hostBannerTitle}>Join requests</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {joinRequests.map((r) => (
              <View key={r.requestId} style={styles.reqChip}>
                <Text style={styles.reqChipText}>{r.name}</Text>
                <Pressable style={styles.reqOk} onPress={() => respondJoinRequest(r.requestId, true)}>
                  <Text style={styles.reqOkText}>Admit</Text>
                </Pressable>
                <Pressable style={styles.reqNo} onPress={() => respondJoinRequest(r.requestId, false)}>
                  <Text style={styles.reqNoText}>Deny</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {isHost && liveCollabRequests.length > 0 ? (
        <View style={styles.hostBanner}>
          <Text style={styles.hostBannerTitle}>Live collaboration</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {liveCollabRequests.map((r) => (
              <View key={r.requestId} style={styles.reqChip}>
                <Text style={styles.reqChipText}>{r.name}</Text>
                <Pressable style={styles.reqOk} onPress={() => respondLiveCollabRequest(r.requestId, true)}>
                  <Text style={styles.reqOkText}>Allow</Text>
                </Pressable>
                <Pressable style={styles.reqNo} onPress={() => respondLiveCollabRequest(r.requestId, false)}>
                  <Text style={styles.reqNoText}>Deny</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {voteSession ? (
        <View style={styles.voteBar}>
          <Text style={styles.voteTitle} numberOfLines={2}>
            {voteSession.title}
          </Text>
          <View style={styles.voteRow}>
            <Text style={styles.voteCount}>
              👍 {voteUp} · 👎 {voteDown}
            </Text>
            {myVote == null ? (
              <View style={styles.voteBtns}>
                <Pressable style={styles.voteUpBtn} onPress={() => submitVote('up')}>
                  <Text style={styles.voteBtnText}>👍</Text>
                </Pressable>
                <Pressable style={styles.voteDownBtn} onPress={() => submitVote('down')}>
                  <Text style={styles.voteBtnText}>👎</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.votedLabel}>You voted {myVote === 'up' ? '👍' : '👎'}</Text>
            )}
            {isHost ? (
              <Pressable style={styles.voteEndBtn} onPress={endVote}>
                <Text style={styles.voteEndText}>End vote</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
        {remoteParticipants.map((p) => (
          <RemoteParticipantTile key={p.sid} participant={p} />
        ))}
        {remoteParticipants.length === 0 ? (
          <Text style={styles.hint}>Waiting for others…</Text>
        ) : null}
      </ScrollView>

      {localTiles.map((ref, i) => (
        <View key={`local-${i}`} style={styles.pip}>
          <VideoTrack trackRef={ref} style={styles.pipVideo} objectFit="cover" mirror zOrder={1} />
        </View>
      ))}

      {toast ? (
        <View style={styles.toastWrap} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      <SafeAreaView edges={['bottom']} style={styles.toolbarSafe}>
        <View style={styles.toolbar}>
          <Pressable style={[styles.toolBtn, !micOn && styles.toolOff]} onPress={toggleMic}>
            <Text style={styles.toolBtnText}>{micOn ? 'Mic' : 'Muted'}</Text>
          </Pressable>
          <Pressable style={[styles.toolBtn, !camOn && styles.toolOff]} onPress={toggleCam}>
            <Text style={styles.toolBtnText}>{camOn ? 'Camera' : 'Off'}</Text>
          </Pressable>
          <Pressable style={[styles.toolBtn, myHandRaised && styles.toolActive]} onPress={toggleHandRaise}>
            <Text style={styles.toolBtnText}>Raise</Text>
          </Pressable>
          <Pressable style={styles.toolBtn} onPress={() => setChatOpen(true)}>
            <Text style={styles.toolBtnText}>Chat</Text>
          </Pressable>
          <Pressable style={styles.toolBtn} onPress={() => setPeopleOpen(true)}>
            <Text style={styles.toolBtnText}>People</Text>
          </Pressable>
          <Pressable style={styles.toolBtn} onPress={() => setMoreOpen(true)}>
            <Text style={styles.toolBtnText}>More</Text>
          </Pressable>
        </View>
      </SafeAreaView>

      <Modal visible={chatOpen} animationType="slide" onRequestClose={() => setChatOpen(false)}>
        <KeyboardAvoidingView
          style={styles.modalRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Chat</Text>
            <Pressable onPress={() => setChatOpen(false)}>
              <Text style={styles.modalClose}>Done</Text>
            </Pressable>
          </View>
          <FlatList
            data={chatMessages}
            keyExtractor={(item, i) => item.id ?? `${item.senderId}-${item.createdAt}-${i}`}
            contentContainerStyle={styles.chatList}
            renderItem={({ item }) => {
              const mine = item.senderUserId === myUserId || item.senderId === mySocketId
              return (
                <View style={[styles.chatRow, mine && styles.chatMine]}>
                  <Text style={styles.chatMeta}>
                    {item.senderName ?? 'Someone'} · {formatChatTime(item.createdAt)}
                  </Text>
                  <Text style={styles.chatText}>{item.text}</Text>
                </View>
              )
            }}
          />
          <View style={styles.chatInputRow}>
            <TextInput
              style={styles.chatInput}
              placeholder="Message…"
              placeholderTextColor="rgba(244,247,251,0.35)"
              value={chatDraft}
              onChangeText={setChatDraft}
              onSubmitEditing={() => {
                sendChat(chatDraft)
                setChatDraft('')
              }}
            />
            <Pressable
              style={styles.chatSend}
              onPress={() => {
                sendChat(chatDraft)
                setChatDraft('')
              }}
            >
              <Text style={styles.chatSendText}>Send</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={peopleOpen} animationType="fade" transparent onRequestClose={() => setPeopleOpen(false)}>
        <Pressable style={styles.peopleBackdrop} onPress={() => setPeopleOpen(false)}>
          <Pressable style={styles.peopleSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>People ({participantCount})</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {rosterRows.map(([peerId, e]) => (
                <View key={peerId} style={styles.personRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.personName}>{e.userName}</Text>
                    {e.userEmail ? <Text style={styles.personEmail}>{e.userEmail}</Text> : null}
                  </View>
                  {handRaisedByPeerId[peerId] ? <Text style={styles.handLabel}>✋</Text> : null}
                  {isHost && peerId !== mySocketId ? (
                    <Pressable
                      style={styles.transferBtn}
                      onPress={() => {
                        transferHost(peerId)
                        setPeopleOpen(false)
                      }}
                    >
                      <Text style={styles.transferBtnText}>Make host</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </ScrollView>
            <Pressable style={styles.modalDoneBtn} onPress={() => setPeopleOpen(false)}>
              <Text style={styles.modalClose}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={moreOpen} animationType="slide" onRequestClose={() => setMoreOpen(false)}>
        <View style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>More</Text>
            <Pressable onPress={() => setMoreOpen(false)}>
              <Text style={styles.modalClose}>Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.moreBody}>
            <Text style={styles.moreNote}>
              Full web experience: notes, agenda, whiteboard, screen share, captions, host AI, and recordings
              are available in the browser app. This mobile screen covers call controls, chat, people, votes, and
              host admission.
            </Text>
            {isHost && !voteSession ? (
              <View style={styles.hostVoteBox}>
                <Text style={styles.label}>Start a vote</Text>
                <TextInput
                  style={styles.voteDraftInput}
                  placeholder="Question"
                  placeholderTextColor="rgba(244,247,251,0.35)"
                  value={voteTitleDraft}
                  onChangeText={setVoteTitleDraft}
                />
                <View style={styles.switchRow}>
                  <Text style={styles.label}>Anonymous</Text>
                  <Switch value={voteAnonymous} onValueChange={setVoteAnonymous} />
                </View>
                <Pressable
                  style={styles.primaryBtn}
                  onPress={() => {
                    startVote(voteTitleDraft, voteAnonymous)
                    setVoteTitleDraft('')
                    setMoreOpen(false)
                  }}
                >
                  <Text style={styles.primaryBtnText}>Start vote</Text>
                </Pressable>
              </View>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </View>
  )
}

export function MeetingLiveKitInner(props: MeetingLiveKitProps) {
  ensureLiveKitGlobals()

  return (
    <LiveKitRoom
      serverUrl={props.serverUrl}
      token={props.token}
      connect
      audio
      video
      connectOptions={{
        autoSubscribe: true,
      }}
      options={{
        // Web uses adaptiveStream/dynacast false; on RN, dynacast helps pick a simulcast layer for remote video.
        adaptiveStream: false,
        dynacast: true,
        disconnectOnPageLeave: false,
      }}
    >
      <RoomInner {...props} />
    </LiveKitRoom>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0f14',
  },
  headerSafe: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  title: {
    color: '#f4f7fb',
    fontSize: 18,
    fontWeight: '600',
  },
  subtitle: {
    color: 'rgba(244,247,251,0.55)',
    fontSize: 13,
    marginTop: 4,
  },
  meta: {
    color: 'rgba(147,197,253,0.85)',
    fontSize: 12,
    marginTop: 4,
  },
  leaveBtn: {
    backgroundColor: 'rgba(239,68,68,0.2)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.45)',
  },
  leaveBtnText: {
    color: '#fecaca',
    fontWeight: '600',
    fontSize: 14,
  },
  hostBanner: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(37,99,235,0.15)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  hostBannerTitle: {
    color: '#bfdbfe',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  reqChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderRadius: 10,
    padding: 8,
    marginRight: 8,
    gap: 8,
  },
  reqChipText: {
    color: '#f4f7fb',
    fontSize: 14,
    maxWidth: 120,
  },
  reqOk: {
    backgroundColor: '#16a34a',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  reqOkText: { color: '#fff', fontWeight: '600', fontSize: 12 },
  reqNo: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  reqNoText: { color: '#fecaca', fontWeight: '600', fontSize: 12 },
  voteBar: {
    padding: 12,
    backgroundColor: 'rgba(234,179,8,0.12)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  voteTitle: { color: '#fef9c3', fontWeight: '600', fontSize: 14 },
  voteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 8,
  },
  voteCount: { color: 'rgba(244,247,251,0.85)', fontSize: 13 },
  voteBtns: { flexDirection: 'row', gap: 8 },
  voteUpBtn: {
    backgroundColor: 'rgba(34,197,94,0.35)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  voteDownBtn: {
    backgroundColor: 'rgba(239,68,68,0.35)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  voteBtnText: { fontSize: 18 },
  votedLabel: { color: '#a7f3d0', fontSize: 13 },
  voteEndBtn: {
    marginLeft: 'auto',
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  voteEndText: { color: '#f4f7fb', fontWeight: '600', fontSize: 13 },
  grid: {
    padding: 12,
    gap: 12,
    paddingBottom: 140,
  },
  tile: {
    aspectRatio: 16 / 9,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111827',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  tilePlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#111827',
  },
  tilePlaceholderTitle: {
    color: 'rgba(244,247,251,0.85)',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
  },
  tilePlaceholderHint: {
    color: 'rgba(244,247,251,0.45)',
    fontSize: 13,
    textAlign: 'center',
  },
  hint: {
    color: 'rgba(244,247,251,0.45)',
    textAlign: 'center',
    marginTop: 24,
    fontSize: 15,
  },
  pip: {
    position: 'absolute',
    right: 16,
    bottom: 120,
    width: 112,
    height: 198,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: '#111827',
    zIndex: 2,
  },
  pipVideo: {
    width: '100%',
    height: '100%',
  },
  toastWrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 100,
    alignItems: 'center',
    zIndex: 5,
  },
  toastText: {
    backgroundColor: 'rgba(15,23,42,0.92)',
    color: '#f4f7fb',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    overflow: 'hidden',
    fontSize: 14,
  },
  toolbarSafe: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(11,15,20,0.94)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  toolBtn: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    minWidth: 72,
    alignItems: 'center',
  },
  toolOff: {
    backgroundColor: 'rgba(239,68,68,0.25)',
  },
  toolActive: {
    backgroundColor: 'rgba(234,179,8,0.35)',
  },
  toolBtnText: {
    color: '#f4f7fb',
    fontWeight: '600',
    fontSize: 12,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: '#0b0f14',
    paddingTop: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  modalTitle: {
    color: '#f4f7fb',
    fontSize: 18,
    fontWeight: '700',
  },
  modalClose: {
    color: '#93c5fd',
    fontSize: 16,
    fontWeight: '600',
  },
  chatList: {
    padding: 16,
    paddingBottom: 8,
    gap: 10,
  },
  chatRow: {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    padding: 10,
  },
  chatMine: {
    alignSelf: 'flex-end',
    backgroundColor: 'rgba(37,99,235,0.35)',
  },
  chatMeta: {
    color: 'rgba(244,247,251,0.45)',
    fontSize: 11,
    marginBottom: 4,
  },
  chatText: {
    color: '#f4f7fb',
    fontSize: 15,
    lineHeight: 20,
  },
  chatInputRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  chatInput: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#f4f7fb',
    fontSize: 16,
  },
  chatSend: {
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  chatSendText: {
    color: '#93c5fd',
    fontWeight: '700',
    fontSize: 16,
  },
  peopleBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  peopleSheet: {
    backgroundColor: '#111827',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '70%',
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
    gap: 8,
  },
  personName: { color: '#f4f7fb', fontSize: 16, fontWeight: '600' },
  personEmail: { color: 'rgba(244,247,251,0.45)', fontSize: 12, marginTop: 2 },
  handLabel: { fontSize: 18 },
  transferBtn: {
    backgroundColor: 'rgba(37,99,235,0.35)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  transferBtnText: { color: '#bfdbfe', fontSize: 12, fontWeight: '600' },
  modalDoneBtn: { alignItems: 'center', paddingTop: 12 },
  moreBody: { padding: 16, gap: 16 },
  moreNote: {
    color: 'rgba(244,247,251,0.55)',
    fontSize: 14,
    lineHeight: 21,
  },
  hostVoteBox: {
    gap: 10,
    padding: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
  },
  label: { color: 'rgba(244,247,251,0.75)', fontSize: 14 },
  voteDraftInput: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    padding: 12,
    color: '#f4f7fb',
    fontSize: 16,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  primaryBtn: {
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
})
