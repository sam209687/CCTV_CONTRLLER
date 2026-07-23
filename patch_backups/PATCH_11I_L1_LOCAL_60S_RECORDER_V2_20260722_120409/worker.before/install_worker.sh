#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"

python3 -m venv "$VENV" 2>/dev/null || {
  echo "Install venv support: sudo apt install -y python3-venv" >&2
  exit 1
}

"$VENV/bin/python" -m pip install --upgrade pip setuptools wheel
"$VENV/bin/python" -m pip install -r "$HERE/requirements.txt"

"$VENV/bin/python" - <<'PY'
from livekit import api, rtc
import livekit
print("Recorder dependencies ready")
print("livekit:", livekit.__version__)
print("RGB24 enum:", rtc.VideoBufferType.RGB24)
print("AccessToken:", api.AccessToken.__name__)
PY
