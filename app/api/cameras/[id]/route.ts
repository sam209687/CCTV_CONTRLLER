// app/api/cameras/[id]/route.ts

import { prisma } from "@/lib/database";
import {
  NextRequest,
  NextResponse,
} from "next/server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods":
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization",
};

type RouteContext = {
  params:
    | {
        id: string;
      }
    | Promise<{
        id: string;
      }>;
};

function jsonResponse(
  body: unknown,
  status = 200,
) {
  return NextResponse.json(body, {
    status,
    headers: corsHeaders,
  });
}

async function getCameraId(
  context: RouteContext,
): Promise<string> {
  const params =
    await context.params;

  return decodeURIComponent(
    params.id,
  );
}

function serializeCamera<
  T extends {
    rtspUrl?: string | null;
  },
>(camera: T) {
  return {
    ...camera,
    streamUrl:
      camera.rtspUrl ?? undefined,
  };
}

/**
 * GET /api/cameras/:id
 */
export async function GET(
  _request: NextRequest,
  context: RouteContext,
) {
  try {
    const cameraId =
      await getCameraId(context);

    const camera =
      await prisma.camera.findUnique({
        where: {
          id: cameraId,
        },
        include: {
          shop: true,
          _count: {
            select: {
              motionEvents: true,
            },
          },
        },
      });

    if (!camera) {
      return jsonResponse(
        {
          error: "Camera not found",
        },
        404,
      );
    }

    return jsonResponse({
      camera:
        serializeCamera(camera),
    });
  } catch (error) {
    console.error(
      "GET camera failed:",
      error,
    );

    return jsonResponse(
      {
        error:
          "Failed to load camera",
      },
      500,
    );
  }
}

/**
 * Shared PUT/PATCH update handler.
 *
 * This supports renaming the camera without changing its
 * technical camera ID.
 */
async function updateCamera(
  request: NextRequest,
  context: RouteContext,
) {
  try {
    const cameraId =
      await getCameraId(context);

    const existingCamera =
      await prisma.camera.findUnique({
        where: {
          id: cameraId,
        },
      });

    if (!existingCamera) {
      return jsonResponse(
        {
          error: "Camera not found",
        },
        404,
      );
    }

    const body = await request.json();

    const updateData: {
      name?: string;
      rtspUrl?: string | null;
      isActive?: boolean;
      motionSensitivity?: number;
      notificationCooldown?: number;
      audioMessageUrl?: string | null;
      enableTelegram?: boolean;
      enableMobilePush?: boolean;
      enableSMS?: boolean;
    } = {};

    if (body.name !== undefined) {
      const name =
        typeof body.name === "string"
          ? body.name.trim()
          : "";

      if (!name) {
        return jsonResponse(
          {
            error:
              "Camera name cannot be empty",
          },
          400,
        );
      }

      updateData.name = name;
    }

    if (
      body.streamUrl !== undefined ||
      body.rtspUrl !== undefined
    ) {
      const streamUrl =
        typeof body.streamUrl ===
        "string"
          ? body.streamUrl.trim()
          : typeof body.rtspUrl ===
              "string"
            ? body.rtspUrl.trim()
            : "";

      updateData.rtspUrl =
        streamUrl || null;
    }

    if (
      typeof body.isActive ===
      "boolean"
    ) {
      updateData.isActive =
        body.isActive;
    }

    if (
      typeof body.motionSensitivity ===
      "number"
    ) {
      updateData.motionSensitivity =
        body.motionSensitivity;
    }

    if (
      typeof body.notificationCooldown ===
      "number"
    ) {
      updateData.notificationCooldown =
        body.notificationCooldown;
    }

    if (
      body.audioMessageUrl !== undefined
    ) {
      updateData.audioMessageUrl =
        typeof body.audioMessageUrl ===
          "string" &&
        body.audioMessageUrl.trim()
          ? body.audioMessageUrl.trim()
          : null;
    }

    if (
      typeof body.enableTelegram ===
      "boolean"
    ) {
      updateData.enableTelegram =
        body.enableTelegram;
    }

    if (
      typeof body.enableMobilePush ===
      "boolean"
    ) {
      updateData.enableMobilePush =
        body.enableMobilePush;
    }

    if (
      typeof body.enableSMS ===
      "boolean"
    ) {
      updateData.enableSMS =
        body.enableSMS;
    }

    if (
      Object.keys(updateData).length ===
      0
    ) {
      return jsonResponse(
        {
          error:
            "No valid camera fields were provided",
        },
        400,
      );
    }

    const camera =
      await prisma.camera.update({
        where: {
          id: cameraId,
        },
        data: updateData,
        include: {
          shop: true,
          _count: {
            select: {
              motionEvents: true,
            },
          },
        },
      });

    console.log(
      "✅ Camera updated:",
      {
        id: camera.id,
        name: camera.name,
      },
    );

    return jsonResponse({
      camera:
        serializeCamera(camera),
    });
  } catch (error) {
    console.error(
      "Camera update failed:",
      error,
    );

    return jsonResponse(
      {
        error:
          "Failed to update camera",
      },
      500,
    );
  }
}

export async function PUT(
  request: NextRequest,
  context: RouteContext,
) {
  return updateCamera(
    request,
    context,
  );
}

export async function PATCH(
  request: NextRequest,
  context: RouteContext,
) {
  return updateCamera(
    request,
    context,
  );
}

/**
 * DELETE /api/cameras/:id
 *
 * Permanently deletes the database record.
 */
export async function DELETE(
  _request: NextRequest,
  context: RouteContext,
) {
  try {
    const cameraId =
      await getCameraId(context);

    const camera =
      await prisma.camera.findUnique({
        where: {
          id: cameraId,
        },
      });

    if (!camera) {
      return jsonResponse(
        {
          error: "Camera not found",
        },
        404,
      );
    }

    await prisma.camera.delete({
      where: {
        id: cameraId,
      },
    });

    console.log(
      "🗑️ Camera permanently deleted:",
      {
        id: camera.id,
        name: camera.name,
      },
    );

    return jsonResponse({
      success: true,
      deletedCameraId: cameraId,
    });
  } catch (error) {
    console.error(
      "Camera deletion failed:",
      error,
    );

    return jsonResponse(
      {
        error:
          "Failed to delete camera",
      },
      500,
    );
  }
}

export async function OPTIONS() {
  return jsonResponse({});
}