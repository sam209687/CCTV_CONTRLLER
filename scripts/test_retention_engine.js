"use strict";

require("dotenv").config();

const path = require("path");
const {
  PrismaClient,
} = require("@prisma/client");
const {
  createStorageManager,
} = require("../server/storage/storageManager");
const {
  createRetentionManager,
} = require("../server/retention/retentionManager");

const prisma = new PrismaClient();

const projectRoot = path.resolve(__dirname, "..");
const recordingsRoot = path.resolve(
  process.env.RECORDINGS_DIR ||
    path.join(projectRoot, "recordings"),
);

async function main() {
  const storageManager =
    createStorageManager({
      prisma,
      legacyRoot: recordingsRoot,
    });

  const retentionManager =
    createRetentionManager({
      prisma,
      storageManager,
    });

  const target =
    await storageManager
      .ensureDefaultStorageTarget();

  const preview =
    await retentionManager.previewCleanup(
      target.id,
    );

  console.log(
    JSON.stringify(
      {
        database: "connected",
        targetId: target.id,
        targetName: target.name,
        retentionEnabled:
          preview.enabled,
        retentionDays:
          preview.policy.retentionDays,
        maxUsagePercent:
          preview.policy.maxUsagePercent,
        minFreeBytes:
          preview.policy.minFreeBytes,
        unlockedCount:
          preview.unlockedCount,
        lockedCount:
          preview.lockedCount,
        deleteCount:
          preview.deleteCount,
        estimatedFreedBytes:
          preview.estimatedFreedBytes,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
