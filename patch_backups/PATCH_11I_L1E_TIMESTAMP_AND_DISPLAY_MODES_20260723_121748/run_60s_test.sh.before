#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CAMERA="${1:-cam-1772515015057}"
SECONDS="${2:-60}"
[[ -x "$HERE/.venv/bin/python" ]] || {
  echo "Run bash $HERE/install_worker.sh first" >&2
  exit 1
}
printf '\nPhone requirement: WEBRTC LIVE\n'
printf 'Camera: %s\nDuration: %ss\n\n' "$CAMERA" "$SECONDS"
exec "$HERE/.venv/bin/python" "$HERE/local_recorder.py" \
  --env-file "$ROOT/.env" \
  --camera-id "$CAMERA" \
  --seconds "$SECONDS"
