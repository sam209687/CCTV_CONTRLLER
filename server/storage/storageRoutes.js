"use strict";

function registerStorageRoutes(
  app,
  { prisma, storageManager },
) {
  app.get("/storage-targets", async (_request, response) => {
    try {
      await storageManager.ensureDefaultStorageTarget();

      const targets = await prisma.storageTarget.findMany({
        orderBy: [
          { isDefault: "desc" },
          { name: "asc" },
        ],
      });

      response.json({
        ok: true,
        count: targets.length,
        storageTargets: targets.map(
          storageManager.serializeStorageTarget,
        ),
      });
    } catch (error) {
      console.error("❌ Failed to list storage targets:", error);

      response.status(500).json({
        ok: false,
        error: error.message || "Failed to list storage targets",
      });
    }
  });

  app.get(
    "/storage-targets/candidates",
    async (_request, response) => {
      try {
        const candidates =
          await storageManager.listStorageCandidates();

        response.json({
          ok: true,
          count: candidates.length,
          candidates,
        });
      } catch (error) {
        console.error(
          "❌ Failed to detect storage candidates:",
          error,
        );

        response.status(500).json({
          ok: false,
          error:
            error.message ||
            "Failed to detect storage candidates",
        });
      }
    },
  );

  app.post("/storage-targets", async (request, response) => {
    try {
      const name = String(request.body?.name || "").trim();
      const rootPath = storageManager.normalizeRootPath(
        request.body?.rootPath,
      );
      const type = storageManager.normalizeStorageType(
        request.body?.type,
      );
      const makeDefault = Boolean(request.body?.isDefault);

      if (!name) {
        response.status(400).json({
          ok: false,
          error: "Storage target name is required",
        });
        return;
      }

      const health = await storageManager.inspectRootPath(
        rootPath,
        {
          createIfMissing: true,
          performWriteTest: true,
        },
      );

      const target = await prisma.$transaction(async (transaction) => {
        if (makeDefault) {
          await transaction.storageTarget.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }

        return transaction.storageTarget.create({
          data: {
            name,
            type,
            rootPath: health.rootPath,
            isDefault: makeDefault,
            isEnabled: true,
            status: health.status,
            totalBytes: health.totalBytes,
            availableBytes: health.availableBytes,
            lastHealthCheckAt: health.checkedAt,
            lastError: null,
          },
        });
      });

      response.status(201).json({
        ok: true,
        storageTarget:
          storageManager.serializeStorageTarget(target),
      });
    } catch (error) {
      const duplicatePath = error.code === "P2002";

      console.error("❌ Failed to create storage target:", error);

      response.status(duplicatePath ? 409 : 400).json({
        ok: false,
        error: duplicatePath
          ? "A storage target already uses this root path"
          : error.message || "Failed to create storage target",
      });
    }
  });

  app.patch(
    "/storage-targets/:storageTargetId",
    async (request, response) => {
      try {
        const existing = await prisma.storageTarget.findUnique({
          where: {
            id: request.params.storageTargetId,
          },
        });

        if (!existing) {
          response.status(404).json({
            ok: false,
            error: "Storage target not found",
          });
          return;
        }

        const data = {};

        if (typeof request.body?.name === "string") {
          const name = request.body.name.trim();

          if (!name) {
            response.status(400).json({
              ok: false,
              error: "Storage target name cannot be empty",
            });
            return;
          }

          data.name = name;
        }

        if (request.body?.type !== undefined) {
          data.type = storageManager.normalizeStorageType(
            request.body.type,
          );
        }

        if (typeof request.body?.isEnabled === "boolean") {
          if (existing.isDefault && !request.body.isEnabled) {
            response.status(409).json({
              ok: false,
              error:
                "The default storage target cannot be disabled",
            });
            return;
          }

          data.isEnabled = request.body.isEnabled;
        }

        if (request.body?.rootPath !== undefined) {
          const rootPath = storageManager.normalizeRootPath(
            request.body.rootPath,
          );

          if (rootPath !== existing.rootPath) {
            const recordingCount =
              await prisma.recording.count({
                where: {
                  storageTargetId: existing.id,
                },
              });

            if (recordingCount > 0) {
              response.status(409).json({
                ok: false,
                error:
                  "This storage target already contains recordings. " +
                  "Create a new storage target instead of changing its path.",
              });
              return;
            }
          }

          const health = await storageManager.inspectRootPath(
            rootPath,
            {
              createIfMissing: true,
              performWriteTest: true,
            },
          );

          Object.assign(data, {
            rootPath: health.rootPath,
            status: health.status,
            totalBytes: health.totalBytes,
            availableBytes: health.availableBytes,
            lastHealthCheckAt: health.checkedAt,
            lastError: null,
          });
        }

        const target = await prisma.storageTarget.update({
          where: {
            id: existing.id,
          },
          data,
        });

        response.json({
          ok: true,
          storageTarget:
            storageManager.serializeStorageTarget(target),
        });
      } catch (error) {
        console.error("❌ Failed to update storage target:", error);

        response.status(error.code === "P2002" ? 409 : 400).json({
          ok: false,
          error:
            error.code === "P2002"
              ? "A storage target already uses this root path"
              : error.message || "Failed to update storage target",
        });
      }
    },
  );

  app.post(
    "/storage-targets/:storageTargetId/test",
    async (request, response) => {
      try {
        const target =
          await storageManager.refreshTargetHealth(
            request.params.storageTargetId,
          );

        const serialized =
          storageManager.serializeStorageTarget(target);

        response.status(
          target.status === "AVAILABLE" ? 200 : 503,
        ).json({
          ok: target.status === "AVAILABLE",
          storageTarget: serialized,
          error:
            target.status === "AVAILABLE"
              ? null
              : target.lastError,
        });
      } catch (error) {
        response.status(404).json({
          ok: false,
          error: error.message || "Storage target not found",
        });
      }
    },
  );

  app.post(
    "/storage-targets/:storageTargetId/default",
    async (request, response) => {
      try {
        const target = await prisma.storageTarget.findUnique({
          where: {
            id: request.params.storageTargetId,
          },
        });

        if (!target) {
          response.status(404).json({
            ok: false,
            error: "Storage target not found",
          });
          return;
        }

        if (!target.isEnabled) {
          response.status(409).json({
            ok: false,
            error:
              "Enable and test the storage target before making it default",
          });
          return;
        }

        const checked =
          await storageManager.refreshTargetHealth(target.id);

        if (checked.status !== "AVAILABLE") {
          response.status(503).json({
            ok: false,
            error:
              checked.lastError ||
              "Storage target is unavailable",
          });
          return;
        }

        const updated = await prisma.$transaction(
          async (transaction) => {
            await transaction.storageTarget.updateMany({
              where: { isDefault: true },
              data: { isDefault: false },
            });

            return transaction.storageTarget.update({
              where: { id: target.id },
              data: { isDefault: true },
            });
          },
        );

        response.json({
          ok: true,
          storageTarget:
            storageManager.serializeStorageTarget(updated),
        });
      } catch (error) {
        console.error(
          "❌ Failed to select default storage target:",
          error,
        );

        response.status(500).json({
          ok: false,
          error:
            error.message ||
            "Failed to select default storage target",
        });
      }
    },
  );

  app.delete(
    "/storage-targets/:storageTargetId",
    async (request, response) => {
      try {
        const target = await prisma.storageTarget.findUnique({
          where: {
            id: request.params.storageTargetId,
          },
        });

        if (!target) {
          response.status(404).json({
            ok: false,
            error: "Storage target not found",
          });
          return;
        }

        if (target.isDefault) {
          response.status(409).json({
            ok: false,
            error: "The default storage target cannot be deleted",
          });
          return;
        }

        const recordingCount = await prisma.recording.count({
          where: {
            storageTargetId: target.id,
          },
        });

        if (recordingCount > 0) {
          response.status(409).json({
            ok: false,
            error:
              "The storage target contains recordings and cannot be deleted",
          });
          return;
        }

        await prisma.storageTarget.delete({
          where: {
            id: target.id,
          },
        });

        response.json({
          ok: true,
          deletedStorageTargetId: target.id,
        });
      } catch (error) {
        console.error("❌ Failed to delete storage target:", error);

        response.status(500).json({
          ok: false,
          error: error.message || "Failed to delete storage target",
        });
      }
    },
  );
}

module.exports = {
  registerStorageRoutes,
};
