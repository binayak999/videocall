import { useMemo, useRef } from 'react'
import { View, StyleSheet } from 'react-native'
import { WebView } from 'react-native-webview'
import { getRecaptchaBaseUrl } from '../lib/config'

export type RecaptchaAction = 'login' | 'register'

type Props = {
  siteKey: string
  action: RecaptchaAction
  onToken: (token: string) => void
  onError: (message: string) => void
}

/**
 * Invisible reCAPTCHA v3 (same flow as web). Required when API has RECAPTCHA_SECRET_KEY set.
 */
export function RecaptchaV3WebView({ siteKey, action, onToken, onError }: Props) {
  const done = useRef(false)
  /** Without this, inline HTML uses a blank origin and Google rejects the token (siteverify success: false). */
  const baseUrl = useMemo(() => `${getRecaptchaBaseUrl()}/`, [])

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<script>
(function() {
  var k = ${JSON.stringify(siteKey)};
  var act = ${JSON.stringify(action)};
  var s = document.createElement('script');
  s.src = 'https://www.google.com/recaptcha/api.js?render=' + encodeURIComponent(k);
  s.onload = function() {
    grecaptcha.ready(function() {
      grecaptcha.execute(k, { action: act }).then(function(token) {
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('OK:' + token);
      }).catch(function(e) {
        var msg = (e && e.message) ? e.message : String(e);
        if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('ERR:' + msg);
      });
    });
  };
  s.onerror = function() {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage('ERR:recaptcha_script');
  };
  document.head.appendChild(s);
})();
</script></body></html>`

  return (
    <View style={styles.wrap} pointerEvents="none">
      <WebView
        originWhitelist={['*']}
        source={{ html, baseUrl }}
        onMessage={(ev) => {
          if (done.current) return
          const data = ev.nativeEvent.data
          if (data.startsWith('OK:')) {
            done.current = true
            onToken(data.slice(3))
          } else if (data.startsWith('ERR:')) {
            done.current = true
            onError(data.slice(4))
          }
        }}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        style={styles.wv}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
    left: 0,
    top: 0,
  },
  wv: { width: 1, height: 1 },
})
