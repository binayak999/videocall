type WorkerOutbound =
  | { type: 'ready' }
  | { type: 'init_error'; message: string }
  | { type: 'result'; id: number; width: number; height: number; mask: ArrayBuffer }
  | { type: 'segment_error'; id: number; message: string }

type Pending = { resolve: (v: SegmentationResult) => void; reject: (e: Error) => void }

export type SegmentationResult = { width: number; height: number; confidence: Float32Array }

/** Main-thread wrapper for `cameraSegmentationWorker.ts`. */
export class CameraSegmentationBridge {
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, Pending>()

  constructor() {
    this.worker = new Worker(new URL('../workers/cameraSegmentationWorker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = (ev: MessageEvent<WorkerOutbound>) => {
      const msg = ev.data
      if (msg.type === 'ready' || msg.type === 'init_error') return
      if (msg.type === 'segment_error') {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          p.reject(new Error(msg.message))
        }
        return
      }
      if (msg.type === 'result') {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          const confidence = new Float32Array(msg.mask)
          p.resolve({ width: msg.width, height: msg.height, confidence })
        }
      }
    }
  }

  async init(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onMsg = (ev: MessageEvent<WorkerOutbound>) => {
        const m = ev.data
        if (m.type === 'ready') {
          cleanup()
          resolve()
        } else if (m.type === 'init_error') {
          cleanup()
          reject(new Error(m.message))
        }
      }
      const cleanup = () => this.worker.removeEventListener('message', onMsg)
      this.worker.addEventListener('message', onMsg)
      this.worker.postMessage({ type: 'init' })
    })
  }

  segment(bitmap: ImageBitmap, timestampMs: number): Promise<SegmentationResult> {
    const id = this.nextId++
    return new Promise<SegmentationResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.worker.postMessage({ type: 'segment', id, timestamp: timestampMs, bitmap }, [bitmap])
      } catch (e) {
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  close(): void {
    this.worker.postMessage({ type: 'close' })
    this.worker.terminate()
    this.pending.clear()
  }
}
