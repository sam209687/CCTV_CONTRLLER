"use strict";

require("dotenv").config();

const path = require("path");
const { PrismaClient } = require("@prisma/client");
const {
  createStorageManager,
} = require("../server/storage/storageManager");

const prisma = new PrismaClient();

const PROJECT_ROOT = path.resolve(__dirname, "..");
const RECORDINGS_ROOT = path.resolve(
  process.env.RECORDINGS_DIR ||
    path.join(PROJECT_ROOT, "recordings"),
);

async function main() {
  const storageManager = createStorageManager({
    prisma,
    legacyRoot: RECORDINGS_ROOT,
  });

  const defaultTarget =
    await storageManager.ensureDefaultStorageTarget();

  const migration = await prisma.recording.updateMany({
    where: {
      storageTargetId: null,
    },
    data: {
      storageTargetId: defaultTarget.id,
    },
  });

  console.log("Storage target seed complete", {
    defaultStorageTarget:
      storageManager.serializeStorageTarget(defaultTarget),
    recordingsAssignedToDefault: migration.count,
  });
}

main()
  .catch((error) => {
    console.error("Storage target seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
