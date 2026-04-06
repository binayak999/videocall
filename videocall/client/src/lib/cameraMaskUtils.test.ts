import { describe, expect, it } from 'vitest'

import {
  applyTemporalMaskSmoothImageData,
  floatConfidenceToRgbaImageData,
} from './cameraMaskUtils'

describe('cameraMaskUtils', () => {
  it('floatConfidenceToRgbaImageData maps confidence to alpha', () => {
    const f = new Float32Array([0, 0.5, 1])
    const img = floatConfidenceToRgbaImageData(f, 3, 1)
    expect(img.width).toBe(3)
    expect(img.height).toBe(1)
    expect(img.data[3]).toBe(0)
    expect(img.data[7]).toBeGreaterThanOrEqual(127)
    expect(img.data[7]).toBeLessThanOrEqual(128)
    expect(img.data[11]).toBe(255)
  })

  it('applyTemporalMaskSmoothImageData blends consecutive frames', () => {
    const mk = (a: number) => {
      const d = new Uint8ClampedArray(4)
      d[0] = 255
      d[1] = 255
      d[2] = 255
      d[3] = a
      return new ImageData(d as ImageData['data'], 1, 1)
    }
    const state = { buffer: null as Uint8ClampedArray | null }
    const ref = { current: null as ImageData | null }
    applyTemporalMaskSmoothImageData(mk(100), state, 0.5, ref)
    const second = applyTemporalMaskSmoothImageData(mk(200), state, 0.5, ref)
    expect(second.data[3]).toBe(150)
  })
})
