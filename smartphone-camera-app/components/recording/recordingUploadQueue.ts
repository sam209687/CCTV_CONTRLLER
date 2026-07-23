import AsyncStorage from
  "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

import {
  uploadRecordingSegment,
  type RecordingUploadResult,
} from "./recordingUpload";

const STORAGE_KEY =
  "@cctv/recording-upload-queue/v1";

const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;

export interface EnqueueRecordingUploadInput {
  fileUri: string;
  fileName: string;
  cameraId: string;
  serverUrl: string;
  startedAt: string;
  durationSeconds: number;
}

interface RecordingUploadQueueItem {
  id: string;
  uploadId: string;
  fileUri: string;
  fileName: string;
  cameraId: string;
  serverUrl: string;
  startedAt: string;
  durationSeconds: number;
  checksumMd5: string | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
}

export interface RecordingUploadQueueSnapshot {
  pendingCount: number;
  retryingCount: number;
  uploadingCount: number;
  completedThisSession: number;
  activeFileName: string | null;
  lastError: string | null;
}

type QueueListener = (
  snapshot: RecordingUploadQueueSnapshot,
) => void;

let items: RecordingUploadQueueItem[] = [];
let loaded = false;
let processing = false;
let activeItemId: string | null = null;
let completedThisSession = 0;
let wakeTimer:
  | ReturnType<typeof setTimeout>
  | null = null;

const listeners = new Set<QueueListener>();

function getQueueDirectory(): string {
  const root = FileSystem.documentDirectory;

  if (!root) {
    throw new Error(
      "Persistent app storage is unavailable",
    );
  }

  return `${root}recording-upload-queue/`;
}

function safeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function createUploadId(
  cameraId: string,
  startedAt: string,
): string {
  const random = Math.random()
    .toString(36)
    .slice(2, 10);

  return [
    safeFilePart(cameraId),
    startedAt.replace(/[^0-9]/g, ""),
    Date.now(),
    random,
  ].join("-");
}

function getSnapshot():
  RecordingUploadQueueSnapshot {
  const active = items.find(
    (item) => item.id === activeItemId,
  );

  const retrying = items.filter(
    (item) => item.attempts > 0,
  );

  return {
    pendingCount: items.length,
    retryingCount: retrying.length,
    uploadingCount: active ? 1 : 0,
    completedThisSession,
    activeFileName: active?.fileName || null,
    lastError:
      retrying
        .slice()
        .sort(
          (left, right) =>
            right.nextAttemptAt -
            left.nextAttemptAt,
        )[0]?.lastError || null,
  };
}

function emitSnapshot(): void {
  const snapshot = getSnapshot();

  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.warn(
        "⚠️ Upload queue listener failed:",
        error,
      );
    }
  });
}

async function persistQueue(): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(items),
  );
}

async function ensureLoaded(): Promise<void> {
  if (loaded) {
    return;
  }

  const queueDirectory = getQueueDirectory();

  await FileSystem.makeDirectoryAsync(
    queueDirectory,
    {
      intermediates: true,
    },
  );

  const raw = await AsyncStorage.getItem(
    STORAGE_KEY,
  );

  if (raw) {
    try {
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        items = parsed.filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.fileUri === "string" &&
            typeof item.fileName === "string",
        );
      }
    } catch (error) {
      console.warn(
        "⚠️ Invalid upload queue metadata was reset:",
        error,
      );

      items = [];
    }
  }

  const survivingItems:
    RecordingUploadQueueItem[] = [];

  for (const item of items) {
    const info = await FileSystem.getInfoAsync(
      item.fileUri,
    );

    if (info.exists) {
      survivingItems.push(item);
    } else {
      console.warn(
        "⚠️ Removing missing queued MP4:",
        item.fileName,
      );
    }
  }

  items = survivingItems;
  loaded = true;

  await persistQueue();
  emitSnapshot();
}

function retryDelay(attempts: number): number {
  const exponential =
    INITIAL_RETRY_DELAY_MS *
    2 ** Math.max(0, attempts - 1);

  return Math.min(
    MAX_RETRY_DELAY_MS,
    exponential,
  );
}

function scheduleNextAttempt(): void {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }

  if (processing || items.length === 0) {
    return;
  }

  const earliest = Math.min(
    ...items.map(
      (item) => item.nextAttemptAt,
    ),
  );

  const delay = Math.max(
    250,
    earliest - Date.now(),
  );

  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void processQueue();
  }, delay);
}

