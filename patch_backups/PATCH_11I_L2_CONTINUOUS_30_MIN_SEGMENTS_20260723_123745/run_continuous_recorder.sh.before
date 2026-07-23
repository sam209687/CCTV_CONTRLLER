#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

CAMERA_ID="${1:-${CCTV_RECORDER_CAMERA_ID:-cam-1772515015057}}"
SEGMENT_SECONDS="${2:-${CCTV_RECORDER_SEGMENT_SECONDS:-1800}}"
DISPLAY_MODE="${3:-${CCTV_RECORDER_DISPLAY_MODE:-portrait}}"
FIT_MODE="${4:-${CCTV_RECORDER_FIT_MODE:-contain}}"

[[ -x "$HERE/.venv/bin/python" ]] || {
  echo "Recorder virtual environment is missing." >&2
  exit 1
}

printf '\nContinuous local CCTV recording\n'
printf '  Camera: %s\n' "$CAMERA_ID"
printf '  Segment duration: %ss\n' "$SEGMENT_SECONDS"
printf '  Display mode: %s\n' "$DISPLAY_MODE"
printf '  Fit mode: %s\n' "$FIT_MODE"
printf '  Stop safely with Ctrl+C or stop_continuous_recorder.sh\n\n'

exec "$HERE/.venv/bin/python" \
  "$HERE/continuous_recorder.py" \
  --env-file "$ROOT/.env" \
  --camera-id "$CAMERA_ID" \
  --segment-seconds "$SEGMENT_SECONDS" \
  --display-mode "$DISPLAY_MODE" \
  --fit-mode "$FIT_MODE"
