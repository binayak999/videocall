import { View, Text, StyleSheet, Pressable } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { clearToken } from '../lib/auth'
import { DEFAULT_API_BASE, getApiBase, getRecaptchaSiteKey, getSignalingUrl } from '../lib/config'

export default function SettingsScreen() {
  const router = useRouter()
  const apiBase = getApiBase()
  const signaling = getSignalingUrl()
  const recaptchaConfigured = Boolean(getRecaptchaSiteKey())

  return (
    <View style={styles.root}>
      <Text style={styles.label}>API base (resolved)</Text>
      <Text style={styles.value}>{apiBase}</Text>
      {!process.env.EXPO_PUBLIC_API_BASE?.trim() ? (
        <Text style={styles.muted}>Using built-in default: {DEFAULT_API_BASE}</Text>
      ) : null}
      <Text style={styles.label}>Signaling URL</Text>
      <Text style={styles.value}>{signaling}</Text>
      <Text style={styles.label}>reCAPTCHA for login/register</Text>
      <Text style={styles.value}>
        {recaptchaConfigured
          ? 'Configured (env or app.json extra.recaptchaSiteKey)'
          : 'Not set — add EXPO_PUBLIC_RECAPTCHA_SITE_KEY (same as web VITE_RECAPTCHA_SITE_KEY) if the API uses RECAPTCHA_SECRET_KEY'}
      </Text>
      <Text style={styles.hint}>
        Copy .env.example to .env for local keys. App: {Constants.expoConfig?.slug}
      </Text>
      <Pressable
        style={styles.signOut}
        onPress={async () => {
          await clearToken()
          router.replace('/')
        }}
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0b0f14',
    padding: 20,
    gap: 8,
  },
  label: {
    color: 'rgba(244,247,251,0.55)',
    fontSize: 13,
    marginTop: 12,
  },
  value: {
    color: '#f4f7fb',
    fontSize: 14,
  },
  muted: {
    color: 'rgba(244,247,251,0.4)',
    fontSize: 12,
    marginTop: 4,
  },
  hint: {
    color: 'rgba(244,247,251,0.4)',
    fontSize: 12,
    marginTop: 16,
    lineHeight: 18,
  },
  signOut: {
    marginTop: 28,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(239,68,68,0.15)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.35)',
  },
  signOutText: {
    color: '#fecaca',
    fontWeight: '600',
  },
})