async function processQueue(): Promise<void> {
  await ensureLoaded();

  if (processing) {
    return;
  }

  const now = Date.now();

  const item = items
    .slice()
    .sort(
      (left, right) =>
        left.nextAttemptAt -
        right.nextAttemptAt,
    )
    .find(
      (candidate) =>
        candidate.nextAttemptAt <= now,
    );

  if (!item) {
    scheduleNextAttempt();
    return;
  }

  processing = true;
  activeItemId = item.id;
  emitSnapshot();

  try {
    console.log(
      "⬆️ Persistent MP4 upload:",
      item.fileName,
      `attempt ${item.attempts + 1}`,
    );

    const uploaded:
      RecordingUploadResult =
      await uploadRecordingSegment({
        fileUri: item.fileUri,
        fileName: item.fileName,
        cameraId: item.cameraId,
        serverUrl: item.serverUrl,
        startedAt: item.startedAt,
        durationSeconds:
          item.durationSeconds,
        uploadId: item.uploadId,
        checksumMd5:
          item.checksumMd5,
      });

    items = items.filter(
      (candidate) =>
        candidate.id !== item.id,
    );

    completedThisSession += 1;

    console.log(
      "✅ Persistent MP4 uploaded:",
      uploaded.fileUrl,
    );
  } catch (error: any) {
    const message =
      error?.message || String(error);

    const attempts = item.attempts + 1;
    const delay = retryDelay(attempts);

    items = items.map((candidate) =>
      candidate.id === item.id
        ? {
            ...candidate,
            attempts,
            lastError: message,
            nextAttemptAt:
              Date.now() + delay,
          }
        : candidate,
    );

    console.warn(
      "⚠️ MP4 upload queued for retry:",
      item.fileName,
      `in ${Math.round(delay / 1000)}s`,
      message,
    );
  } finally {
    activeItemId = null;
    processing = false;

    await persistQueue();
    emitSnapshot();

    if (
      items.some(
        (candidate) =>
          candidate.nextAttemptAt <=
          Date.now(),
      )
    ) {
      setTimeout(() => {
        void processQueue();
      }, 0);
    } else {
      scheduleNextAttempt();
    }
  }
}

export function subscribeRecordingUploadQueue(
  listener: QueueListener,
): () => void {
  listeners.add(listener);
  listener(getSnapshot());

  void ensureLoaded().then(() => {
    listener(getSnapshot());
  });

  return () => {
    listeners.delete(listener);
  };
}

export async function resumeRecordingUploadQueue(
  currentServerUrl?: string,
): Promise<void> {
  await ensureLoaded();

  const normalizedServerUrl =
    currentServerUrl
      ?.trim()
      .replace(/\/+$/, "");

  if (normalizedServerUrl) {
    items = items.map((item) => ({
      ...item,
      serverUrl: normalizedServerUrl,
      nextAttemptAt: Math.min(
        item.nextAttemptAt,
        Date.now(),
      ),
    }));

    await persistQueue();
    emitSnapshot();
  }

  void processQueue();
}

export async function enqueueRecordingUpload(
  input: EnqueueRecordingUploadInput,
): Promise<string> {
  await ensureLoaded();

  const uploadId = createUploadId(
    input.cameraId,
    input.startedAt,
  );

  const queueDirectory = getQueueDirectory();
  const destinationUri =
    `${queueDirectory}${safeFilePart(
      uploadId,
    )}.mp4`;

  await FileSystem.copyAsync({
    from: input.fileUri,
    to: destinationUri,
  });

  await FileSystem.deleteAsync(
    input.fileUri,
    {
      idempotent: true,
    },
  );

  const info = await FileSystem.getInfoAsync(
    destinationUri,
    {
      md5: true,
    },
  );

  if (!info.exists) {
    throw new Error(
      "The MP4 could not be copied into the persistent upload queue",
    );
  }

  const checksumMd5 =
    "md5" in info &&
    typeof info.md5 === "string"
      ? info.md5.toLowerCase()
      : null;

  const item: RecordingUploadQueueItem = {
    id: uploadId,
    uploadId,
    fileUri: destinationUri,
    fileName: input.fileName,
    cameraId: input.cameraId,
    serverUrl: input.serverUrl
      .trim()
      .replace(/\/+$/, ""),
    startedAt: input.startedAt,
    durationSeconds:
      input.durationSeconds,
    checksumMd5,
    attempts: 0,
    nextAttemptAt: Date.now(),
    lastError: null,
    createdAt: Date.now(),
  };

  items.push(item);

  await persistQueue();
  emitSnapshot();

  console.log(
    "📥 MP4 added to persistent upload queue:",
    input.fileName,
    checksumMd5
      ? `MD5 ${checksumMd5}`
      : "without client MD5",
  );

  void processQueue();

  return uploadId;
}

export async function getRecordingUploadQueueSnapshot():
  Promise<RecordingUploadQueueSnapshot> {
  await ensureLoaded();
  return getSnapshot();
}
