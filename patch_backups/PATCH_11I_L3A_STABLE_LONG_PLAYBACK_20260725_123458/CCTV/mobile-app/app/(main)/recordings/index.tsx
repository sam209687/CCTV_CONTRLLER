// app/(main)/recordings/index.tsx
//
// Searchable MP4 recordings library with playback, locking,
// deletion, download, camera/date filters, and auto-refresh.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";

import RecordingPlayer from "@/components/recordings/RecordingPlayer";
import { useTheme } from "@/contexts/ThemeContext";
import {
  deleteRecording,
  getRecordingServerUrl,
  getRecordingSummary,
  listRecordings,
  setRecordingLocked,
  type Recording,
  type RecordingSummary,
} from "@/services/recordings";

const ALL_CAMERAS = "__all__";
const AUTO_REFRESH_MS = 15_000;

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  const converted = value / 1024 ** index;

  return `${converted.toFixed(converted >= 100 ? 0 : 1)} ${
    units[index]
  }`;
}

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(
    0,
    Math.round(totalSeconds || 0),
  );
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor(
    (safeSeconds % 3600) / 60,
  );
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function startOfDate(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = new Date(`${value.trim()}T00:00:00`);

  return Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toISOString();
}

function endOfDate(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = new Date(`${value.trim()}T23:59:59.999`);

  return Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toISOString();
}

function todayDateInput(): string {
  const now = new Date();
  const local = new Date(
    now.getTime() - now.getTimezoneOffset() * 60_000,
  );

  return local.toISOString().slice(0, 10);
}

