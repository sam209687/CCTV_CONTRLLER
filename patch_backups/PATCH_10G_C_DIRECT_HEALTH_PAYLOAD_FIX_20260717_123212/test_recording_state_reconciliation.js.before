"use strict";

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(
  __dirname,
  "..",
);

const phone = fs.readFileSync(
  path.join(
    projectRoot,
    "smartphone-camera-app",
    "components",
    "SimpleCameraStream.tsx",
  ),
  "utf8",
);

const server = fs.readFileSync(
  path.join(projectRoot, "server.js"),
  "utf8",
);

const recordCall =
  /await\s+(?:recordingCamera|cameraRef\.current)\s*\.\s*recordAsync\s*\(/;

const trueIndex = phone.indexOf(
  "reportRecordingStatus(true);",
);

const callMatch = phone.match(recordCall);
const callIndex = callMatch
  ? phone.indexOf(callMatch[0])
  : -1;

const checks = {
  helperAdded:
    phone.includes(
      "const reportRecordingStatus = useCallback(",
    ),
  trueImmediatelyBeforeNativeCall:
    trueIndex >= 0 &&
    callIndex >= 0 &&
    trueIndex < callIndex &&
    callIndex - trueIndex < 500,
  nativeCleanupReportsFalse:
    /reportRecordingStatus\(false\);[\s\S]{0,220}nativeRecordingActiveRef\.current\s*=\s*false;/.test(
      phone,
    ),
  loopCleanupReportsFalse:
    /reportRecordingStatus\(false\);[\s\S]{0,220}recordingLoopRunningRef\.current\s*=\s*false;/.test(
      phone,
    ),
  heartbeatUsesNativeState:
    phone.includes(
      "isRecording:\n          nativeRecordingActiveRef.current",
    ) ||
    phone.includes(
      "isRecording: nativeRecordingActiveRef.current",
    ),
  backendStartsIdle:
    /signalStatus:\s*"idle"/.test(server),
  patchMarkerPresent:
    phone.includes(
      "PATCH_10G_A_ADAPTIVE_RECORDING_STATE_RECONCILIATION",
    ) &&
    server.includes(
      "PATCH_10G_A_ADAPTIVE_RECORDING_STATE_RECONCILIATION",
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
