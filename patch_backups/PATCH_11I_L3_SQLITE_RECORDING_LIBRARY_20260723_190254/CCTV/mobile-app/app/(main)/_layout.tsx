import React, { useState } from "react";
import {
  View,
  StyleSheet,
  Modal,
  TouchableWithoutFeedback,
  Platform,
  useWindowDimensions,
} from "react-native";
import { Stack } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";

export default function MainLayout() {
  const { colors } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const { width } = useWindowDimensions();
  const isTablet = width >= 768 && Platform.OS === "web";

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Sidebar container ALWAYS mounted (safe for router) */}
      <View
        style={[
          styles.sidebarContainer,
          isTablet ? styles.desktopSidebar : styles.hiddenSidebar,
        ]}
      >
        <Sidebar isOpen={true} onClose={() => {}} />
      </View>

      {/* Mobile sidebar modal */}
      {!isTablet && (
        <Modal
          visible={sidebarOpen}
          animationType="slide"
          transparent
          onRequestClose={() => setSidebarOpen(false)}
        >
          <TouchableWithoutFeedback onPress={() => setSidebarOpen(false)}>
            <View style={styles.modalOverlay}>
              <TouchableWithoutFeedback>
                <View style={styles.modalContent}>
                  <Sidebar
                    isOpen={sidebarOpen}
                    onClose={() => setSidebarOpen(false)}
                  />
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
      )}

      {/* Main navigation (structure never changes) */}
      <View style={styles.mainContent}>
        <Stack
          screenOptions={{
            header: ({ options }) => (
              <Header
                title={options.title || "Dashboard"}
                onMenuPress={() => setSidebarOpen(true)}
                notificationCount={3}
              />
            ),
          }}
        >
          <Stack.Screen name="dashboard" options={{ title: "Dashboard" }} />
          <Stack.Screen name="cameras" options={{ title: "Cameras" }} />
          <Stack.Screen name="events" options={{ title: "Events" }} />
          <Stack.Screen name="analytics" options={{ title: "Analytics" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
        </Stack>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: "row",
  },

  sidebarContainer: {
    width: 280,
  },

  desktopSidebar: {
    borderRightWidth: 1,
    borderRightColor: "#E2E8F0",
  },

  hiddenSidebar: {
    width: 0,
    overflow: "hidden",
  },

  mainContent: {
    flex: 1,
  },

  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
  },

  modalContent: {
    width: 280,
    height: "100%",
    backgroundColor: "#fff",
  },
});
