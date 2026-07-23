// services/security/cameraSecurity.ts
//
// Build-time camera credential issued by the CCTV backend.
// Each future phone/camera must receive its own camera token.

export function getCameraSecurityToken(): string {
  const token =
    process.env.EXPO_PUBLIC_CCTV_CAMERA_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "EXPO_PUBLIC_CCTV_CAMERA_TOKEN is not configured. Run the CCTV provisioning patch or issue a camera token.",
    );
  }

  return token;
}

export function getCameraSocketAuth(
  cameraId: string,
): {
  role: "camera";
  cameraId: string;
  token: string;
} {
  return {
    role: "camera",
    cameraId: cameraId.trim(),
    token: getCameraSecurityToken(),
  };
}

export function getCameraSecurityFingerprint(): string {
  const token = getCameraSecurityToken();

  let hash = 2166136261;

  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (
    (hash >>> 0)
      .toString(16)
      .padStart(8, "0")
  );
}

