const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// @livekit/react-native "exports"."default" omits .js; Metro strict resolution warns and may mis-resolve.
config.resolver.unstable_enablePackageExports = false

module.exports = config
