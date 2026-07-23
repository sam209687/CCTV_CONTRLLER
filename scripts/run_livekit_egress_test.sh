#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CAMERA_ID="${2:-cam-1772515015057}"
DURATION_SECONDS="${3:-}"

cd "$PROJECT_ROOT"

bash scripts/show_livekit_egress_s3.sh

printf '\nImportant: the phone must already show WEBRTC LIVE.\n'
printf 'This proof test creates one short MP4 in the configured bucket.\n\n'

if [[ -n "$DURATION_SECONDS" ]]; then
  node \
    scripts/record_livekit_participant_test.js \
    "$CAMERA_ID" \
    "$DURATION_SECONDS"
else
  node \
    scripts/record_livekit_participant_test.js \
    "$CAMERA_ID"
fi
