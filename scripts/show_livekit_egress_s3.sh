#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$PROJECT_ROOT/.env"

[[ -f "$ENV_FILE" ]] || {
  echo "Missing .env: $ENV_FILE" >&2
  exit 1
}

node - "$ENV_FILE" <<'NODE'
"use strict";

const fs = require("fs");
const crypto = require("crypto");

const envPath = process.argv[2];

function parseEnv(path) {
  const result = {};

  for (const rawLine of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const separator = rawLine.indexOf("=");
    const key = rawLine.slice(0, separator).trim();
    let value = rawLine.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function fingerprint(value) {
  if (!value) {
    return "<missing>";
  }

  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 10);
}

const env = parseEnv(envPath);

console.log("LiveKit Egress recording configuration");
console.log(
  `  Provider: ${env.LIVEKIT_EGRESS_STORAGE_PROVIDER || "<missing>"}`,
);
console.log(
  `  Bucket: ${env.LIVEKIT_EGRESS_S3_BUCKET || "<missing>"}`,
);
console.log(
  `  Region: ${env.LIVEKIT_EGRESS_S3_REGION || "<missing>"}`,
);
console.log(
  `  Endpoint: ${env.LIVEKIT_EGRESS_S3_ENDPOINT || "<AWS default>"}`,
);
console.log(
  `  Force path style: ${env.LIVEKIT_EGRESS_S3_FORCE_PATH_STYLE || "<missing>"}`,
);
console.log(
  `  Prefix: ${env.LIVEKIT_EGRESS_RECORDING_PREFIX || "<missing>"}`,
);
console.log(
  `  Proof-test seconds: ${env.LIVEKIT_EGRESS_TEST_SECONDS || "<missing>"}`,
);
console.log(
  `  Final segment seconds: ${env.LIVEKIT_EGRESS_SEGMENT_SECONDS || "<missing>"}`,
);
console.log(
  `  Access-key fingerprint: ${fingerprint(
    env.LIVEKIT_EGRESS_S3_ACCESS_KEY,
  )}`,
);
console.log(
  `  Secret fingerprint: ${fingerprint(
    env.LIVEKIT_EGRESS_S3_SECRET,
  )}`,
);
console.log("  Storage credentials are not displayed.");
NODE
