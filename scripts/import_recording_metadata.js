"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const script = path.join(
  __dirname,
  "index_local_recordings.js",
);

const result = spawnSync(
  process.execPath,
  [script, "--scan"],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status || 0;
