"use strict";

require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const PROJECT_ROOT = path.resolve(__dirname, "..");
const RECORDINGS_ROOT = path.resolve(
  process.env.RECORDINGS_DIR ||
    path.join(PROJECT_ROOT, "recordings"),
);

async function walk(directory) {
  let entries = [];

  try {
    entries = await fs.readdir(directory, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".json")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

function parseDate(value, fallback = new Date()) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

async function main() {
  const metadataFiles = await walk(RECORDINGS_ROOT);

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const metadataFile of metadataFiles) {
    try {
      const raw = await fs.readFile(metadataFile, "utf8");
      const item = JSON.parse(raw);

      const relativeFilePath = String(
        item.relativeFilePath || "",
      ).trim();

      const cameraId = String(item.cameraId || "").trim();
      const fileName = String(item.fileName || "").trim();

      if (!relativeFilePath || !cameraId || !fileName) {
        skipped += 1;
        continue;
      }

      const absoluteVideoPath = path.resolve(
        RECORDINGS_ROOT,
        relativeFilePath,
      );

      if (!absoluteVideoPath.startsWith(RECORDINGS_ROOT)) {
        skipped += 1;
        continue;
      }

      let sizeBytes = Number(item.sizeBytes || 0);

      try {
        const stat = await fs.stat(absoluteVideoPath);
        sizeBytes = stat.size;
      } catch (_error) {
        // Preserve metadata size when the video is temporarily unavailable.
      }

      const startedAt = parseDate(item.startedAt);
      const durationSeconds = Math.max(
        0,
        Math.round(Number(item.durationSeconds || 0)),
      );

      const endedAt = new Date(
        startedAt.getTime() + durationSeconds * 1000,
      );

      await prisma.recording.upsert({
        where: { relativeFilePath },
        update: {
          cameraId,
          fileName,
          sizeBytes: BigInt(Math.max(0, sizeBytes)),
          startedAt,
          endedAt,
          durationSeconds,
          uploadStatus: "STORED",
          uploadedAt: parseDate(item.uploadedAt),
        },
        create: {
          id:
            typeof item.id === "string" && item.id.trim()
              ? item.id.trim()
              : undefined,
          cameraId,
          fileName,
          relativeFilePath,
          sizeBytes: BigInt(Math.max(0, sizeBytes)),
          startedAt,
          endedAt,
          durationSeconds,
          recordingMode: "CONTINUOUS",
          uploadStatus: "STORED",
          uploadedAt: parseDate(item.uploadedAt),
        },
      });

      imported += 1;
    } catch (error) {
      failed += 1;
      console.warn(
        "Skipping metadata file:",
        metadataFile,
        error.message,
      );
    }
  }

  console.log("Recording metadata import complete", {
    recordingsRoot: RECORDINGS_ROOT,
    metadataFiles: metadataFiles.length,
    imported,
    skipped,
    failed,
  });
}

main()
  .catch((error) => {
    console.error("Recording metadata import failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
