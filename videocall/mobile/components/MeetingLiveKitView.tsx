import { useEffect, useState, type ComponentType } from 'react'
import { View, Text, StyleSheet, ActivityIndicator, Pressable } from 'react-native'
import Constants from 'expo-constants'
import type { MeetingLiveKitProps } from './meetingLiveKitTypes'

function isLikelyExpoGo(): boolean {
  return Constants.appOwnership === 'expo'
}

export function MeetingLiveKitView(props: MeetingLiveKitProps) {
  const [Inner, setInner] = useState<ComponentType<MeetingLiveKitProps> | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    import('./MeetingLiveKitInner')
      .then((m) => {
        if (!cancelled) setInner(() => m.MeetingLiveKitInner)
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        if (!cancelled) setLoadErr(msg)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loadErr) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Video needs a dev build</Text>
        <Text style={styles.body}>
          LiveKit uses native WebRTC ({'@livekit/react-native-webrtc'}). It does not run inside the Expo Go
          app.
        </Text>
        {isLikelyExpoGo() ? (
          <Text style={styles.callout}>You appear to be using Expo Go — switch to a development build.</Text>
        ) : null}
        <Text style={styles.mono}>{loadErr}</Text>
        <Text style={styles.steps}>
          From the mobile folder:{'\n'}
          npx expo prebuild{'\n'}
          npx expo run:android{'\n'}
          (or run:ios){'\n\n'}
          Or: eas build --profile development
        </Text>
        <Pressable style={styles.btn} onPress={props.onLeave}>
          <Text style={styles.btnText}>Back</Text>
        </Pressable>
      </View>
    )
  }

  if (!Inner) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#93c5fd" />
        <Text style={styles.loading}>Loading video…</Text>
      </View>
    )
  }

  return <Inner {...props} />
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: '#0b0f14',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  title: {
    color: '#f4f7fb',
    fontSize: 20,
    fontWeight: '700',
  },
  body: {
    color: 'rgba(244,247,251,0.65)',
    fontSize: 15,
    lineHeight: 22,
  },
  callout: {
    color: '#fcd34d',
    fontSize: 14,
    lineHeight: 20,
  },
  mono: {
    color: 'rgba(244,247,251,0.45)',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  steps: {
    color: 'rgba(147,197,253,0.9)',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
  },
  loading: {
    marginTop: 12,
    color: 'rgba(244,247,251,0.55)',
    fontSize: 15,
  },
  btn: {
    alignSelf: 'flex-start',
    backgroundColor: '#2563eb',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 16,
  },
  btnText: {
    color: '#fff',
    fontWeight: '600',
  },
})
