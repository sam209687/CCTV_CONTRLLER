#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

CAMERA_ID="${1:-${CCTV_RECORDER_CAMERA_ID:-cam-1772515015057}}"
SEGMENT_SECONDS="${2:-60}"
MAX_SEGMENTS="${3:-2}"
DISPLAY_MODE="${4:-landscape}"
FIT_MODE="${5:-cover}"

[[ -x "$HERE/.venv/bin/python" ]] || {
  echo "Recorder virtual environment is missing." >&2
  exit 1
}

printf '\nPhase 11I-L2 continuous segmentation test\n'
printf '  Camera: %s\n' "$CAMERA_ID"
printf '  Segment duration: %ss\n' "$SEGMENT_SECONDS"
printf '  Number of segments: %s\n' "$MAX_SEGMENTS"
printf '  Display mode: %s\n' "$DISPLAY_MODE"
printf '  Fit mode: %s\n' "$FIT_MODE"
printf '\nThe phone must already show WEBRTC LIVE.\n\n'

exec "$HERE/.venv/bin/python" \
  "$HERE/continuous_recorder.py" \
  --env-file "$ROOT/.env" \
  --camera-id "$CAMERA_ID" \
  --segment-seconds "$SEGMENT_SECONDS" \
  --max-segments "$MAX_SEGMENTS" \
  --display-mode "$DISPLAY_MODE" \
  --fit-mode "$FIT_MODE"
