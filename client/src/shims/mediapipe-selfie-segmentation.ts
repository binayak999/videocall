/**
 * @mediapipe/selfie_segmentation ships a UMD-ish bundle that registers `SelfieSegmentation`
 * on globalThis instead of ESM exports. @tensorflow-models/body-segmentation expects a named export.
 */
import '@mediapipe/selfie_segmentation/selfie_segmentation.js'

type SelfieCtor = new (config?: { locateFile?: (file: string) => string }) => {
  close(): Promise<void>
  onResults(cb: (results: unknown) => void): void
  initialize(): Promise<void>
  reset(): void
  send(inputs: { image: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement }): Promise<void>
  setOptions(options: { selfieMode?: boolean; modelSelection?: number }): void
}

const Global = globalThis as typeof globalThis & { SelfieSegmentation?: SelfieCtor }

export const SelfieSegmentation: SelfieCtor =
  Global.SelfieSegmentation ??
  (() => {
    throw new Error('SelfieSegmentation failed to load (mediapipe bundle)')
  })()

export const VERSION = '0.1.1675465747'
