"use strict";

const path = require("path");

require("dotenv").config({
  path: path.resolve(
    __dirname,
    "..",
    ".env",
  ),
});

const server = String(
  process.env.CCTV_AI_BACKEND_URL ||
    "http://127.0.0.1:3000",
).replace(/\/+$/, "");

const token = String(
  process.env.CCTV_DASHBOARD_TOKEN ||
    "",
).trim();

const cameraId = String(
  process.env.CCTV_AI_CAMERA_ID ||
    process.env
      .CCTV_RECORDER_CAMERA_ID ||
    "cam-1772515015057",
).trim();

async function request(
  pathname,
  options = {},
) {
  const response = await fetch(
    `${server}${pathname}`,
    {
      ...options,
      headers: {
        Authorization:
          `Bearer ${token}`,
        "Content-Type":
          "application/json",
        ...(options.headers || {}),
      },
    },
  );

  const payload =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error ||
        `HTTP ${response.status}`,
    );
  }

  return payload;
}

async function main() {
  if (!token) {
    throw new Error(
      "CCTV_DASHBOARD_TOKEN is missing",
    );
  }

  const saved = await request(
    `/ai/config/${encodeURIComponent(
      cameraId,
    )}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        customerZone: [
          0,
          0,
          0.65,
          1,
        ],
        staffZone: [
          0.65,
          0,
          1,
          1,
        ],
      }),
    },
  );

  const readBack = await request(
    `/ai/config/${encodeURIComponent(
      cameraId,
    )}`,
  );

  const runtime =
    await request(
      "/ai/runtime-health",
    );

  if (
    saved.config.splitPercent !==
      65 ||
    readBack.config.splitPercent !==
      65
  ) {
    throw new Error(
      "Zone configuration was not persisted",
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        phase: "11J-B1",
        cameraId,
        splitPercent:
          readBack.config
            .splitPercent,
        aiWorker:
          runtime.aiWorker
            ?.state || null,
        recorder:
          runtime.recorder
            ?.state || null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    error.stack ||
      error.message ||
      error,
  );

  process.exitCode = 1;
});
