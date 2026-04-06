/** Minimal `ImageData` for Vitest (JSDOM’s binding is not constructible in this context). */
class ImageDataMock {
  data: Uint8ClampedArray
  width: number
  height: number

  constructor(sw: number | Uint8ClampedArray, sh: number, sh2?: number) {
    if (typeof sw === 'number') {
      this.width = sw
      this.height = sh
      this.data = new Uint8ClampedArray(sw * sh * 4)
    } else {
      this.data = sw
      this.width = sh
      this.height = sh2 ?? Math.floor(sw.length / (4 * sh))
    }
  }
}

Object.defineProperty(globalThis, 'ImageData', {
  value: ImageDataMock,
  writable: true,
  configurable: true,
})