export default function RecordingsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const compact = width < 900;

  const [recordings, setRecordings] = useState<Recording[]>(
    [],
  );
  const [summary, setSummary] =
    useState<RecordingSummary | null>(null);
  const [selectedRecordingId, setSelectedRecordingId] =
    useState<string | null>(null);

  const [cameraFilter, setCameraFilter] =
    useState(ALL_CAMERAS);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [searchText, setSearchText] = useState("");

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] =
    useState(false);
  const [workingRecordingId, setWorkingRecordingId] =
    useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] =
    useState<Date | null>(null);

  const serverUrl = useMemo(() => {
    try {
      return getRecordingServerUrl();
    } catch {
      return "Unavailable";
    }
  }, []);

  const selectedCameraId =
    cameraFilter === ALL_CAMERAS
      ? undefined
      : cameraFilter;

  const loadData = useCallback(
    async (silent = false): Promise<void> => {
      if (!silent) {
        setLoading(true);
      }

      try {
        const [loadedRecordings, loadedSummary] =
          await Promise.all([
            listRecordings({
              cameraId: selectedCameraId,
              from: startOfDate(fromDate),
              to: endOfDate(toDate),
              limit: 500,
            }),
            getRecordingSummary(selectedCameraId),
          ]);

        setRecordings(loadedRecordings);
        setSummary(loadedSummary);
        setLastUpdatedAt(new Date());

        setSelectedRecordingId((currentId) => {
          if (
            currentId &&
            loadedRecordings.some(
              (recording) => recording.id === currentId,
            )
          ) {
            return currentId;
          }

          return loadedRecordings[0]?.id || null;
        });
      } catch (error: any) {
        console.error("Failed to load recordings:", error);

        if (!silent) {
          Alert.alert(
            "Recordings loading failed",
            error?.message ||
              "The recording library could not be loaded.",
          );
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [fromDate, selectedCameraId, toDate],
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!autoRefresh) {
      return undefined;
    }

    const timer = setInterval(() => {
      void loadData(true);
    }, AUTO_REFRESH_MS);

    return () => {
      clearInterval(timer);
    };
  }, [autoRefresh, loadData]);

  const cameraIds = useMemo(
    () =>
      Array.from(
        new Set(
          recordings.map(
            (recording) => recording.cameraId,
          ),
        ),
      ).sort(),
    [recordings],
  );

  const visibleRecordings = useMemo(() => {
    const normalizedSearch = searchText
      .trim()
      .toLowerCase();

    if (!normalizedSearch) {
      return recordings;
    }

    return recordings.filter((recording) => {
      return [
        recording.fileName,
        recording.cameraId,
        recording.recordingMode,
        recording.eventType || "",
        recording.uploadStatus,
      ].some((value) =>
        value.toLowerCase().includes(normalizedSearch),
      );
    });
  }, [recordings, searchText]);

  const selectedRecording = useMemo(
    () =>
      visibleRecordings.find(
        (recording) =>
          recording.id === selectedRecordingId,
      ) ||
      recordings.find(
        (recording) =>
          recording.id === selectedRecordingId,
      ) ||
      visibleRecordings[0] ||
      null,
    [
      recordings,
      selectedRecordingId,
      visibleRecordings,
    ],
  );

  const filteredSize = useMemo(
    () =>
      visibleRecordings.reduce(
        (sum, recording) =>
          sum + (recording.sizeBytes || 0),
        0,
      ),
    [visibleRecordings],
  );

  const filteredDuration = useMemo(
    () =>
      visibleRecordings.reduce(
        (sum, recording) =>
          sum + (recording.durationSeconds || 0),
        0,
      ),
    [visibleRecordings],
  );

  async function refresh(): Promise<void> {
    setRefreshing(true);

    try {
      await loadData();
    } finally {
      setRefreshing(false);
    }
  }

  async function toggleLock(
    recording: Recording,
  ): Promise<void> {
    setWorkingRecordingId(recording.id);

    try {
      const updated = await setRecordingLocked(
        recording.id,
        !recording.isLocked,
      );

      setRecordings((current) =>
        current.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      );

      setSummary((current) =>
        current
          ? {
              ...current,
              lockedCount: Math.max(
                0,
                current.lockedCount +
                  (updated.isLocked ? 1 : -1),
              ),
            }
          : current,
      );
    } catch (error: any) {
      Alert.alert(
        "Recording lock failed",
        error?.message ||
          "The recording lock could not be changed.",
      );
    } finally {
      setWorkingRecordingId(null);
    }
  }

  async function performDelete(
    recording: Recording,
  ): Promise<void> {
    if (recording.isLocked) {
      Alert.alert(
        "Recording is locked",
        "Unlock this recording before deleting it.",
      );
      return;
    }

    setWorkingRecordingId(recording.id);

    try {
      await deleteRecording(recording.id);

      setRecordings((current) =>
        current.filter(
          (item) => item.id !== recording.id,
        ),
      );

      setSelectedRecordingId((currentId) =>
        currentId === recording.id ? null : currentId,
      );

      await loadData(true);
    } catch (error: any) {
      Alert.alert(
        "Recording deletion failed",
        error?.message ||
          "The recording could not be deleted.",
      );
    } finally {
      setWorkingRecordingId(null);
    }
  }

  function confirmDelete(recording: Recording): void {
    if (
      Platform.OS === "web" &&
      typeof window !== "undefined"
    ) {
      const confirmed = window.confirm(
        `Delete "${recording.fileName}"?\n\n` +
          "This removes the MP4 file and its database record.",
      );

      if (confirmed) {
        void performDelete(recording);
      }

      return;
    }

    Alert.alert(
      "Delete recording",
      `Delete "${recording.fileName}" permanently?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void performDelete(recording);
          },
        },
      ],
    );
  }

  async function downloadRecording(
    recording: Recording,
  ): Promise<void> {
    if (
      Platform.OS === "web" &&
      typeof document !== "undefined"
    ) {
      const anchor = document.createElement("a");
      anchor.href = recording.fileUrl;
      anchor.download = recording.fileName;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return;
    }

    await Linking.openURL(recording.fileUrl);
  }

  function clearFilters(): void {
    setCameraFilter(ALL_CAMERAS);
    setFromDate("");
    setToDate("");
    setSearchText("");
  }

  return (
    <View
      style={[
        pageStyles.screen,
        { backgroundColor: colors.background },
      ]}
    >
      <View
        style={[
          pageStyles.header,
          {
            backgroundColor: colors.surface,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <TouchableOpacity
          style={[
            pageStyles.backButton,
            { borderColor: colors.border },
          ]}
          onPress={() => router.back()}
        >
          <Text
            style={[
              pageStyles.backButtonText,
              { color: colors.text },
            ]}
          >
            ← Cameras
          </Text>
        </TouchableOpacity>

        <View style={pageStyles.headerText}>
          <Text
            style={[
              pageStyles.title,
              { color: colors.text },
            ]}
          >
            Recording Library
          </Text>
          <Text
            style={[
              pageStyles.subtitle,
              { color: colors.textSecondary },
            ]}
          >
            Search, play, protect, download, and manage MP4
            security recordings.
          </Text>
        </View>

        <TouchableOpacity
          style={[
            pageStyles.autoRefreshButton,
            {
              backgroundColor: autoRefresh
                ? `${colors.success}18`
                : colors.background,
              borderColor: autoRefresh
                ? colors.success
                : colors.border,
            },
          ]}
          onPress={() =>
            setAutoRefresh((current) => !current)
          }
        >
          <View
            style={[
              pageStyles.autoRefreshDot,
              {
                backgroundColor: autoRefresh
                  ? colors.success
                  : colors.textSecondary,
              },
            ]}
          />
          <Text
            style={[
              pageStyles.autoRefreshText,
              {
                color: autoRefresh
                  ? colors.success
                  : colors.text,
              },
            ]}
          >
            Auto refresh {autoRefresh ? "ON" : "OFF"}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={pageStyles.scroll}
        contentContainerStyle={pageStyles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
          />
        }
      >
        <View
          style={[
            pageStyles.serverBanner,
            {
              backgroundColor: `${colors.primary}12`,
              borderColor: `${colors.primary}45`,
            },
          ]}
        >
          <Text style={pageStyles.serverIcon}>🎞️</Text>
          <View style={{ flex: 1 }}>
            <Text
              style={[
                pageStyles.serverLabel,
                { color: colors.textSecondary },
              ]}
            >
              Recording backend
            </Text>
            <Text
              selectable
              style={[
                pageStyles.serverValue,
                { color: colors.text },
              ]}
            >
              {serverUrl}
            </Text>
          </View>
          <Text
            style={[
              pageStyles.lastUpdated,
              { color: colors.textSecondary },
            ]}
          >
            {lastUpdatedAt
              ? `Updated ${lastUpdatedAt.toLocaleTimeString()}`
              : "Not updated yet"}
          </Text>
        </View>

        <View
          style={[
            pageStyles.summaryGrid,
            compact && pageStyles.summaryGridCompact,
          ]}
        >
          <SummaryCard
            icon="🎬"
            label="Recordings"
            value={String(
              searchText.trim()
                ? visibleRecordings.length
                : summary?.count ?? recordings.length,
            )}
            colors={colors}
          />
          <SummaryCard
            icon="🔒"
            label="Protected"
            value={String(
              summary?.lockedCount ??
                recordings.filter(
                  (recording) => recording.isLocked,
                ).length,
            )}
            colors={colors}
          />
          <SummaryCard
            icon="⏱️"
            label="Filtered duration"
            value={formatDuration(filteredDuration)}
            colors={colors}
          />
          <SummaryCard
            icon="💾"
            label="Filtered size"
            value={formatBytes(filteredSize)}
            colors={colors}
          />
        </View>

        <View
          style={[
            pageStyles.filterPanel,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <View style={pageStyles.filterHeader}>
            <View>
              <Text
                style={[
                  pageStyles.sectionTitle,
                  { color: colors.text },
                ]}
              >
                Recording filters
              </Text>
              <Text
                style={[
                  pageStyles.sectionDescription,
                  { color: colors.textSecondary },
                ]}
              >
                Filter by camera, date, filename, or recording
                status.
              </Text>
            </View>

            <TouchableOpacity onPress={clearFilters}>
              <Text
                style={[
                  pageStyles.clearFiltersText,
                  { color: colors.primary },
                ]}
              >
                Clear filters
              </Text>
            </TouchableOpacity>
          </View>

          <View style={pageStyles.cameraChips}>
            <FilterChip
              label="All Cameras"
              selected={cameraFilter === ALL_CAMERAS}
              colors={colors}
              onPress={() =>
                setCameraFilter(ALL_CAMERAS)
              }
            />

            {cameraIds.map((cameraId) => (
              <FilterChip
                key={cameraId}
                label={cameraId}
                selected={cameraFilter === cameraId}
                colors={colors}
                onPress={() =>
                  setCameraFilter(cameraId)
                }
              />
            ))}
          </View>

          <View
            style={[
              pageStyles.filterInputs,
              compact && pageStyles.filterInputsCompact,
            ]}
          >
            <View style={pageStyles.inputGroup}>
              <Text
                style={[
                  pageStyles.inputLabel,
                  { color: colors.text },
                ]}
              >
                Search
              </Text>
              <TextInput
                value={searchText}
                onChangeText={setSearchText}
                placeholder="Filename, camera, event…"
                placeholderTextColor={colors.textSecondary}
                style={[
                  pageStyles.input,
                  {
                    color: colors.text,
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                  },
                ]}
              />
            </View>

            <View style={pageStyles.inputGroup}>
              <Text
                style={[
                  pageStyles.inputLabel,
                  { color: colors.text },
                ]}
              >
                From date
              </Text>
              <TextInput
                value={fromDate}
                onChangeText={setFromDate}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={todayDateInput()}
                placeholderTextColor={colors.textSecondary}
                style={[
                  pageStyles.input,
                  {
                    color: colors.text,
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                  },
                ]}
              />
            </View>

            <View style={pageStyles.inputGroup}>
              <Text
                style={[
                  pageStyles.inputLabel,
                  { color: colors.text },
                ]}
              >
                To date
              </Text>
              <TextInput
                value={toDate}
                onChangeText={setToDate}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={todayDateInput()}
                placeholderTextColor={colors.textSecondary}
                style={[
                  pageStyles.input,
                  {
                    color: colors.text,
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                  },
                ]}
              />
            </View>

            <TouchableOpacity
              style={[
                pageStyles.applyButton,
                { backgroundColor: colors.primary },
              ]}
              onPress={() => void loadData()}
            >
              <Text style={pageStyles.applyButtonText}>
                Apply
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {loading ? (
          <View style={pageStyles.loadingPanel}>
            <ActivityIndicator
              size="large"
              color={colors.primary}
            />
            <Text
              style={[
                pageStyles.loadingText,
                { color: colors.textSecondary },
              ]}
            >
              Loading recording library…
            </Text>
          </View>
        ) : recordings.length === 0 ? (
          <View
            style={[
              pageStyles.emptyPanel,
              { backgroundColor: colors.surface },
            ]}
          >
            <Text style={pageStyles.emptyIcon}>🎥</Text>
            <Text
              style={[
                pageStyles.emptyTitle,
                { color: colors.text },
              ]}
            >
              No recordings found
            </Text>
            <Text
              style={[
                pageStyles.emptyText,
                { color: colors.textSecondary },
              ]}
            >
              Record an MP4 segment from the smartphone camera
              or clear the active filters.
            </Text>
          </View>
        ) : (
          <View
            style={[
              pageStyles.libraryLayout,
              compact && pageStyles.libraryLayoutCompact,
            ]}
          >
            <View
              style={[
                pageStyles.playerColumn,
                compact && pageStyles.playerColumnCompact,
              ]}
            >
              <View style={pageStyles.sectionHeader}>
                <View>
                  <Text
                    style={[
                      pageStyles.sectionTitle,
                      { color: colors.text },
                    ]}
                  >
                    Recording player
                  </Text>
                  <Text
                    style={[
                      pageStyles.sectionDescription,
                      { color: colors.textSecondary },
                    ]}
                  >
                    Use the native controls to seek or open
                    fullscreen.
                  </Text>
                </View>
              </View>

              {selectedRecording ? (
                <>
                  <RecordingPlayer
                    key={selectedRecording.id}
                    recording={selectedRecording}
                  />

                  <View
                    style={[
                      pageStyles.selectedDetails,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                      },
                    ]}
                  >
                    <DetailRow
                      label="Recorded"
                      value={formatDateTime(
                        selectedRecording.startedAt,
                      )}
                      colors={colors}
                    />
                    <DetailRow
                      label="Duration"
                      value={formatDuration(
                        selectedRecording.durationSeconds,
                      )}
                      colors={colors}
                    />
                    <DetailRow
                      label="File size"
                      value={formatBytes(
                        selectedRecording.sizeBytes,
                      )}
                      colors={colors}
                    />
                    <DetailRow
                      label="Storage"
                      value={
                        selectedRecording.storageTargetId ||
                        "Legacy local storage"
                      }
                      colors={colors}
                    />
                    <DetailRow
                      label="Checksum"
                      value={
                        selectedRecording.checksumSha256 ||
                        "Not calculated for imported clip"
                      }
                      colors={colors}
                      selectable
                    />

                    <View style={pageStyles.selectedActions}>
                      <ActionButton
                        label={
                          selectedRecording.isLocked
                            ? "🔓 Unlock"
                            : "🔒 Protect"
                        }
                        colors={colors}
                        disabled={
                          workingRecordingId ===
                          selectedRecording.id
                        }
                        primary={
                          !selectedRecording.isLocked
                        }
                        onPress={() =>
                          void toggleLock(
                            selectedRecording,
                          )
                        }
                      />
                      <ActionButton
                        label="⬇ Download"
                        colors={colors}
                        disabled={false}
                        onPress={() =>
                          void downloadRecording(
                            selectedRecording,
                          )
                        }
                      />
                      <ActionButton
                        label="🗑 Delete"
                        colors={colors}
                        disabled={
                          selectedRecording.isLocked ||
                          workingRecordingId ===
                            selectedRecording.id
                        }
                        danger
                        onPress={() =>
                          confirmDelete(selectedRecording)
                        }
                      />
                    </View>
                  </View>
                </>
              ) : (
                <View
                  style={[
                    pageStyles.noSelection,
                    { backgroundColor: colors.surface },
                  ]}
                >
                  <Text style={pageStyles.noSelectionIcon}>
                    ▶️
                  </Text>
                  <Text
                    style={[
                      pageStyles.noSelectionText,
                      { color: colors.textSecondary },
                    ]}
                  >
                    Select a recording from the list.
                  </Text>
                </View>
              )}
            </View>

            <View
              style={[
                pageStyles.listColumn,
                compact && pageStyles.listColumnCompact,
              ]}
            >
              <View style={pageStyles.sectionHeader}>
                <View>
                  <Text
                    style={[
                      pageStyles.sectionTitle,
                      { color: colors.text },
                    ]}
                  >
                    Recent recordings
                  </Text>
                  <Text
                    style={[
                      pageStyles.sectionDescription,
                      { color: colors.textSecondary },
                    ]}
                  >
                    {visibleRecordings.length} clip
                    {visibleRecordings.length === 1
                      ? ""
                      : "s"}{" "}
                    displayed
                  </Text>
                </View>

                <TouchableOpacity
                  onPress={() => void refresh()}
                >
                  <Text
                    style={[
                      pageStyles.refreshText,
                      { color: colors.primary },
                    ]}
                  >
                    Refresh
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={pageStyles.recordingList}>
                {visibleRecordings.map((recording) => (
                  <RecordingRow
                    key={recording.id}
                    recording={recording}
                    selected={
                      selectedRecording?.id ===
                      recording.id
                    }
                    busy={
                      workingRecordingId === recording.id
                    }
                    colors={colors}
                    onSelect={() =>
                      setSelectedRecordingId(
                        recording.id,
                      )
                    }
                    onLock={() =>
                      void toggleLock(recording)
                    }
                    onDownload={() =>
                      void downloadRecording(recording)
                    }
                    onDelete={() =>
                      confirmDelete(recording)
                    }
                  />
                ))}
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  colors,
}: {
  icon: string;
  label: string;
  value: string;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  return (
    <View
      style={[
        pageStyles.summaryCard,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
        },
      ]}
    >
      <Text style={pageStyles.summaryIcon}>{icon}</Text>
      <Text
        style={[
          pageStyles.summaryLabel,
          { color: colors.textSecondary },
        ]}
      >
        {label}
      </Text>
      <Text
        numberOfLines={2}
        style={[
          pageStyles.summaryValue,
          { color: colors.text },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

function FilterChip({
  label,
  selected,
  colors,
  onPress,
}: {
  label: string;
  selected: boolean;
  colors: ReturnType<typeof useTheme>["colors"];
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[
        pageStyles.filterChip,
        {
          backgroundColor: selected
            ? colors.primary
            : colors.background,
          borderColor: selected
            ? colors.primary
            : colors.border,
        },
      ]}
      onPress={onPress}
    >
      <Text
        numberOfLines={1}
        style={[
          pageStyles.filterChipText,
          {
            color: selected ? "#FFFFFF" : colors.text,
          },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function DetailRow({
  label,
  value,
  colors,
  selectable = false,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useTheme>["colors"];
  selectable?: boolean;
}) {
  return (
    <View style={pageStyles.detailRow}>
      <Text
        style={[
          pageStyles.detailLabel,
          { color: colors.textSecondary },
        ]}
      >
        {label}
      </Text>
      <Text
        selectable={selectable}
        style={[
          pageStyles.detailValue,
          { color: colors.text },
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

function RecordingRow({
  recording,
  selected,
  busy,
  colors,
  onSelect,
  onLock,
  onDownload,
  onDelete,
}: {
  recording: Recording;
  selected: boolean;
  busy: boolean;
  colors: ReturnType<typeof useTheme>["colors"];
  onSelect: () => void;
  onLock: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  return (
    <TouchableOpacity
      style={[
        pageStyles.recordingRow,
        {
          backgroundColor: selected
            ? `${colors.primary}12`
            : colors.surface,
          borderColor: selected
            ? colors.primary
            : colors.border,
        },
      ]}
      activeOpacity={0.78}
      onPress={onSelect}
    >
      <View
        style={[
          pageStyles.recordingIconBox,
          {
            backgroundColor: recording.isLocked
              ? `${colors.warning}18`
              : `${colors.primary}12`,
          },
        ]}
      >
        <Text style={pageStyles.recordingIcon}>
          {recording.isLocked ? "🔒" : "🎬"}
        </Text>
      </View>

      <View style={pageStyles.recordingMain}>
        <Text
          numberOfLines={1}
          style={[
            pageStyles.recordingFile,
            { color: colors.text },
          ]}
        >
          {recording.fileName}
        </Text>

        <Text
          numberOfLines={1}
          style={[
            pageStyles.recordingMeta,
            { color: colors.textSecondary },
          ]}
        >
          {formatDateTime(recording.startedAt)}
        </Text>

        <Text
          numberOfLines={1}
          style={[
            pageStyles.recordingMeta,
            { color: colors.textSecondary },
          ]}
        >
          {recording.cameraId} ·{" "}
          {formatDuration(recording.durationSeconds)} ·{" "}
          {formatBytes(recording.sizeBytes)}
        </Text>

        <View style={pageStyles.statusRow}>
          <View
            style={[
              pageStyles.statusBadge,
              {
                backgroundColor:
                  recording.uploadStatus === "STORED"
                    ? `${colors.success}18`
                    : `${colors.warning}18`,
              },
            ]}
          >
            <Text
              style={[
                pageStyles.statusBadgeText,
                {
                  color:
                    recording.uploadStatus === "STORED"
                      ? colors.success
                      : colors.warning,
                },
              ]}
            >
              {recording.uploadStatus}
            </Text>
          </View>

          {recording.eventType && (
            <View
              style={[
                pageStyles.statusBadge,
                {
                  backgroundColor: `${colors.secondary}18`,
                },
              ]}
            >
              <Text
                style={[
                  pageStyles.statusBadgeText,
                  { color: colors.secondary },
                ]}
              >
                {recording.eventType}
              </Text>
            </View>
          )}
        </View>
      </View>

      <View style={pageStyles.rowActions}>
        <MiniButton
          label={recording.isLocked ? "🔓" : "🔒"}
          accessibilityLabel={
            recording.isLocked
              ? "Unlock recording"
              : "Protect recording"
          }
          disabled={busy}
          colors={colors}
          onPress={onLock}
        />
        <MiniButton
          label="⬇"
          accessibilityLabel="Download recording"
          disabled={false}
          colors={colors}
          onPress={onDownload}
        />
        <MiniButton
          label="🗑"
          accessibilityLabel="Delete recording"
          disabled={busy || recording.isLocked}
          colors={colors}
          danger
          onPress={onDelete}
        />
      </View>
    </TouchableOpacity>
  );
}

function MiniButton({
  label,
  accessibilityLabel,
  disabled,
  colors,
  danger = false,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  colors: ReturnType<typeof useTheme>["colors"];
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[
        pageStyles.miniButton,
        {
          backgroundColor: danger
            ? `${colors.error}12`
            : colors.background,
          borderColor: danger
            ? `${colors.error}45`
            : colors.border,
          opacity: disabled ? 0.42 : 1,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
    >
      <Text style={pageStyles.miniButtonText}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function ActionButton({
  label,
  colors,
  disabled,
  primary = false,
  danger = false,
  onPress,
}: {
  label: string;
  colors: ReturnType<typeof useTheme>["colors"];
  disabled: boolean;
  primary?: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  const backgroundColor = disabled
    ? colors.border
    : primary
      ? colors.primary
      : danger
        ? `${colors.error}12`
        : colors.background;

  const textColor = disabled
    ? colors.textSecondary
    : primary
      ? "#FFFFFF"
      : danger
        ? colors.error
        : colors.text;

  return (
    <TouchableOpacity
      style={[
        pageStyles.actionButton,
        {
          backgroundColor,
          borderColor: danger
            ? `${colors.error}45`
            : colors.border,
        },
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text
        style={[
          pageStyles.actionButtonText,
          { color: textColor },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const pageStyles = StyleSheet.create({
  screen: {
    flex: 1,
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    gap: 16,
  },

  backButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 10,
  },

  backButtonText: {
    fontSize: 13,
    fontWeight: "800",
  },

  headerText: {
    flex: 1,
  },

  title: {
    fontSize: 23,
    fontWeight: "900",
  },

  subtitle: {
    fontSize: 13,
    marginTop: 3,
  },

  autoRefreshButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 10,
  },

  autoRefreshDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  autoRefreshText: {
    fontSize: 12,
    fontWeight: "800",
  },

  scroll: {
    flex: 1,
  },

  scrollContent: {
    padding: 20,
    paddingBottom: 48,
  },

  serverBanner: {
    flexDirection: "row",
    alignItems: "center",
    padding: 15,
    borderWidth: 1,
    borderRadius: 14,
    gap: 13,
  },

  serverIcon: {
    fontSize: 27,
  },

  serverLabel: {
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase",
  },

  serverValue: {
    fontSize: 13,
    fontWeight: "800",
    marginTop: 4,
  },

  lastUpdated: {
    fontSize: 11,
  },

  summaryGrid: {
    flexDirection: "row",
    gap: 12,
    marginTop: 18,
  },

  summaryGridCompact: {
    flexWrap: "wrap",
  },

  summaryCard: {
    flex: 1,
    minWidth: 155,
    minHeight: 112,
    padding: 16,
    borderWidth: 1,
    borderRadius: 14,
  },

  summaryIcon: {
    fontSize: 24,
    marginBottom: 9,
  },

  summaryLabel: {
    fontSize: 11,
  },

  summaryValue: {
    fontSize: 18,
    fontWeight: "900",
    marginTop: 5,
  },

  filterPanel: {
    marginTop: 18,
    padding: 17,
    borderWidth: 1,
    borderRadius: 16,
  },

  filterHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 12,
  },

  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 13,
    gap: 12,
  },

  sectionTitle: {
    fontSize: 17,
    fontWeight: "900",
  },

  sectionDescription: {
    fontSize: 12,
    marginTop: 4,
  },

  clearFiltersText: {
    fontSize: 12,
    fontWeight: "900",
  },

  cameraChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 15,
  },

  filterChip: {
    maxWidth: 260,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderRadius: 999,
  },

  filterChipText: {
    fontSize: 11,
    fontWeight: "800",
  },

  filterInputs: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    marginTop: 15,
  },

  filterInputsCompact: {
    flexWrap: "wrap",
  },

  inputGroup: {
    flex: 1,
    minWidth: 170,
  },

  inputLabel: {
    fontSize: 11,
    fontWeight: "800",
    marginBottom: 6,
  },

  input: {
    width: "100%",
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 13,
  },

  applyButton: {
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 9,
  },

  applyButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "900",
  },

  loadingPanel: {
    minHeight: 280,
    justifyContent: "center",
    alignItems: "center",
  },

  loadingText: {
    marginTop: 12,
    fontSize: 13,
  },

  emptyPanel: {
    marginTop: 20,
    padding: 50,
    alignItems: "center",
    borderRadius: 16,
  },

  emptyIcon: {
    fontSize: 52,
  },

  emptyTitle: {
    fontSize: 20,
    fontWeight: "900",
    marginTop: 12,
  },

  emptyText: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 7,
    textAlign: "center",
  },

  libraryLayout: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 18,
    marginTop: 22,
  },

  libraryLayoutCompact: {
    flexDirection: "column",
  },

  playerColumn: {
    flex: 1.35,
    minWidth: 0,
  },

  playerColumnCompact: {
    width: "100%",
  },

  listColumn: {
    flex: 1,
    minWidth: 360,
  },

  listColumnCompact: {
    width: "100%",
    minWidth: 0,
  },

  selectedDetails: {
    marginTop: 12,
    padding: 16,
    borderWidth: 1,
    borderRadius: 14,
  },

  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(148,163,184,0.24)",
  },

  detailLabel: {
    fontSize: 12,
    fontWeight: "700",
  },

  detailValue: {
    flex: 1,
    fontSize: 12,
    fontWeight: "800",
    textAlign: "right",
  },

  selectedActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 9,
    marginTop: 15,
  },

  actionButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 9,
  },

  actionButtonText: {
    fontSize: 12,
    fontWeight: "900",
  },

  noSelection: {
    minHeight: 300,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 16,
  },

  noSelectionIcon: {
    fontSize: 45,
  },

  noSelectionText: {
    fontSize: 13,
    marginTop: 10,
  },

  refreshText: {
    fontSize: 12,
    fontWeight: "900",
  },

  recordingList: {
    gap: 10,
  },

  recordingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    padding: 12,
    borderWidth: 1,
    borderRadius: 13,
  },

  recordingIconBox: {
    width: 43,
    height: 43,
    borderRadius: 11,
    justifyContent: "center",
    alignItems: "center",
  },

  recordingIcon: {
    fontSize: 21,
  },

  recordingMain: {
    flex: 1,
    minWidth: 0,
  },

  recordingFile: {
    fontSize: 13,
    fontWeight: "900",
  },

  recordingMeta: {
    fontSize: 11,
    marginTop: 3,
  },

  statusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
    marginTop: 7,
  },

  statusBadge: {
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
  },

  statusBadgeText: {
    fontSize: 9,
    fontWeight: "900",
  },

  rowActions: {
    gap: 6,
  },

  miniButton: {
    width: 34,
    height: 32,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 8,
  },

  miniButtonText: {
    fontSize: 14,
  },
});
