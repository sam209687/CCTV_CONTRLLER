"use strict";

require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");

const {
  EgressClient,
  EncodedFileOutput,
  S3Upload,
} = require("livekit-server-sdk");

const EGRESS_STATUS_NAMES = {
  0: "STARTING",
  1: "ACTIVE",
  2: "ENDING",
  3: "COMPLETE",
  4: "FAILED",
  5: "ABORTED",
  6: "LIMIT_REACHED",
};

function fail(message) {
  throw new Error(message);
}

function normalizeCameraId(value) {
  return String(value || "")
    .replace(/^smartphone:/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .slice(0, 120);
}

function getRoomName(cameraId) {
  return `camera-${cameraId}`;
}

function getParticipantIdentity(cameraId) {
  return `camera:${cameraId}`;
}

function getHttpLiveKitUrl(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\/+$/, "");

  if (normalized.startsWith("wss://")) {
    return `https://${normalized.slice("wss://".length)}`;
  }

  if (normalized.startsWith("ws://")) {
    return `http://${normalized.slice("ws://".length)}`;
  }

  return normalized;
}

function getRequired(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    fail(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getBoolean(name, fallback) {
  const value = String(
    process.env[name] ?? fallback,
  )
    .trim()
    .toLowerCase();

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  fail(`${name} must be true or false`);
}

function getDurationSeconds() {
  const fromArgument = Number(process.argv[3]);

  const fromEnvironment = Number(
    process.env.LIVEKIT_EGRESS_TEST_SECONDS ||
      60,
  );

  const value = Number.isFinite(fromArgument)
    ? fromArgument
    : fromEnvironment;

  if (
    !Number.isInteger(value) ||
    value < 10 ||
    value > 600
  ) {
    fail(
      "Proof-test duration must be a whole number between 10 and 600 seconds",
    );
  }

  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function timestampForFile(date) {
  return date
    .toISOString()
    .replace(/[:.]/g, "-");
}

function bigintToNumber(value) {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number)
      ? number
      : String(value);
  }

  return value;
}

function sanitizeEgressInfo(info) {
  return {
    egressId: info?.egressId || null,
    roomId: info?.roomId || null,
    roomName: info?.roomName || null,
    status:
      EGRESS_STATUS_NAMES[
        Number(info?.status)
      ] || String(info?.status),
    startedAt: bigintToNumber(
      info?.startedAt,
    ),
    endedAt: bigintToNumber(
      info?.endedAt,
    ),
    updatedAt: bigintToNumber(
      info?.updatedAt,
    ),
    error: info?.error || null,
    fileResults: (info?.fileResults || []).map(
      (file) => ({
        filename: file.filename || null,
        startedAt: bigintToNumber(
          file.startedAt,
        ),
        endedAt: bigintToNumber(
          file.endedAt,
        ),
        durationNanoseconds: bigintToNumber(
          file.duration,
        ),
        sizeBytes: bigintToNumber(file.size),
        location: file.location || null,
      }),
    ),
  };
}

async function readEgress(
  client,
  egressId,
) {
  const results = await client.listEgress({
    egressId,
    active: true,
  });

  return results[0] || null;
}

async function waitForActive(
  client,
  egressId,
) {
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline) {
    const info = await readEgress(
      client,
      egressId,
    );

    if (!info) {
      await sleep(1000);
      continue;
    }

    const status = Number(info.status);

    if (status === 1) {
      return info;
    }

    if ([3, 4, 5, 6].includes(status)) {
      fail(
        `Egress ended before becoming active: ${
          EGRESS_STATUS_NAMES[status] || status
        } ${info.error || ""}`.trim(),
      );
    }

    await sleep(1500);
  }

  fail(
    "Egress did not become active within 45 seconds. Confirm that the camera is WEBRTC LIVE.",
  );
}

