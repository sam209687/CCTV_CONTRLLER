// lib/notifications.ts
import admin from 'firebase-admin';
// import { sendTelegramNotification } from './telegram';
import { prisma } from './database';
import { sendTelegramNotification } from './telegram';

// Initialize Firebase Admin (do this once)
if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  } catch (error) {
    console.error('Firebase initialization error:', error);
  }
}

interface NotificationPayload {
  userId: string;
  title: string;
  body: string;
  imageUrl?: string;
  data?: Record<string, string>;
  shopName?: string;
  cameraName?: string;
  timestamp?: Date;
}

/**
 * Send notification via all enabled channels
 */
export async function sendNotification(payload: NotificationPayload) {
  const results = {
    telegram: false,
    mobilePush: false,
    errors: [] as string[],
  };

  try {
    // Get user preferences
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        telegramChatId: true,
        fcmToken: true,
        expoPushToken: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Send Telegram notification
    if (user.telegramChatId) {
      try {
        const telegramResult = await sendTelegramNotification({
          chatId: user.telegramChatId,
          title: payload.title,
          body: payload.body,
          imageUrl: payload.imageUrl,
          shopName: payload.shopName,
          cameraName: payload.cameraName,
          timestamp: payload.timestamp,
        });
        results.telegram = telegramResult.success;
        if (!telegramResult.success) {
          results.errors.push(`Telegram: ${telegramResult.error}`);
        }
      } catch (error) {
        results.errors.push(`Telegram: ${error}`);
      }
    }

    // Send Mobile Push notification (Firebase)
    if (user.fcmToken) {
      try {
        await sendFirebasePushNotification({
          token: user.fcmToken,
          title: payload.title,
          body: payload.body,
          imageUrl: payload.imageUrl,
          data: payload.data,
        });
        results.mobilePush = true;
      } catch (error) {
        results.errors.push(`Firebase: ${error}`);
      }
    }

    // Send Expo Push notification (alternative to Firebase)
    if (user.expoPushToken) {
      try {
        await sendExpoPushNotification({
          token: user.expoPushToken,
          title: payload.title,
          body: payload.body,
          data: payload.data,
        });
        results.mobilePush = true;
      } catch (error) {
        results.errors.push(`Expo: ${error}`);
      }
    }

    return results;
  } catch (error) {
    console.error('Error sending notifications:', error);
    results.errors.push(String(error));
    return results;
  }
}

/**
 * Send Firebase Cloud Messaging push notification
 */
async function sendFirebasePushNotification({
  token,
  title,
  body,
  imageUrl,
  data,
}: {
  token: string;
  title: string;
  body: string;
  imageUrl?: string;
  data?: Record<string, string>;
}) {
  try {
    if (!admin.apps.length) {
      throw new Error('Firebase not initialized');
    }

    const message: admin.messaging.Message = {
      notification: {
        title,
        body,
        imageUrl,
      },
      data: data || {},
      token,
      android: {
        notification: {
          sound: 'default',
          priority: 'high',
          channelId: 'motion_alerts',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log('Firebase notification sent:', response);
    return response;
  } catch (error) {
    console.error('Firebase notification error:', error);
    throw error;
  }
}

/**
 * Send Expo Push notification
 */
async function sendExpoPushNotification({
  token,
  title,
  body,
  data,
}: {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}) {
  try {
    const message = {
      to: token,
      sound: 'default',
      title,
      body,
      data: data || {},
    };

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json();
    console.log('Expo notification sent:', result);
    return result;
  } catch (error) {
    console.error('Expo notification error:', error);
    throw error;
  }
}

/**
 * Update user's Telegram chat ID
 */
export async function updateUserTelegramChatId(userId: string, chatId: string) {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: chatId },
    });
  } catch (error) {
    console.error('Error updating Telegram chat ID:', error);
    throw error;
  }
}

/**
 * Update user's FCM token
 */
export async function updateUserFCMToken(userId: string, token: string) {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { fcmToken: token },
    });
  } catch (error) {
    console.error('Error updating FCM token:', error);
    throw error;
  }
}

/**
 * Update user's Expo push token
 */
export async function updateUserExpoPushToken(userId: string, token: string) {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { expoPushToken: token },
    });
  } catch (error) {
    console.error('Error updating Expo push token:', error);
    throw error;
  }
}