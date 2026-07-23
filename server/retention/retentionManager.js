"use strict";

const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_INITIAL_DELAY_SECONDS = 90;
const MAX_PUBLIC_CANDIDATES = 250;

function bigintToNumber(value) {
  if (value === null || value === undefined) {
    return 0;
  }

  return Number(value);
}

function clampInteger(
  value,
  minimum,
  maximum,
  fallback,
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(minimum, Math.round(parsed)),
  );
}

function normalizeSettings(input, current) {
  const retentionEnabled =
    input.retentionEnabled === undefined
      ? current.retentionEnabled
      : Boolean(input.retentionEnabled);

  const retentionDays = clampInteger(
    input.retentionDays,
    1,
    3650,
    current.retentionDays || 30,
  );

  const maxUsagePercent = clampInteger(
    input.maxUsagePercent,
    50,
    99,
    current.maxUsagePercent || 90,
  );

  let minFreeBytes =
    current.minFreeBytes === null ||
    current.minFreeBytes === undefined
      ? 0n
      : BigInt(current.minFreeBytes);

  if (
    input.minFreeGigabytes !== undefined &&
    input.minFreeGigabytes !== null
  ) {
    const gigabytes = Number(
      input.minFreeGigabytes,
    );

    if (!Number.isFinite(gigabytes) || gigabytes < 0) {
      throw new Error(
        "Minimum free gigabytes must be zero or greater",
      );
    }

    minFreeBytes = BigInt(
      Math.round(gigabytes * 1024 ** 3),
    );
  } else if (
    input.minFreeBytes !== undefined &&
    input.minFreeBytes !== null
  ) {
    const bytes = Number(input.minFreeBytes);

    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error(
        "Minimum free bytes must be zero or greater",
      );
    }

    minFreeBytes = BigInt(Math.round(bytes));
  }

  return {
    retentionEnabled,
    retentionDays,
    maxUsagePercent,
    minFreeBytes,
  };
}

function serializeCandidate(recording, reason) {
  return {
    id: recording.id,
    cameraId: recording.cameraId,
    fileName: recording.fileName,
    startedAt:
      recording.startedAt?.toISOString?.() ||
      String(recording.startedAt),
    durationSeconds: recording.durationSeconds,
    sizeBytes: bigintToNumber(
      recording.sizeBytes,
    ),
    reason,
  };
}

