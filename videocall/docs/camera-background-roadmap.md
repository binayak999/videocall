# Camera background: Meet/Zoom-class roadmap

This document tracks work to move from the legacy TensorFlow.js + MediaPipe Selfie (solutions) stack toward **GPU-first Tasks**, **off-main-thread inference**, and **WebGPU compositing**.

## Environment flags (client)

| Variable | Values | Purpose |
|----------|--------|---------|
| `VITE_CAMERA_BG_ENGINE` | `legacy` (default), `tasks-worker` | Segmentation backend |
| `VITE_CAMERA_BG_COMPOSITE` | `canvas2d` (default), `webgpu` | Final composite path (WebGPU falls back to 2D when unavailable) |

## Phase A — MediaPipe Tasks Image Segmenter (GPU delegate)

- [x] **A1** Add dedicated worker: `cameraSegmentationWorker.ts` loads `ImageSegmenter` with `delegate: 'GPU'` and `OffscreenCanvas`, falls back to CPU.
- [x] **A2** Use official Tasks model: `selfie_segmenter` float16 from `storage.googleapis.com/mediapipe-models/...`.
- [x] **A3** Main thread posts `ImageBitmap` + monotonic timestamp; worker returns `Float32Array` confidence mask (transferable).
- [x] **A4** Wire `startCameraBackgroundPipeline` behind `VITE_CAMERA_BG_ENGINE=tasks-worker`.

### Follow-ups

- [ ] Host Tasks **WASM** same-origin (like `public/mediapipe/selfie_segmentation/`) for strict CSP.
- [ ] Optional **local model** asset to avoid Google Storage dependency offline.

## Phase B — WebGPU end-to-end compositing

- [x] **B1** `tryCreateWebGpuBackgroundRenderer`: `navigator.gpu` + `getContext('webgpu')` probe.
- [x] **B2** Per frame: `copyExternalImageToTexture` from `<video>` + R8 mask upload; fullscreen pass `mix(bg, fg, mask)`.
- [x] **B3** **Blur mode**: 9-tap approximate background blur in WGSL (tunable `blurUvRadius`).
- [ ] **B4** **Image background**: bind static/albedo `texture_2d` + mip sampling (currently falls back to Canvas2D for `image` mode when using WebGPU renderer is optional — implement full parity).
- [ ] **B5** **captureStream** validation matrix: Chrome / Edge / Safari + note Firefox gaps.
- [ ] **B6** Optional: **half-float** masks + soft feather without Canvas2D `filter: blur()`.

## Phase C — Worker offload (main-thread jank)

- [x] **C1** Segmentation runs entirely inside the worker; main thread only `createImageBitmap` + render/composite.
- [ ] **C2** Optional second worker for **mask post-process** (temporal filter, morphology) if profiling shows main-thread cost.
- [ ] **C3** `requestVideoFrameCallback` + **frame dropping** policy when worker queue depth > 1 (keep-latest).

## Phase D — Quality & parity tuning

- [ ] **D1** Match output resolution policy (540 cap vs dynamic) to encoder bitrate (LiveKit simulcast).
- [ ] **D2** A/B temporal blend coefficients for Tasks vs legacy masks.
- [ ] **D3** Latency HUD (dev-only): inference ms, composite ms, dropped frames.

## Phase E — Testing

- [x] **E1** Unit tests for mask helpers (`cameraMaskUtils.test.ts`) via Vitest.
- [ ] **E2** Playwright smoke: enable virtual background, assert processed track `readyState === live` (requires fake camera or permission mocks).
- [ ] **E3** Manual QA checklist: laptop iGPU, discrete GPU, Safari, Firefox fallback.

## Agent / CI commands

```bash
cd client && yarn test:unit
cd client && yarn build
```

---

**Note:** Meet/Zoom use **native** stacks; full parity in pure web is constrained by browser APIs, encoder behavior, and model choice. This roadmap prioritizes measurable wins: **higher mask update rate**, **less main-thread blocking**, and **GPU compositing** where supported.
