"use strict";

const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const backendUrl = String(
  process.env.CCTV_BACKEND_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`,
).replace(/\/+$/, "");

const token = String(
  process.env.CCTV_DASHBOARD_TOKEN || "",
).trim();

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function api(pathname, options = {}) {
  const response = await fetch(
    `${backendUrl}${pathname}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    },
  );

  const payload =
    await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error ||
        `HTTP ${response.status}`,
    );
  }

  return payload;
}

async function waitForExport(id) {
  const deadline = Date.now() + 120000;

  while (Date.now() < deadline) {
    const result = await api(
      `/recording-exports/${encodeURIComponent(
        id,
      )}`,
    );

    if (
      result.export.status === "COMPLETED"
    ) {
      return result.export;
    }

    if (
      result.export.status === "FAILED"
    ) {
      throw new Error(
        result.export.errorMessage ||
          "Export failed",
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 750),
    );
  }

  throw new Error(
    "Timed out waiting for export",
  );
}

async function download(item) {
  const response = await fetch(
    `${backendUrl}${item.downloadPath}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  const body = Buffer.from(
    await response.arrayBuffer(),
  );

  requireValue(
    response.ok,
    `Download failed: HTTP ${response.status}`,
  );

  requireValue(
    body.length > 100,
    "Downloaded file is empty",
  );

  return {
    status: response.status,
    contentType:
      response.headers.get("content-type"),
    sizeBytes: body.length,
  };
}

async function main() {
  requireValue(
    token,
    "CCTV_DASHBOARD_TOKEN is missing",
  );

  const recordingList =
    await api("/recordings?limit=500");

  const recording =
    recordingList.recordings.find(
      (item) =>
        Number(item.durationSeconds) >= 10,
    ) ||
    recordingList.recordings[0];

  requireValue(
    recording,
    "No indexed recording was found",
  );

  const duration = Number(
    recording.durationSeconds,
  );

  const snapshotRequest = await api(
    `/recordings/${encodeURIComponent(
      recording.id,
    )}/exports/snapshot`,
    {
      method: "POST",
      body: JSON.stringify({
        timestampSeconds: Math.min(
          5,
          duration - 0.5,
        ),
      }),
    },
  );

  const snapshot = await waitForExport(
    snapshotRequest.export.id,
  );

  const snapshotDownload =
    await download(snapshot);

  const clipRequest = await api(
    `/recordings/${encodeURIComponent(
      recording.id,
    )}/exports/clip`,
    {
      method: "POST",
      body: JSON.stringify({
        startSeconds: 1,
        endSeconds: Math.min(4, duration),
      }),
    },
  );

  const clip = await waitForExport(
    clipRequest.export.id,
  );

  const clipDownload =
    await download(clip);

  await api(
    `/recording-exports/${encodeURIComponent(
      snapshot.id,
    )}`,
    { method: "DELETE" },
  );

  await api(
    `/recording-exports/${encodeURIComponent(
      clip.id,
    )}`,
    { method: "DELETE" },
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        phase: "11I-L3B1A",
        recording: recording.fileName,
        snapshot: {
          checksum:
            snapshot.checksumSha256,
          download: snapshotDownload,
        },
        clip: {
          checksum:
            clip.checksumSha256,
          download: clipDownload,
        },
        cleanup: true,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    error.stack || error.message || error,
  );
  process.exitCode = 1;
});
