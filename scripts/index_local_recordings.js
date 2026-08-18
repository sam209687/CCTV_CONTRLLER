"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({
  path: path.join(PROJECT_ROOT, ".env"),
});

const prisma = new PrismaClient();

function recordingsRoot() {
  return path.resolve(
    process.env.CCTV_RECORDINGS_DIR ||
      process.env.RECORDINGS_DIR ||
      path.join(PROJECT_ROOT, "recordings"),
  );
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function parseDate(value, fallback) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed
    : fallback;
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function walkMetadata(directory) {
  let entries;

  try {
    entries = await fsp.readdir(directory, {
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
      files.push(...(await walkMetadata(fullPath)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".json") &&
      !entry.name.endsWith(".reason.json")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

async function ensureStorageTarget(root) {
  const existing = await prisma.storageTarget.findUnique({
    where: { rootPath: root },
  });

  if (existing) {
    return prisma.storageTarget.update({
      where: { id: existing.id },
      data: {
        isEnabled: true,
        status: "ONLINE",
        lastHealthCheckAt: new Date(),
        lastError: null,
      },
    });
  }

  const defaultCount = await prisma.storageTarget.count({
    where: { isDefault: true },
  });

  return prisma.storageTarget.create({
    data: {
      name: "Local CCTV Recordings",
      type: "LOCAL",
      rootPath: root,
      isDefault: defaultCount === 0,
      isEnabled: true,
      status: "ONLINE",
      retentionEnabled: true,
      retentionDays: 30,
      maxUsagePercent: 90,
      minFreeBytes: BigInt(10 * 1024 * 1024 * 1024),
      lastHealthCheckAt: new Date(),
    },
  });
}

async function resolveVideoPath(metadata, metadataPath, root) {
  const candidates = [];

  if (typeof metadata.filePath === "string" && metadata.filePath.trim()) {
    candidates.push(
      path.isAbsolute(metadata.filePath)
        ? path.resolve(metadata.filePath)
        : path.resolve(root, metadata.filePath),
    );
  }

  if (
    typeof metadata.relativeFilePath === "string" &&
    metadata.relativeFilePath.trim()
  ) {
    candidates.push(
      path.resolve(root, metadata.relativeFilePath),
    );
  }

  candidates.push(
    metadataPath.replace(/\.json$/i, ".mp4"),
  );

  for (const candidate of candidates) {
    if (
      withinRoot(root, candidate) &&
      candidate.toLowerCase().endsWith(".mp4") &&
      !candidate.toLowerCase().endsWith(".partial.mp4")
    ) {
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) {
          return { path: candidate, stat };
        }
      } catch (_error) {
        // Try the next candidate.
      }
    }
  }

  return null;
}

function inferCameraId(metadata, videoPath, root) {
  const explicit = String(metadata.cameraId || "").trim();
  if (explicit) {
    return explicit;
  }

  const relative = path.relative(root, videoPath);
  const firstPart = relative.split(path.sep)[0];

  return firstPart && firstPart !== "_Interrupted"
    ? firstPart
    : "unknown-camera";
}

async function indexMetadataFile(metadataPath, storageTarget, root) {
  const raw = await fsp.readFile(metadataPath, "utf8");
  const metadata = JSON.parse(raw);
  const resolved = await resolveVideoPath(
    metadata,
    metadataPath,
    root,
  );

  if (!resolved) {
    return {
      status: "skipped",
      metadataPath,
      reason: "finalized-mp4-not-found",
    };
  }

  const videoPath = resolved.path;
  const stat = resolved.stat;
  const relativeFilePath = path
    .relative(root, videoPath)
    .split(path.sep)
    .join("/");
  const cameraId = inferCameraId(metadata, videoPath, root);
  const fileName = path.basename(videoPath);

  const durationValue = Number(
    metadata.durationSeconds ??
      metadata.wallClockElapsedSeconds ??
      0,
  );
  const durationSeconds = Math.max(
    0,
    Math.round(
      Number.isFinite(durationValue) ? durationValue : 0,
    ),
  );

  const fallbackStarted = stat.birthtimeMs > 0
    ? stat.birthtime
    : stat.mtime;
  const startedAt = parseDate(
    metadata.startedAt,
    fallbackStarted,
  );
  const endedAt = parseDate(
    metadata.endedAt,
    new Date(
      startedAt.getTime() + durationSeconds * 1000,
    ),
  );
  const uploadedAt = parseDate(
    metadata.uploadedAt || metadata.endedAt,
    stat.mtime,
  );

  const recordingMode = String(
    metadata.recordingMode || "CONTINUOUS_LOCAL_SEGMENT",
  ).trim();
  const eventType = String(
    metadata.eventType || metadata.terminationReason || "",
  ).trim() || null;

  const recording = await prisma.recording.upsert({
    where: { relativeFilePath },
    update: {
      cameraId,
      fileName,
      sizeBytes: BigInt(stat.size),
      startedAt,
      endedAt,
      durationSeconds,
      recordingMode,
      eventType,
      uploadStatus: "STORED",
      storageTargetId: storageTarget.id,
      uploadedAt,
    },
    create: {
      cameraId,
      fileName,
      relativeFilePath,
      sizeBytes: BigInt(stat.size),
      startedAt,
      endedAt,
      durationSeconds,
      recordingMode,
      eventType,
      uploadStatus: "STORED",
      storageTargetId: storageTarget.id,
      uploadedAt,
    },
  });

  return {
    status: "indexed",
    metadataPath,
    recording: {
      id: recording.id,
      cameraId: recording.cameraId,
      fileName: recording.fileName,
      relativeFilePath: recording.relativeFilePath,
      sizeBytes: Number(recording.sizeBytes),
      durationSeconds: recording.durationSeconds,
      startedAt: recording.startedAt.toISOString(),
      endedAt: recording.endedAt
        ? recording.endedAt.toISOString()
        : null,
      storageTargetId: recording.storageTargetId,
    },
  };
}

async function main() {
  const root = recordingsRoot();
  const metadataArgument = argumentValue("--metadata");
  const scan = hasArgument("--scan") || !metadataArgument;
  const cameraFilter = String(
    argumentValue("--camera") || "",
  ).trim();
  const jsonOutput = hasArgument("--json");

  await fsp.mkdir(root, { recursive: true });
  const storageTarget = await ensureStorageTarget(root);

  let metadataFiles = [];

  if (metadataArgument) {
    metadataFiles = [path.resolve(metadataArgument)];
  } else if (scan) {
    metadataFiles = await walkMetadata(root);
  }

  metadataFiles.sort();

  const results = [];
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (const metadataPath of metadataFiles) {
    try {
      const result = await indexMetadataFile(
        metadataPath,
        storageTarget,
        root,
      );

      if (
        cameraFilter &&
        result.recording?.cameraId !== cameraFilter
      ) {
        continue;
      }

      results.push(result);

      if (result.status === "indexed") {
        indexed += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      results.push({
        status: "failed",
        metadataPath,
        error: error.message,
      });
    }
  }

  const payload = {
    ok: failed === 0,
    phase: "11I-L3",
    recordingsRoot: root,
    storageTargetId: storageTarget.id,
    metadataFiles: metadataFiles.length,
    indexed,
    skipped,
    failed,
    results: metadataArgument ? results : results.slice(-10),
  };

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    console.log(
      "Local recording SQLite index complete",
      payload,
    );
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("Local recording index failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
