#!/usr/bin/env bash
set -Eeuo pipefail

NAME="PATCH_11J_A_AUTOSTART_AI_ENGINE"
ROOT="${1:-$HOME/Videos/backend-nextjs}"

SERVER="$ROOT/server.js"
PACKAGE="$ROOT/package.json"
SCHEMA="$ROOT/prisma/schema.prisma"
ENV_FILE="$ROOT/.env"

AI_DIR="$ROOT/cctv-ai-worker"
AI_WORKER="$AI_DIR/ai_shopkeeper_worker.py"
AI_REQUIREMENTS="$AI_DIR/requirements.txt"

AI_SERVER_DIR="$ROOT/server/ai"
AI_SERVER="$AI_SERVER_DIR/aiShopkeeperRoutes.js"

TEST_SCRIPT="$ROOT/scripts/test_ai_shopkeeper.js"
STATUS_SCRIPT="$ROOT/scripts/show_ai_shopkeeper_status.sh"

DEPLOY_DIR="$ROOT/deploy/systemd"

STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP="$ROOT/patch_backups/${NAME}_${STAMP}"

CURRENT_USER="$(id -un)"
CURRENT_GROUP="$(id -gn)"
HOME_DIR="$HOME"
NODE_BIN="$(command -v node)"
PYTHON_BIN="$(command -v python3)"

BACKEND_SERVICE="root-seed-cctv-backend.service"
RECORDER_SERVICE="root-seed-cctv-recorder.service"
AI_SERVICE="root-seed-cctv-ai.service"

log() {
  printf '\n[%s] %s\n' "$NAME" "$*"
}

fail() {
  printf '\n[%s] ERROR: %s\n' "$NAME" "$*" >&2
  exit 1
}

[[ "$EUID" -ne 0 ]] ||
  fail "Run this patch as your normal user, not with sudo."

[[ -f "$SERVER" ]] ||
  fail "server.js not found: $SERVER"

[[ -f "$PACKAGE" ]] ||
  fail "package.json not found: $PACKAGE"

[[ -f "$SCHEMA" ]] ||
  fail "Prisma schema not found: $SCHEMA"

[[ -f "$ENV_FILE" ]] ||
  fail ".env not found: $ENV_FILE"

[[ -x "$ROOT/cctv-recorder-worker/.venv/bin/python" ]] ||
  fail "Recorder virtual environment is missing."

command -v npm >/dev/null 2>&1 ||
  fail "npm is required"

command -v ffmpeg >/dev/null 2>&1 ||
  fail "FFmpeg is required"

command -v sudo >/dev/null 2>&1 ||
  fail "sudo is required for system services"

if ss -ltnp 2>/dev/null |
  grep -qE '0\.0\.0\.0:3000|127\.0\.0\.1:3000|\*:3000'; then

  fail "Port 3000 is active. Stop node server.js first."
fi

if pgrep -af \
  "$ROOT/cctv-recorder-worker/continuous_recorder.py" \
  >/dev/null 2>&1; then

  fail "Continuous recorder is running. Stop it safely first."
fi

if pgrep -af \
  "$ROOT/cctv-ai-worker/ai_shopkeeper_worker.py" \
  >/dev/null 2>&1; then

  fail "AI worker is already running."
fi

sudo -v

sudo systemctl stop \
  "$AI_SERVICE" \
  "$RECORDER_SERVICE" \
  "$BACKEND_SERVICE" \
  2>/dev/null || true

mkdir -p \
  "$BACKUP" \
  "$AI_DIR" \
  "$AI_SERVER_DIR" \
  "$(dirname "$TEST_SCRIPT")" \
  "$DEPLOY_DIR"

backup_file() {
  local file="$1"

  if [[ ! -e "$file" ]]; then
    return
  fi

  local relative="${file#$ROOT/}"
  mkdir -p "$BACKUP/$(dirname "$relative")"
  cp -a "$file" "$BACKUP/$relative"
}

backup_file "$SERVER"
backup_file "$PACKAGE"
backup_file "$SCHEMA"
backup_file "$AI_SERVER"
backup_file "$AI_WORKER"
backup_file "$AI_REQUIREMENTS"
backup_file "$TEST_SCRIPT"
backup_file "$STATUS_SCRIPT"

find "$ROOT/prisma" \
  -maxdepth 1 \
  -type f \
  -name '*.db*' \
  -exec cp -a {} "$BACKUP/" \; \
  2>/dev/null || true

log "Extending Prisma for Premium AI Shopkeeper"

python3 - "$SCHEMA" <<'PY_SCHEMA'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

if "streamCameraId" not in text:
    anchor = """  rtspUrl              String?
  isActive             Boolean @default(true)
"""

    replacement = """  rtspUrl              String?
  streamCameraId       String? @unique
  aiEnabled            Boolean @default(false)
  aiCustomerZone       String?
  aiStaffZone          String?
  isActive             Boolean @default(true)
"""

    if anchor not in text:
        raise SystemExit(
            "Camera field anchor not found"
        )

    text = text.replace(
        anchor,
        replacement,
        1,
    )

if "aiShopkeeperEnabled" not in text:
    anchor = """  maxCameras     Int @default(1)
  maxStorageDays Int @default(7)
  maxShops       Int @default(1)
"""

    replacement = """  maxCameras          Int     @default(1)
  maxStorageDays      Int     @default(7)
  maxShops            Int     @default(1)
  aiShopkeeperEnabled Boolean @default(false)
"""

    if anchor not in text:
        raise SystemExit(
            "Subscription limits anchor not found"
        )

    text = text.replace(
        anchor,
        replacement,
        1,
    )

if "model AiShopkeeperEvent {" not in text:
    model = r'''
// --------------------------------------------------
// Premium AI Smart Shopkeeper events
// Added by PATCH_11J_A_AUTOSTART_AI_ENGINE
// --------------------------------------------------
model AiShopkeeperEvent {
  id                    String   @id @default(cuid())
  cameraId              String
  eventType             String   @default("UNATTENDED_CUSTOMER")
  state                 String   @default("UNATTENDED_CUSTOMER")
  status                String   @default("OPEN")
  customerCount         Int      @default(0)
  staffCount            Int      @default(0)
  faceCount             Int      @default(0)
  confidence            Float?
  imageRelativePath     String?
  detectedAt            DateTime
  unattendedSince       DateTime?
  acknowledgedAt        DateTime?
  resolvedAt            DateTime?
  ownerAction           String?
  telegramSent          Boolean  @default(false)
  deliveryError         String?
  metadataJson          String?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@index([cameraId, detectedAt])
  @@index([status, detectedAt])
  @@index([eventType, detectedAt])
}

'''

    anchor = """// --------------------------------------------------
// CCTV MP4 recording metadata
"""

    if anchor not in text:
        raise SystemExit(
            "Recording model comment anchor not found"
        )

    text = text.replace(
        anchor,
        model + anchor,
        1,
    )

path.write_text(text, encoding="utf-8")
PY_SCHEMA

log "Creating AI Smart Shopkeeper backend"

