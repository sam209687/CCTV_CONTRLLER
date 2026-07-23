"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "server.js"),
  "utf8",
);

const match = source.match(
  /function getEffectiveCameraSignalStatus\([\s\S]*?\n\}/,
);

if (!match) {
  throw new Error(
    "getEffectiveCameraSignalStatus() not found",
  );
}

const previewRequests = new Map();
const sandbox = { previewRequests };

vm.createContext(sandbox);

vm.runInContext(
  `${match[0]}
   this.statusFor =
     getEffectiveCameraSignalStatus;`,
  sandbox,
);

const statusFor = sandbox.statusFor;

const cases = [
  [
    "offline",
    "cam-a",
    null,
    "offline",
  ],
  [
    "idle without viewers",
    "cam-a",
    {
      isRecording: false,
      previewActive: false,
      signalStatus: "waiting",
    },
    "idle",
  ],
  [
    "recording",
    "cam-a",
    {
      isRecording: true,
      previewActive: false,
      signalStatus: "waiting",
    },
    "recording",
  ],
  [
    "waiting for first frame",
    "cam-b",
    {
      isRecording: false,
      previewActive: true,
      signalStatus: "idle",
    },
    "waiting",
  ],
  [
    "live",
    "cam-c",
    {
      isRecording: false,
      previewActive: true,
      signalStatus: "live",
    },
    "live",
  ],
];

previewRequests.set(
  "cam-b",
  new Set(["viewer-1"]),
);

previewRequests.set(
  "cam-c",
  new Set(["viewer-2"]),
);

for (const [
  name,
  cameraId,
  camera,
  expected,
] of cases) {
  const actual = statusFor(cameraId, camera);

  if (actual !== expected) {
    throw new Error(
      `${name}: expected ${expected}, got ${actual}`,
    );
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      idleWithoutViewers: true,
      states: cases.map(
        (entry) => entry[3],
      ),
    },
    null,
    2,
  ),
);
