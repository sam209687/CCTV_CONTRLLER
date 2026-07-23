// smartphone-camera-app/config.ts

import Constants from "expo-constants";

const BACKEND_PORT = 3000;

function removeTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function getExpoDevelopmentHost(): string | null {
  const hostUri = Constants.expoConfig?.hostUri;

  if (!hostUri) {
    return null;
  }

  /*
   * Expo normally provides:
   *
   * 172.24.195.214:8081
   *
   * We need only:
   *
   * 172.24.195.214
   */
  const withoutProtocol = hostUri
    .replace(/^https?:\/\//i, "")
    .replace(/^exp:\/\//i, "");

  const host = withoutProtocol.split(":")[0].trim();

  return host || null;
}

function getServerUrl(): string {
  const expoDevelopmentHost = getExpoDevelopmentHost();

  /*
   * During Expo Go development, automatically use the computer
   * running the Expo development server.
   */
  if (__DEV__ && expoDevelopmentHost) {
    const automaticUrl =
      `http://${expoDevelopmentHost}:${BACKEND_PORT}`;

    console.log(
      "🌐 Automatically detected CCTV server:",
      automaticUrl,
    );

    return automaticUrl;
  }

  /*
   * Used later for standalone production builds.
   */
  const configuredUrl =
    process.env.EXPO_PUBLIC_SERVER_URL?.trim();

  if (configuredUrl) {
    return removeTrailingSlash(configuredUrl);
  }

  throw new Error(
    "Unable to determine CCTV backend server URL.",
  );
}

export const config = {
  serverUrl: getServerUrl(),
};