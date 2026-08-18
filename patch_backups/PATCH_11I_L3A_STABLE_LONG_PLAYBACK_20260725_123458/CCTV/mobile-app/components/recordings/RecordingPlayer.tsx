// components/recordings/RecordingPlayer.tsx

import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useEvent } from "expo";
import {
  useVideoPlayer,
  VideoView,
} from "expo-video";

import { useTheme } from "@/contexts/ThemeContext";
import type { Recording } from "@/services/recordings";

interface RecordingPlayerProps {
  recording: Recording;
}

export default function RecordingPlayer({
  recording,
}: RecordingPlayerProps) {
  const { colors } = useTheme();

  const player = useVideoPlayer(
    {
      uri: recording.fileUrl,
      contentType: "progressive",
      metadata: {
        title: recording.fileName,
        artist: recording.cameraId,
      },
    },
    (instance) => {
      instance.loop = false;
    },
  );

  const statusEvent = useEvent(
    player,
    "statusChange",
    {
      status: player.status,
    },
  );

  const status =
    statusEvent?.status ?? player.status;
  const error = statusEvent?.error;

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surface },
      ]}
    >
      <View style={styles.videoShell}>
        <VideoView
          style={styles.video}
          player={player}
          nativeControls
          contentFit="contain"
          fullscreenOptions={{ enable: true }}
          playsInline
        />

        {status === "loading" && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator
              size="large"
              color="#FFFFFF"
            />
            <Text style={styles.loadingText}>
              Loading recording…
            </Text>
          </View>
        )}

        {status === "error" && (
          <View style={styles.errorOverlay}>
            <Text style={styles.errorTitle}>
              Recording playback failed
            </Text>
            <Text style={styles.errorText}>
              {error?.message ||
                "The MP4 file could not be loaded."}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.caption}>
        <Text
          numberOfLines={1}
          style={[
            styles.fileName,
            { color: colors.text },
          ]}
        >
          {recording.fileName}
        </Text>

        <Text
          selectable
          numberOfLines={1}
          style={[
            styles.cameraId,
            { color: colors.textSecondary },
          ]}
        >
          Camera ID: {recording.cameraId}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    overflow: "hidden",
    borderRadius: 16,
  },

  videoShell: {
    width: "100%",
    aspectRatio: 16 / 9,
    minHeight: 260,
    position: "relative",
    overflow: "hidden",
    backgroundColor: "#000000",
  },

  video: {
    width: "100%",
    height: "100%",
    backgroundColor: "#000000",
  },

  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.54)",
    pointerEvents: "none",
  },

  loadingText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },

  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
    backgroundColor: "rgba(0,0,0,0.88)",
  },

  errorTitle: {
    color: "#FCA5A5",
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },

  errorText: {
    color: "#FECACA",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
    textAlign: "center",
  },

  caption: {
    paddingHorizontal: 16,
    paddingVertical: 13,
  },

  fileName: {
    fontSize: 14,
    fontWeight: "900",
  },

  cameraId: {
    fontSize: 12,
    marginTop: 5,
  },
});
