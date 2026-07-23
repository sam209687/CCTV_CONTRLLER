"use strict";

require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const dashboardRoot = path.join(
  projectRoot,
  "CCTV",
  "mobile-app",
);

function parseEnv(filePath) {
  const result = {};

  if (!fs.existsSync(filePath)) {
    return result;
  }

  fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
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

const backendToken = String(
  process.env.CCTV_DASHBOARD_TOKEN || "",
).trim();

if (!backendToken) {
  throw new Error(
    "Backend CCTV_DASHBOARD_TOKEN is missing",
  );
}

const envFiles = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
];

const results = envFiles.map((fileName) => {
  const values = parseEnv(
    path.join(dashboardRoot, fileName),
  );

  const token = String(
    values.EXPO_PUBLIC_CCTV_DASHBOARD_TOKEN ||
      "",
  ).trim();

  const serverUrl = String(
    values.EXPO_PUBLIC_CCTV_SERVER_URL ||
      values.EXPO_PUBLIC_SERVER_URL ||
      "",
  ).trim();

  return {
    fileName,
    tokenConfigured: Boolean(token),
    tokenMatchesBackend:
      token === backendToken,
    tokenFingerprint:
      token ? fingerprint(token) : null,
    serverUrl,
  };
});

const ok = results.every(
  (result) =>
    result.tokenConfigured &&
    result.tokenMatchesBackend &&
    Boolean(result.serverUrl),
);

console.log(
  JSON.stringify(
    {
      ok,
      backendFingerprint:
        fingerprint(backendToken),
      environments: results,
    },
    null,
    2,
  ),
);

if (!ok) {
  process.exitCode = 1;
}
