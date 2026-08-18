"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

function registerRecordingEvidenceRoutes(
  app,
  {
    prisma,
    storageManager,
    recordingsRoot,
  },
) {
  const exportRoot = path.resolve(
    process.env.CCTV_RECORDING_EXPORTS_DIR ||
      path.join(recordingsRoot, "_Evidence"),
  );

  const maximumClipSeconds = Math.max(
    1,
    Number(
      process.env.CCTV_EXPORT_MAX_CLIP_SECONDS ||
        1800,
    ) || 1800,
  );

  const exportFps = Math.max(
    1,
    Math.min(
      60,
      Number(process.env.CCTV_EXPORT_FPS || 10) ||
        10,
    ),
  );

  const exportCrf = Math.max(
    0,
    Math.min(
      51,
      Number(process.env.CCTV_EXPORT_CRF || 23) ||
        23,
    ),
  );

  fs.mkdirSync(exportRoot, {
    recursive: true,
  });

  function sanitize(value, fallback = "camera") {
    const result = String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 160);

    return result || fallback;
  }

  function insideRoot(root, candidate) {
    const relative = path.relative(root, candidate);

    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  function resolveExportPath(item) {
    if (!item.relativeFilePath) {
      throw new Error(
        "Export does not have an output path",
      );
    }

    const absolutePath = path.resolve(
      exportRoot,
      ...item.relativeFilePath
        .split("/")
        .filter(Boolean),
    );

    if (!insideRoot(exportRoot, absolutePath)) {
      throw new Error(
        "Export path is outside the evidence directory",
      );
    }

    return absolutePath;
  }

  function serialize(item) {
    return {
      id: item.id,
      recordingId: item.recordingId,
      cameraId: item.cameraId,
      kind: item.kind,
      status: item.status,
      progress: item.progress,
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      timestampSeconds: item.timestampSeconds,
      format: item.format,
      fileName: item.fileName,
      relativeFilePath: item.relativeFilePath,
      downloadPath:
        item.status === "COMPLETED"
          ? `/recording-exports/${encodeURIComponent(
              item.id,
            )}/file`
          : null,
      sizeBytes:
        item.sizeBytes === null ||
        item.sizeBytes === undefined
          ? null
          : Number(item.sizeBytes),
      checksumSha256: item.checksumSha256,
      errorMessage: item.errorMessage,
      startedAt:
        item.startedAt?.toISOString() || null,
      completedAt:
        item.completedAt?.toISOString() ||
        null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  function clamp(value, maximum) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
      return null;
    }

    return Math.max(
      0,
      Math.min(parsed, maximum),
    );
  }

  async function sha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash =
        crypto.createHash("sha256");
      const stream =
        fs.createReadStream(filePath);

      stream.on("error", reject);
      stream.on("data", (chunk) => {
        hash.update(chunk);
      });
      stream.on("end", () => {
        resolve(hash.digest("hex"));
      });
    });
  }

  function destinationFor(item, recording) {
    const date = new Date(recording.startedAt);
    const safeDate = Number.isNaN(
      date.getTime(),
    )
      ? new Date()
      : date;

    const year = String(
      safeDate.getFullYear(),
    );
    const month = String(
      safeDate.getMonth() + 1,
    ).padStart(2, "0");
    const day = String(
      safeDate.getDate(),
    ).padStart(2, "0");

    const cameraId = sanitize(
      recording.cameraId,
    );

    const folder =
      item.kind === "CLIP"
        ? "Clips"
        : "Snapshots";

    const extension =
      item.kind === "CLIP"
        ? "mp4"
        : "jpg";

    const descriptor =
      item.kind === "CLIP"
        ? `${Math.round(
            item.startSeconds * 1000,
          )}_to_${Math.round(
            item.endSeconds * 1000,
          )}`
        : `${Math.round(
            item.timestampSeconds * 1000,
          )}`;

    const fileName =
      `${cameraId}_${folder.toLowerCase()}_` +
      `${descriptor}_${item.id}.${extension}`;

    const directory = path.join(
      exportRoot,
      folder,
      cameraId,
      year,
      month,
      day,
    );

    const finalPath = path.join(
      directory,
      fileName,
    );

    return {
      directory,
      fileName,
      finalPath,
      partialPath: path.join(
        directory,
        `.partial-${fileName}`,
      ),
      relativeFilePath: path
        .relative(exportRoot, finalPath)
        .split(path.sep)
        .join("/"),
    };
  }

  function runFfmpeg({
    item,
    inputPath,
    outputPath,
    onProgress,
  }) {
    return new Promise((resolve, reject) => {
      const clipDuration =
        item.kind === "CLIP"
          ? item.endSeconds -
            item.startSeconds
          : null;

      const args =
        item.kind === "CLIP"
          ? [
              "-hide_banner",
              "-loglevel",
              "error",
              "-nostdin",
              "-y",
              "-ss",
              String(item.startSeconds),
              "-i",
              inputPath,
              "-t",
              String(clipDuration),
              "-map",
              "0:v:0",
              "-map",
              "0:a?",
              "-vf",
              `fps=${exportFps},format=yuv420p`,
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              String(exportCrf),
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-movflags",
              "+faststart",
              "-progress",
              "pipe:1",
              "-nostats",
              outputPath,
            ]
          : [
              "-hide_banner",
              "-loglevel",
              "error",
              "-nostdin",
              "-y",
              "-ss",
              String(item.timestampSeconds),
              "-i",
              inputPath,
              "-frames:v",
              "1",
              "-q:v",
              "2",
              outputPath,
            ];

      const child = spawn(
        "ffmpeg",
        args,
        {
          stdio: [
            "ignore",
            item.kind === "CLIP"
              ? "pipe"
              : "ignore",
            "pipe",
          ],
        },
      );

      let stderr = "";
      let stdout = "";

      if (child.stdout) {
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf8");

          const lines = stdout.split(/\r?\n/);
          stdout = lines.pop() || "";

          for (const line of lines) {
            const [key, rawValue] =
              line.split("=", 2);

            if (
              key !== "out_time_us" &&
              key !== "out_time_ms"
            ) {
              continue;
            }

            const microseconds =
              Number(rawValue);

            if (
              !Number.isFinite(
                microseconds,
              ) ||
              !clipDuration
            ) {
              continue;
            }

            const progress = Math.max(
              1,
              Math.min(
                99,
                Math.floor(
                  (
                    microseconds /
                    1_000_000 /
                    clipDuration
                  ) * 100,
                ),
              ),
            );

            onProgress(progress);
          }
        });
      }

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");

        if (stderr.length > 10000) {
          stderr = stderr.slice(-10000);
        }
      });

      child.once("error", reject);

      child.once("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new Error(
            stderr.trim() ||
              `FFmpeg exited with code ${code}`,
          ),
        );
      });
    });
  }

  async function processJob(exportId) {
    let partialPath = null;

    try {
      const item =
        await prisma.recordingExport.findUnique({
          where: { id: exportId },
          include: { recording: true },
        });

      if (!item?.recording) {
        throw new Error(
          "Original recording was not found",
        );
      }

      const recording = item.recording;

      const { absolutePath: inputPath } =
        await storageManager.resolveRecordingPath(
          recording,
        );

      const inputStat =
        await fsp.stat(inputPath);

      if (!inputStat.isFile()) {
        throw new Error(
          "Original MP4 file is missing",
        );
      }

      const destination =
        destinationFor(item, recording);

      partialPath = destination.partialPath;

      await fsp.mkdir(
        destination.directory,
        {
          recursive: true,
        },
      );

      await fsp.rm(partialPath, {
        force: true,
      });

      await prisma.recordingExport.update({
        where: { id: item.id },
        data: {
          status: "PROCESSING",
          progress:
            item.kind === "SNAPSHOT"
              ? 50
              : 1,
          fileName: destination.fileName,
          relativeFilePath:
            destination.relativeFilePath,
          startedAt: new Date(),
          errorMessage: null,
        },
      });

      let lastProgress = 0;

      await runFfmpeg({
        item,
        inputPath,
        outputPath: partialPath,
        onProgress(progress) {
          if (progress < lastProgress + 3) {
            return;
          }

          lastProgress = progress;

          void prisma.recordingExport
            .update({
              where: { id: item.id },
              data: { progress },
            })
            .catch(() => undefined);
        },
      });

      const generatedStat =
        await fsp.stat(partialPath);

      if (
        !generatedStat.isFile() ||
        generatedStat.size < 100
      ) {
        throw new Error(
          "FFmpeg created an empty file",
        );
      }

      await fsp.rename(
        partialPath,
        destination.finalPath,
      );

      partialPath = null;

      const finalStat =
        await fsp.stat(
          destination.finalPath,
        );

      const checksum =
        await sha256(
          destination.finalPath,
        );

      await prisma.recordingExport.update({
        where: { id: item.id },
        data: {
          status: "COMPLETED",
          progress: 100,
          sizeBytes:
            BigInt(finalStat.size),
          checksumSha256: checksum,
          completedAt: new Date(),
          errorMessage: null,
        },
      });

      console.log(
        `✅ ${item.kind} export completed:`,
        destination.finalPath,
      );
    } catch (error) {
      if (partialPath) {
        await fsp.rm(partialPath, {
          force: true,
        }).catch(() => undefined);
      }

      await prisma.recordingExport
        .update({
          where: { id: exportId },
          data: {
            status: "FAILED",
            errorMessage:
              error?.message ||
              "Evidence export failed",
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);

      console.error(
        "❌ Evidence export failed:",
        error,
      );
    }
  }

  app.post(
    "/recordings/:recordingId/exports/clip",
    async (request, response) => {
      try {
        const recording =
          await prisma.recording.findUnique({
            where: {
              id: request.params.recordingId,
            },
          });

        if (!recording) {
          response.status(404).json({
            ok: false,
            error: "Recording not found",
          });
          return;
        }

        const maximum = Math.max(
          0,
          Number(
            recording.durationSeconds,
          ) || 0,
        );

        const startSeconds = clamp(
          request.body?.startSeconds,
          maximum,
        );

        const endSeconds = clamp(
          request.body?.endSeconds,
          maximum,
        );

        if (
          startSeconds === null ||
          endSeconds === null ||
          endSeconds <= startSeconds
        ) {
          response.status(400).json({
            ok: false,
            error:
              "Clip end time must be after the start time",
          });
          return;
        }

        if (
          endSeconds - startSeconds >
          maximumClipSeconds
        ) {
          response.status(400).json({
            ok: false,
            error:
              `Maximum clip length is ${maximumClipSeconds} seconds`,
          });
          return;
        }

        const item =
          await prisma.recordingExport.create({
            data: {
              recordingId: recording.id,
              cameraId: recording.cameraId,
              kind: "CLIP",
              status: "PENDING",
              progress: 0,
              startSeconds,
              endSeconds,
              format: "mp4",
            },
          });

        setImmediate(() => {
          void processJob(item.id);
        });

        response.status(202).json({
          ok: true,
          export: serialize(item),
        });
      } catch (error) {
        console.error(
          "❌ Clip request failed:",
          error,
        );

        response.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Failed to create clip",
        });
      }
    },
  );

  app.post(
    "/recordings/:recordingId/exports/snapshot",
    async (request, response) => {
      try {
        const recording =
          await prisma.recording.findUnique({
            where: {
              id: request.params.recordingId,
            },
          });

        if (!recording) {
          response.status(404).json({
            ok: false,
            error: "Recording not found",
          });
          return;
        }

        const maximum = Math.max(
          0,
          Number(
            recording.durationSeconds,
          ) || 0,
        );

        const timestampSeconds = clamp(
          request.body?.timestampSeconds,
          maximum,
        );

        if (timestampSeconds === null) {
          response.status(400).json({
            ok: false,
            error:
              "A valid snapshot time is required",
          });
          return;
        }

        const item =
          await prisma.recordingExport.create({
            data: {
              recordingId: recording.id,
              cameraId: recording.cameraId,
              kind: "SNAPSHOT",
              status: "PENDING",
              progress: 0,
              timestampSeconds,
              format: "jpeg",
            },
          });

        setImmediate(() => {
          void processJob(item.id);
        });

        response.status(202).json({
          ok: true,
          export: serialize(item),
        });
      } catch (error) {
        console.error(
          "❌ Snapshot request failed:",
          error,
        );

        response.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Failed to create snapshot",
        });
      }
    },
  );

  app.get(
    "/recordings/:recordingId/exports",
    async (request, response) => {
      try {
        const items =
          await prisma.recordingExport.findMany({
            where: {
              recordingId:
                request.params.recordingId,
            },
            orderBy: {
              createdAt: "desc",
            },
            take: 50,
          });

        response.json({
          ok: true,
          exports: items.map(serialize),
        });
      } catch (error) {
        response.status(500).json({
          ok: false,
          error:
            "Failed to list evidence exports",
        });
      }
    },
  );

  app.get(
    "/recording-exports/:exportId",
    async (request, response) => {
      const item =
        await prisma.recordingExport.findUnique({
          where: {
            id: request.params.exportId,
          },
        });

      if (!item) {
        response.status(404).json({
          ok: false,
          error: "Export not found",
        });
        return;
      }

      response.json({
        ok: true,
        export: serialize(item),
      });
    },
  );

  app.get(
    "/recording-exports/:exportId/file",
    async (request, response) => {
      try {
        const item =
          await prisma.recordingExport.findUnique({
            where: {
              id: request.params.exportId,
            },
          });

        if (
          !item ||
          item.status !== "COMPLETED"
        ) {
          response.status(404).json({
            ok: false,
            error:
              "Completed export not found",
          });
          return;
        }

        const absolutePath =
          resolveExportPath(item);

        const stat =
          await fsp.stat(absolutePath);

        response.setHeader(
          "Content-Type",
          item.kind === "CLIP"
            ? "video/mp4"
            : "image/jpeg",
        );

        response.setHeader(
          "Content-Length",
          String(stat.size),
        );

        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${String(
            item.fileName ||
              path.basename(absolutePath),
          ).replace(/["\r\n]/g, "_")}"`,
        );

        fs.createReadStream(
          absolutePath,
        ).pipe(response);
      } catch (error) {
        response.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Failed to download export",
        });
      }
    },
  );

  app.delete(
    "/recording-exports/:exportId",
    async (request, response) => {
      try {
        const item =
          await prisma.recordingExport.findUnique({
            where: {
              id: request.params.exportId,
            },
          });

        if (!item) {
          response.status(404).json({
            ok: false,
            error: "Export not found",
          });
          return;
        }

        if (
          item.status === "PENDING" ||
          item.status === "PROCESSING"
        ) {
          response.status(409).json({
            ok: false,
            error:
              "Wait for the export to finish",
          });
          return;
        }

        if (item.relativeFilePath) {
          await fsp.rm(
            resolveExportPath(item),
            { force: true },
          );
        }

        await prisma.recordingExport.delete({
          where: { id: item.id },
        });

        response.json({
          ok: true,
          deletedExportId: item.id,
        });
      } catch (error) {
        response.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Failed to delete export",
        });
      }
    },
  );

  void prisma.recordingExport.updateMany({
    where: {
      status: {
        in: ["PENDING", "PROCESSING"],
      },
    },
    data: {
      status: "FAILED",
      errorMessage:
        "Backend restarted before export completed",
      completedAt: new Date(),
    },
  });
}

module.exports = {
  registerRecordingEvidenceRoutes,
};
