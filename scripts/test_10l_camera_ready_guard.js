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

const checks = {
  startHandlerRequiresReady:
    /const\s+startMp4Recording[\s\S]{0,700}if\s*\(\s*!isCameraReady\s*\)/.test(
      phone,
    ),

  transitionMessagePresent:
    phone.includes(
      "Camera preview is still changing mode. Wait for Camera Ready, then press Start.",
    ),

  buttonDisabledDuringTransition:
    /disabled\s*=\s*\{\s*!isConnected\s*\|\|\s*!isCameraReady\s*\}/.test(
      phone,
    ),

  preparingLabelPresent:
    phone.includes("… Preparing Camera"),

  pictureReadyMessagePresent:
    phone.includes(
      "Camera ready. Press Start MP4 Recording.",
    ),

  videoReadyMessagePresent:
    phone.includes(
      "Video camera ready. Initializing MP4 recorder…",
    ),

  nativeRecordingCallStillPresent:
    /video\s*=\s*await\s+recordingCamera\.recordAsync\s*\(/.test(
      phone,
    ),

  lifecycleMarkersStillPresent:
    phone.includes(
      "PATCH_10G_RECOVER_AND_REPAIR_NATIVE_STATE",
    ) &&
    phone.includes(
      "PATCH_10G_I_FIX_VIDEO_ASSIGNMENT_ORDER",
    ),

  patchMarkerPresent:
    phone.includes(
      "PATCH_10L_CAMERA_READY_TRANSITION_GUARD",
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
