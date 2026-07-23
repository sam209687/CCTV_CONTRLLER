"use strict";

require("dotenv").config();

const crypto = require("crypto");

const cameraId =
  process.argv[2] || "cam-1772515015057";

const masterSecret =
  String(
    process.env.CCTV_DEVICE_MASTER_SECRET || "",
  ).trim();

const dashboardToken =
  String(
    process.env.CCTV_DASHBOARD_TOKEN || "",
  ).trim();

if (!masterSecret || !dashboardToken) {
  throw new Error(
    "Required CCTV security secrets are missing",
  );
}

const cameraToken = crypto
  .createHmac("sha256", masterSecret)
  .update(`camera:${cameraId}`)
  .digest("base64url");

function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      cameraId,
      cameraTokenConfigured:
        Boolean(cameraToken),
      cameraTokenFingerprint:
        fingerprint(cameraToken),
      dashboardTokenConfigured:
        Boolean(dashboardToken),
      dashboardTokenFingerprint:
        fingerprint(dashboardToken),
      securityRequired:
        String(
          process.env.CCTV_SECURITY_REQUIRED ||
            "true",
        ).toLowerCase() !== "false",
      playbackUrlTtlSeconds:
        Number(
          process.env
            .CCTV_PLAYBACK_URL_TTL_SECONDS ||
            3600,
        ),
    },
    null,
    2,
  ),
);
