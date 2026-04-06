/**
 * Normalized center square crop on a video frame. Use with
 * `recognizeForVideo(video, ts, { regionOfInterest })` so MediaPipe gets full
 * IMAGE_DIMENSIONS and a square pixel ROI — avoids NORM_RECT warnings from
 * passing a canvas-only crop without dimensions.
 */
export function centerSquareRegionOfInterest(
  videoWidth: number,
  videoHeight: number,
): { left: number; top: number; right: number; bottom: number } | null {
  if (videoWidth <= 0 || videoHeight <= 0) return null
  const dim = Math.min(videoWidth, videoHeight)
  const sx = (videoWidth - dim) / 2
  const sy = (videoHeight - dim) / 2
  return {
    left: sx / videoWidth,
    top: sy / videoHeight,
    right: (sx + dim) / videoWidth,
    bottom: (sy + dim) / videoHeight,
  }
}
