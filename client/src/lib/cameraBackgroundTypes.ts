export type CameraBackgroundEffectMode = 'blur' | 'image'

export interface CameraBackgroundPipeline {
  getRawTrack: () => MediaStreamTrack
  getProcessedTrack: () => MediaStreamTrack
  setMode: (mode: CameraBackgroundEffectMode) => void
  setBackgroundImage: (img: HTMLImageElement | null) => void
  setBlurAmount: (amount: number) => void
  stop: () => void
}
