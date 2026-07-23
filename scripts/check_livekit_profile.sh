#!/usr/bin/env bash
set -Eeuo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_URL="${1:-http://127.0.0.1:3000}"
CAMERA_ID="${2:-cam-1772515015057}"
set -a
# shellcheck disable=SC1090
source "$PROJECT_ROOT/.env"
set +a

bash "$PROJECT_ROOT/scripts/show_livekit_profile.sh"
echo
python3 - "${LIVEKIT_URL:-}" <<'PY'
from urllib.parse import urlparse
import socket, ssl, sys
u=urlparse(sys.argv[1])
if u.scheme not in {"ws","wss"} or not u.hostname: raise SystemExit("Invalid LIVEKIT_URL")
port=u.port or (443 if u.scheme=="wss" else 80)
s=socket.create_connection((u.hostname,port),timeout=8)
if u.scheme=="wss": s=ssl.create_default_context().wrap_socket(s,server_hostname=u.hostname)
print(f"LiveKit host reachable: {u.hostname}:{port}")
s.close()
PY

echo
echo "Backend WebRTC status:"
curl -fsS "$BACKEND_URL/webrtc/status" | python3 -m json.tool

echo
echo "Secure camera token test:"
bash "$PROJECT_ROOT/scripts/test_webrtc_foundation.sh" "$BACKEND_URL" "$CAMERA_ID"
