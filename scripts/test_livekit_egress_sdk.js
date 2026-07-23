"use strict";

const {
  EgressClient,
  EncodedFileOutput,
  S3Upload,
} = require("livekit-server-sdk");

const checks = {
  EgressClient: typeof EgressClient === "function",
  EncodedFileOutput:
    typeof EncodedFileOutput === "function",
  S3Upload: typeof S3Upload === "function",
};

const output =
  checks.EncodedFileOutput && checks.S3Upload
    ? new EncodedFileOutput({
        filepath:
          "cctv-recordings/sdk-shape-test.mp4",
        output: {
          case: "s3",
          value: new S3Upload({
            accessKey: "test-access-key",
            secret: "test-secret",
            region: "auto",
            endpoint:
              "https://example.invalid",
            bucket: "test-bucket",
            forcePathStyle: true,
          }),
        },
      })
    : null;

checks.outputCreated = Boolean(
  output &&
  output.filepath &&
  output.output?.case === "s3",
);

const ok = Object.values(checks).every(Boolean);

console.log(
  JSON.stringify(
    {
      ok,
      sdk: require(
        "livekit-server-sdk/package.json",
      ).version,
      checks,
    },
    null,
    2,
  ),
);

if (!ok) {
  process.exit(1);
}
