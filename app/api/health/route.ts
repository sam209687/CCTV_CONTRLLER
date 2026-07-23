// app/api/health/route.ts

import { prisma } from "@/lib/database";
import { NextResponse } from "next/server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods":
    "GET,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization",
};

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json(
      {
        ok: true,
        service: "cctv-camera-api",
        database: "connected",
        timestamp:
          new Date().toISOString(),
      },
      {
        headers: corsHeaders,
      },
    );
  } catch (error) {
    console.error(
      "API health check failed:",
      error,
    );

    return NextResponse.json(
      {
        ok: false,
        service: "cctv-camera-api",
        database: "disconnected",
      },
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json(
    {},
    {
      headers: corsHeaders,
    },
  );
}