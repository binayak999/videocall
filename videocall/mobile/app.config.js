// Load mobile/.env first so process.env is populated when this file runs (Expo CLI, EAS, prebuild).
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

const appJson = require('./app.json')
const baseExtra = appJson.expo.extra || {}

/** Mirrors EXPO_PUBLIC_* from .env into expo.extra (readable at runtime via expo-constants). */
module.exports = {
  expo: {
    ...appJson.expo,
    extra: {
      ...baseExtra,
      apiBase: process.env.EXPO_PUBLIC_API_BASE ?? baseExtra.apiBase,
      signalingUrl: process.env.EXPO_PUBLIC_SIGNALING_URL ?? baseExtra.signalingUrl,
      recaptchaSiteKey: process.env.EXPO_PUBLIC_RECAPTCHA_SITE_KEY ?? baseExtra.recaptchaSiteKey,
      recaptchaBaseUrl: process.env.EXPO_PUBLIC_RECAPTCHA_BASE_URL ?? baseExtra.recaptchaBaseUrl,
    },
  },
}
