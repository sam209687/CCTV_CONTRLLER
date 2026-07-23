// app/api/motion/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
// import { getCameraSettings } from '@/lib/database';
// import { saveMotionEvent } from '@/lib/database';
import { sendNotification } from '@/lib/notifications';
import { getCameraSettings } from '@/lib/database';
import { saveMotionEvent } from '@/lib/database';


export async function POST(request: NextRequest) {
  try {
    const formData = (await request.formData()) as unknown as {
      get(name: string): unknown;
    };
    const image = formData.get('image') as File;
    const timestamp = formData.get('timestamp') as string;
    const cameraId = formData.get('camera_id') as string;
    const message = formData.get('message') as string;

    if (!image) {
      return NextResponse.json(
        { error: 'No image provided' },
        { status: 400 }
      );
    }

    if (!cameraId) {
      return NextResponse.json(
        { error: 'Camera ID is required' },
        { status: 400 }
      );
    }

    // Get camera settings to check user ID and notification preferences
    const camera = await getCameraSettings(cameraId);
    
    if (!camera) {
      return NextResponse.json(
        { error: 'Camera not found' },
        { status: 404 }
      );
    }

    // Save image
    const bytes = await image.arrayBuffer();
    const buffer = Buffer.from(bytes);
    
    const uploadsDir = path.join(process.cwd(), 'public', 'uploads', 'motion');
    await mkdir(uploadsDir, { recursive: true });
    
    const filename = `motion_${cameraId}_${Date.now()}.jpg`;
    const filepath = path.join(uploadsDir, filename);
    await writeFile(filepath, buffer);

    const imageUrl = `/uploads/motion/${filename}`;

    // Save to database
    const event = await saveMotionEvent({
      timestamp: new Date(timestamp),
      cameraId,
      message: message || 'Motion detected at entrance',
      imageUrl,
    });

    // Send notifications via Telegram and Mobile Push
    const notificationResults = await sendNotification({
      userId: camera.userId,
      title: '🔔 Customer Detected',
      body: `Motion detected at ${camera.shop.name} - ${camera.name}`,
      imageUrl,
      shopName: camera.shop.name,
      cameraName: camera.name,
      timestamp: new Date(timestamp),
      data: {
        eventId: event.id,
        cameraId,
        timestamp,
      },
    });

    console.log('Notification results:', notificationResults);

    return NextResponse.json({
      success: true,
      eventId: event.id,
      imageUrl,
      timestamp,
      notifications: {
        telegram: notificationResults.telegram,
        mobilePush: notificationResults.mobilePush,
        errors: notificationResults.errors,
      },
    });
  } catch (error) {
    console.error('Motion detection API error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to process motion event',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

// GET endpoint to fetch recent events
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '10');
    const cameraId = searchParams.get('camera_id');
    const userId = searchParams.get('user_id');

    const { getRecentEvents } = await import('@/lib/database');
    const events = await getRecentEvents({ 
      limit, 
      cameraId: cameraId || null, 
      userId: userId || undefined 
    });

    return NextResponse.json({ 
      success: true,
      events,
      count: events.length 
    });
  } catch (error) {
    console.error('Fetch events error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch events',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
// PATCH_11A_C_REQUEST_FORMDATA_COMPAT
