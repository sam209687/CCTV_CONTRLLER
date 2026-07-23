#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$PROJECT_ROOT/.env"

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

[[ -f "$ENV_FILE" ]] ||
  fail "Missing .env: $ENV_FILE"

printf '\nLiveKit Egress S3-compatible storage configuration\n'
printf 'The API secret and storage secret will not be printed.\n\n'

read -r -p "Storage provider name [s3-compatible]: " PROVIDER
PROVIDER="${PROVIDER:-s3-compatible}"

read -r -p "Bucket name: " BUCKET
[[ -n "$BUCKET" ]] ||
  fail "Bucket name is required."

read -r -p "Region [auto]: " REGION
REGION="${REGION:-auto}"

read -r -p "HTTPS endpoint (leave blank only for AWS S3): " ENDPOINT

if [[ -n "$ENDPOINT" && "$ENDPOINT" != https://* ]]; then
  fail "A custom S3 endpoint must begin with https://"
fi

read -r -p "Access key ID: " ACCESS_KEY
[[ -n "$ACCESS_KEY" ]] ||
  fail "Access key is required."

read -r -s -p "Secret access key: " SECRET
printf '\n'

[[ -n "$SECRET" ]] ||
  fail "Secret access key is required."

DEFAULT_FORCE_PATH_STYLE="true"

if [[ -z "$ENDPOINT" ]]; then
  DEFAULT_FORCE_PATH_STYLE="false"
fi

read -r -p \
  "Force path style [$DEFAULT_FORCE_PATH_STYLE]: " \
  FORCE_PATH_STYLE

FORCE_PATH_STYLE="${
  FORCE_PATH_STYLE:-$DEFAULT_FORCE_PATH_STYLE
}"

case "$FORCE_PATH_STYLE" in
  true|false)
    ;;
  *)
    fail "Force path style must be true or false."
    ;;
esac

read -r -p \
  "Recording path prefix [cctv-recordings]: " \
  PREFIX

PREFIX="${PREFIX:-cctv-recordings}"
PREFIX="$(
  printf '%s' "$PREFIX" |
    sed -E 's#^/+##; s#/+$##'
)"

read -r -p \
  "Proof-test duration in seconds [60]: " \
  TEST_SECONDS

TEST_SECONDS="${TEST_SECONDS:-60}"

[[ "$TEST_SECONDS" =~ ^[0-9]+$ ]] ||
  fail "Test duration must be a whole number."

if (( TEST_SECONDS < 10 || TEST_SECONDS > 600 )); then
  fail "Proof-test duration must be between 10 and 600 seconds."
fi

read -r -p \
  "Final CCTV segment duration in seconds [1800]: " \
  SEGMENT_SECONDS

SEGMENT_SECONDS="${SEGMENT_SECONDS:-1800}"

[[ "$SEGMENT_SECONDS" =~ ^[0-9]+$ ]] ||
  fail "Segment duration must be a whole number."

if (( SEGMENT_SECONDS < 60 || SEGMENT_SECONDS > 10800 )); then
  fail "Segment duration must be between 60 and 10800 seconds."
fi

python3 - \
  "$ENV_FILE" \
  "$PROVIDER" \
  "$BUCKET" \
  "$REGION" \
  "$ENDPOINT" \
  "$ACCESS_KEY" \
  "$SECRET" \
  "$FORCE_PATH_STYLE" \
  "$PREFIX" \
  "$TEST_SECONDS" \
  "$SEGMENT_SECONDS" <<'PY'
from __future__ import annotations

import os
import sys
from pathlib import Path

env_path = Path(sys.argv[1])

values = {
    "LIVEKIT_EGRESS_STORAGE_PROVIDER": sys.argv[2],
    "LIVEKIT_EGRESS_S3_BUCKET": sys.argv[3],
    "LIVEKIT_EGRESS_S3_REGION": sys.argv[4],
    "LIVEKIT_EGRESS_S3_ENDPOINT": sys.argv[5],
    "LIVEKIT_EGRESS_S3_ACCESS_KEY": sys.argv[6],
    "LIVEKIT_EGRESS_S3_SECRET": sys.argv[7],
    "LIVEKIT_EGRESS_S3_FORCE_PATH_STYLE": sys.argv[8],
    "LIVEKIT_EGRESS_RECORDING_PREFIX": sys.argv[9],
    "LIVEKIT_EGRESS_TEST_SECONDS": sys.argv[10],
    "LIVEKIT_EGRESS_SEGMENT_SECONDS": sys.argv[11],
}

lines = env_path.read_text(
    encoding="utf-8",
    errors="replace",
).splitlines()

output: list[str] = []
seen: set[str] = set()

for line in lines:
    if (
        "=" not in line
        or line.lstrip().startswith("#")
    ):
        output.append(line)
        continue

    key = line.split("=", 1)[0].strip()

    if key in values:
        output.append(f"{key}={values[key]}")
        seen.add(key)
    else:
        output.append(line)

if output and output[-1].strip():
    output.append("")

if not any(
    line.strip() == "# LiveKit Egress recording"
    for line in output
):
    output.append("# LiveKit Egress recording")

for key, value in values.items():
    if key not in seen:
        output.append(f"{key}={value}")

temporary = env_path.with_name(
    f".{env_path.name}.tmp-{os.getpid()}"
)

temporary.write_text(
    "\n".join(output).rstrip() + "\n",
    encoding="utf-8",
)

temporary.chmod(0o600)
temporary.replace(env_path)
env_path.chmod(0o600)
PY

printf '\nEgress storage configuration saved.\n'
printf 'Secrets were not printed.\n'
printf 'Run: bash scripts/show_livekit_egress_s3.sh\n'
