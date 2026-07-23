// lib/telegram.ts
import TelegramBot from 'node-telegram-bot-api';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

// Initialize bot (singleton pattern)
let bot: TelegramBot | null = null;

function getBot() {
  if (!bot && TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
  }
  return bot;
}

interface TelegramNotificationPayload {
  chatId: string;
  title: string;
  body: string;
  imageUrl?: string;
  shopName?: string;
  cameraName?: string;
  timestamp?: Date;
}

/**
 * Send a Telegram notification with image
 */
export async function sendTelegramNotification(payload: TelegramNotificationPayload) {
  try {
    const telegramBot = getBot();
    if (!telegramBot) {
      console.error('Telegram bot not initialized');
      return { success: false, error: 'Bot not initialized' };
    }

    const message = formatTelegramMessage(payload);

    // Send message with image if available
    if (payload.imageUrl) {
      // Check if image URL is accessible
      const imageUrl = payload.imageUrl.startsWith('http') 
        ? payload.imageUrl 
        : `${process.env.NEXT_PUBLIC_API_URL}${payload.imageUrl}`;

      try {
        await telegramBot.sendPhoto(payload.chatId, imageUrl, {
          caption: message,
          parse_mode: 'HTML',
        });
      } catch (imgError) {
        // If image fails, send text message
        console.error('Error sending image, sending text instead:', imgError);
        await telegramBot.sendMessage(payload.chatId, message, {
          parse_mode: 'HTML',
        });
      }
    } else {
      // Send text message only
      await telegramBot.sendMessage(payload.chatId, message, {
        parse_mode: 'HTML',
      });
    }

    console.log('Telegram notification sent successfully');
    return { success: true };
  } catch (error) {
    console.error('Error sending Telegram notification:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Format message for Telegram
 */
function formatTelegramMessage(payload: TelegramNotificationPayload): string {
  const timestamp = payload.timestamp 
    ? new Date(payload.timestamp).toLocaleString() 
    : new Date().toLocaleString();

  let message = `🔔 <b>${payload.title}</b>\n\n`;
  message += `${payload.body}\n\n`;
  
  if (payload.shopName) {
    message += `🏪 Shop: ${payload.shopName}\n`;
  }
  
  if (payload.cameraName) {
    message += `📹 Camera: ${payload.cameraName}\n`;
  }
  
  message += `🕐 Time: ${timestamp}`;

  return message;
}

/**
 * Send a simple text message via Telegram
 */
export async function sendTelegramMessage(chatId: string, text: string) {
  try {
    const telegramBot = getBot();
    if (!telegramBot) {
      throw new Error('Telegram bot not initialized');
    }

    await telegramBot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
    });

    return { success: true };
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    throw error;
  }
}

/**
 * Send location via Telegram (optional feature)
 */
export async function sendTelegramLocation(
  chatId: string, 
  latitude: number, 
  longitude: number,
  title?: string
) {
  try {
    const telegramBot = getBot();
    if (!telegramBot) {
      throw new Error('Telegram bot not initialized');
    }

    await telegramBot.sendLocation(chatId, latitude, longitude);
    
    if (title) {
      await telegramBot.sendMessage(chatId, `📍 ${title}`);
    }

    return { success: true };
  } catch (error) {
    console.error('Error sending Telegram location:', error);
    throw error;
  }
}

/**
 * Setup Telegram Bot Commands (optional)
 * Call this once when server starts
 */
export async function setupTelegramBot() {
  try {
    const telegramBot = getBot();
    if (!telegramBot) {
      console.log('Telegram bot token not configured');
      return;
    }

    // Set bot commands
    await telegramBot.setMyCommands([
      { command: 'start', description: 'Start the bot and get your Chat ID' },
      { command: 'status', description: 'Check camera status' },
      { command: 'help', description: 'Get help' },
    ]);

    console.log('Telegram bot commands set up successfully');
  } catch (error) {
    console.error('Error setting up Telegram bot:', error);
  }
}

/**
 * Get updates from Telegram (for getting chat ID)
 * This is useful for finding out your chat ID
 */
export async function getTelegramUpdates() {
  try {
    const telegramBot = getBot();
    if (!telegramBot) {
      throw new Error('Telegram bot not initialized');
    }

    const updates = await telegramBot.getUpdates();
    return updates;
  } catch (error) {
    console.error('Error getting Telegram updates:', error);
    throw error;
  }
}