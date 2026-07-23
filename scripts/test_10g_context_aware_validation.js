"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

const phone = fs.readFileSync(
  path.join(
    root,
    "smartphone-camera-app",
    "components",
    "SimpleCameraStream.tsx",
  ),
  "utf8",
);

const server = fs.readFileSync(
  path.join(root, "server.js"),
  "utf8",
);

function extractListener(
  source,
  eventName,
) {
  const quoted =
    `socket.on("${eventName}"`;

  let start = source.indexOf(quoted);

  if (start < 0) {
    const multiline =
      `socket.on(\n    "${eventName}"`;

    start = source.indexOf(multiline);
  }

  if (start < 0) {
    throw new Error(
      `Listener not found: ${eventName}`,
    );
  }

  let end = source.indexOf(
    "\n  socket.on(",
    start + 20,
  );

  if (end < 0) {
    end = Math.min(
      source.length,
      start + 7000,
    );
  }

  return source.slice(start, end);
}

const healthBlock = extractListener(
  server,
  "camera:health",
);

const recordingBlock = extractListener(
  server,
  "camera:recording-status",
);

const recordAsyncMatch = phone.match(
  /await\s+(?:recordingCamera|cameraRef\.current)\s*\.\s*recordAsync\s*\(/,
);

const recordAsyncIndex = recordAsyncMatch
  ? phone.indexOf(recordAsyncMatch[0])
  : -1;

const statusEvents = [
  ...phone.matchAll(
    /["']camera:recording-status["']/g,
  ),
].map((match) => match.index);

const beforeRecordAsync =
  statusEvents.filter(
    (index) =>
      index >= 0 &&
      recordAsyncIndex >= 0 &&
      index < recordAsyncIndex,
  ).length;

const afterRecordAsync =
  statusEvents.filter(
    (index) =>
      index >= 0 &&
      recordAsyncIndex >= 0 &&
      index > recordAsyncIndex,
  ).length;

const checks = {
  phoneRestored:
    phone.split(/\r?\n/).length >= 700,

  phoneHealthPresent:
    phone.includes("camera:health"),

  exactlyTwoExplicitPhoneEvents:
    statusEvents.length === 2,

  startEventBeforeRecordAsync:
    beforeRecordAsync === 1,

  stopEventAfterRecordAsync:
    afterRecordAsync === 1,

  explicitServerHandlerUsesPayload:
    /camera\.isRecording\s*=\s*Boolean\(payload\.isRecording\)\s*;/.test(
      recordingBlock,
    ),

  healthHandlerDoesNotUsePayload:
    !/camera\.isRecording\s*=\s*Boolean\(payload\.isRecording\)\s*;/.test(
      healthBlock,
    ),

  healthHandlerPreservesExplicitState:
    /camera\.isRecording\s*=\s*Boolean\(camera\.isRecording\)\s*;/.test(
      healthBlock,
    ),

  markerPresent:
    server.includes(
      "PATCH_10G_H_CONTEXT_AWARE_VALIDATION",
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
