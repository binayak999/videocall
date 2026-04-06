import { useMemo, useState } from 'react'
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
import { login, errorMessage } from '../lib/api'
import { setToken } from '../lib/auth'
import { getRecaptchaSiteKey } from '../lib/config'
import { RecaptchaV3WebView } from '../components/RecaptchaV3WebView'
import { RecaptchaDisclosure } from '../components/RecaptchaDisclosure'

export default function LoginScreen() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [awaitingRecaptcha, setAwaitingRecaptcha] = useState(false)

  const recaptchaSiteKey = useMemo(() => getRecaptchaSiteKey(), [])

  const runLogin = async (recaptchaToken?: string) => {
    setErr(null)
    setLoading(true)
    try {
      const res = await login({ email: email.trim(), password, recaptchaToken })
      await setToken(res.token)
      router.replace('/')
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setLoading(false)
      setAwaitingRecaptcha(false)
    }
  }

  const onSubmit = () => {
    if (recaptchaSiteKey) {
      setAwaitingRecaptcha(true)
      setLoading(true)
      return
    }
    void runLogin()
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.label}>Email</Text>
      <TextInput
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
        placeholder="you@company.com"
        placeholderTextColor="rgba(244,247,251,0.35)"
        style={styles.input}
      />
      <Text style={styles.label}>Password</Text>
      <TextInput
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholder="••••••••"
        placeholderTextColor="rgba(244,247,251,0.35)"
        style={styles.input}
      />
      {err ? <Text style={styles.error}>{err}</Text> : null}
      {awaitingRecaptcha && recaptchaSiteKey ? (
        <RecaptchaV3WebView
          siteKey={recaptchaSiteKey}
          action="login"
          onToken={(t) => void runLogin(t)}
          onError={(m) => {
            setAwaitingRecaptcha(false)
            setLoading(false)
            setErr(m || 'reCAPTCHA failed')
          }}
        />
      ) : null}
      <Pressable
        style={[styles.primaryBtn, loading && styles.btnDisabled]}
        onPress={() => void onSubmit()}
        disabled={loading}
      >
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Sign in</Text>}
      </Pressable>
      <Pressable style={styles.footer} onPress={() => router.push('/register')}>
        <Text style={styles.footerText}>Need an account? Register</Text>
      </Pressable>
      <RecaptchaDisclosure />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0b0f14',
    padding: 20,
    gap: 8,
    paddingTop: 24,
  },
  label: {
    color: 'rgba(244,247,251,0.75)',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 8,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#f4f7fb',
  },
  error: {
    color: '#fca5a5',
    fontSize: 14,
    marginTop: 4,
  },
  primaryBtn: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 16,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.7,
  },
  footer: {
    marginTop: 20,
    alignItems: 'center',
  },
  footerText: {
    color: 'rgba(147,197,253,0.95)',
    fontSize: 15,
  },
})
