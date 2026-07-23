"use strict";

function registerRetentionRoutes(
  app,
  {
    prisma,
    retentionManager,
    storageManager,
  },
) {
  app.get(
    "/retention/status",
    async (_request, response) => {
      try {
        const targets =
          await prisma.storageTarget.findMany({
            orderBy: [
              {
                isDefault: "desc",
              },
              {
                name: "asc",
              },
            ],
          });

        response.json({
          ok: true,
          targetCount: targets.length,
          enabledTargetCount: targets.filter(
            (target) =>
              target.isEnabled &&
              target.retentionEnabled,
          ).length,
          storageTargets: targets.map(
            storageManager.serializeStorageTarget,
          ),
        });
      } catch (error) {
        response.status(500).json({
          ok: false,
          error:
            error.message ||
            "Failed to load retention status",
        });
      }
    },
  );

  app.get(
    "/storage-targets/:targetId/retention",
    async (request, response) => {
      try {
        const target =
          await prisma.storageTarget.findUnique({
            where: {
              id: request.params.targetId,
            },
          });

        if (!target) {
          response.status(404).json({
            ok: false,
            error: "Storage target not found",
          });
          return;
        }

        response.json({
          ok: true,
          storageTarget:
            storageManager.serializeStorageTarget(
              target,
            ),
        });
      } catch (error) {
        response.status(500).json({
          ok: false,
          error:
            error.message ||
            "Failed to load retention settings",
        });
      }
    },
  );

  app.patch(
    "/storage-targets/:targetId/retention",
    async (request, response) => {
      try {
        const storageTarget =
          await retentionManager.updateSettings(
            request.params.targetId,
            request.body || {},
          );

        response.json({
          ok: true,
          storageTarget,
        });
      } catch (error) {
        response.status(
          error.message ===
          "Storage target not found"
            ? 404
            : 400,
        ).json({
          ok: false,
          error:
            error.message ||
            "Failed to update retention settings",
        });
      }
    },
  );

  app.post(
    "/storage-targets/:targetId/cleanup-preview",
    async (request, response) => {
      try {
        const preview =
          await retentionManager.previewCleanup(
            request.params.targetId,
            {
              force: Boolean(
                request.body?.force,
              ),
            },
          );

        response.json({
          ok: true,
          preview,
        });
      } catch (error) {
        response.status(
          error.message ===
          "Storage target not found"
            ? 404
            : 500,
        ).json({
          ok: false,
          error:
            error.message ||
            "Failed to preview cleanup",
        });
      }
    },
  );

  app.post(
    "/storage-targets/:targetId/cleanup-run",
    async (request, response) => {
      try {
        const result =
          await retentionManager.runCleanup(
            request.params.targetId,
            {
              force: Boolean(
                request.body?.force,
              ),
            },
          );

        response.json({
          ok: true,
          result,
        });
      } catch (error) {
        response.status(
          error.message ===
          "Storage target not found"
            ? 404
            : 500,
        ).json({
          ok: false,
          error:
            error.message ||
            "Retention cleanup failed",
        });
      }
    },
  );

  app.post(
    "/retention/run-all",
    async (request, response) => {
      try {
        const result =
          await retentionManager
            .runAllEnabledTargets({
              force: Boolean(
                request.body?.force,
              ),
            });

        response.json({
          ok: true,
          result,
        });
      } catch (error) {
        response.status(500).json({
          ok: false,
          error:
            error.message ||
            "Failed to run retention cleanup",
        });
      }
    },
  );
}

module.exports = {
  registerRetentionRoutes,
};