function createRetentionManager({
  prisma,
  storageManager,
}) {
  let intervalHandle = null;
  let initialHandle = null;
  let runningAllTargets = false;

  async function findTarget(targetId) {
    const id = String(targetId || "").trim();

    const target =
      await prisma.storageTarget.findUnique({
        where: {
          id,
        },
      });

    if (!target) {
      throw new Error("Storage target not found");
    }

    return target;
  }

  async function updateSettings(targetId, input) {
    const current = await findTarget(targetId);
    const data = normalizeSettings(
      input || {},
      current,
    );

    const updated =
      await prisma.storageTarget.update({
        where: {
          id: current.id,
        },
        data,
      });

    return storageManager.serializeStorageTarget(
      updated,
    );
  }

  async function buildPlan(
    targetId,
    options = {},
  ) {
    const force = Boolean(options.force);
    const target = await findTarget(targetId);

    let checkedTarget = target;

    try {
      checkedTarget =
        await storageManager.refreshTargetHealth(
          target.id,
        );
    } catch (_error) {
      // Use the most recent stored capacity if the
      // immediate health check is unavailable.
    }

    const totalBytes = bigintToNumber(
      checkedTarget.totalBytes,
    );
    const availableBytes = bigintToNumber(
      checkedTarget.availableBytes,
    );
    const usedBytes =
      totalBytes > 0
        ? Math.max(0, totalBytes - availableBytes)
        : 0;

    const retentionDays =
      checkedTarget.retentionDays || 30;
    const maxUsagePercent =
      checkedTarget.maxUsagePercent || 90;
    const minFreeBytes = bigintToNumber(
      checkedTarget.minFreeBytes,
    );

    const maxUsedBytes =
      totalBytes > 0
        ? Math.floor(
            totalBytes *
              (maxUsagePercent / 100),
          )
        : 0;

    const requiredByUsage =
      totalBytes > 0
        ? Math.max(0, usedBytes - maxUsedBytes)
        : 0;

    const requiredByFree = Math.max(
      0,
      minFreeBytes - availableBytes,
    );

    const capacityBytesRequired = Math.max(
      requiredByUsage,
      requiredByFree,
    );

    const cutoff = new Date(
      Date.now() -
        retentionDays * 24 * 60 * 60 * 1000,
    );

    const unlockedRecordings =
      await prisma.recording.findMany({
        where: {
          storageTargetId: checkedTarget.id,
          isLocked: false,
        },
        orderBy: [
          {
            startedAt: "asc",
          },
          {
            createdAt: "asc",
          },
        ],
      });

    const lockedCount =
      await prisma.recording.count({
        where: {
          storageTargetId: checkedTarget.id,
          isLocked: true,
        },
      });

    const selected = [];
    const selectedIds = new Set();
    let estimatedFreedBytes = 0;

    function select(recording, reason) {
      if (selectedIds.has(recording.id)) {
        return;
      }

      selectedIds.add(recording.id);
      selected.push({
        recording,
        reason,
      });
      estimatedFreedBytes += bigintToNumber(
        recording.sizeBytes,
      );
    }

    const enabled =
      Boolean(checkedTarget.retentionEnabled);

    if (enabled || force) {
      unlockedRecordings.forEach((recording) => {
        if (recording.startedAt < cutoff) {
          select(
            recording,
            `OLDER_THAN_${retentionDays}_DAYS`,
          );
        }
      });

      if (
        estimatedFreedBytes <
        capacityBytesRequired
      ) {
        for (const recording of unlockedRecordings) {
          if (
            estimatedFreedBytes >=
            capacityBytesRequired
          ) {
            break;
          }

          select(
            recording,
            requiredByFree >= requiredByUsage
              ? "MINIMUM_FREE_SPACE"
              : "MAXIMUM_DISK_USAGE",
          );
        }
      }
    }

    const predictedUsedBytes = Math.max(
      0,
      usedBytes - estimatedFreedBytes,
    );

    const predictedAvailableBytes =
      availableBytes + estimatedFreedBytes;

    return {
      target: checkedTarget,
      enabled,
      force,
      policy: {
        retentionDays,
        maxUsagePercent,
        minFreeBytes,
      },
      capacity: {
        totalBytes,
        usedBytes,
        availableBytes,
        currentUsagePercent:
          totalBytes > 0
            ? (usedBytes / totalBytes) * 100
            : 0,
        requiredByUsage,
        requiredByFree,
        capacityBytesRequired,
        predictedUsedBytes,
        predictedAvailableBytes,
        predictedUsagePercent:
          totalBytes > 0
            ? (predictedUsedBytes / totalBytes) *
              100
            : 0,
      },
      unlockedCount: unlockedRecordings.length,
      lockedCount,
      selected,
      estimatedFreedBytes,
      cutoff,
    };
  }

  function serializePlan(plan) {
    return {
      target:
        storageManager.serializeStorageTarget(
          plan.target,
        ),
      enabled: plan.enabled,
      forced: plan.force,
      policy: plan.policy,
      capacity: plan.capacity,
      unlockedCount: plan.unlockedCount,
      lockedCount: plan.lockedCount,
      deleteCount: plan.selected.length,
      estimatedFreedBytes:
        plan.estimatedFreedBytes,
      cutoff: plan.cutoff.toISOString(),
      candidates: plan.selected
        .slice(0, MAX_PUBLIC_CANDIDATES)
        .map(({ recording, reason }) =>
          serializeCandidate(
            recording,
            reason,
          ),
        ),
      candidateListTruncated:
        plan.selected.length >
        MAX_PUBLIC_CANDIDATES,
    };
  }

  async function previewCleanup(
    targetId,
    options = {},
  ) {
    return serializePlan(
      await buildPlan(targetId, options),
    );
  }

  async function removeRecordingFile(
    target,
    recording,
  ) {
    const rootPath = path.resolve(
      target.rootPath,
    );

    const absolutePath = path.resolve(
      rootPath,
      recording.relativeFilePath,
    );

    if (
      absolutePath !== rootPath &&
      !absolutePath.startsWith(
        `${rootPath}${path.sep}`,
      )
    ) {
      throw new Error(
        "Recording path is outside its storage target",
      );
    }

    await fsp.rm(absolutePath, {
      force: true,
    });

    await fsp.rm(
      absolutePath.replace(/\.mp4$/i, ".json"),
      {
        force: true,
      },
    );

    await prisma.recording.delete({
      where: {
        id: recording.id,
      },
    });

    let directory = path.dirname(absolutePath);

    while (
      directory !== rootPath &&
      directory.startsWith(
        `${rootPath}${path.sep}`,
      )
    ) {
      try {
        await fsp.rmdir(directory);
      } catch (_error) {
        break;
      }

      directory = path.dirname(directory);
    }
  }

  async function runCleanup(
    targetId,
    options = {},
  ) {
    const plan = await buildPlan(
      targetId,
      options,
    );

    if (!plan.enabled && !plan.force) {
      return {
        ok: true,
        skipped: true,
        reason: "RETENTION_DISABLED",
        deletedCount: 0,
        freedBytes: 0,
        failures: [],
        preview: serializePlan(plan),
      };
    }

    let deletedCount = 0;
    let freedBytes = 0;
    const failures = [];

    for (const item of plan.selected) {
      try {
        await removeRecordingFile(
          plan.target,
          item.recording,
        );

        deletedCount += 1;
        freedBytes += bigintToNumber(
          item.recording.sizeBytes,
        );
      } catch (error) {
        failures.push({
          recordingId: item.recording.id,
          fileName: item.recording.fileName,
          error:
            error.message ||
            "Recording cleanup failed",
        });
      }
    }

    let updatedTarget =
      await prisma.storageTarget.update({
        where: {
          id: plan.target.id,
        },
        data: {
          lastCleanupAt: new Date(),
          lastCleanupDeleted: deletedCount,
          lastCleanupFreedBytes:
            BigInt(freedBytes),
        },
      });

    try {
      updatedTarget =
        await storageManager.refreshTargetHealth(
          updatedTarget.id,
        );
    } catch (_error) {
      // Keep the cleanup result even when the final
      // health refresh cannot finish.
    }

    return {
      ok: failures.length === 0,
      skipped: false,
      target:
        storageManager.serializeStorageTarget(
          updatedTarget,
        ),
      deletedCount,
      freedBytes,
      failures,
      preview: serializePlan(plan),
      completedAt: new Date().toISOString(),
    };
  }

  async function runAllEnabledTargets(
    options = {},
  ) {
    if (runningAllTargets) {
      return {
        skipped: true,
        reason: "CLEANUP_ALREADY_RUNNING",
        targetCount: 0,
        results: [],
      };
    }

    runningAllTargets = true;

    try {
      const targets =
        await prisma.storageTarget.findMany({
          where: {
            isEnabled: true,
            retentionEnabled: true,
          },
          orderBy: {
            isDefault: "desc",
          },
        });

      const results = [];

      for (const target of targets) {
        try {
          results.push(
            await runCleanup(
              target.id,
              options,
            ),
          );
        } catch (error) {
          results.push({
            ok: false,
            targetId: target.id,
            targetName: target.name,
            error:
              error.message ||
              "Scheduled cleanup failed",
          });
        }
      }

      return {
        skipped: false,
        targetCount: targets.length,
        results,
        completedAt: new Date().toISOString(),
      };
    } finally {
      runningAllTargets = false;
    }
  }

  function startScheduler() {
    if (intervalHandle || initialHandle) {
      return;
    }

    const intervalMinutes = clampInteger(
      process.env
        .RETENTION_CLEANUP_INTERVAL_MINUTES,
      5,
      24 * 60,
      DEFAULT_INTERVAL_MINUTES,
    );

    const initialDelaySeconds = clampInteger(
      process.env
        .RETENTION_CLEANUP_INITIAL_DELAY_SECONDS,
      10,
      24 * 60 * 60,
      DEFAULT_INITIAL_DELAY_SECONDS,
    );

    const execute = () => {
      void runAllEnabledTargets()
        .then((result) => {
          const totals = (
            result.results || []
          ).reduce(
            (current, item) => ({
              deletedCount:
                current.deletedCount +
                Number(
                  item.deletedCount || 0,
                ),
              freedBytes:
                current.freedBytes +
                Number(item.freedBytes || 0),
            }),
            {
              deletedCount: 0,
              freedBytes: 0,
            },
          );

          console.log(
            "🧹 Scheduled retention cleanup:",
            {
              targets:
                result.targetCount || 0,
              ...totals,
            },
          );
        })
        .catch((error) => {
          console.error(
            "❌ Scheduled retention cleanup failed:",
            error,
          );
        });
    };

    initialHandle = setTimeout(() => {
      initialHandle = null;
      execute();

      intervalHandle = setInterval(
        execute,
        intervalMinutes * 60 * 1000,
      );

      intervalHandle.unref?.();
    }, initialDelaySeconds * 1000);

    initialHandle.unref?.();

    console.log(
      "🧹 Retention scheduler enabled:",
      {
        initialDelaySeconds,
        intervalMinutes,
      },
    );
  }

  return {
    previewCleanup,
    runAllEnabledTargets,
    runCleanup,
    startScheduler,
    updateSettings,
  };
}

module.exports = {
  createRetentionManager,
};
