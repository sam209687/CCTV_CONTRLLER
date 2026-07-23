#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.." &&
  pwd
)"

CONFIG_FILE="$PROJECT_ROOT/config/livekit.dev.yaml"

[[ -f "$CONFIG_FILE" ]] || {
  echo "Missing LiveKit config: $CONFIG_FILE" >&2
  exit 1
}

LAN_IP="$(
  sed -nE \
    's/^[[:space:]]*node_ip:[[:space:]]*"?([^"[:space:]]+)"?[[:space:]]*$/\1/p' \
    "$CONFIG_FILE" |
    head -n 1
)"

[[ -n "$LAN_IP" ]] || {
  echo "Could not read rtc.node_ip." >&2
  exit 1
}

echo "Configured LiveKit LAN address: $LAN_IP"
echo

echo "PC address ownership:"
ip -4 address show |
  grep -F "inet ${LAN_IP}/" ||
  true

echo
echo "Listening ports:"
ss -ltnup 2>/dev/null |
  grep -E ':(3000|7880|7881|7882)\b' ||
  true

echo
echo "Expected:"
echo "  TCP 3000  CCTV control/token backend"
echo "  TCP 7880  LiveKit signaling"
echo "  TCP 7881  WebRTC ICE/TCP fallback"
echo "  UDP 7882  WebRTC ICE/UDP media"
echo

echo "Backend WebRTC status:"
curl -fsS \
  "http://127.0.0.1:3000/webrtc/status" |
  python3 -m json.tool

echo
echo "ADB reverse mappings:"
adb reverse --list 2>/dev/null ||
  true

echo
echo "Phone TCP reachability:"
for port in 3000 7880 7881; do
  printf '  %s:%s -> ' "$LAN_IP" "$port"

  if adb shell \
    "toybox nc -z -w 3 '$LAN_IP' '$port'" \
    >/dev/null 2>&1; then
    echo "reachable"
  else
    echo "not confirmed"
  fi
done

echo
echo "The UDP 7882 path is verified by the LiveKit ICE connection,"
echo "not by a normal TCP port probe."
