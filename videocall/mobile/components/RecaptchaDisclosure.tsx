import { View, Text, StyleSheet, Linking } from 'react-native'
import { getRecaptchaSiteKey } from '../lib/config'

/**
 * reCAPTCHA v3 is score-based (no checkbox). Matches web RecaptchaDisclosure branding text.
 */
export function RecaptchaDisclosure() {
  const siteKey = getRecaptchaSiteKey()
  if (!siteKey) return null

  return (
    <View style={styles.wrap}>
      <Text style={styles.text}>
        This app is protected by reCAPTCHA and the Google{' '}
        <Text style={styles.link} onPress={() => void Linking.openURL('https://policies.google.com/privacy')}>
          Privacy Policy
        </Text>{' '}
        and{' '}
        <Text style={styles.link} onPress={() => void Linking.openURL('https://policies.google.com/terms')}>
          Terms of Service
        </Text>{' '}
        apply.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 20,
    paddingHorizontal: 4,
  },
  text: {
    textAlign: 'center',
    fontSize: 10,
    lineHeight: 15,
    color: 'rgba(244,247,251,0.45)',
  },
  link: {
    color: 'rgba(147,197,253,0.95)',
    textDecorationLine: 'underline',
  },
})
