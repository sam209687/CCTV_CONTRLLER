#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RUNTIME_DIR="${CCTV_RECORDER_RUNTIME_DIR:-$ROOT/runtime/cctv-recorder}"
LOG_DIR="$ROOT/logs/cctv-recorder"
PID_FILE="$RUNTIME_DIR/continuous_recorder.pid"
LOG_FILE="$LOG_DIR/continuous.log"

CAMERA_ID="${1:-${CCTV_RECORDER_CAMERA_ID:-cam-1772515015057}}"
SEGMENT_SECONDS="${2:-${CCTV_RECORDER_SEGMENT_SECONDS:-1800}}"
DISPLAY_MODE="${3:-${CCTV_RECORDER_DISPLAY_MODE:-portrait}}"
FIT_MODE="${4:-${CCTV_RECORDER_FIT_MODE:-contain}}"

mkdir -p "$RUNTIME_DIR" "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(tr -cd '0-9' < "$PID_FILE")"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "Continuous recorder is already running with PID $EXISTING_PID" >&2
    exit 1
  fi
fi

nohup "$HERE/run_continuous_recorder.sh" \
  "$CAMERA_ID" \
  "$SEGMENT_SECONDS" \
  "$DISPLAY_MODE" \
  "$FIT_MODE" \
  >> "$LOG_FILE" 2>&1 &

LAUNCH_PID=$!
sleep 3

if ! kill -0 "$LAUNCH_PID" 2>/dev/null; then
  echo "Recorder failed to stay running. Recent log:" >&2
  tail -n 80 "$LOG_FILE" >&2 || true
  exit 1
fi

printf 'Continuous recorder started.\n'
printf 'PID: %s\n' "$LAUNCH_PID"
printf 'Log: %s\n' "$LOG_FILE"
printf 'Status: bash %s/show_continuous_status.sh\n' "$HERE"
