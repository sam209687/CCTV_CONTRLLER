"use strict";

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({
  path: path.join(PROJECT_ROOT, ".env"),
});

const prisma = new PrismaClient();

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const cameraId = String(
    argumentValue("--camera") || "",
  ).trim();

  const where = cameraId ? { cameraId } : {};
  const [count, latest, aggregate] = await Promise.all([
    prisma.recording.count({ where }),
    prisma.recording.findFirst({
      where,
      orderBy: { startedAt: "desc" },
      include: { storageTarget: true },
    }),
    prisma.recording.aggregate({
      where,
      _sum: {
        sizeBytes: true,
        durationSeconds: true,
      },
    }),
  ]);

  if (!latest) {
    throw new Error(
      `No indexed recordings found${cameraId ? ` for ${cameraId}` : ""}.`,
    );
  }

  const root = latest.storageTarget?.rootPath ||
    path.resolve(
      process.env.CCTV_RECORDINGS_DIR ||
        process.env.RECORDINGS_DIR ||
        path.join(PROJECT_ROOT, "recordings"),
    );
  const absolutePath = path.resolve(
    root,
    ...latest.relativeFilePath.split("/"),
  );

  const result = {
    ok: true,
    phase: "11I-L3",
    cameraId: cameraId || null,
    count,
    totalSizeBytes: Number(aggregate._sum.sizeBytes || 0n),
    totalDurationSeconds:
      aggregate._sum.durationSeconds || 0,
    latest: {
      id: latest.id,
      cameraId: latest.cameraId,
      fileName: latest.fileName,
      relativeFilePath: latest.relativeFilePath,
      absolutePath,
      fileExists: fs.existsSync(absolutePath),
      sizeBytes: Number(latest.sizeBytes),
      durationSeconds: latest.durationSeconds,
      startedAt: latest.startedAt.toISOString(),
      endedAt: latest.endedAt
        ? latest.endedAt.toISOString()
        : null,
      recordingMode: latest.recordingMode,
      eventType: latest.eventType,
      storageTargetId: latest.storageTargetId,
      storageRoot: root,
    },
  };

  console.log(JSON.stringify(result, null, 2));

  if (!result.latest.fileExists) {
    throw new Error(
      `Latest indexed MP4 is missing: ${absolutePath}`,
    );
  }
}

main()
  .catch((error) => {
    console.error("Recording index validation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
