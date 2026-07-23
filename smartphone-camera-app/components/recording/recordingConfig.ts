export const RECORDING_SEGMENT_SECONDS = 30;
export const RECORDING_VIDEO_QUALITY = "720p" as const;
export const RECORDING_WITH_AUDIO = false;
export const RECORDING_UPLOAD_TIMEOUT_MS = 120_000;

export function buildRecordingFileName(
  cameraId: string,
  startedAtIso: string,
): string {
  const safeCameraId = cameraId
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_");

  const safeTimestamp = startedAtIso
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "Z");

  return `${safeCameraId}_${safeTimestamp}.mp4`;
}