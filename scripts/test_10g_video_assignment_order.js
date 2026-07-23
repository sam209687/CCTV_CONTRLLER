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

const eventMatches = [
  ...phone.matchAll(
    /["']camera:recording-status["']/g,
  ),
];

const recordAsyncMatch = phone.match(
  /await\s+recordingCamera\.recordAsync\s*\(/,
);

const videoAssignmentMatch = phone.match(
  /video\s*=\s*await\s+recordingCamera\.recordAsync\s*\(/,
);

const malformedAssignment =
  /video\s*=\s*socketRef\.current\?\.emit\s*\(/.test(
    phone,
  ) ||
  /video\s*=\s*\n\s*socketRef\.current\?\.emit\s*\(/.test(
    phone,
  );

const startEventMatch = phone.match(
  /socketRef\.current\?\.emit\([\s\S]*?["']camera:recording-status["'][\s\S]*?isRecording:\s*true[\s\S]*?\);/,
);

const stopEventMatch = phone.match(
  /socketRef\.current\?\.emit\([\s\S]*?["']camera:recording-status["'][\s\S]*?isRecording:\s*false[\s\S]*?\);/,
);

const startEventIndex = startEventMatch
  ? phone.indexOf(startEventMatch[0])
  : -1;

const recordAsyncIndex = recordAsyncMatch
  ? phone.indexOf(recordAsyncMatch[0])
  : -1;

const stopEventIndex = stopEventMatch
  ? phone.indexOf(stopEventMatch[0])
  : -1;

const checks = {
  exactlyTwoRecordingStatusEvents:
    eventMatches.length === 2,

  noEmitAssignedToVideo:
    !malformedAssignment,

  videoAssignedFromRecordAsync:
    Boolean(videoAssignmentMatch),

  startEventBeforeRecordAsync:
    startEventIndex >= 0 &&
    recordAsyncIndex >= 0 &&
    startEventIndex < recordAsyncIndex,

  stopEventAfterRecordAsync:
    stopEventIndex >= 0 &&
    recordAsyncIndex >= 0 &&
    stopEventIndex > recordAsyncIndex,

  recoveryMarkerPresent:
    phone.includes(
      "PATCH_10G_RECOVER_AND_REPAIR_NATIVE_STATE",
    ),

  assignmentFixMarkerPresent:
    phone.includes(
      "PATCH_10G_I_FIX_VIDEO_ASSIGNMENT_ORDER",
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