cat > "$AI_SERVER" <<'JS_SERVER'
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function registerAiShopkeeperRoutes(
  app,
  {
    prisma,
    io,
    recordingsRoot,
  },
) {
  const premiumPlans = new Set([
    "premium",
    "premium_ai",
    "premium-ai",
    "business",
    "enterprise",
    "ai",
  ]);

  const eventRoot = path.resolve(
    process.env.CCTV_AI_EVENT_DIR ||
      path.join(recordingsRoot, "_AIEvents"),
  );

  const fallbackPlan = String(
    process.env.CCTV_AI_PLAN ||
      "PREMIUM_AI",
  )
    .trim()
    .toLowerCase();

  const aiGloballyEnabled =
    String(
      process.env.CCTV_AI_ENABLED ||
        "true",
    )
      .trim()
      .toLowerCase() !== "false";

  const unattendedSeconds = Math.max(
    1,
    Number(
      process.env.CCTV_AI_UNATTENDED_SECONDS ||
        20,
    ) || 20,
  );

  const clearSeconds = Math.max(
    1,
    Number(
      process.env.CCTV_AI_CLEAR_SECONDS ||
        5,
    ) || 5,
  );

  const eventCooldownSeconds = Math.max(
    1,
    Number(
      process.env
        .CCTV_AI_EVENT_COOLDOWN_SECONDS ||
        60,
    ) || 60,
  );

  const workerStaleSeconds = Math.max(
    5,
    Number(
      process.env.CCTV_AI_WORKER_STALE_SECONDS ||
        15,
    ) || 15,
  );

  const dashboardUrl = String(
    process.env.CCTV_PUBLIC_DASHBOARD_URL ||
      "http://127.0.0.1:8082",
  ).replace(/\/+$/, "");

  const cameraStates = new Map();

  fs.mkdirSync(eventRoot, {
    recursive: true,
  });

  function safeCameraId(value) {
    return String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 120);
  }

  function positiveInteger(value) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
      return 0;
    }

    return Math.max(
      0,
      Math.round(parsed),
    );
  }

  function validDate(value) {
    const date = new Date(
      value || Date.now(),
    );

    return Number.isNaN(date.getTime())
      ? new Date()
      : date;
  }

  function stateFor(cameraId) {
    if (!cameraStates.has(cameraId)) {
      cameraStates.set(cameraId, {
        cameraId,
        state: "UNKNOWN",
        unattendedSinceMs: null,
        clearSinceMs: null,
        activeEventId: null,
        lastEventAtMs: 0,
        lastDetectionAtMs: 0,
        lastWorkerHeartbeatAtMs: 0,
        customerCount: 0,
        staffCount: 0,
        faceCount: 0,
        confidence: null,
        detector: null,
        processingMilliseconds: null,
      });
    }

    return cameraStates.get(cameraId);
  }

  async function getPremiumAccess(cameraId) {
    const camera =
      await prisma.camera.findFirst({
        where: {
          OR: [
            { id: cameraId },
            { streamCameraId: cameraId },
          ],
        },
        include: {
          user: {
            include: {
              subscription: true,
            },
          },
        },
      });

    if (!camera) {
      return {
        enabled:
          aiGloballyEnabled &&
          premiumPlans.has(fallbackPlan),
        plan: fallbackPlan,
        cameraRecordId: null,
        telegramChatId:
          String(
            process.env
              .CCTV_OWNER_TELEGRAM_CHAT_ID ||
              process.env.TELEGRAM_CHAT_ID ||
              "",
          ).trim() || null,
      };
    }

    const subscription =
      camera.user?.subscription || null;

    const plan = String(
      subscription?.plan || "free",
    )
      .trim()
      .toLowerCase();

    const enabled =
      aiGloballyEnabled &&
      (
        camera.aiEnabled ||
        subscription?.aiShopkeeperEnabled ||
        premiumPlans.has(plan)
      );

    return {
      enabled,
      plan,
      cameraRecordId: camera.id,
      telegramChatId:
        camera.user?.telegramChatId ||
        String(
          process.env
            .CCTV_OWNER_TELEGRAM_CHAT_ID ||
            process.env.TELEGRAM_CHAT_ID ||
            "",
        ).trim() ||
        null,
    };
  }

  function serializeEvent(event) {
    let metadata = null;

    if (event.metadataJson) {
      try {
        metadata = JSON.parse(
          event.metadataJson,
        );
      } catch {
        metadata = null;
      }
    }

    return {
      id: event.id,
      cameraId: event.cameraId,
      eventType: event.eventType,
      state: event.state,
      status: event.status,
      customerCount:
        event.customerCount,
      staffCount: event.staffCount,
      faceCount: event.faceCount,
      confidence: event.confidence,
      snapshotPath:
        event.imageRelativePath
          ? `/ai/events/${encodeURIComponent(
              event.id,
            )}/snapshot`
          : null,
      detectedAt:
        event.detectedAt.toISOString(),
      unattendedSince:
        event.unattendedSince?.toISOString() ||
        null,
      acknowledgedAt:
        event.acknowledgedAt?.toISOString() ||
        null,
      resolvedAt:
        event.resolvedAt?.toISOString() ||
        null,
      ownerAction: event.ownerAction,
      telegramSent:
        event.telegramSent,
      deliveryError:
        event.deliveryError,
      metadata,
      createdAt:
        event.createdAt.toISOString(),
      updatedAt:
        event.updatedAt.toISOString(),
      liveDashboardPath:
        `/cameras?cameraId=${encodeURIComponent(
          event.cameraId,
        )}`,
    };
  }

  function serializeCameraState(state) {
    const now = Date.now();

    return {
      cameraId: state.cameraId,
      state: state.state,
      customerCount:
        state.customerCount,
      staffCount: state.staffCount,
      faceCount: state.faceCount,
      confidence: state.confidence,
      detector: state.detector,
      processingMilliseconds:
        state.processingMilliseconds,
      activeEventId:
        state.activeEventId,
      unattendedSince:
        state.unattendedSinceMs
          ? new Date(
              state.unattendedSinceMs,
            ).toISOString()
          : null,
      lastDetectionAt:
        state.lastDetectionAtMs
          ? new Date(
              state.lastDetectionAtMs,
            ).toISOString()
          : null,
      workerStatus:
        state.lastWorkerHeartbeatAtMs &&
        now -
          state.lastWorkerHeartbeatAtMs <=
          workerStaleSeconds * 1000
          ? "ONLINE"
          : "OFFLINE",
      heartbeatAgeSeconds:
        state.lastWorkerHeartbeatAtMs
          ? Math.round(
              (
                now -
                state.lastWorkerHeartbeatAtMs
              ) / 100
            ) / 10
          : null,
    };
  }

  async function saveSnapshot(
    cameraId,
    eventId,
    detectedAt,
    value,
  ) {
    if (!value) {
      return null;
    }

    const base64 = String(value)
      .replace(
        /^data:image\/jpeg;base64,/i,
        "",
      )
      .trim();

    if (
      !base64 ||
      base64.length > 4_000_000
    ) {
      return null;
    }

    const buffer = Buffer.from(
      base64,
      "base64",
    );

    if (
      buffer.length < 100 ||
      buffer.length > 3_000_000 ||
      buffer[0] !== 0xff ||
      buffer[1] !== 0xd8
    ) {
      return null;
    }

    const cameraFolder =
      safeCameraId(cameraId) || "camera";

    const year = String(
      detectedAt.getFullYear(),
    );

    const month = String(
      detectedAt.getMonth() + 1,
    ).padStart(2, "0");

    const day = String(
      detectedAt.getDate(),
    ).padStart(2, "0");

    const directory = path.join(
      eventRoot,
      "Snapshots",
      cameraFolder,
      year,
      month,
      day,
    );

    await fsp.mkdir(directory, {
      recursive: true,
    });

    const fileName =
      `${cameraFolder}_` +
      `${detectedAt
        .toISOString()
        .replace(/[:.]/g, "-")}_` +
      `${eventId}.jpg`;

    const finalPath = path.join(
      directory,
      fileName,
    );

    const temporaryPath = path.join(
      directory,
      `.${fileName}.tmp-${process.pid}`,
    );

    await fsp.writeFile(
      temporaryPath,
      buffer,
    );

    await fsp.rename(
      temporaryPath,
      finalPath,
    );

    return path
      .relative(eventRoot, finalPath)
      .split(path.sep)
      .join("/");
  }

  function resolveEventSnapshotPath(event) {
    if (!event.imageRelativePath) {
      return null;
    }

    const candidate = path.resolve(
      eventRoot,
      ...event.imageRelativePath
        .split("/")
        .filter(Boolean),
    );

    const relative = path.relative(
      eventRoot,
      candidate,
    );

    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(
        `..${path.sep}`,
      ) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        "AI event snapshot path is invalid",
      );
    }

    return candidate;
  }

  async function sendTelegram(
    event,
    access,
  ) {
    const botToken = String(
      process.env.TELEGRAM_BOT_TOKEN ||
        process.env
          .TELEGRAM_BOT_API_TOKEN ||
        "",
    ).trim();

    const chatId = String(
      access.telegramChatId || "",
    ).trim();

    if (!botToken || !chatId) {
      return {
        sent: false,
        error:
          "Telegram is not configured",
      };
    }

    const liveUrl =
      `${dashboardUrl}/cameras` +
      `?cameraId=${encodeURIComponent(
        event.cameraId,
      )}`;

    const message = [
      "🚨 Unattended customer detected",
      "",
      `Camera: ${event.cameraId}`,
      `Customers: ${event.customerCount}`,
      `Faces visible: ${event.faceCount}`,
      `Time: ${event.detectedAt.toLocaleString()}`,
      "",
      `Watch live: ${liveUrl}`,
    ].join("\n");

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            disable_web_page_preview:
              false,
          }),
          signal:
            AbortSignal.timeout(10_000),
        },
      );

      const payload =
        await response
          .json()
          .catch(() => null);

      if (!response.ok) {
        throw new Error(
          payload?.description ||
            `Telegram returned HTTP ${response.status}`,
        );
      }

      return {
        sent: true,
        error: null,
      };
    } catch (error) {
      return {
        sent: false,
        error:
          error?.message ||
          "Telegram delivery failed",
      };
    }
  }

  async function resolveActiveEvent(
    state,
    action,
    resolvedAt,
  ) {
    if (!state.activeEventId) {
      return null;
    }

    const updated =
      await prisma.aiShopkeeperEvent.update({
        where: {
          id: state.activeEventId,
        },
        data: {
          state: action,
          status:
            action === "SALE_COMPLETED"
              ? "SALE_COMPLETED"
              : action === "ABANDONED"
                ? "ABANDONED"
                : "RESOLVED",
          ownerAction: action,
          resolvedAt,
        },
      });

    state.activeEventId = null;
    state.clearSinceMs = null;

    io.emit(
      "ai:shopkeeper-event",
      {
        action: "UPDATED",
        event: serializeEvent(updated),
      },
    );

    return updated;
  }

  async function findExistingOpenEvent(
    cameraId,
  ) {
    return prisma.aiShopkeeperEvent.findFirst({
      where: {
        cameraId,
        status: {
          in: [
            "OPEN",
            "ACKNOWLEDGED",
          ],
        },
      },
      orderBy: {
        detectedAt: "desc",
      },
    });
  }

  async function processDetection(
    payload,
    {
      forceTrigger = false,
      sendNotifications = true,
      eventType =
        "UNATTENDED_CUSTOMER",
    } = {},
  ) {
    const cameraId =
      safeCameraId(payload.cameraId);

    if (!cameraId) {
      const error =
        new Error("cameraId is required");
      error.statusCode = 400;
      throw error;
    }

    const access =
      await getPremiumAccess(cameraId);

    if (!access.enabled) {
      const error = new Error(
        "Premium AI Smart Shopkeeper is not enabled for this camera",
      );
      error.statusCode = 403;
      throw error;
    }

    const detectedAt =
      validDate(payload.timestamp);

    const nowMs = detectedAt.getTime();

    const customerCount =
      positiveInteger(
        payload.customerCount,
      );

    const staffCount =
      positiveInteger(
        payload.staffCount,
      );

    const faceCount =
      positiveInteger(
        payload.faceCount,
      );

    const confidenceNumber =
      Number(payload.confidence);

    const confidence =
      Number.isFinite(
        confidenceNumber,
      )
        ? Math.max(
            0,
            Math.min(
              confidenceNumber,
              1,
            ),
          )
        : null;

    const state = stateFor(cameraId);

    state.customerCount =
      customerCount;

    state.staffCount = staffCount;
    state.faceCount = faceCount;
    state.confidence = confidence;

    state.detector =
      String(
        payload.detector || "",
      ).trim() || null;

    const processing =
      Number(
        payload.processingMilliseconds,
      );

    state.processingMilliseconds =
      Number.isFinite(processing)
        ? Math.max(0, processing)
        : null;

    state.lastDetectionAtMs = nowMs;
    state.lastWorkerHeartbeatAtMs =
      Date.now();

    let createdEvent = null;
    let resolvedEvent = null;

    if (staffCount > 0) {
      state.state =
        "STAFF_PRESENT";
      state.unattendedSinceMs = null;
      state.clearSinceMs = null;

      if (state.activeEventId) {
        resolvedEvent =
          await resolveActiveEvent(
            state,
            "STAFF_PRESENT",
            detectedAt,
          );
      }
    } else if (customerCount > 0) {
      state.clearSinceMs = null;

      if (!state.unattendedSinceMs) {
        state.unattendedSinceMs =
          nowMs;
      }

      const waitingSeconds =
        (
          nowMs -
          state.unattendedSinceMs
        ) / 1000;

      const shouldTrigger =
        forceTrigger ||
        waitingSeconds >=
          unattendedSeconds;

      state.state = shouldTrigger
        ? "UNATTENDED_CUSTOMER"
        : "CUSTOMER_WAITING";

      if (shouldTrigger) {
        if (!state.activeEventId) {
          const existing =
            await findExistingOpenEvent(
              cameraId,
            );

          if (existing) {
            state.activeEventId =
              existing.id;
          }
        }

        const cooldownElapsed =
          nowMs -
            state.lastEventAtMs >=
          eventCooldownSeconds * 1000;

        if (
          !state.activeEventId &&
          (
            forceTrigger ||
            cooldownElapsed
          )
        ) {
          const event =
            await prisma
              .aiShopkeeperEvent
              .create({
                data: {
                  cameraId,
                  eventType,
                  state:
                    "UNATTENDED_CUSTOMER",
                  status: "OPEN",
                  customerCount,
                  staffCount,
                  faceCount,
                  confidence,
                  detectedAt,
                  unattendedSince:
                    new Date(
                      state.unattendedSinceMs,
                    ),
                  metadataJson:
                    JSON.stringify({
                      detector:
                        payload.detector ||
                        null,
                      boxes:
                        Array.isArray(
                          payload.boxes,
                        )
                          ? payload.boxes
                          : [],
                      customerZone:
                        payload.customerZone ||
                        null,
                      staffZone:
                        payload.staffZone ||
                        null,
                      processingMilliseconds:
                        state
                          .processingMilliseconds,
                      workerId:
                        payload.workerId ||
                        null,
                    }),
                },
              });

          const imageRelativePath =
            await saveSnapshot(
              cameraId,
              event.id,
              detectedAt,
              payload.imageJpegBase64,
            );

          let finalEvent = event;

          if (imageRelativePath) {
            finalEvent =
              await prisma
                .aiShopkeeperEvent
                .update({
                  where: {
                    id: event.id,
                  },
                  data: {
                    imageRelativePath,
                  },
                });
          }

          state.activeEventId =
            finalEvent.id;

          state.lastEventAtMs = nowMs;

          createdEvent = finalEvent;

          io.emit(
            "ai:shopkeeper-event",
            {
              action: "CREATED",
              event:
                serializeEvent(
                  finalEvent,
                ),
            },
          );

          if (sendNotifications) {
            const delivery =
              await sendTelegram(
                finalEvent,
                access,
              );

            finalEvent =
              await prisma
                .aiShopkeeperEvent
                .update({
                  where: {
                    id:
                      finalEvent.id,
                  },
                  data: {
                    telegramSent:
                      delivery.sent,
                    deliveryError:
                      delivery.error,
                  },
                });

            createdEvent = finalEvent;

            io.emit(
              "ai:shopkeeper-event",
              {
                action: "UPDATED",
                event:
                  serializeEvent(
                    finalEvent,
                  ),
              },
            );
          }
        }
      }
    } else {
      state.unattendedSinceMs = null;

      if (state.activeEventId) {
        if (!state.clearSinceMs) {
          state.clearSinceMs =
            nowMs;
        }

        const clearElapsed =
          (
            nowMs -
            state.clearSinceMs
          ) / 1000;

        if (
          clearElapsed >=
          clearSeconds
        ) {
          state.state =
            "SHOP_EMPTY";

          resolvedEvent =
            await resolveActiveEvent(
              state,
              "CUSTOMER_LEFT",
              detectedAt,
            );
        } else {
          state.state =
            "CUSTOMER_LEFT_PENDING";
        }
      } else {
        state.state =
          "SHOP_EMPTY";

        state.clearSinceMs = null;
      }
    }

    const serializedState =
      serializeCameraState(state);

    io.emit(
      "ai:shopkeeper-status",
      serializedState,
    );

    return {
      state: serializedState,
      createdEvent:
        createdEvent
          ? serializeEvent(createdEvent)
          : null,
      resolvedEvent:
        resolvedEvent
          ? serializeEvent(resolvedEvent)
          : null,
      plan: access.plan,
    };
  }

  app.post(
    "/ai/detections",
    async (request, response) => {
      try {
        const result =
          await processDetection(
            request.body || {},
          );

        response.status(202).json({
          ok: true,
          ...result,
        });
      } catch (error) {
        response
          .status(
            error.statusCode || 500,
          )
          .json({
            ok: false,
            error:
              error?.message ||
              "AI detection processing failed",
          });
      }
    },
  );

  app.get(
    "/ai/status",
    async (request, response) => {
      const cameraId =
        safeCameraId(
          request.query.cameraId,
        );

      const states = cameraId
        ? [
            serializeCameraState(
              stateFor(cameraId),
            ),
          ]
        : Array.from(
            cameraStates.values(),
          ).map(serializeCameraState);

      response.json({
        ok: true,
        enabled: aiGloballyEnabled,
        fallbackPlan,
        unattendedSeconds,
        clearSeconds,
        eventCooldownSeconds,
        workerStaleSeconds,
        states,
      });
    },
  );

  app.get(
    "/ai/health",
    async (_request, response) => {
      const states = Array.from(
        cameraStates.values(),
      ).map(serializeCameraState);

      const onlineWorkers =
        states.filter(
          (state) =>
            state.workerStatus ===
            "ONLINE",
        ).length;

      response.json({
        ok: true,
        service:
          "premium-ai-smart-shopkeeper",
        enabled: aiGloballyEnabled,
        cameraCount: states.length,
        onlineWorkers,
        states,
        timestamp:
          new Date().toISOString(),
      });
    },
  );

  app.get(
    "/ai/events",
    async (request, response) => {
      try {
        const cameraId =
          safeCameraId(
            request.query.cameraId,
          );

        const status =
          String(
            request.query.status || "",
          )
            .trim()
            .toUpperCase();

        const limit = Math.max(
          1,
          Math.min(
            500,
            Number(
              request.query.limit ||
                100,
            ) || 100,
          ),
        );

        const events =
          await prisma
            .aiShopkeeperEvent
            .findMany({
              where: {
                ...(cameraId
                  ? { cameraId }
                  : {}),
                ...(status
                  ? { status }
                  : {}),
              },
              orderBy: {
                detectedAt: "desc",
              },
              take: limit,
            });

        response.json({
          ok: true,
          count: events.length,
          events:
            events.map(
              serializeEvent,
            ),
        });
      } catch (error) {
        response.status(500).json({
          ok: false,
          error:
            "Failed to list AI events",
        });
      }
    },
  );

  app.get(
    "/ai/events/:eventId",
    async (request, response) => {
      const event =
        await prisma
          .aiShopkeeperEvent
          .findUnique({
            where: {
              id:
                request.params.eventId,
            },
          });

      if (!event) {
        response.status(404).json({
          ok: false,
          error: "AI event not found",
        });
        return;
      }

      response.json({
        ok: true,
        event: serializeEvent(event),
      });
    },
  );

  app.get(
    "/ai/events/:eventId/snapshot",
    async (request, response) => {
      try {
        const event =
          await prisma
            .aiShopkeeperEvent
            .findUnique({
              where: {
                id:
                  request.params.eventId,
              },
            });

        if (
          !event ||
          !event.imageRelativePath
        ) {
          response.status(404).json({
            ok: false,
            error:
              "AI event snapshot not found",
          });
          return;
        }

        const snapshotPath =
          resolveEventSnapshotPath(
            event,
          );

        const stat =
          await fsp.stat(snapshotPath);

        if (!stat.isFile()) {
          response.status(404).json({
            ok: false,
            error:
              "AI event snapshot file is missing",
          });
          return;
        }

        response.setHeader(
          "Content-Type",
          "image/jpeg",
        );

        response.setHeader(
          "Content-Length",
          String(stat.size),
        );

        response.setHeader(
          "Cache-Control",
          "private, no-cache",
        );

        fs.createReadStream(
          snapshotPath,
        ).pipe(response);
      } catch (error) {
        response.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Failed to read AI snapshot",
        });
      }
    },
  );

  app.patch(
    "/ai/events/:eventId/action",
    async (request, response) => {
      try {
        const action = String(
          request.body?.action || "",
        )
          .trim()
          .toUpperCase();

        const allowed = new Set([
          "ACKNOWLEDGE",
          "OWNER_WATCHING",
          "AI_ASSISTING",
          "RESOLVE",
          "SALE_COMPLETED",
          "ABANDONED",
        ]);

        if (!allowed.has(action)) {
          response.status(400).json({
            ok: false,
            error:
              "Unsupported AI event action",
          });
          return;
        }

        const now = new Date();

        const data = {
          ownerAction: action,
          state:
            action ===
            "ACKNOWLEDGE"
              ? undefined
              : action,
          status:
            action ===
            "ACKNOWLEDGE"
              ? "ACKNOWLEDGED"
              : [
                    "RESOLVE",
                    "SALE_COMPLETED",
                    "ABANDONED",
                  ].includes(action)
                ? action ===
                    "RESOLVE"
                  ? "RESOLVED"
                  : action
                : "OPEN",
          acknowledgedAt:
            action ===
            "ACKNOWLEDGE"
              ? now
              : undefined,
          resolvedAt:
            [
              "RESOLVE",
              "SALE_COMPLETED",
              "ABANDONED",
            ].includes(action)
              ? now
              : undefined,
        };

        Object.keys(data).forEach(
          (key) => {
            if (
              data[key] === undefined
            ) {
              delete data[key];
            }
          },
        );

        const event =
          await prisma
            .aiShopkeeperEvent
            .update({
              where: {
                id:
                  request.params.eventId,
              },
              data,
            });

        if (
          [
            "RESOLVE",
            "SALE_COMPLETED",
            "ABANDONED",
          ].includes(action)
        ) {
          const state =
            cameraStates.get(
              event.cameraId,
            );

          if (
            state?.activeEventId ===
            event.id
          ) {
            state.activeEventId =
              null;

            state.state =
              action === "RESOLVE"
                ? "SHOP_EMPTY"
                : action;
          }
        }

        const serialized =
          serializeEvent(event);

        io.emit(
          "ai:shopkeeper-event",
          {
            action: "UPDATED",
            event: serialized,
          },
        );

        response.json({
          ok: true,
          event: serialized,
        });
      } catch (error) {
        if (error.code === "P2025") {
          response.status(404).json({
            ok: false,
            error:
              "AI event not found",
          });
          return;
        }

        response.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Failed to update AI event",
        });
      }
    },
  );

  app.post(
    "/ai/test/unattended",
    async (request, response) => {
      try {
        const cameraId =
          safeCameraId(
            request.body?.cameraId ||
              process.env
                .CCTV_AI_CAMERA_ID ||
              process.env
                .CCTV_RECORDER_CAMERA_ID ||
              "cam-1772515015057",
          );

        const result =
          await processDetection(
            {
              cameraId,
              timestamp:
                new Date().toISOString(),
              customerCount: 1,
              staffCount: 0,
              faceCount: 1,
              confidence: 0.99,
              detector:
                "synthetic-acceptance-test",
              boxes: [],
            },
            {
              forceTrigger: true,
              sendNotifications: false,
              eventType:
                "TEST_UNATTENDED_CUSTOMER",
            },
          );

        response.status(201).json({
          ok: true,
          ...result,
        });
      } catch (error) {
        response
          .status(
            error.statusCode || 500,
          )
          .json({
            ok: false,
            error:
              error?.message ||
              "AI test failed",
          });
      }
    },
  );

  app.delete(
    "/ai/events/:eventId",
    async (request, response) => {
      try {
        const event =
          await prisma
            .aiShopkeeperEvent
            .findUnique({
              where: {
                id:
                  request.params.eventId,
              },
            });

        if (!event) {
          response.status(404).json({
            ok: false,
            error:
              "AI event not found",
          });
          return;
        }

        if (
          !event.eventType.startsWith(
            "TEST_",
          )
        ) {
          response.status(403).json({
            ok: false,
            error:
              "Only synthetic test events may be deleted directly",
          });
          return;
        }

        if (event.imageRelativePath) {
          await fsp.rm(
            resolveEventSnapshotPath(
              event,
            ),
            {
              force: true,
            },
          );
        }

        await prisma
          .aiShopkeeperEvent
          .delete({
            where: {
              id: event.id,
            },
          });

        const state =
          cameraStates.get(
            event.cameraId,
          );

        if (
          state?.activeEventId ===
          event.id
        ) {
          state.activeEventId =
            null;
          state.state =
            "SHOP_EMPTY";
        }

        response.json({
          ok: true,
          deletedEventId:
            event.id,
        });
      } catch (error) {
        response.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Failed to delete test event",
        });
      }
    },
  );
}

