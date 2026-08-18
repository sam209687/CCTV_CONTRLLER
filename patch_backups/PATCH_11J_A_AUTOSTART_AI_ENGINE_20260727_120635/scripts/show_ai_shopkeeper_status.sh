#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(
  cd "$(
    dirname "${BASH_SOURCE[0]}"
  )/.."
  pwd
)"

AI_STATUS="$ROOT/runtime/cctv-ai/ai_shopkeeper_status.json"
RECORDER_STATUS="$ROOT/runtime/cctv-recorder/continuous_recorder_status.json"

printf '\nSystem services:\n'

sudo systemctl \
  --no-pager \
  --full \
  status \
  root-seed-cctv-backend.service \
  root-seed-cctv-recorder.service \
  root-seed-cctv-ai.service \
  2>/dev/null || true

printf '\nAI worker status:\n'

if [[ -f "$AI_STATUS" ]]; then
  python3 -m json.tool \
    "$AI_STATUS"
else
  echo "No AI worker status file yet."
fi

printf '\nRecorder status:\n'

if [[ -f "$RECORDER_STATUS" ]]; then
  python3 -m json.tool \
    "$RECORDER_STATUS"
else
  echo "No recorder status file yet."
fi

printf '\nRecent AI service logs:\n'

sudo journalctl \
  -u root-seed-cctv-ai.service \
  --no-pager \
  -n 30
