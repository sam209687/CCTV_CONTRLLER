#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

CAMERA="${1:-cam-1772515015057}"
SECONDS_TO_RECORD="${2:-60}"
DISPLAY_MODE="${3:-${CCTV_RECORDER_DISPLAY_MODE:-portrait}}"
FIT_MODE="${4:-${CCTV_RECORDER_FIT_MODE:-contain}}"

[[ -x "$HERE/.venv/bin/python" ]] || {
  echo "Run bash $HERE/install_worker.sh first" >&2
  exit 1
}

printf '\nPhone requirement: WEBRTC LIVE\n'
printf 'Camera: %s\n' "$CAMERA"
printf 'Duration: %ss\n' "$SECONDS_TO_RECORD"
printf 'Display mode: %s\n' "$DISPLAY_MODE"
printf 'Fit mode: %s\n\n' "$FIT_MODE"

exec "$HERE/.venv/bin/python" "$HERE/local_recorder.py" \
  --env-file "$ROOT/.env" \
  --camera-id "$CAMERA" \
  --seconds "$SECONDS_TO_RECORD" \
  --display-mode "$DISPLAY_MODE" \
  --fit-mode "$FIT_MODE"
