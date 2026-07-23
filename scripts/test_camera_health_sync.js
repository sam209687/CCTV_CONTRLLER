"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

const server = fs.readFileSync(
  path.join(root, "server.js"),
  "utf8",
);

const viewer = fs.readFileSync(
  path.join(
    root,
    "CCTV",
    "mobile-app",
    "components",
    "camera",
    "MJPEGViewer.tsx",
  ),
  "utf8",
);

const checks = {
  backendHealthRequest:
    server.includes('"viewer:health:get"'),
  backendImmediatePush:
    server.includes(
      "emitCameraHealthToSocket(",
    ),
  backendPeriodicPush:
    server.includes(
      "cameraHealthBroadcastTimer",
    ),
  dashboardHealthRequest:
    viewer.includes('"viewer:health:get"'),
  dashboardHeartbeatTimeout:
    viewer.includes(
      "Camera heartbeat timed out",
    ),
  dashboardPreviewReconciliation:
    viewer.includes(
      "Boolean(payload.previewActive)",
    ),
};

const ok = Object.values(checks).every(Boolean);

console.log(
  JSON.stringify(
    {
      ok,
      checks,
    },
    null,
    2,
  ),
);

if (!ok) {
  process.exitCode = 1;
}
