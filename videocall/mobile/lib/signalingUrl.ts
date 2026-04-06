import { getSignalingUrl } from './config'

/**
 * Socket.IO base URL (engine adds `/socket.io`). Set EXPO_PUBLIC_SIGNALING_URL for direct signaling server.
 */
export function defaultSignalingUrl(): string {
  return getSignalingUrl()
}
