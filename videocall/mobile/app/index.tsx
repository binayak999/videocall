import { useCallback, useEffect, useState } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import { createMeeting, errorMessage } from '../lib/api'
import { getToken, subscribeAuth } from '../lib/auth'

export default function HomeScreen() {
  const router = useRouter()
  const [joinCode, setJoinCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)

  const refreshAuth = useCallback(async () => {
    const t = await getToken()
    setSignedIn(!!t)
  }, [])

  useEffect(() => {
    void refreshAuth()
    return subscribeAuth(() => {
      void refreshAuth()
    })
  }, [refreshAuth])

  // Server uses nanoid(10): [A-Za-z0-9_-]. Must not uppercase (DB lookup is case-sensitive) or strip _.
  const normalizedCode = joinCode.trim().replace(/[^a-zA-Z0-9_-]/g, '')

  const onJoin = () => {
    setErr(null)
    if (normalizedCode.length < 3) {
      setErr('Enter a meeting code.')
      return
    }
    router.push(`/m/${encodeURIComponent(normalizedCode)}`)
  }

  const onCreate = async () => {
    setErr(null)
    const t = await getToken()
    if (!t) {
      router.push('/login')
      return
    }
    setCreating(true)
    try {
      const { meeting } = await createMeeting({})
      router.replace(`/m/${encodeURIComponent(meeting.code)}`)
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  const onOpenRecordings = async () => {
    const t = await getToken()
    if (!t) {
      router.push('/login')
      return
    }
    router.push('/recordings')
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.hero}>
        <Text style={styles.brand}>Nexivo</Text>
        <Text style={styles.tagline}>Video meetings on your terms.</Text>
      </View>

      {signedIn === null ? (
        <ActivityIndicator color="#93c5fd" style={{ marginTop: 24 }} />
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>Join with code</Text>
          <TextInput
            value={joinCode}
            onChangeText={setJoinCode}
            placeholder="e.g. ABC-123"
            placeholderTextColor="rgba(244,247,251,0.35)"
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable
            style={[styles.primaryBtn, loading && styles.btnDisabled]}
            onPress={onJoin}
            disabled={loading}
          >
            <Text style={styles.primaryBtnText}>Join meeting</Text>
          </Pressable>

          {err ? <Text style={styles.error}>{err}</Text> : null}

          <View style={styles.divider} />

          <Pressable
            style={[styles.secondaryBtn, creating && styles.btnDisabled]}
            onPress={() => void onCreate()}
            disabled={creating}
          >
            {creating ? (
              <ActivityIndicator color="#bfdbfe" />
            ) : (
              <Text style={styles.secondaryBtnText}>Create new meeting</Text>
            )}
          </Pressable>

          <Pressable style={styles.linkRow} onPress={() => void onOpenRecordings()}>
            <Text style={styles.link}>My recordings</Text>
          </Pressable>

          <Pressable style={styles.linkRow} onPress={() => router.push('/settings')}>
            <Text style={styles.link}>Settings</Text>
          </Pressable>

          {!signedIn ? (
            <Pressable style={styles.signInFooter} onPress={() => router.push('/login')}>
              <Text style={styles.signInFooterText}>Sign in for cloud recordings & host tools</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0b0f14',
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  hero: {
    marginBottom: 28,
  },
  brand: {
    fontSize: 34,
    fontWeight: '700',
    color: '#f4f7fb',
    letterSpacing: -0.5,
  },
  tagline: {
    marginTop: 8,
    fontSize: 16,
    color: 'rgba(244,247,251,0.55)',
  },
  card: {
    gap: 12,
  },
  label: {
    color: 'rgba(244,247,251,0.75)',
    fontSize: 14,
    fontWeight: '500',
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
    color: '#f4f7fb',
  },
  primaryBtn: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  error: {
    color: '#fca5a5',
    fontSize: 14,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginVertical: 8,
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.45)',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#bfdbfe',
    fontSize: 16,
    fontWeight: '600',
  },
  linkRow: {
    paddingVertical: 6,
  },
  link: {
    color: 'rgba(147,197,253,0.95)',
    fontSize: 15,
  },
  signInFooter: {
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(37,99,235,0.12)',
  },
  signInFooterText: {
    color: 'rgba(191,219,254,0.95)',
    fontSize: 13,
    textAlign: 'center',
  },
})
