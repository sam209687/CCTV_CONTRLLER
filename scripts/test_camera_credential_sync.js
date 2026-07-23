"use strict";

require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const cameraId = String(
  process.argv[2] || "cam-1772515015057",
)
  .trim()
  .toLowerCase();

function envKey(cameraIdValue) {
  return `CCTV_CAMERA_TOKEN_${cameraIdValue
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;
}

function parseEnv(filePath) {
  const result = {};

  if (!fs.existsSync(filePath)) {
    return result;
  }

  const text = fs.readFileSync(
    filePath,
    "utf8",
  );

  text.split(/\r?\n/).forEach((line) => {
    let current = line.trim();

    if (
      !current ||
      current.startsWith("#")
    ) {
      return;
    }

    if (current.startsWith("export ")) {
      current = current.slice(7).trim();
    }

    const separator = current.indexOf("=");

    if (separator < 1) {
      return;
    }

    const key = current
      .slice(0, separator)
      .trim();

    const value = current
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");

    result[key] = value;
  });

  return result;
}

function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

const projectRoot = path.resolve(
  __dirname,
  "..",
);

const phoneRoot = path.join(
  projectRoot,
  "smartphone-camera-app",
);

const backendToken = String(
  process.env[envKey(cameraId)] || "",
).trim();

if (!backendToken) {
  throw new Error(
    `Backend explicit token is missing: ${envKey(cameraId)}`,
  );
}

const phoneFiles = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
];

const results = phoneFiles.map((fileName) => {
  const filePath = path.join(
    phoneRoot,
    fileName,
  );

  const token = String(
    parseEnv(filePath)
      .EXPO_PUBLIC_CCTV_CAMERA_TOKEN || "",
  ).trim();

  return {
    fileName,
    exists: fs.existsSync(filePath),
    configured: Boolean(token),
    matchesBackend:
      Boolean(token) &&
      token === backendToken,
    fingerprint:
      token ? fingerprint(token) : null,
  };
});

const allSynchronized = results.every(
  (result) =>
    result.configured &&
    result.matchesBackend,
);

console.log(
  JSON.stringify(
    {
      ok: allSynchronized,
      cameraId,
      backendEnvironmentKey:
        envKey(cameraId),
      backendFingerprint:
        fingerprint(backendToken),
      phoneEnvironments: results,
    },
    null,
    2,
  ),
);

if (!allSynchronized) {
  process.exitCode = 1;
}
