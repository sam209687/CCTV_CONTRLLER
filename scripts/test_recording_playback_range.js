"use strict";

const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const backendUrl = String(
  process.env.CCTV_BACKEND_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`,
).replace(/\/+$/, "");

const dashboardToken = String(
  process.env.CCTV_DASHBOARD_TOKEN || "",
).trim();

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readRange(url, range) {
  const response = await fetch(url, {
    headers: {
      Range: range,
    },
  });

  const body = Buffer.from(
    await response.arrayBuffer(),
  );

  return {
    status: response.status,
    acceptRanges: response.headers.get("accept-ranges"),
    contentRange: response.headers.get("content-range"),
    contentLength: Number(
      response.headers.get("content-length") || 0,
    ),
    bodyLength: body.length,
  };
}

async function main() {
  requireCondition(
    dashboardToken,
    "CCTV_DASHBOARD_TOKEN is missing from .env",
  );

  const listResponse = await fetch(
    `${backendUrl}/recordings?limit=500`,
    {
      headers: {
        Authorization: `Bearer ${dashboardToken}`,
      },
    },
  );

  requireCondition(
    listResponse.ok,
    `Recording list failed with HTTP ${listResponse.status}`,
  );

  const payload = await listResponse.json();
  const recordings = payload.recordings || [];
  const recording =
    recordings.find(
      (item) => Number(item.durationSeconds) >= 1200,
    ) || recordings[0];

  requireCondition(
    recording?.fileUrl,
    "No indexed recording with a playback URL was found",
  );

  const first = await readRange(
    recording.fileUrl,
    "bytes=0-4095",
  );

  const middleStart = Math.max(
    4096,
    Math.floor(Number(recording.sizeBytes) / 2),
  );

  const middle = await readRange(
    recording.fileUrl,
    `bytes=${middleStart}-${middleStart + 4095}`,
  );

  for (const [label, result] of Object.entries({
    first,
    middle,
  })) {
    requireCondition(
      result.status === 206,
      `${label} request returned HTTP ${result.status}`,
    );
    requireCondition(
      result.acceptRanges === "bytes",
      `${label} response is missing Accept-Ranges: bytes`,
    );
    requireCondition(
      /^bytes \d+-\d+\/\d+$/.test(
        result.contentRange || "",
      ),
      `${label} response has an invalid Content-Range`,
    );
    requireCondition(
      result.contentLength === result.bodyLength,
      `${label} Content-Length does not match its body`,
    );
    requireCondition(
      result.bodyLength === 4096,
      `${label} returned ${result.bodyLength} bytes instead of 4096`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        recording: {
          id: recording.id,
          fileName: recording.fileName,
          durationSeconds: recording.durationSeconds,
          sizeBytes: recording.sizeBytes,
        },
        first,
        middle,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
