#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAMERA="${1:-cam-1772515015057}"
SECONDS_TO_RECORD="${2:-60}"
FIT_MODE="${3:-cover}"

printf '\nLandscape recording selected.\n'
printf 'Mount the smartphone horizontally for the best full-screen result.\n'
printf 'The cover mode fills 16:9 and may crop a portrait source.\n\n'

exec "$HERE/run_60s_test.sh" \
  "$CAMERA" \
  "$SECONDS_TO_RECORD" \
  landscape \
  "$FIT_MODE"
