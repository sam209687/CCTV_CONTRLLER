#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.." &&
  pwd
)"

CONFIG_FILE="$PROJECT_ROOT/config/livekit.dev.yaml"

command -v livekit-server >/dev/null 2>&1 || {
  echo "livekit-server is not installed." >&2
  echo "Run: bash scripts/install_livekit_server.sh" >&2
  exit 1
}

[[ -f "$CONFIG_FILE" ]] || {
  echo "LiveKit config is missing: $CONFIG_FILE" >&2
  exit 1
}

CONFIGURED_IP="$(
  sed -nE \
    's/^[[:space:]]*node_ip:[[:space:]]*"?([^"[:space:]]+)"?[[:space:]]*$/\1/p' \
    "$CONFIG_FILE" |
    head -n 1
)"

if [[ -z "$CONFIGURED_IP" ]]; then
  echo "rtc.node_ip is missing from $CONFIG_FILE" >&2
  exit 1
fi

if ! ip -4 address show |
  grep -Fq "inet ${CONFIGURED_IP}/"; then

  echo "Configured LiveKit node IP is not assigned to this PC:" >&2
  echo "  $CONFIGURED_IP" >&2
  echo >&2
  echo "Rerun Patch 11A-D with the current LAN IP." >&2
  exit 1
fi

echo "Starting LiveKit LAN development server"
echo "Signal:  ws://${CONFIGURED_IP}:7880"
echo "ICE/TCP: ${CONFIGURED_IP}:7881"
echo "ICE/UDP: ${CONFIGURED_IP}:7882"
echo "Config:  $CONFIG_FILE"
echo

exec livekit-server \
  --config "$CONFIG_FILE"
