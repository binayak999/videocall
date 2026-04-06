import { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  Linking,
} from 'react-native'
import { useRouter } from 'expo-router'
import { errorMessage, listMyRecordings } from '../lib/api'
import { getToken } from '../lib/auth'
import type { MeetingRecordingItem } from '../lib/types'

export default function RecordingsScreen() {
  const router = useRouter()
  const [items, setItems] = useState<MeetingRecordingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const t = await getToken()
      if (!t) {
        router.replace('/login')
        return
      }
      const res = await listMyRecordings()
      setItems(res.recordings)
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#93c5fd" />
      </View>
    )
  }

  return (
    <View style={styles.root}>
      {err ? <Text style={styles.error}>{err}</Text> : null}
      <FlatList
        data={items}
        keyExtractor={(r) => r.id}
        contentContainerStyle={items.length === 0 ? styles.empty : styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No recordings yet. Host a meeting on web or mobile to create one.</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => void Linking.openURL(item.playbackUrl)}
          >
            <Text style={styles.rowTitle}>{item.meetingTitle ?? item.meetingCode}</Text>
            <Text style={styles.rowMeta}>
              {item.meetingCode}
              {item.durationSec != null ? ` · ${Math.round(item.durationSec)}s` : ''}
            </Text>
          </Pressable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0b0f14',
    padding: 16,
  },
  center: {
    flex: 1,
    backgroundColor: '#0b0f14',
    justifyContent: 'center',
    alignItems: 'center',
  },
  list: {
    gap: 10,
    paddingBottom: 24,
  },
  empty: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {
    color: 'rgba(244,247,251,0.45)',
    fontSize: 15,
    textAlign: 'center',
  },
  error: {
    color: '#fca5a5',
    marginBottom: 12,
  },
  row: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    padding: 14,
  },
  rowTitle: {
    color: '#f4f7fb',
    fontSize: 16,
    fontWeight: '600',
  },
  rowMeta: {
    color: 'rgba(244,247,251,0.45)',
    fontSize: 13,
    marginTop: 4,
  },
})
