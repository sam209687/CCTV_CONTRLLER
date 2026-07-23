// lib/database.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Motion Event functions
export async function saveMotionEvent({
  timestamp,
  cameraId,
  message,
  imageUrl,
  videoUrl,
}: {
  timestamp: Date;
  cameraId: string;
  message: string;
  imageUrl: string;
  videoUrl?: string;
}) {
  try {
    const event = await prisma.motionEvent.create({
      data: {
        timestamp,
        cameraId,
        message,
        imageUrl,
        videoUrl,
        notified: true,
      },
      include: {
        camera: {
          include: {
            user: true,
            shop: true,
          },
        },
      },
    });

    await prisma.notification.create({
      data: {
        userId: event.camera.userId,
        motionEventId: event.id,
        title: 'Customer Detected',
        body: message,
        type: 'motion',
        telegramSent: event.camera.enableTelegram,
        mobilePushSent: event.camera.enableMobilePush,
      },
    });

    return event;
  } catch (error) {
    console.error('Error saving motion event:', error);
    throw error;
  }
}

export async function getRecentEvents({
  limit = 10,
  cameraId,
  userId,
}: {
  limit?: number;
  cameraId?: string | null;
  userId?: string;
}) {
  try {
    const where: any = {};
    
    if (cameraId) {
      where.cameraId = cameraId;
    }
    
    if (userId) {
      where.camera = {
        userId,
      };
    }

    const events = await prisma.motionEvent.findMany({
      where,
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
      include: {
        camera: {
          select: {
            name: true,
            shop: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

    return events;
  } catch (error) {
    console.error('Error fetching events:', error);
    throw error;
  }
}

export async function getCameraSettings(cameraId: string) {
  try {
    const camera = await prisma.camera.findUnique({
      where: { id: cameraId },
      include: {
        shop: true,
        user: true,
      },
    });

    return camera;
  } catch (error) {
    console.error('Error fetching camera settings:', error);
    throw error;
  }
}

export async function updateCameraSettings(
  cameraId: string,
  settings: {
    motionSensitivity?: number;
    notificationCooldown?: number;
    audioMessageUrl?: string;
    isActive?: boolean;
    enableTelegram?: boolean;
    enableMobilePush?: boolean;
  }
) {
  try {
    const camera = await prisma.camera.update({
      where: { id: cameraId },
      data: settings,
    });

    return camera;
  } catch (error) {
    console.error('Error updating camera settings:', error);
    throw error;
  }
}

export async function getUserNotifications(userId: string, limit = 20) {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: {
        sentAt: 'desc',
      },
      take: limit,
      include: {
        motionEvent: {
          include: {
            camera: {
              select: {
                name: true,
                shop: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return notifications;
  } catch (error) {
    console.error('Error fetching notifications:', error);
    throw error;
  }
}

export async function markNotificationAsRead(notificationId: string) {
  try {
    await prisma.notification.update({
      where: { id: notificationId },
      data: {
        read: true,
        readAt: new Date(),
      },
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    throw error;
  }
}

export async function createShop(userId: string, name: string, address?: string) {
  try {
    const shop = await prisma.shop.create({
      data: {
        name,
        address,
        userId,
      },
    });

    return shop;
  } catch (error) {
    console.error('Error creating shop:', error);
    throw error;
  }
}

export async function createCamera(data: {
  name: string;
  shopId: string;
  userId: string;
  rtspUrl?: string;
  audioMessageUrl?: string;
}) {
  try {
    const camera = await prisma.camera.create({
      data,
    });

    return camera;
  } catch (error) {
    console.error('Error creating camera:', error);
    throw error;
  }
}

export async function getUserCameras(userId: string) {
  try {
    const cameras = await prisma.camera.findMany({
      where: { userId },
      include: {
        shop: true,
        _count: {
          select: {
            motionEvents: true,
          },
        },
      },
    });

    return cameras;
  } catch (error) {
    console.error('Error fetching cameras:', error);
    throw error;
  }
}

export async function getUserByEmail(email: string) {
  try {
    const user = await prisma.user.findUnique({
      where: { email },
    });
    return user;
  } catch (error) {
    console.error('Error fetching user:', error);
    throw error;
  }
}

export async function createUser(data: {
  email: string;
  password: string;
  name?: string;
  telegramChatId?: string;
}) {
  try {
    const user = await prisma.user.create({
      data,
    });
    return user;
  } catch (error) {
    console.error('Error creating user:', error);
    throw error;
  }
}

export async function updateUserTelegramChatId(userId: string, telegramChatId: string) {
  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { telegramChatId },
    });
    return user;
  } catch (error) {
    console.error('Error updating Telegram chat ID:', error);
    throw error;
  }
}
