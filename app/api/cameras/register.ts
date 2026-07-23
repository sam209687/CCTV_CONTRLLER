// app/api/cameras/register/route.ts - Next.js 13+ App Router
import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function POST(req: NextRequest) {
  try {
    const { cameraId, deviceInfo } = await req.json();
    const token = req.headers.get('authorization')?.replace('Bearer ', '');

    if (!token || !cameraId) {
      return NextResponse.json({ error: 'Missing credentials' }, { status: 401 });
    }

    // For now, just mark camera as active since we don't have token field
    // You can extend Camera model later to add token/status fields
    const camera = await prisma.camera.update({
      where: { id: cameraId },
      data: {
        isActive: true,
        // Store device info in audioMessageUrl as temporary solution
        // Or add a deviceInfo field to your schema
        name: `📱 ${deviceInfo?.model || 'Smartphone'}`,
      },
    });

    return NextResponse.json({ success: true, camera });
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 });
  }
}

// app/api/cameras/[id]/heartbeat/route.ts
export async function handleHeartbeat(req: NextRequest, context: any) {
  try {
    const { id } = context.params;
    
    await prisma.camera.update({
      where: { id },
      data: {
        isActive: true,
        updatedAt: new Date(),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Heartbeat failed' }, { status: 500 });
  }
}