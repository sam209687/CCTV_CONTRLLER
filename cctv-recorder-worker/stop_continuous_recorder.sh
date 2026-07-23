#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RUNTIME_DIR="${CCTV_RECORDER_RUNTIME_DIR:-$ROOT/runtime/cctv-recorder}"
PID_FILE="$RUNTIME_DIR/continuous_recorder.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Continuous recorder is not running."
  exit 0
fi

PID="$(tr -cd '0-9' < "$PID_FILE")"

if [[ -z "$PID" ]] || ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "Continuous recorder is not running."
  exit 0
fi

printf 'Requesting safe stop for PID %s...\n' "$PID"
kill -TERM "$PID"

for _ in $(seq 1 60); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Continuous recorder stopped after finalizing its active segment."
    exit 0
  fi
  sleep 1
done

echo "Recorder is still finalizing after 60 seconds." >&2
echo "Do not use kill -9; inspect its log and status first." >&2
exit 1