async function main() {
  const cameraId = normalizeCameraId(
    process.argv[2],
  );

  if (!cameraId) {
    fail(
      "Usage: node scripts/record_livekit_participant_test.js <camera-id> [seconds]",
    );
  }

  const durationSeconds =
    getDurationSeconds();

  const livekitUrl = getHttpLiveKitUrl(
    getRequired("LIVEKIT_URL"),
  );

  const apiKey = getRequired(
    "LIVEKIT_API_KEY",
  );

  const apiSecret = getRequired(
    "LIVEKIT_API_SECRET",
  );

  const bucket = getRequired(
    "LIVEKIT_EGRESS_S3_BUCKET",
  );

  const accessKey = getRequired(
    "LIVEKIT_EGRESS_S3_ACCESS_KEY",
  );

  const secret = getRequired(
    "LIVEKIT_EGRESS_S3_SECRET",
  );

  const region = String(
    process.env.LIVEKIT_EGRESS_S3_REGION ||
      "auto",
  ).trim();

  const endpoint = String(
    process.env.LIVEKIT_EGRESS_S3_ENDPOINT ||
      "",
  ).trim();

  const forcePathStyle = getBoolean(
    "LIVEKIT_EGRESS_S3_FORCE_PATH_STYLE",
    endpoint ? "true" : "false",
  );

  const prefix = String(
    process.env.LIVEKIT_EGRESS_RECORDING_PREFIX ||
      "cctv-recordings",
  )
    .trim()
    .replace(/^\/+|\/+$/g, "");

  const now = new Date();
  const datePath = now
    .toISOString()
    .slice(0, 10);

  const objectPath = [
    prefix,
    cameraId,
    datePath,
    `${cameraId}_${timestampForFile(now)}_proof.mp4`,
  ]
    .filter(Boolean)
    .join("/");

  const output = new EncodedFileOutput({
    filepath: objectPath,
    output: {
      case: "s3",
      value: new S3Upload({
        accessKey,
        secret,
        region,
        endpoint,
        bucket,
        forcePathStyle,
        metadata: {
          cameraId,
          recordingMode: "PROOF_TEST",
        },
        contentDisposition:
          `attachment; filename="${path.basename(
            objectPath,
          )}"`,
      }),
    },
  });

  const roomName = getRoomName(cameraId);
  const identity =
    getParticipantIdentity(cameraId);

  const client = new EgressClient(
    livekitUrl,
    apiKey,
    apiSecret,
  );

  console.log("Starting LiveKit Participant Egress proof test");
  console.log(`  Camera: ${cameraId}`);
  console.log(`  Room: ${roomName}`);
  console.log(`  Participant: ${identity}`);
  console.log(`  Duration: ${durationSeconds}s`);
  console.log(`  Bucket: ${bucket}`);
  console.log(`  Object: ${objectPath}`);
  console.log("  Storage secrets are not displayed.");
  console.log();

  const started = await client.startParticipantEgress(
    roomName,
    identity,
    {
      file: output,
    },
    {
      screenShare: false,
    },
  );

  const egressId = started.egressId;

  if (!egressId) {
    fail(
      "LiveKit did not return an Egress ID.",
    );
  }

  console.log(`Egress ID: ${egressId}`);
  console.log("Waiting for the camera track...");

  const activeInfo = await waitForActive(
    client,
    egressId,
  );

  console.log(
    `Egress active: ${
      EGRESS_STATUS_NAMES[
        Number(activeInfo.status)
      ] || activeInfo.status
    }`,
  );

  const recordingStartedAt = Date.now();

  while (
    Date.now() - recordingStartedAt <
    durationSeconds * 1000
  ) {
    const elapsed = Math.floor(
      (Date.now() - recordingStartedAt) /
        1000,
    );

    const remaining =
      durationSeconds - elapsed;

    process.stdout.write(
      `\rRecording proof video: ${remaining}s remaining   `,
    );

    await sleep(1000);
  }

  process.stdout.write(
    "\nStopping Egress and finalizing MP4...\n",
  );

  const stopped = await client.stopEgress(
    egressId,
  );

  const safeResult =
    sanitizeEgressInfo(stopped);

  const outputDirectory = path.join(
    process.cwd(),
    "logs",
    "egress-tests",
  );

  await fs.mkdir(outputDirectory, {
    recursive: true,
  });

  const reportPath = path.join(
    outputDirectory,
    `${cameraId}_${timestampForFile(
      new Date(),
    )}.json`,
  );

  await fs.writeFile(
    reportPath,
    JSON.stringify(safeResult, null, 2),
    "utf8",
  );

  console.log();
  console.log(
    JSON.stringify(safeResult, null, 2),
  );

  console.log();
  console.log(`Safe report: ${reportPath}`);

  if (
    [4, 5, 6].includes(
      Number(stopped.status),
    )
  ) {
    fail(
      `Egress did not complete successfully: ${
        stopped.error ||
        EGRESS_STATUS_NAMES[
          Number(stopped.status)
        ]
      }`,
    );
  }

  console.log(
    "Proof recording request completed. Confirm the MP4 object in the configured bucket.",
  );
}

main().catch((error) => {
  console.error();
  console.error(
    `LiveKit Egress proof test failed: ${
      error?.message || String(error)
    }`,
  );

  process.exitCode = 1;
});
