/**
 * Hermes / React Native do not provide DOMException. livekit-client uses
 * `class X extends DOMException` (e.g. DeferrableMapAbortError). Load this
 * module before any livekit or @livekit/react-native import.
 */
if (typeof globalThis.DOMException === 'undefined') {
  class DOMExceptionPolyfill extends Error {
    constructor(message = '', name = 'Error') {
      super(message)
      this.name = name
    }
  }

  ;(globalThis as typeof globalThis & { DOMException: typeof DOMException }).DOMException =
    DOMExceptionPolyfill as unknown as typeof DOMException
}
