/**
 * Client-side frame classification for outgoing camera video.
 * ML moderation is imperfect (false positives/negatives); tune thresholds and
 * pair with human review for production compliance programs.
 */

export type ModerationScores = Record<string, number>

export interface FrameModerationResult {
  violation: boolean
  scores?: ModerationScores
}

const PORN_THRESHOLD = 0.82
const HENTAI_THRESHOLD = 0.88

function moderationDisabled(): boolean {
  return (import.meta.env as Record<string, string | undefined>).VITE_CAMERA_MODERATION === 'false'
}

type NsfwModel = { classify: (img: HTMLVideoElement | HTMLCanvasElement) => Promise<{ className: string; probability: number }[]> }

let modelLoadPromise: Promise<NsfwModel> | null = null

export function preloadModerationModel(): void {
  if (moderationDisabled()) return
  void getModerationModel()
}

async function getModerationModel(): Promise<NsfwModel> {
  if (!modelLoadPromise) {
    modelLoadPromise = (async () => {
      const { ensureTfjsPreferGpuBackend } = await import('./tfjsPreferGpuBackend')
      await ensureTfjsPreferGpuBackend()
      const ns = await import('nsfwjs')
      return ns.load() as Promise<NsfwModel>
    })()
  }
  return modelLoadPromise
}

export async function classifyCameraFrame(video: HTMLVideoElement): Promise<FrameModerationResult> {
  if (moderationDisabled()) return { violation: false }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return { violation: false }
  if (video.videoWidth < 16 || video.videoHeight < 16) return { violation: false }

  try {
    const model = await getModerationModel()
    const predictions = await model.classify(video)
    const scores: ModerationScores = {}
    for (const p of predictions) scores[p.className] = p.probability

    const porn = scores.Porn ?? 0
    const hentai = scores.Hentai ?? 0
    const violation = porn >= PORN_THRESHOLD || hentai >= HENTAI_THRESHOLD

    return { violation, scores }
  } catch {
    return { violation: false }
  }
}
