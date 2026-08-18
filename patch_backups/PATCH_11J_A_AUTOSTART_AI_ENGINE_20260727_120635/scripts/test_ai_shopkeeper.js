"use strict";

const path = require("path");

require("dotenv").config({
  path: path.resolve(
    __dirname,
    "..",
    ".env",
  ),
});

const backendUrl = String(
  process.env.CCTV_AI_BACKEND_URL ||
    `http://127.0.0.1:${
      process.env.PORT || 3000
    }`,
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

function requireValue(
  condition,
  message,
) {
  if (!condition) {
    throw new Error(message);
  }
}

async function api(
  pathname,
  options = {},
) {
  const response = await fetch(
    `${backendUrl}${pathname}`,
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
        `HTTP ${response.status} for ${pathname}`,
    );
  }

  return payload;
}

async function main() {
  requireValue(
    token,
    "CCTV_DASHBOARD_TOKEN is missing",
  );

  const created = await api(
    "/ai/test/unattended",
    {
      method: "POST",
      body: JSON.stringify({
        cameraId,
      }),
    },
  );

  requireValue(
    created.createdEvent?.id,
    "Synthetic unattended event was not created",
  );

  const eventId =
    created.createdEvent.id;

  const acknowledged = await api(
    `/ai/events/${encodeURIComponent(
      eventId,
    )}/action`,
    {
      method: "PATCH",
      body: JSON.stringify({
        action: "ACKNOWLEDGE",
      }),
    },
  );

  requireValue(
    acknowledged.event.status ===
      "ACKNOWLEDGED",
    "Event acknowledgement failed",
  );

  const resolved = await api(
    `/ai/events/${encodeURIComponent(
      eventId,
    )}/action`,
    {
      method: "PATCH",
      body: JSON.stringify({
        action: "RESOLVE",
      }),
    },
  );

  requireValue(
    resolved.event.status ===
      "RESOLVED",
    "Event resolution failed",
  );

  const eventList = await api(
    `/ai/events?cameraId=${encodeURIComponent(
      cameraId,
    )}&limit=20`,
  );

  requireValue(
    eventList.events.some(
      (event) =>
        event.id === eventId,
    ),
    "Created AI event was not found in the event list",
  );

  const health =
    await api("/ai/health");

  requireValue(
    health.service ===
      "premium-ai-smart-shopkeeper",
    "Unexpected AI health response",
  );

  await api(
    `/ai/events/${encodeURIComponent(
      eventId,
    )}`,
    {
      method: "DELETE",
    },
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        phase: "11J-A",
        cameraId,
        state:
          created.state.state,
        plan: created.plan,
        eventWorkflow: {
          created: true,
          acknowledged: true,
          resolved: true,
          deletedTestEvent: true,
        },
        health: {
          enabled:
            health.enabled,
          cameraCount:
            health.cameraCount,
          onlineWorkers:
            health.onlineWorkers,
        },
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
