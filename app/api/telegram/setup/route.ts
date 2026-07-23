// app/api/telegram/setup/route.ts
// import { getTelegramUpdates } from '@/app/lib/telegram';
import { getTelegramUpdates } from '@/lib/telegram';
import { NextRequest, NextResponse } from 'next/server';
// import { getTelegramUpdates } from '@/lib/telegram';

/**
 * This endpoint helps users find their Telegram Chat ID
 * Instructions for users:
 * 1. Open Telegram and search for your bot (@YourBotName)
 * 2. Send /start message to the bot
 * 3. Call this API to get your chat ID
 */
export async function GET(request: NextRequest) {
  try {
    const updates = await getTelegramUpdates();

    if (!updates || updates.length === 0) {
      return NextResponse.json({
        success: false,
        message: 'No updates found. Please send /start to your Telegram bot first.',
        instructions: [
          '1. Open Telegram app',
          '2. Search for your bot (use bot username from @BotFather)',
          '3. Click START or send /start',
          '4. Call this API again to get your Chat ID'
        ]
      });
    }

    // Extract chat IDs from updates
    const chatIds = updates.map(update => ({
      chatId: update.message?.chat.id,
      username: update.message?.chat.username,
      firstName: update.message?.chat.first_name,
      message: update.message?.text,
    })).filter(item => item.chatId);

    return NextResponse.json({
      success: true,
      message: 'Found Telegram updates',
      chatIds,
      instructions: [
        'Copy your Chat ID from the list above',
        'Use this Chat ID in your user settings or .env file',
        'Format: TELEGRAM_CHAT_ID=your_chat_id'
      ]
    });
  } catch (error) {
    console.error('Telegram setup error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to get Telegram updates',
        details: error instanceof Error ? error.message : String(error),
        help: 'Make sure TELEGRAM_BOT_TOKEN is set in .env'
      },
      { status: 500 }
    );
  }
}

/**
 * Save Telegram chat ID to user profile
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId, chatId } = body;

    if (!userId || !chatId) {
      return NextResponse.json(
        { error: 'userId and chatId are required' },
        { status: 400 }
      );
    }

    const { updateUserTelegramChatId } = await import('@/lib/database');
    await updateUserTelegramChatId(userId, chatId);

    return NextResponse.json({
      success: true,
      message: 'Telegram chat ID saved successfully'
    });
  } catch (error) {
    console.error('Save Telegram chat ID error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to save Telegram chat ID',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}