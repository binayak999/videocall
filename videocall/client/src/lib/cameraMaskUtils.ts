/** Shared mask conversion / smoothing for legacy ImageData and Tasks Float32 masks. */

export const DEFAULT_MASK_TEMPORAL_BLEND = 0.38

export function floatConfidenceToRgbaImageData(
  confidence: Float32Array,
  width: number,
  height: number,
): ImageData {
  const n = width * height
  const rgba = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const a = Math.min(255, Math.max(0, Math.round(confidence[i]! * 255)))
    const o = i * 4
    rgba[o] = 255
    rgba[o + 1] = 255
    rgba[o + 2] = 255
    rgba[o + 3] = a
  }
  return new ImageData(rgba as ImageData['data'], width, height)
}

export type MaskSmoothState = { buffer: Uint8ClampedArray | null }

export function applyTemporalMaskSmoothImageData(
  maskImage: ImageData,
  state: MaskSmoothState,
  blend: number,
  smoothedRef: { current: ImageData | null },
): ImageData {
  const { data, width, height } = maskImage
  const len = data.length
  let buf = state.buffer
  if (!buf || buf.length !== len) {
    buf = new Uint8ClampedArray(len)
    buf.set(data)
    state.buffer = buf
    smoothedRef.current = new ImageData(buf as ImageData['data'], width, height)
    return smoothedRef.current
  }
  const inv = 1 - blend
  const b = blend
  for (let i = 0; i < len; i++) {
    buf[i] = (buf[i]! * inv + data[i]! * b) | 0
  }
  if (!smoothedRef.current || smoothedRef.current.width !== width || smoothedRef.current.height !== height) {
    smoothedRef.current = new ImageData(buf as ImageData['data'], width, height)
  }
  return smoothedRef.current
}

/** Scale mask canvas to output size and return single-channel alpha for WebGPU R8 upload. */
export function extractMaskAlphaR8Scaled(
  maskCanvas: HTMLCanvasElement,
  outW: number,
  outH: number,
  scratch: HTMLCanvasElement,
  scratchCtx: CanvasRenderingContext2D,
): Uint8Array {
  if (scratch.width !== outW || scratch.height !== outH) {
    scratch.width = outW
    scratch.height = outH
  }
  scratchCtx.drawImage(maskCanvas, 0, 0, outW, outH)
  const img = scratchCtx.getImageData(0, 0, outW, outH)
  const out = new Uint8Array(outW * outH)
  for (let i = 0; i < out.length; i++) {
    out[i] = img.data[i * 4 + 3]!
  }
  return out
}
