import { View, Text, StyleSheet, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'

/**
 * Live watch on web uses WebRTC + signaling (not LiveKit). Native parity requires
 * porting that pipeline or serving watch via WebView — tracked for a follow-up.
 */
export default function LiveWatchPlaceholder() {
  const { code: raw } = useLocalSearchParams<{ code: string }>()
  const router = useRouter()
  const code = typeof raw === 'string' ? decodeURIComponent(raw) : ''

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Live watch</Text>
      <Text style={styles.body}>
        Meeting “{code}”: the browser live viewer uses WebRTC through the signaling server. A native
        equivalent will use the same socket protocol or a bundled WebView. Join the meeting from Home
        for full LiveKit AV.
      </Text>
      <Pressable style={styles.btn} onPress={() => router.replace('/')}>
        <Text style={styles.btnText}>Back home</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0b0f14',
    padding: 24,
    justifyContent: 'center',
    gap: 16,
  },
  title: {
    color: '#f4f7fb',
    fontSize: 22,
    fontWeight: '700',
  },
  body: {
    color: 'rgba(244,247,251,0.6)',
    fontSize: 15,
    lineHeight: 22,
  },
  btn: {
    alignSelf: 'flex-start',
    backgroundColor: '#2563eb',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  btnText: {
    color: '#fff',
    fontWeight: '600',
  },
})
