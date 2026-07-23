#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RUNTIME_DIR="${CCTV_RECORDER_RUNTIME_DIR:-$ROOT/runtime/cctv-recorder}"
STATUS_FILE="$RUNTIME_DIR/continuous_recorder_status.json"
PID_FILE="$RUNTIME_DIR/continuous_recorder.pid"
RECORDINGS_DIR="${CCTV_RECORDINGS_DIR:-$HOME/CCTV_Recordings}"

if [[ -f "$PID_FILE" ]]; then
  PID="$(tr -cd '0-9' < "$PID_FILE")"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    printf 'Process: running (PID %s)\n' "$PID"
  else
    printf 'Process: stale PID file\n'
  fi
else
  printf 'Process: not running\n'
fi

printf '\nRecorder status:\n'
if [[ -f "$STATUS_FILE" ]]; then
  python3 -m json.tool "$STATUS_FILE"
else
  echo "No status file yet: $STATUS_FILE"
fi

printf '\nRecording storage:\n'
df -h "$RECORDINGS_DIR" | tail -n 2

printf '\nNewest finalized segments:\n'
python3 - "$RECORDINGS_DIR" <<'PY_LIST'
from pathlib import Path
import sys

root = Path(sys.argv[1]).expanduser()
files = sorted(
    (
        path
        for path in root.rglob("*.mp4")
        if not path.name.endswith(".partial.mp4")
    ),
    key=lambda path: path.stat().st_mtime_ns,
    reverse=True,
)

for path in files[:5]:
    print(path)
PY_LIST
