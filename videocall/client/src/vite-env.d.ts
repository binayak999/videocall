/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string
  readonly VITE_RECAPTCHA_SITE_KEY?: string
  readonly VITE_USE_LIVEKIT?: string
  /** `legacy` | `tasks-worker` — see docs/camera-background-roadmap.md */
  readonly VITE_CAMERA_BG_ENGINE?: string
  /** `canvas2d` | `webgpu` — WebGPU composite only for blur or solid image background */
  readonly VITE_CAMERA_BG_COMPOSITE?: string
}
