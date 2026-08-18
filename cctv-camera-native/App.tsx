import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  AppState,
  AppStateStatus,
  NativeModules,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import {
  LiveKitRoom,
  VideoTrack,
  isTrackReference,
  useTracks,
} from "@livekit/react-native";

import {
  Track,
} from "livekit-client";

import {
  io,
  Socket,
} from "socket.io-client";

import {
  CAMERA_ID,
  CCTV_BACKEND_URL,
  CCTV_CAMERA_TOKEN,
} from "./src/runtimeConfig";

interface LiveKitCredentials {
  server_url: string;
  participant_token: string;
  room_name: string;
  participant_identity: string;
}

interface ForegroundServiceModule {
  start(message: string): Promise<boolean>;
  update(message: string): Promise<boolean>;
  stop(): Promise<boolean>;
  isRunning(): Promise<boolean>;
  isBatteryOptimizationIgnored(): Promise<boolean>;
  openBatterySettings(): Promise<boolean>;
}

type StreamStatus =
  | "stopped"
  | "requesting-permission"
  | "starting-service"
  | "requesting-token"
  | "connecting"
  | "live"
  | "error";

const foregroundService =
  NativeModules.CCTVForegroundService as
    | ForegroundServiceModule
    | undefined;

function requireForegroundService(): ForegroundServiceModule {
  if (!foregroundService) {
    throw new Error(
      "Foreground service native module is unavailable. Rebuild and reinstall the Android APK.",
    );
  }

  return foregroundService;
}

async function requestCameraPermission(): Promise<boolean> {
  if (Platform.OS !== "android") {
    return true;
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.CAMERA,
    {
      title: "CCTV camera access",
      message:
        "Camera access is required to publish the WebRTC video stream.",
      buttonPositive: "Allow",
      buttonNegative: "Cancel",
    },
  );

  return (
    result ===
    PermissionsAndroid.RESULTS.GRANTED
  );
}

async function requestNotificationPermission(): Promise<boolean> {
  if (
    Platform.OS !== "android" ||
    Number(Platform.Version) < 33
  ) {
    return true;
  }

  const result = await PermissionsAndroid.request(
    "android.permission.POST_NOTIFICATIONS" as never,
    {
      title: "CCTV status notification",
      message:
        "Allow the persistent notification so Android can show when the camera is streaming in the background.",
      buttonPositive: "Allow",
      buttonNegative: "Not now",
    },
  );

  return (
    result === PermissionsAndroid.RESULTS.GRANTED
  );
}

// PATCH_11J_C0_AUTO_RECOVERY_V1
async function requestCredentials(): Promise<LiveKitCredentials> {
  let response: Response;

  try {
    response = await fetch(
      `${CCTV_BACKEND_URL}/webrtc/token/camera`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Camera-Id": CAMERA_ID,
          "X-Camera-Token": CCTV_CAMERA_TOKEN,
        },
        body: JSON.stringify({ cameraId: CAMERA_ID }),
      },
    );
  } catch {
    throw new Error(
      "Network unavailable · waiting to reconnect",
    );
  }

  const rawBody = await response.text();
  let value: any = {};

  if (rawBody.trim()) {
    try {
      value = JSON.parse(rawBody);
    } catch {
      if (!response.ok) {
        throw new Error(
          `Backend temporarily unavailable (HTTP ${response.status})`,
        );
      }
      throw new Error("Backend returned an invalid response");
    }
  }

  if (!response.ok) {
    throw new Error(
      value?.error ||
        `Camera server request failed (HTTP ${response.status})`,
    );
  }

  if (!value?.server_url || !value?.participant_token) {
    throw new Error(
      "Backend returned invalid LiveKit credentials",
    );
  }

  return value as LiveKitCredentials;
}

