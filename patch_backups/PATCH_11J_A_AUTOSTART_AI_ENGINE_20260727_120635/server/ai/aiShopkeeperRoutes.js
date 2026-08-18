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
