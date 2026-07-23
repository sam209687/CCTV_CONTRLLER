#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(
  cd "$(dirname "${BASH_SOURCE[0]}")" &&
  pwd
)"

RECORDINGS_DIR="${CCTV_RECORDINGS_DIR:-$HOME/CCTV_Recordings}"
CAMERA_ID="${1:-}"

COMMAND=(
  python3
  "$HERE/inspect_recording.py"
  --recordings-dir
  "$RECORDINGS_DIR"
)

if [[ -n "$CAMERA_ID" ]]; then
  COMMAND+=(
    --camera-id
    "$CAMERA_ID"
  )
fi

exec "${COMMAND[@]}"
