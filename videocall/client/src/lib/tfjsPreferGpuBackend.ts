/**
 * Single init for TensorFlow.js: prefer GPU backends (WebGPU → WebGL), then WASM, then CPU.
 * Shared so body-segmentation, nsfwjs, and any other tfjs users agree on the same backend.
 */
let tfjsBackendPromise: Promise<void> | null = null

export function ensureTfjsPreferGpuBackend(): Promise<void> {
  if (!tfjsBackendPromise) {
    tfjsBackendPromise = (async () => {
      const tf = await import('@tensorflow/tfjs')

      async function tryBackend(name: string): Promise<boolean> {
        try {
          await tf.setBackend(name)
          await tf.ready()
          return tf.getBackend() === name
        } catch {
          return false
        }
      }

      const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { gpu?: GPU }) : null
      if (nav?.gpu) {
        try {
          await import('@tensorflow/tfjs-backend-webgpu')
          if (await tryBackend('webgpu')) return
        } catch {
          // No WebGPU adapter, permission, or bundler/runtime mismatch
        }
      }

      if (await tryBackend('webgl')) return

      if (await tryBackend('wasm')) return

      await tf.setBackend('cpu')
      await tf.ready()
    })()
  }
  return tfjsBackendPromise
}
