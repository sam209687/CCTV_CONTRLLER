#!/usr/bin/env bash
set -Eeuo pipefail

if command -v livekit-server >/dev/null 2>&1; then
  echo "LiveKit server is already installed:"
  livekit-server --version || true
  exit 0
fi

echo "Installing the official LiveKit server binary..."
curl -sSL https://get.livekit.io | bash

command -v livekit-server >/dev/null 2>&1 || {
  echo "LiveKit was installed, but livekit-server is not in PATH." >&2
  echo "Open a new terminal and run this script again." >&2
  exit 1
}

livekit-server --version || true