module.exports = {
  registerAiShopkeeperRoutes,
};
JS_SERVER

log "Registering AI backend in server.js"

python3 - "$SERVER" <<'PY_SERVER'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

import_block = """const {
  registerAiShopkeeperRoutes,
} = require("./server/ai/aiShopkeeperRoutes");
"""

if "registerAiShopkeeperRoutes" not in text:
    anchor = """const {
  registerRecordingEvidenceRoutes,
} = require("./server/recordings/recordingEvidenceRoutes");
"""

    if anchor not in text:
        raise SystemExit(
            "RecordingEvidence import anchor not found"
        )

    text = text.replace(
        anchor,
        anchor + import_block,
        1,
    )

registration = """registerAiShopkeeperRoutes(app, {
  prisma,
  io,
  recordingsRoot: RECORDINGS_ROOT,
});

"""

if "registerAiShopkeeperRoutes(app" not in text:
    anchor = """registerRecordingEvidenceRoutes(app, {
  prisma,
  storageManager,
  recordingsRoot: RECORDINGS_ROOT,
});

"""

    if anchor not in text:
        raise SystemExit(
            "RecordingEvidence registration anchor not found"
        )

    text = text.replace(
        anchor,
        anchor + registration,
        1,
    )

path.write_text(text, encoding="utf-8")
PY_SERVER

