/// <reference lib="webworker" />

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

/** Keep in sync with `useVoteGestureRecognition` / package.json `@mediapipe/tasks-vision`. */
const TASKS_VISION_VERSION = '0.10.34'
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`

const SELFIE_SEGMENTER_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'

type Inbound = { type: 'init' } | { type: 'segment'; id: number; timestamp: number; bitmap: ImageBitmap } | { type: 'close' }

type Outbound =
  | { type: 'ready' }
  | { type: 'init_error'; message: string }
  | { type: 'result'; id: number; width: number; height: number; mask: ArrayBuffer }
  | { type: 'segment_error'; id: number; message: string }

let segmenter: ImageSegmenter | null = null

async function createSegmenterGpuFirst(): Promise<ImageSegmenter> {
  const wasm = await FilesetResolver.forVisionTasks(WASM_BASE)
  const gpuCanvas = new OffscreenCanvas(640, 480)
  const shared = {
    runningMode: 'VIDEO' as const,
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  }
  try {
    return await ImageSegmenter.createFromOptions(wasm, {
      ...shared,
      baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL, delegate: 'GPU' },
      canvas: gpuCanvas,
    })
  } catch {
    return await ImageSegmenter.createFromOptions(wasm, {
      ...shared,
      baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL, delegate: 'CPU' },
    })
  }
}

function post(o: Outbound, transfer?: Transferable[]) {
  if (transfer?.length) self.postMessage(o, transfer)
  else self.postMessage(o)
}

self.onmessage = (ev: MessageEvent<Inbound>) => {
  const msg = ev.data
  if (msg.type === 'close') {
    segmenter?.close()
    segmenter = null
    return
  }

  if (msg.type === 'init') {
    void (async () => {
      try {
        segmenter = await createSegmenterGpuFirst()
        post({ type: 'ready' })
      } catch (e) {
        post({ type: 'init_error', message: e instanceof Error ? e.message : String(e) })
      }
    })()
    return
  }

  if (msg.type === 'segment') {
    const { id, timestamp, bitmap } = msg
    const run = async () => {
      try {
        if (!segmenter) segmenter = await createSegmenterGpuFirst()
        const seg = segmenter
        seg.segmentForVideo(bitmap, timestamp, (result) => {
          try {
            const m = result.confidenceMasks?.[0]
            if (!m) {
              post({ type: 'segment_error', id, message: 'No confidence mask' })
              return
            }
            const mw = m.width
            const mh = m.height
            const f32 = m.getAsFloat32Array()
            const copy = new Float32Array(f32.length)
            copy.set(f32)
            m.close()
            post({ type: 'result', id, width: mw, height: mh, mask: copy.buffer }, [copy.buffer])
          } catch (e) {
            post({ type: 'segment_error', id, message: e instanceof Error ? e.message : String(e) })
          }
        })
      } catch (e) {
        post({ type: 'segment_error', id, message: e instanceof Error ? e.message : String(e) })
      } finally {
        bitmap.close()
      }
    }
    void run()
  }
}
