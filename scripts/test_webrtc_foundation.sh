#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.." &&
  pwd
)"

set -a
# shellcheck disable=SC1091
source "$PROJECT_ROOT/.env"
set +a

BACKEND_URL="${1:-http://127.0.0.1:3000}"
CAMERA_ID="${2:-cam-1772515015057}"

CAMERA_ENV_KEY="$(
  printf '%s' "$CAMERA_ID" |
    tr '[:lower:]' '[:upper:]' |
    sed 's/[^A-Z0-9]/_/g'
)"
CAMERA_ENV_KEY="CCTV_CAMERA_TOKEN_${CAMERA_ENV_KEY}"
CAMERA_TOKEN="${!CAMERA_ENV_KEY:-}"

[[ -n "$CAMERA_TOKEN" ]] || {
  echo "Camera token is missing: $CAMERA_ENV_KEY" >&2
  exit 1
}

echo "WebRTC status:"
curl -fsS "$BACKEND_URL/webrtc/status" |
  python3 -m json.tool

echo
echo "Camera token endpoint:"
curl -fsS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Camera-Id: $CAMERA_ID" \
  -H "X-Camera-Token: $CAMERA_TOKEN" \
  --data "{\"cameraId\":\"$CAMERA_ID\"}" \
  "$BACKEND_URL/webrtc/token/camera" |
  python3 -c '
import json
import sys

value = json.load(sys.stdin)
value["participant_token"] = "<REDACTED>"
print(json.dumps(value, indent=2))
'

echo
echo "Viewer token endpoint:"
curl -fsS \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CCTV_DASHBOARD_TOKEN" \
  --data "{\"cameraId\":\"$CAMERA_ID\"}" \
  "$BACKEND_URL/webrtc/token/viewer" |
  python3 -c '
import json
import sys

value = json.load(sys.stdin)
value["participant_token"] = "<REDACTED>"
print(json.dumps(value, indent=2))
'