log "Creating the local LiveKit AI worker"

cat > "$AI_WORKER" <<'PY_WORKER'
#!/usr/bin/env python3
"""Premium AI Smart Shopkeeper edge worker.

This worker subscribes to a LiveKit smartphone camera, performs
local CPU person and face-presence detection, assigns people to
customer/staff zones, and reports detection state to the CCTV backend.

It performs face detection only. It does not identify a person.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import fcntl
import json
import logging
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from dotenv import load_dotenv
from livekit import api, rtc


LOG = logging.getLogger(
    "cctv-ai-shopkeeper"
)


def iso_now() -> str:
    return (
        datetime.now()
        .astimezone()
        .isoformat()
    )


def safe_camera_id(value: str) -> str:
    value = re.sub(
        r"[^a-zA-Z0-9._-]",
        "_",
        str(value or "").strip(),
    )[:120]

    if not value:
        raise ValueError(
            "Camera ID is required"
        )

    return value


def required_environment(
    name: str,
) -> str:
    value = str(
        os.getenv(name, "")
    ).strip()

    if not value:
        raise RuntimeError(
            f"Missing environment variable: {name}"
        )

    return value


def parse_zone(
    value: str,
    name: str,
) -> tuple[float, float, float, float]:
    parts = [
        float(item.strip())
        for item in value.split(",")
    ]

    if len(parts) != 4:
        raise ValueError(
            f"{name} must contain x1,y1,x2,y2"
        )

    x1, y1, x2, y2 = parts

    if not (
        0 <= x1 < x2 <= 1
        and 0 <= y1 < y2 <= 1
    ):
        raise ValueError(
            f"{name} coordinates must be between 0 and 1"
        )

    return x1, y1, x2, y2


def point_in_zone(
    x: float,
    y: float,
    zone: tuple[
        float,
        float,
        float,
        float,
    ],
) -> bool:
    x1, y1, x2, y2 = zone

    return (
        x1 <= x <= x2
        and y1 <= y <= y2
    )


def rotate_rgb(
    image: np.ndarray,
    rotation: int,
) -> np.ndarray:
    if rotation == 1:
        return cv2.rotate(
            image,
            cv2.ROTATE_90_CLOCKWISE,
        )

    if rotation == 2:
        return cv2.rotate(
            image,
            cv2.ROTATE_180,
        )

    if rotation == 3:
        return cv2.rotate(
            image,
            cv2.ROTATE_90_COUNTERCLOCKWISE,
        )

    return image


def encode_zone(
    zone: tuple[
        float,
        float,
        float,
        float,
    ],
) -> list[float]:
    return [
        round(value, 4)
        for value in zone
    ]


@dataclass(frozen=True)
class WorkerConfig:
    camera_id: str
    room_name: str
    camera_identity: str
    backend_url: str
    dashboard_token: str
    customer_zone: tuple[
        float,
        float,
        float,
        float,
    ]
    staff_zone: tuple[
        float,
        float,
        float,
        float,
    ]
    sample_interval_seconds: float
    reconnect_seconds: float
    wait_for_camera_seconds: float
    frame_timeout_seconds: float
    detection_width: int
    jpeg_quality: int
    minimum_weight: float
    minimum_box_area_ratio: float
    face_detection_enabled: bool
    runtime_dir: Path


class AtomicStatus:
    def __init__(
        self,
        path: Path,
        config: WorkerConfig,
    ) -> None:
        self.path = path
        self.base = {
            "schemaVersion": 1,
            "phase": "11J-A",
            "cameraId":
                config.camera_id,
            "roomName":
                config.room_name,
            "customerZone":
                encode_zone(
                    config.customer_zone
                ),
            "staffZone":
                encode_zone(
                    config.staff_zone
                ),
            "pid": os.getpid(),
            "startedAt": iso_now(),
        }

    def update(
        self,
        state: str,
        **values: Any,
    ) -> None:
        payload = {
            **self.base,
            "state": state,
            "updatedAt": iso_now(),
            **values,
        }

        self.path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        temporary = self.path.with_name(
            f".{self.path.name}.tmp-"
            f"{os.getpid()}-"
            f"{uuid.uuid4().hex[:8]}"
        )

        temporary.write_text(
            json.dumps(
                payload,
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

        temporary.replace(self.path)


class ProcessLock:
    def __init__(
        self,
        lock_path: Path,
        pid_path: Path,
    ) -> None:
        self.lock_path = lock_path
        self.pid_path = pid_path
        self.handle: Any | None = None

    def __enter__(
        self,
    ) -> "ProcessLock":
        self.lock_path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        self.handle = self.lock_path.open(
            "a+",
            encoding="utf-8",
        )

        try:
            fcntl.flock(
                self.handle.fileno(),
                fcntl.LOCK_EX |
                fcntl.LOCK_NB,
            )
        except BlockingIOError as error:
            raise RuntimeError(
                "Another AI worker already owns "
                f"{self.lock_path}"
            ) from error

        self.handle.seek(0)
        self.handle.truncate()
        self.handle.write(
            f"{os.getpid()}\n"
        )
        self.handle.flush()

        self.pid_path.write_text(
            f"{os.getpid()}\n",
            encoding="utf-8",
        )

        return self

    def __exit__(
        self,
        *_: Any,
    ) -> None:
        with contextlib.suppress(
            FileNotFoundError
        ):
            self.pid_path.unlink()

        if self.handle is not None:
            with contextlib.suppress(
                OSError
            ):
                fcntl.flock(
                    self.handle.fileno(),
                    fcntl.LOCK_UN,
                )

            self.handle.close()
            self.handle = None


class LocalDetector:
    def __init__(
        self,
        config: WorkerConfig,
    ) -> None:
        self.config = config

        self.hog = cv2.HOGDescriptor()

        try:
            people_detector = (
                cv2
                .HOGDescriptor_getDefaultPeopleDetector()
            )
        except AttributeError:
            people_detector = (
                cv2.HOGDescriptor
                .getDefaultPeopleDetector()
            )

        self.hog.setSVMDetector(
            people_detector
        )

        cascade_path = (
            Path(cv2.data.haarcascades)
            / "haarcascade_frontalface_default.xml"
        )

        self.face_detector = (
            cv2.CascadeClassifier(
                str(cascade_path)
            )
        )

        if (
            config.face_detection_enabled
            and self.face_detector.empty()
        ):
            raise RuntimeError(
                "OpenCV face cascade could not be loaded"
            )

    def prepare_frame(
        self,
        frame: rtc.VideoFrame,
        rotation: int,
    ) -> np.ndarray:
        width = int(frame.width)
        height = int(frame.height)

        raw = np.frombuffer(
            bytes(frame.data),
            dtype=np.uint8,
        )

        expected = width * height * 3

        if raw.size != expected:
            raise RuntimeError(
                "Unexpected RGB24 frame size: "
                f"{raw.size}; expected {expected}"
            )

        rgb = raw.reshape(
            height,
            width,
            3,
        )

        rgb = rotate_rgb(
            rgb,
            rotation,
        )

        source_height, source_width = (
            rgb.shape[:2]
        )

        target_width = min(
            self.config.detection_width,
            source_width,
        )

        scale = (
            target_width /
            source_width
        )

        target_height = max(
            128,
            round(
                source_height * scale
            ),
        )

        return cv2.resize(
            rgb,
            (
                target_width,
                target_height,
            ),
            interpolation=cv2.INTER_AREA,
        )

    def person_boxes(
        self,
        bgr: np.ndarray,
    ) -> list[dict[str, Any]]:
        rectangles, weights = (
            self.hog.detectMultiScale(
                bgr,
                hitThreshold=0,
                winStride=(8, 8),
                padding=(8, 8),
                scale=1.05,
                finalThreshold=2,
                useMeanshiftGrouping=False,
            )
        )

        frame_height, frame_width = (
            bgr.shape[:2]
        )

        frame_area = (
            frame_width * frame_height
        )

        boxes: list[list[int]] = []
        scores: list[float] = []

        for rectangle, raw_weight in zip(
            rectangles,
            weights,
        ):
            x, y, width, height = [
                int(value)
                for value in rectangle
            ]

            weight = float(
                np.asarray(
                    raw_weight
                ).reshape(-1)[0]
            )

            area_ratio = (
                width * height
            ) / max(1, frame_area)

            if (
                weight <
                self.config.minimum_weight
                or area_ratio <
                self.config
                .minimum_box_area_ratio
            ):
                continue

            boxes.append(
                [x, y, width, height]
            )

            scores.append(weight)

        if not boxes:
            return []

        score_threshold = max(
            0.0,
            min(
                self.config.minimum_weight,
                max(scores),
            ),
        )

        indexes = cv2.dnn.NMSBoxes(
            boxes,
            scores,
            score_threshold,
            0.4,
        )

        if indexes is None:
            return []

        flattened = np.asarray(
            indexes
        ).reshape(-1)

        results: list[
            dict[str, Any]
        ] = []

        for raw_index in flattened:
            index = int(raw_index)

            if not (
                0 <= index < len(boxes)
            ):
                continue

            x, y, width, height = (
                boxes[index]
            )

            centre_x = (
                x + width / 2
            ) / frame_width

            centre_y = (
                y + height / 2
            ) / frame_height

            zone = "outside"

            if point_in_zone(
                centre_x,
                centre_y,
                self.config.staff_zone,
            ):
                zone = "staff"
            elif point_in_zone(
                centre_x,
                centre_y,
                self.config.customer_zone,
            ):
                zone = "customer"

            results.append({
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "confidence":
                    round(
                        scores[index],
                        4,
                    ),
                "centreX":
                    round(
                        centre_x,
                        4,
                    ),
                "centreY":
                    round(
                        centre_y,
                        4,
                    ),
                "zone": zone,
            })

        return results

    def face_boxes(
        self,
        bgr: np.ndarray,
    ) -> list[dict[str, int]]:
        if not (
            self.config
            .face_detection_enabled
        ):
            return []

        gray = cv2.cvtColor(
            bgr,
            cv2.COLOR_BGR2GRAY,
        )

        gray = cv2.equalizeHist(gray)

        faces = (
            self.face_detector
            .detectMultiScale(
                gray,
                scaleFactor=1.1,
                minNeighbors=5,
                minSize=(24, 24),
            )
        )

        return [
            {
                "x": int(x),
                "y": int(y),
                "width": int(width),
                "height": int(height),
            }
            for x, y, width, height
            in faces
        ]

    def draw_zone(
        self,
        image: np.ndarray,
        zone: tuple[
            float,
            float,
            float,
            float,
        ],
        label: str,
        colour: tuple[
            int,
            int,
            int,
        ],
    ) -> None:
        height, width = image.shape[:2]

        x1 = round(zone[0] * width)
        y1 = round(zone[1] * height)
        x2 = round(zone[2] * width)
        y2 = round(zone[3] * height)

        cv2.rectangle(
            image,
            (x1, y1),
            (x2, y2),
            colour,
            2,
        )

        cv2.putText(
            image,
            label,
            (
                x1 + 5,
                max(18, y1 + 18),
            ),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            colour,
            1,
            cv2.LINE_AA,
        )

    def analyse(
        self,
        frame: rtc.VideoFrame,
        rotation: int,
    ) -> dict[str, Any]:
        started = time.monotonic()

        rgb = self.prepare_frame(
            frame,
            rotation,
        )

        bgr = cv2.cvtColor(
            rgb,
            cv2.COLOR_RGB2BGR,
        )

        people = self.person_boxes(bgr)
        faces = self.face_boxes(bgr)

        customer_count = sum(
            1
            for item in people
            if item["zone"] ==
            "customer"
        )

        staff_count = sum(
            1
            for item in people
            if item["zone"] ==
            "staff"
        )

        annotated = bgr.copy()

        self.draw_zone(
            annotated,
            self.config.customer_zone,
            "CUSTOMER",
            (0, 200, 255),
        )

        self.draw_zone(
            annotated,
            self.config.staff_zone,
            "STAFF",
            (80, 255, 80),
        )

        for person in people:
            x = person["x"]
            y = person["y"]
            width = person["width"]
            height = person["height"]

            colour = (
                (80, 255, 80)
                if person["zone"] ==
                "staff"
                else (0, 200, 255)
            )

            cv2.rectangle(
                annotated,
                (x, y),
                (
                    x + width,
                    y + height,
                ),
                colour,
                2,
            )

            cv2.putText(
                annotated,
                (
                    f"person "
                    f"{person['zone']}"
                ),
                (
                    x,
                    max(16, y - 5),
                ),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                colour,
                1,
                cv2.LINE_AA,
            )

        for face in faces:
            x = face["x"]
            y = face["y"]
            width = face["width"]
            height = face["height"]

            cv2.rectangle(
                annotated,
                (x, y),
                (
                    x + width,
                    y + height,
                ),
                (255, 140, 0),
                2,
            )

        encoded_ok, encoded = (
            cv2.imencode(
                ".jpg",
                annotated,
                [
                    int(
                        cv2.IMWRITE_JPEG_QUALITY
                    ),
                    self.config.jpeg_quality,
                ],
            )
        )

        image_base64 = (
            base64.b64encode(
                encoded.tobytes()
            ).decode("ascii")
            if encoded_ok
            else None
        )

        confidences = [
            item["confidence"]
            for item in people
        ]

        confidence = (
            max(confidences)
            if confidences
            else 0.0
        )

        return {
            "customerCount":
                customer_count,
            "staffCount":
                staff_count,
            "faceCount": len(faces),
            "confidence":
                min(
                    1.0,
                    max(
                        0.0,
                        confidence,
                    ),
                ),
            "boxes": people,
            "faces": faces,
            "customerZone":
                encode_zone(
                    self.config
                    .customer_zone
                ),
            "staffZone":
                encode_zone(
                    self.config
                    .staff_zone
                ),
            "imageJpegBase64":
                image_base64,
            "processingMilliseconds":
                round(
                    (
                        time.monotonic() -
                        started
                    ) * 1000,
                    1,
                ),
        }


def post_json(
    url: str,
    token: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(
            payload,
            separators=(",", ":"),
        ).encode("utf-8"),
        headers={
            "Authorization":
                f"Bearer {token}",
            "Content-Type":
                "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(
            request,
            timeout=15,
        ) as response:
            body = response.read()

            return (
                json.loads(
                    body.decode("utf-8")
                )
                if body
                else {}
            )
    except urllib.error.HTTPError as error:
        body = error.read().decode(
            "utf-8",
            errors="replace",
        )

        raise RuntimeError(
            f"Backend HTTP {error.code}: "
            f"{body}"
        ) from error


class AiShopkeeperWorker:
    def __init__(
        self,
        config: WorkerConfig,
    ) -> None:
        self.config = config
        self.detector = LocalDetector(
            config
        )
        self.stop_event = asyncio.Event()
        self.reconnect_count = 0
        self.worker_id = (
            f"ai:{config.camera_id}:"
            f"{uuid.uuid4().hex[:12]}"
        )

        self.status = AtomicStatus(
            config.runtime_dir
            / "ai_shopkeeper_status.json",
            config,
        )

    def request_stop(self) -> None:
        self.stop_event.set()

    def create_token(self) -> str:
        api_key = required_environment(
            "LIVEKIT_API_KEY"
        )

        api_secret = required_environment(
            "LIVEKIT_API_SECRET"
        )

        return (
            api.AccessToken(
                api_key,
                api_secret,
            )
            .with_identity(
                self.worker_id
            )
            .with_name(
                "AI Smart Shopkeeper "
                f"{self.config.camera_id}"
            )
            .with_metadata(
                json.dumps({
                    "role":
                        "ai-smart-shopkeeper",
                    "cameraId":
                        self.config.camera_id,
                    "phase": "11J-A",
                })
            )
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=
                        self.config.room_name,
                    can_publish=False,
                    can_subscribe=True,
                    can_publish_data=False,
                    hidden=True,
                )
            )
            .to_jwt()
        )

    async def sleep_or_stop(
        self,
        seconds: float,
    ) -> None:
        try:
            await asyncio.wait_for(
                self.stop_event.wait(),
                timeout=seconds,
            )
        except asyncio.TimeoutError:
            pass

    async def run_forever(self) -> None:
        self.status.update(
            "STARTING",
            reconnectCount=0,
        )

        while not self.stop_event.is_set():
            try:
                await self.run_session()
            except Exception as error:
                if self.stop_event.is_set():
                    break

                self.reconnect_count += 1

                LOG.exception(
                    "AI session failed: %s",
                    error,
                )

                self.status.update(
                    "ERROR_RETRYING",
                    reconnectCount=
                        self.reconnect_count,
                    lastError=str(error),
                    retryInSeconds=
                        self.config
                        .reconnect_seconds,
                )

                await self.sleep_or_stop(
                    self.config
                    .reconnect_seconds
                )

        self.status.update(
            "STOPPED",
            reconnectCount=
                self.reconnect_count,
            stoppedAt=iso_now(),
        )

    async def run_session(self) -> None:
        room = rtc.Room()

        track_queue: asyncio.Queue[
            tuple[Any, Any]
        ] = asyncio.Queue(
            maxsize=1
        )

        session_lost = asyncio.Event()

        loss_reason = {
            "value":
                "camera-session-ended"
        }

        @room.on("track_subscribed")
        def on_track_subscribed(
            track,
            publication,
            participant,
        ) -> None:
            if (
                participant.identity ==
                self.config
                .camera_identity
                and track.kind ==
                rtc.TrackKind.KIND_VIDEO
                and track_queue.empty()
            ):
                if getattr(
                    publication,
                    "simulcasted",
                    False,
                ):
                    with contextlib.suppress(
                        Exception
                    ):
                        publication.set_video_quality(
                            rtc.VideoQuality
                            .VIDEO_QUALITY_MEDIUM
                        )

                track_queue.put_nowait(
                    (
                        track,
                        publication,
                    )
                )

        @room.on("track_unsubscribed")
        def on_track_unsubscribed(
            track,
            _publication,
            participant,
        ) -> None:
            if (
                participant.identity ==
                self.config
                .camera_identity
                and track.kind ==
                rtc.TrackKind.KIND_VIDEO
            ):
                loss_reason["value"] = (
                    "camera-track-unsubscribed"
                )

                session_lost.set()

        @room.on("participant_disconnected")
        def on_participant_disconnected(
            participant,
        ) -> None:
            if (
                participant.identity ==
                self.config
                .camera_identity
            ):
                loss_reason["value"] = (
                    "camera-participant-disconnected"
                )

                session_lost.set()

        @room.on("disconnected")
        def on_disconnected(
            reason,
        ) -> None:
            loss_reason["value"] = (
                "ai-room-disconnected:"
                f"{reason}"
            )

            session_lost.set()

        livekit_url = (
            required_environment(
                "LIVEKIT_URL"
            )
        )

        self.status.update(
            "CONNECTING",
            reconnectCount=
                self.reconnect_count,
            livekitUrl=livekit_url,
        )

        await room.connect(
            livekit_url,
            self.create_token(),
            rtc.RoomOptions(
                auto_subscribe=True
            ),
        )

        stream: rtc.VideoStream | None = (
            None
        )

        try:
            self.status.update(
                "WAITING_TRACK",
                reconnectCount=
                    self.reconnect_count,
            )

            track_task = (
                asyncio.create_task(
                    track_queue.get()
                )
            )

            stop_task = (
                asyncio.create_task(
                    self.stop_event.wait()
                )
            )

            lost_task = (
                asyncio.create_task(
                    session_lost.wait()
                )
            )

            done, pending = (
                await asyncio.wait(
                    {
                        track_task,
                        stop_task,
                        lost_task,
                    },
                    timeout=
                        self.config
                        .wait_for_camera_seconds,
                    return_when=
                        asyncio
                        .FIRST_COMPLETED,
                )
            )

            for task in pending:
                task.cancel()

            await asyncio.gather(
                *pending,
                return_exceptions=True,
            )

            if not done:
                raise RuntimeError(
                    "Camera track did not "
                    "arrive before timeout"
                )

            if (
                stop_task in done
                and stop_task.result()
            ):
                return

            if (
                lost_task in done
                and lost_task.result()
            ):
                raise RuntimeError(
                    loss_reason["value"]
                )

            track, publication = (
                track_task.result()
            )

            stream = rtc.VideoStream(
                track,
                capacity=2,
                format=
                    rtc.VideoBufferType
                    .RGB24,
            )

            last_sample_at = 0.0

            self.status.update(
                "ANALYSING",
                reconnectCount=
                    self.reconnect_count,
                trackSid=publication.sid,
            )

            while not (
                self.stop_event.is_set()
                or session_lost.is_set()
            ):
                try:
                    event = (
                        await asyncio
                        .wait_for(
                            stream.__anext__(),
                            timeout=
                                self.config
                                .frame_timeout_seconds,
                        )
                    )
                except asyncio.TimeoutError:
                    raise RuntimeError(
                        "No camera frame arrived "
                        "before timeout"
                    )

                now = time.monotonic()

                if (
                    now - last_sample_at <
                    self.config
                    .sample_interval_seconds
                ):
                    continue

                last_sample_at = now

                result = (
                    self.detector.analyse(
                        event.frame,
                        int(
                            event.rotation
                        ),
                    )
                )

                payload = {
                    "cameraId":
                        self.config
                        .camera_id,
                    "timestamp":
                        iso_now(),
                    "workerId":
                        self.worker_id,
                    "detector":
                        (
                            "opencv-hog-person"
                            "+haar-face-presence"
                        ),
                    **result,
                }

                response = (
                    await asyncio.to_thread(
                        post_json,
                        (
                            self.config
                            .backend_url
                            + "/ai/detections"
                        ),
                        self.config
                        .dashboard_token,
                        payload,
                    )
                )

                state = (
                    response
                    .get("state", {})
                    .get("state", "UNKNOWN")
                )

                LOG.info(
                    "AI state=%s "
                    "customer=%s staff=%s "
                    "faces=%s processing=%sms",
                    state,
                    result[
                        "customerCount"
                    ],
                    result[
                        "staffCount"
                    ],
                    result[
                        "faceCount"
                    ],
                    result[
                        "processingMilliseconds"
                    ],
                )

                self.status.update(
                    "ANALYSING",
                    reconnectCount=
                        self.reconnect_count,
                    trackSid=publication.sid,
                    aiState=state,
                    customerCount=
                        result[
                            "customerCount"
                        ],
                    staffCount=
                        result[
                            "staffCount"
                        ],
                    faceCount=
                        result[
                            "faceCount"
                        ],
                    confidence=
                        result[
                            "confidence"
                        ],
                    processingMilliseconds=
                        result[
                            "processingMilliseconds"
                        ],
                    lastDetectionAt=
                        iso_now(),
                )

            if session_lost.is_set():
                raise RuntimeError(
                    loss_reason["value"]
                )
        finally:
            if stream is not None:
                with contextlib.suppress(
                    Exception
                ):
                    await stream.aclose()

            with contextlib.suppress(
                Exception
            ):
                await room.disconnect()


def build_config(
    args: argparse.Namespace,
    project_root: Path,
) -> WorkerConfig:
    camera_id = safe_camera_id(
        args.camera_id
        or os.getenv(
            "CCTV_AI_CAMERA_ID",
            os.getenv(
                "CCTV_RECORDER_CAMERA_ID",
                "cam-1772515015057",
            ),
        )
    )

    backend_url = str(
        os.getenv(
            "CCTV_AI_BACKEND_URL",
            "http://127.0.0.1:3000",
        )
    ).rstrip("/")

    dashboard_token = (
        required_environment(
            "CCTV_DASHBOARD_TOKEN"
        )
    )

    customer_zone = parse_zone(
        os.getenv(
            "CCTV_AI_CUSTOMER_ZONE",
            "0.00,0.00,0.65,1.00",
        ),
        "CCTV_AI_CUSTOMER_ZONE",
    )

    staff_zone = parse_zone(
        os.getenv(
            "CCTV_AI_STAFF_ZONE",
            "0.65,0.00,1.00,1.00",
        ),
        "CCTV_AI_STAFF_ZONE",
    )

    runtime_dir = Path(
        os.getenv(
            "CCTV_AI_RUNTIME_DIR",
            str(
                project_root /
                "runtime" /
                "cctv-ai"
            ),
        )
    ).expanduser().resolve()

    return WorkerConfig(
        camera_id=camera_id,
        room_name=
            f"camera-{camera_id}",
        camera_identity=
            f"camera:{camera_id}",
        backend_url=backend_url,
        dashboard_token=
            dashboard_token,
        customer_zone=
            customer_zone,
        staff_zone=staff_zone,
        sample_interval_seconds=
            max(
                0.5,
                float(
                    os.getenv(
                        "CCTV_AI_SAMPLE_INTERVAL_SECONDS",
                        "1.0",
                    )
                ),
            ),
        reconnect_seconds=
            max(
                1.0,
                float(
                    os.getenv(
                        "CCTV_AI_RECONNECT_SECONDS",
                        "5",
                    )
                ),
            ),
        wait_for_camera_seconds=
            max(
                10,
                float(
                    os.getenv(
                        "CCTV_AI_WAIT_FOR_CAMERA_SECONDS",
                        "45",
                    )
                ),
            ),
        frame_timeout_seconds=
            max(
                5,
                float(
                    os.getenv(
                        "CCTV_AI_FRAME_TIMEOUT_SECONDS",
                        "15",
                    )
                ),
            ),
        detection_width=
            max(
                256,
                min(
                    640,
                    int(
                        os.getenv(
                            "CCTV_AI_DETECTION_WIDTH",
                            "416",
                        )
                    ),
                ),
            ),
        jpeg_quality=
            max(
                40,
                min(
                    90,
                    int(
                        os.getenv(
                            "CCTV_AI_JPEG_QUALITY",
                            "72",
                        )
                    ),
                ),
            ),
        minimum_weight=
            float(
                os.getenv(
                    "CCTV_AI_MIN_PERSON_WEIGHT",
                    "0.15",
                )
            ),
        minimum_box_area_ratio=
            max(
                0.005,
                float(
                    os.getenv(
                        "CCTV_AI_MIN_BOX_AREA_RATIO",
                        "0.025",
                    )
                ),
            ),
        face_detection_enabled=
            str(
                os.getenv(
                    "CCTV_AI_FACE_DETECTION",
                    "true",
                )
            )
            .strip()
            .lower()
            not in {
                "0",
                "false",
                "no",
                "off",
            },
        runtime_dir=runtime_dir,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--env-file"
    )

    parser.add_argument(
        "--camera-id"
    )

    parser.add_argument(
        "--self-test",
        action="store_true",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    project_root = (
        Path(__file__)
        .resolve()
        .parents[1]
    )

    env_file = Path(
        args.env_file
        or project_root / ".env"
    ).expanduser().resolve()

    if not env_file.is_file():
        print(
            f"Missing environment file: "
            f"{env_file}",
            file=sys.stderr,
        )
        return 2

    load_dotenv(
        env_file,
        override=False,
    )

    logging.basicConfig(
        level=logging.INFO,
        format=(
            "%(asctime)s "
            "%(levelname)s "
            "%(name)s: "
            "%(message)s"
        ),
    )

    config = build_config(
        args,
        project_root,
    )

    detector = LocalDetector(config)

    if args.self_test:
        blank = np.zeros(
            (
                360,
                640,
                3,
            ),
            dtype=np.uint8,
        )

        people = detector.person_boxes(
            blank
        )

        faces = detector.face_boxes(
            blank
        )

        print(
            json.dumps(
                {
                    "ok": True,
                    "phase": "11J-A",
                    "opencvVersion":
                        cv2.__version__,
                    "cameraId":
                        config.camera_id,
                    "customerZone":
                        encode_zone(
                            config
                            .customer_zone
                        ),
                    "staffZone":
                        encode_zone(
                            config
                            .staff_zone
                        ),
                    "blankPersonCount":
                        len(people),
                    "blankFaceCount":
                        len(faces),
                    "faceDetectionOnly":
                        True,
                    "faceRecognition":
                        False,
                },
                indent=2,
            )
        )

        return 0

    config.runtime_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    worker = AiShopkeeperWorker(
        config
    )

    loop = asyncio.new_event_loop()

    asyncio.set_event_loop(loop)

    for signal_name in (
        signal.SIGINT,
        signal.SIGTERM,
    ):
        with contextlib.suppress(
            NotImplementedError
        ):
            loop.add_signal_handler(
                signal_name,
                worker.request_stop,
            )

    lock_path = (
        config.runtime_dir /
        "ai_shopkeeper.lock"
    )

    pid_path = (
        config.runtime_dir /
        "ai_shopkeeper.pid"
    )

    try:
        with ProcessLock(
            lock_path,
            pid_path,
        ):
            loop.run_until_complete(
                worker.run_forever()
            )
    except KeyboardInterrupt:
        worker.request_stop()
    except Exception as error:
        LOG.exception(
            "AI worker failed: %s",
            error,
        )
        return 1
    finally:
        loop.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY_WORKER

chmod +x "$AI_WORKER"

cat > "$AI_REQUIREMENTS" <<'REQ'
livekit==1.1.13
livekit-api==1.2.0
python-dotenv==1.1.1
numpy>=2.0,<3
opencv-python-headless==4.13.0.92
REQ

log "Adding safe AI environment defaults"

python3 - "$ENV_FILE" <<'PY_ENV'
from pathlib import Path
import os
import sys

path = Path(sys.argv[1])

lines = path.read_text(
    encoding="utf-8",
    errors="replace",
).splitlines()

defaults = {
    "CCTV_AI_ENABLED": "true",
    "CCTV_AI_PLAN": "PREMIUM_AI",
    "CCTV_AI_CAMERA_ID":
        "cam-1772515015057",
    "CCTV_AI_BACKEND_URL":
        "http://127.0.0.1:3000",
    "CCTV_PUBLIC_DASHBOARD_URL":
        "http://127.0.0.1:8082",
    "CCTV_AI_CUSTOMER_ZONE":
        "0.00,0.00,0.65,1.00",
    "CCTV_AI_STAFF_ZONE":
        "0.65,0.00,1.00,1.00",
    "CCTV_AI_UNATTENDED_SECONDS":
        "20",
    "CCTV_AI_CLEAR_SECONDS": "5",
    "CCTV_AI_EVENT_COOLDOWN_SECONDS":
        "60",
    "CCTV_AI_WORKER_STALE_SECONDS":
        "15",
    "CCTV_AI_SAMPLE_INTERVAL_SECONDS":
        "1.0",
    "CCTV_AI_RECONNECT_SECONDS": "5",
    "CCTV_AI_WAIT_FOR_CAMERA_SECONDS":
        "45",
    "CCTV_AI_FRAME_TIMEOUT_SECONDS":
        "15",
    "CCTV_AI_DETECTION_WIDTH": "416",
    "CCTV_AI_JPEG_QUALITY": "72",
    "CCTV_AI_MIN_PERSON_WEIGHT":
        "0.15",
    "CCTV_AI_MIN_BOX_AREA_RATIO":
        "0.025",
    "CCTV_AI_FACE_DETECTION": "true",
}

existing = {
    line.split("=", 1)[0].strip()
    for line in lines
    if "=" in line
    and not line.lstrip().startswith("#")
}

if lines and lines[-1].strip():
    lines.append("")

lines.append(
    "# Phase 11J Premium AI Smart Shopkeeper"
)

for key, value in defaults.items():
    if key not in existing:
        lines.append(
            f"{key}={value}"
        )

temporary = path.with_name(
    f".{path.name}.tmp-{os.getpid()}"
)

temporary.write_text(
    "\n".join(lines).rstrip()
    + "\n",
    encoding="utf-8",
)

temporary.chmod(0o600)
temporary.replace(path)
path.chmod(0o600)
PY_ENV

log "Creating AI backend acceptance test"

cat > "$TEST_SCRIPT" <<'JS_TEST'
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
JS_TEST

cat > "$STATUS_SCRIPT" <<'SH_STATUS'
#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(
  cd "$(
    dirname "${BASH_SOURCE[0]}"
  )/.."
  pwd
)"

AI_STATUS="$ROOT/runtime/cctv-ai/ai_shopkeeper_status.json"
RECORDER_STATUS="$ROOT/runtime/cctv-recorder/continuous_recorder_status.json"

printf '\nSystem services:\n'

sudo systemctl \
  --no-pager \
  --full \
  status \
  root-seed-cctv-backend.service \
  root-seed-cctv-recorder.service \
  root-seed-cctv-ai.service \
  2>/dev/null || true

printf '\nAI worker status:\n'

if [[ -f "$AI_STATUS" ]]; then
  python3 -m json.tool \
    "$AI_STATUS"
else
  echo "No AI worker status file yet."
fi

printf '\nRecorder status:\n'

if [[ -f "$RECORDER_STATUS" ]]; then
  python3 -m json.tool \
    "$RECORDER_STATUS"
else
  echo "No recorder status file yet."
fi

printf '\nRecent AI service logs:\n'

sudo journalctl \
  -u root-seed-cctv-ai.service \
  --no-pager \
  -n 30
SH_STATUS

chmod +x "$STATUS_SCRIPT"

log "Adding npm commands"

python3 - "$PACKAGE" <<'PY_PACKAGE'
from pathlib import Path
import json
import sys

path = Path(sys.argv[1])

data = json.loads(
    path.read_text(
        encoding="utf-8"
    )
)

scripts = data.setdefault(
    "scripts",
    {},
)

scripts["ai:test"] = (
    "node scripts/test_ai_shopkeeper.js"
)

scripts["ai:worker-self-test"] = (
    "cctv-ai-worker/.venv/bin/python "
    "cctv-ai-worker/ai_shopkeeper_worker.py "
    "--env-file .env --self-test"
)

path.write_text(
    json.dumps(
        data,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY_PACKAGE

log "Creating isolated AI virtual environment"

if [[ ! -x "$AI_DIR/.venv/bin/python" ]]; then
  "$PYTHON_BIN" -m venv \
    "$AI_DIR/.venv"
fi

"$AI_DIR/.venv/bin/python" \
  -m pip install \
  --upgrade \
  pip \
  wheel \
  setuptools

"$AI_DIR/.venv/bin/pip" \
  install \
  -r "$AI_REQUIREMENTS"

log "Updating SQLite and Prisma client"

(
  cd "$ROOT"

  npx --no-install prisma validate
  npx --no-install prisma db push
  npx --no-install prisma generate
)

log "Validating JavaScript and Python"

node --check "$SERVER"
node --check "$AI_SERVER"
node --check "$TEST_SCRIPT"

"$AI_DIR/.venv/bin/python" \
  -m py_compile \
  "$AI_WORKER"

(
  cd "$ROOT"
  npm run ai:worker-self-test
)

log "Creating systemd boot services"

cat > "$DEPLOY_DIR/$BACKEND_SERVICE" <<UNIT_BACKEND
[Unit]
Description=ROOT & SEED CCTV Backend
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_GROUP
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $SERVER
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
UMask=0027
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT_BACKEND

cat > "$DEPLOY_DIR/$RECORDER_SERVICE" <<UNIT_RECORDER
[Unit]
Description=ROOT & SEED Continuous CCTV Recorder
Wants=network-online.target
After=network-online.target $BACKEND_SERVICE
StartLimitIntervalSec=0

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_GROUP
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
ExecStart=$ROOT/cctv-recorder-worker/run_continuous_recorder.sh
Restart=always
RestartSec=5
TimeoutStopSec=120
KillSignal=SIGTERM
UMask=0027
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT_RECORDER

cat > "$DEPLOY_DIR/$AI_SERVICE" <<UNIT_AI
[Unit]
Description=ROOT & SEED Premium AI Smart Shopkeeper
Requires=$BACKEND_SERVICE
Wants=network-online.target
After=network-online.target $BACKEND_SERVICE
StartLimitIntervalSec=0

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_GROUP
WorkingDirectory=$ROOT
Environment=HOME=$HOME_DIR
ExecStart=$AI_DIR/.venv/bin/python $AI_WORKER --env-file $ENV_FILE
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
UMask=0027
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT_AI

sudo install \
  -m 0644 \
  "$DEPLOY_DIR/$BACKEND_SERVICE" \
  "/etc/systemd/system/$BACKEND_SERVICE"

sudo install \
  -m 0644 \
  "$DEPLOY_DIR/$RECORDER_SERVICE" \
  "/etc/systemd/system/$RECORDER_SERVICE"

sudo install \
  -m 0644 \
  "$DEPLOY_DIR/$AI_SERVICE" \
  "/etc/systemd/system/$AI_SERVICE"

rm -f \
  "$ROOT/runtime/cctv-recorder/continuous_recorder.pid" \
  "$ROOT/runtime/cctv-ai/ai_shopkeeper.pid"

sudo systemctl daemon-reload

sudo systemctl enable \
  "$BACKEND_SERVICE" \
  "$RECORDER_SERVICE" \
  "$AI_SERVICE"

sudo systemctl restart \
  "$BACKEND_SERVICE"

log "Waiting for the backend"

BACKEND_READY=false

for _ in $(seq 1 30); do
  if "$NODE_BIN" - <<'JS_HEALTH' >/dev/null 2>&1
fetch("http://127.0.0.1:3000/health")
  .then((response) => {
    if (!response.ok) {
      process.exit(1);
    }
  })
  .catch(() => {
    process.exit(1);
  });
JS_HEALTH
  then
    BACKEND_READY=true
    break
  fi

  sleep 1
done

[[ "$BACKEND_READY" == "true" ]] ||
  fail "Backend service did not become healthy."

sudo systemctl restart \
  "$RECORDER_SERVICE" \
  "$AI_SERVICE"

sleep 5

sudo systemctl is-active \
  --quiet \
  "$BACKEND_SERVICE" ||
  fail "Backend system service is not active."

sudo systemctl is-active \
  --quiet \
  "$RECORDER_SERVICE" ||
  fail "Recorder system service is not active."

sudo systemctl is-active \
  --quiet \
  "$AI_SERVICE" ||
  fail "AI system service is not active."

log "Running AI backend acceptance test"

(
  cd "$ROOT"
  npm run ai:test
)

log "Running final structural validation"

python3 - \
  "$SERVER" \
  "$SCHEMA" \
  "$AI_SERVER" \
  "$AI_WORKER" \
  "$PACKAGE" <<'PY_VALIDATE'
from pathlib import Path
import json
import sys

server = Path(
    sys.argv[1]
).read_text(encoding="utf-8")

schema = Path(
    sys.argv[2]
).read_text(encoding="utf-8")

ai_server = Path(
    sys.argv[3]
).read_text(encoding="utf-8")

worker = Path(
    sys.argv[4]
).read_text(encoding="utf-8")

package = json.loads(
    Path(sys.argv[5]).read_text(
        encoding="utf-8"
    )
)

checks = {
    "serverRegistration": (
        "registerAiShopkeeperRoutes"
        in server
    ),
    "eventModel": (
        "model AiShopkeeperEvent"
        in schema
    ),
    "premiumField": (
        "aiShopkeeperEnabled"
        in schema
    ),
    "cameraMapping": (
        "streamCameraId"
        in schema
    ),
    "detectionApi": (
        '"/ai/detections"'
        in ai_server
    ),
    "eventApi": (
        '"/ai/events"'
        in ai_server
    ),
    "socketAlerts": (
        "ai:shopkeeper-event"
        in ai_server
    ),
    "telegramSupport": (
        "TELEGRAM_BOT_TOKEN"
        in ai_server
    ),
    "personDetection": (
        "HOGDescriptor"
        in worker
    ),
    "facePresence": (
        "CascadeClassifier"
        in worker
    ),
    "livekitWorker": (
        "rtc.VideoStream"
        in worker
    ),
    "testCommand": (
        package
        .get("scripts", {})
        .get("ai:test")
        ==
        "node scripts/test_ai_shopkeeper.js"
    ),
}

print(
    json.dumps(
        checks,
        indent=2,
    )
)

if not all(checks.values()):
    raise SystemExit(
        "11J-A structural validation failed"
    )
PY_VALIDATE

printf '\n[%s] Applied successfully\n' \
  "$NAME"

printf 'Backup: %s\n' "$BACKUP"

printf '\nInstalled services:\n'
printf '  %s\n' "$BACKEND_SERVICE"
printf '  %s\n' "$RECORDER_SERVICE"
printf '  %s\n' "$AI_SERVICE"

printf '\nStatus command:\n'
printf '  cd %q\n' "$ROOT"
printf '  bash scripts/show_ai_shopkeeper_status.sh\n'

printf '\nService logs:\n'
printf '  sudo journalctl -u %s -f\n' "$AI_SERVICE"

printf '\nAI zones currently use:\n'
printf '  Customer: left 65%% of image\n'
printf '  Staff: right 35%% of image\n'
printf 'These zones will be calibrated in the 11J-B dashboard.\n'