function LocalCameraPreview() {
  const tracks = useTracks([
    Track.Source.Camera,
  ]);

  const localTrack = useMemo(
    () =>
      tracks.find(
        (track) =>
          isTrackReference(track) &&
          track.participant.isLocal,
      ),
    [tracks],
  );

  if (
    !localTrack ||
    !isTrackReference(localTrack)
  ) {
    return (
      <View style={styles.previewWaiting}>
        <Text style={styles.previewWaitingText}>
          Preparing rear camera track…
        </Text>
      </View>
    );
  }

  return (
    <VideoTrack
      trackRef={localTrack}
      style={styles.video}
      mirror={false}
      objectFit="cover"
    />
  );
}

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const webrtcLiveRef = useRef(false);
  const foregroundServiceRunningRef = useRef(false);
  const desiredStreamingRef = useRef(false);
  const recoveryInFlightRef = useRef(false);
  const recoveryAttemptRef = useRef(0);
  const recoveryTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlDisconnectedAtRef =
    useRef<number | null>(null);

  const [credentials, setCredentials] =
    useState<LiveKitCredentials | null>(null);

  const [status, setStatus] =
    useState<StreamStatus>("stopped");

  const [message, setMessage] =
    useState("WebRTC stream is stopped");

  const [controlConnected, setControlConnected] =
    useState(false);

  const [webrtcLive, setWebrtcLive] =
    useState(false);

  const [foregroundServiceRunning, setForegroundServiceRunning] =
    useState(false);

  const [batteryOptimizationIgnored, setBatteryOptimizationIgnored] =
    useState(false);

  const [currentAppState, setCurrentAppState] =
    useState<AppStateStatus>(
      AppState.currentState,
    );

  const setForegroundServiceState = (
    running: boolean,
  ): void => {
    foregroundServiceRunningRef.current = running;
    setForegroundServiceRunning(running);
  };

  const setWebrtcState = (
    live: boolean,
  ): void => {
    webrtcLiveRef.current = live;
    setWebrtcLive(live);
  };

  const updateForegroundNotification = async (
    nextMessage: string,
  ): Promise<void> => {
    if (!foregroundServiceRunningRef.current) {
      return;
    }

    try {
      await requireForegroundService().update(
        nextMessage,
      );
    } catch (error) {
      console.warn(
        "Foreground notification update failed:",
        error,
      );
    }
  };

  const stopForegroundService = async (): Promise<void> => {
    try {
      if (foregroundService) {
        await foregroundService.stop();
      }
    } catch (error) {
      console.warn(
        "Foreground service stop failed:",
        error,
      );
    } finally {
      setForegroundServiceState(false);
    }
  };

  useEffect(() => {
    const loadNativeServiceStatus = async (): Promise<void> => {
      if (!foregroundService) {
        return;
      }

      try {
        const [running, ignored] = await Promise.all([
          foregroundService.isRunning(),
          foregroundService.isBatteryOptimizationIgnored(),
        ]);

        setForegroundServiceState(Boolean(running));
        setBatteryOptimizationIgnored(Boolean(ignored));
      } catch (error) {
        console.warn(
          "Foreground service state check failed:",
          error,
        );
      }
    };

    void loadNativeServiceStatus();
  }, []);

  const recoverWebRTCStream = async (
    force = false,
  ): Promise<void> => {
    if (
      !desiredStreamingRef.current ||
      recoveryInFlightRef.current ||
      (!force && webrtcLiveRef.current)
    ) {
      return;
    }

    recoveryInFlightRef.current = true;

    try {
      setStatus("requesting-token");
      setMessage(
        "Network restored · reconnecting WebRTC automatically",
      );

      await requireForegroundService().start(
        "Reconnecting secure WebRTC camera",
      );
      setForegroundServiceState(true);

      const nextCredentials = await requestCredentials();

      setCredentials(null);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });

      setCredentials(nextCredentials);
      setStatus("connecting");
      setMessage(
        "Reconnecting WebRTC camera automatically",
      );

      await updateForegroundNotification(
        "Reconnecting secure WebRTC camera",
      );

      recoveryAttemptRef.current = 0;
    } catch (error: any) {
      setStatus("error");
      setMessage(
        error?.message ||
          "Network unavailable · waiting to reconnect",
      );
      recoveryAttemptRef.current += 1;
      scheduleWebRTCRecovery(
        "Connection unavailable",
        force,
      );
    } finally {
      recoveryInFlightRef.current = false;
    }
  };

  const scheduleWebRTCRecovery = (
    reason: string,
    force = false,
  ): void => {
    if (!desiredStreamingRef.current) {
      return;
    }

    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current);
    }

    const attempt = recoveryAttemptRef.current;
    const delayMs = Math.min(
      30000,
      1500 * Math.pow(2, Math.min(attempt, 4)),
    );

    setMessage(
      `${reason} · automatic retry in ${Math.ceil(delayMs / 1000)}s`,
    );

    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      void recoverWebRTCStream(force);
    }, delayMs);
  };

  useEffect(() => {
    const client = io(CCTV_BACKEND_URL, {
      transports: ["websocket"],
      reconnection: true,
      auth: {
        role: "camera",
        cameraId: CAMERA_ID,
        token: CCTV_CAMERA_TOKEN,
      },
    });

    socketRef.current = client;

    client.on("connect", () => {
      const disconnectedAt =
        controlDisconnectedAtRef.current;
      const outageMs =
        disconnectedAt === null
          ? 0
          : Date.now() - disconnectedAt;

      controlDisconnectedAtRef.current = null;
      setControlConnected(true);

      if (
        desiredStreamingRef.current &&
        (outageMs >= 2000 || !webrtcLiveRef.current)
      ) {
        scheduleWebRTCRecovery(
          "Control connection restored",
          outageMs >= 2000,
        );
      }

      client.emit(
        "camera:register",
        {
          cameraId: CAMERA_ID,
          transport: "webrtc",
          webrtcLive: webrtcLiveRef.current,
          foregroundService:
            foregroundServiceRunningRef.current,
        },
        (acknowledgement: {
          ok?: boolean;
          error?: string;
        }) => {
          if (!acknowledgement?.ok) {
            console.error(
              "Camera control registration failed:",
              acknowledgement?.error,
            );
          }
        },
      );
    });

    client.on("disconnect", () => {
      setControlConnected(false);
      controlDisconnectedAtRef.current = Date.now();

      if (desiredStreamingRef.current) {
        setMessage(
          "Network/control connection lost · reconnecting automatically",
        );
      }
    });

    client.on(
      "connect_error",
      (error: Error) => {
        console.error(
          "Camera control connection error:",
          error.message,
        );

        if (desiredStreamingRef.current) {
          setMessage(
            "Control server unavailable · waiting for network",
          );
        }
      },
    );

    return () => {
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }

      client.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const sendHealth = (): void => {
      socketRef.current?.emit(
        "camera:health",
        {
          cameraId: CAMERA_ID,
          appState: AppState.currentState,
          captureMode: "webrtc",
          transport: "webrtc",
          webrtcLive,
          cameraReady: true,
          previewActive: webrtcLive,
          foregroundServiceRunning,
          backgroundStreamingEnabled: true,
          batteryOptimizationIgnored,
          isRecording: false,
          pendingUploads: 0,
          retryingUploads: 0,
          uploadedSegments: 0,
          recordedSegments: 0,
          fps: webrtcLive ? 15 : 0,
          timestamp: Date.now(),
        },
      );
    };

    sendHealth();

    const timer = setInterval(
      sendHealth,
      5000,
    );

    return () => {
      clearInterval(timer);
    };
  }, [
    batteryOptimizationIgnored,
    foregroundServiceRunning,
    webrtcLive,
  ]);

  useEffect(() => {
    const subscription =
      AppState.addEventListener(
        "change",
        (nextState) => {
          setCurrentAppState(nextState);

          if (!webrtcLiveRef.current) {
            return;
          }

          if (nextState === "active") {
            setMessage(
              "Rear camera is live through WebRTC",
            );

            void updateForegroundNotification(
              "WebRTC camera live · app visible",
            );
          } else {
            setMessage(
              "WebRTC camera remains live in the background",
            );

            void updateForegroundNotification(
              "WebRTC camera live in background",
            );
          }
        },
      );

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (webrtcLive) {
      recoveryAttemptRef.current = 0;

      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    }

    if (status === "stopped" && !webrtcLive) {
      desiredStreamingRef.current = false;
    }
  }, [status, webrtcLive]);

  const startStream = async (): Promise<void> => {
    try {
      desiredStreamingRef.current = true;
      recoveryAttemptRef.current = 0;
      if (AppState.currentState !== "active") {
        throw new Error(
          "Open the CCTV app before starting the camera service",
        );
      }

      setStatus("requesting-permission");
      setMessage("Requesting camera permission");

      const granted =
        await requestCameraPermission();

      if (!granted) {
        throw new Error(
          "Camera permission was denied",
        );
      }

      await requestNotificationPermission();

      setStatus("starting-service");
      setMessage(
        "Starting Android foreground camera service",
      );

      await requireForegroundService().start(
        "Preparing secure WebRTC camera",
      );

      setForegroundServiceState(true);

      setStatus("requesting-token");
      setMessage(
        "Requesting secure LiveKit access",
      );

      const nextCredentials =
        await requestCredentials();

      setCredentials(nextCredentials);
      setStatus("connecting");
      setMessage("Connecting WebRTC camera");

      await updateForegroundNotification(
        "Connecting secure WebRTC camera",
      );
    } catch (error: any) {
      console.error(
        "WebRTC camera start failed:",
        error,
      );

      setCredentials(null);
      setWebrtcState(false);
      await stopForegroundService();
      setStatus("error");
      setMessage(
        error?.message ||
          "WebRTC camera start failed",
      );
    }
  };

  const stopStream = async (): Promise<void> => {
    setCredentials(null);
    setWebrtcState(false);
    await stopForegroundService();
    setStatus("stopped");
    setMessage("WebRTC stream is stopped");
  };

  const openBatterySettings = async (): Promise<void> => {
    try {
      await requireForegroundService()
        .openBatterySettings();
    } catch (error) {
      console.error(
        "Could not open battery settings:",
        error,
      );
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="#020617"
      />

      <View style={styles.header}>
        <Text style={styles.title}>
          CCTV WebRTC Camera
        </Text>

        <Text style={styles.cameraId}>
          {CAMERA_ID}
        </Text>
      </View>

      <View style={styles.preview}>
        {credentials ? (
          <LiveKitRoom
            serverUrl={credentials.server_url}
            token={credentials.participant_token}
            connect
            audio={false}
            video={{
              facingMode: "environment",
              frameRate: 15,
              resolution: {
                width: 1280,
                height: 720,
              },
            }}
            options={{
              adaptiveStream: false,
              dynacast: true,
            }}
            onConnected={() => {
              console.log(
                "✅ LiveKit camera connected",
              );

              setWebrtcState(true);
              setStatus("live");
              setMessage(
                "Rear camera is live through WebRTC",
              );

              void updateForegroundNotification(
                "WebRTC camera live · 1280×720 · 15 FPS",
              );
            }}
            onDisconnected={() => {
              console.warn(
                "LiveKit camera disconnected",
              );

              setCredentials(null);
              setWebrtcState(false);
              setStatus("stopped");
              setMessage(
                "WebRTC camera disconnected",
              );

              void stopForegroundService();
            }}
            onError={(error) => {
              console.error(
                "LiveKit room error:",
                error,
              );

              setWebrtcState(false);
              setStatus("error");
              setMessage(
                error?.message ||
                  "LiveKit connection failed",
              );

              void updateForegroundNotification(
                "WebRTC connection needs attention",
              );
            }}
          >
            <LocalCameraPreview />
          </LiveKitRoom>
        ) : (
          <View style={styles.previewWaiting}>
            <Text style={styles.previewWaitingText}>
              Press Start WebRTC Camera
            </Text>
          </View>
        )}

        {webrtcLive && (
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>
              WEBRTC LIVE
            </Text>
          </View>
        )}
      </View>

      <View style={styles.statusCard}>
        <Text style={styles.statusLabel}>
          Status
        </Text>

        <Text style={styles.statusValue}>
          {message}
        </Text>

        <Text style={styles.detail}>
          Control: {controlConnected
            ? "connected"
            : "disconnected"}
        </Text>

        <Text style={styles.detail}>
          Foreground service: {foregroundServiceRunning
            ? "active"
            : "inactive"}
        </Text>

        <Text style={styles.detail}>
          App state: {currentAppState}
        </Text>

        <Text style={styles.detail}>
          Battery optimization: {batteryOptimizationIgnored
            ? "unrestricted"
            : "system managed"}
        </Text>

        <Text style={styles.detail}>
          1280 × 720 · 15 FPS · rear camera
        </Text>

        <Text style={styles.detail}>
          Audio disabled · MP4 disabled · JPEG disabled
        </Text>
      </View>

      <TouchableOpacity
        style={[
          styles.button,
          credentials
            ? styles.stopButton
            : styles.startButton,
        ]}
        onPress={
          credentials
            ? () => {
                void stopStream();
              }
            : () => {
                void startStream();
              }
        }
        disabled={
          status === "requesting-permission" ||
          status === "starting-service" ||
          status === "requesting-token"
        }
      >
        <Text style={styles.buttonText}>
          {credentials
            ? "Stop WebRTC Camera"
            : status === "requesting-permission" ||
                status === "starting-service" ||
                status === "requesting-token"
              ? "Preparing…"
              : "Start WebRTC Camera"}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.secondaryButton}
        onPress={() => {
          void openBatterySettings();
        }}
      >
        <Text style={styles.secondaryButtonText}>
          Open Battery Optimization Settings
        </Text>
      </TouchableOpacity>

      <Text style={styles.footer}>
        Phase 11H Android foreground camera service
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    padding: 16,
    backgroundColor: "#020617",
  },

  header: {
    paddingVertical: 12,
  },

  title: {
    color: "#F8FAFC",
    fontSize: 24,
    fontWeight: "800",
  },

  cameraId: {
    color: "#94A3B8",
    fontSize: 13,
    marginTop: 4,
  },

  preview: {
    flex: 1,
    minHeight: 330,
    position: "relative",
    overflow: "hidden",
    borderRadius: 18,
    backgroundColor: "#000000",
  },

  video: {
    flex: 1,
    width: "100%",
    height: "100%",
  },

  previewWaiting: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },

  previewWaitingText: {
    color: "#CBD5E1",
    fontSize: 16,
    textAlign: "center",
  },

  liveBadge: {
    position: "absolute",
    top: 14,
    left: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: "rgba(5,150,105,0.94)",
  },

  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#FFFFFF",
  },

  liveText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "800",
  },

  statusCard: {
    marginTop: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1E293B",
    borderRadius: 14,
    backgroundColor: "#0F172A",
  },

  statusLabel: {
    color: "#64748B",
    fontSize: 12,
    textTransform: "uppercase",
  },

  statusValue: {
    color: "#F8FAFC",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 5,
    marginBottom: 8,
  },

  detail: {
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 2,
  },

  button: {
    minHeight: 54,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 14,
    borderRadius: 14,
  },

  startButton: {
    backgroundColor: "#2563EB",
  },

  stopButton: {
    backgroundColor: "#DC2626",
  },

  buttonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "800",
  },

  secondaryButton: {
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 10,
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 12,
    backgroundColor: "#0F172A",
  },

  secondaryButtonText: {
    color: "#CBD5E1",
    fontSize: 13,
    fontWeight: "700",
  },

  footer: {
    color: "#64748B",
    fontSize: 11,
    textAlign: "center",
    marginTop: 10,
  },
});

// PATCH_11G_WEBRTC_CAMERA_REGISTRATION
// PATCH_11H_ANDROID_FOREGROUND_CAMERA_SERVICE
