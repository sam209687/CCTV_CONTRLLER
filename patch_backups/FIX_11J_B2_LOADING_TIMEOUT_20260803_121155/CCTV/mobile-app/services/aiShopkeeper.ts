import { Platform } from "react-native";
import {
  io,
  type Socket,
} from "socket.io-client";

import {
  getDashboardSecurityHeaders,
  getDashboardSocketAuth,
} from "@/services/security/dashboardSecurity";

export type AiEventAction =
  | "ACKNOWLEDGE"
  | "OWNER_WATCHING"
  | "AI_ASSISTING"
  | "RESOLVE"
  | "SALE_COMPLETED"
  | "ABANDONED";

export interface AiCameraState {
  cameraId: string;
  state: string;
  customerCount: number;
  staffCount: number;
  faceCount: number;
  confidence: number | null;
  detector: string | null;
  processingMilliseconds: number | null;
  activeEventId: string | null;
  unattendedSince: string | null;
  lastDetectionAt: string | null;
  workerStatus: "ONLINE" | "OFFLINE";
  heartbeatAgeSeconds: number | null;
}

export interface AiShopkeeperEvent {
  id: string;
  cameraId: string;
  eventType: string;
  state: string;
  status: string;
  customerCount: number;
  staffCount: number;
  faceCount: number;
  confidence: number | null;
  snapshotPath: string | null;
  detectedAt: string;
  unattendedSince: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  ownerAction: string | null;
  telegramSent: boolean;
  deliveryError: string | null;
}

export interface AiConfiguration {
  cameraId: string;

  customerZone: [
    number,
    number,
    number,
    number,
  ];

  staffZone: [
    number,
    number,
    number,
    number,
  ];

  splitPercent: number;
  updatedAt: string | null;
}

export interface RuntimeStatus {
  state?: string;
  updatedAt?: string;
  reconnectCount?: number;
  customerCount?: number;
  staffCount?: number;
  faceCount?: number;
  currentElapsedSeconds?: number;
  processingMilliseconds?: number;
  lastError?: string;
}

export interface RuntimeHealth {
  ok: boolean;
  aiWorker: RuntimeStatus | null;
  recorder: RuntimeStatus | null;
  timestamp: string;
}

export function getAiServerUrl(): string {
  const configured =
    process.env
      .EXPO_PUBLIC_CCTV_SERVER_URL
      ?.trim() ||
    process.env
      .EXPO_PUBLIC_SERVER_URL
      ?.trim();

  if (configured) {
    return configured.replace(
      /\/+$/,
      "",
    );
  }

  if (
    Platform.OS === "web" &&
    typeof window !== "undefined"
  ) {
    return (
      `${window.location.protocol}//` +
      `${window.location.hostname}:3000`
    );
  }

  return "http://127.0.0.1:3000";
}

async function apiRequest<T>(
  pathname: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(
    `${getAiServerUrl()}${pathname}`,
    {
      ...options,

      headers: {
        "Content-Type":
          "application/json",

        ...getDashboardSecurityHeaders(),

        ...(options.headers || {}),
      },
    },
  );

  const payload =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error ||
        `Request failed with HTTP ${response.status}`,
    );
  }

  return payload as T;
}

export function createAiSocket(): Socket {
  return io(
    getAiServerUrl(),
    {
      transports: ["websocket"],
      auth:
        getDashboardSocketAuth(),
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    },
  );
}

export async function getAiStatus(
  cameraId: string,
): Promise<AiCameraState | null> {
  const payload =
    await apiRequest<{
      states: AiCameraState[];
    }>(
      `/ai/status?cameraId=${encodeURIComponent(
        cameraId,
      )}`,
    );

  return (
    payload.states.find(
      (item) =>
        item.cameraId === cameraId,
    ) || null
  );
}

export async function getRuntimeHealth(): Promise<RuntimeHealth> {
  return apiRequest(
    "/ai/runtime-health",
  );
}

export async function getAiEvents(
  cameraId: string,
): Promise<AiShopkeeperEvent[]> {
  const payload =
    await apiRequest<{
      events: AiShopkeeperEvent[];
    }>(
      `/ai/events?cameraId=${encodeURIComponent(
        cameraId,
      )}&limit=50`,
    );

  return payload.events;
}

export async function getAiConfiguration(
  cameraId: string,
): Promise<AiConfiguration> {
  const payload =
    await apiRequest<{
      config: AiConfiguration;
    }>(
      `/ai/config/${encodeURIComponent(
        cameraId,
      )}`,
    );

  return payload.config;
}

export async function saveAiConfiguration(
  cameraId: string,

  customerZone: [
    number,
    number,
    number,
    number,
  ],

  staffZone: [
    number,
    number,
    number,
    number,
  ],
): Promise<AiConfiguration> {
  const payload =
    await apiRequest<{
      config: AiConfiguration;
    }>(
      `/ai/config/${encodeURIComponent(
        cameraId,
      )}`,
      {
        method: "PATCH",

        body: JSON.stringify({
          customerZone,
          staffZone,
        }),
      },
    );

  return payload.config;
}

export async function performAiEventAction(
  eventId: string,
  action: AiEventAction,
): Promise<AiShopkeeperEvent> {
  const payload =
    await apiRequest<{
      event: AiShopkeeperEvent;
    }>(
      `/ai/events/${encodeURIComponent(
        eventId,
      )}/action`,
      {
        method: "PATCH",

        body: JSON.stringify({
          action,
        }),
      },
    );

  return payload.event;
}

export async function loadProtectedSnapshot(
  snapshotPath: string,
): Promise<string> {
  if (Platform.OS !== "web") {
    throw new Error(
      "Protected snapshots are currently available on the web dashboard.",
    );
  }

  const response = await fetch(
    `${getAiServerUrl()}${snapshotPath}`,
    {
      headers:
        getDashboardSecurityHeaders(),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Snapshot failed with HTTP ${response.status}`,
    );
  }

  const blob =
    await response.blob();

  return URL.createObjectURL(blob);
}
