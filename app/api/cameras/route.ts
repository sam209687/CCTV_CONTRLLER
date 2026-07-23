import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  return NextResponse.json(
    {
      cameras: [
        {
          id: "cam-1",
          name: "Old Android Phone",
          type: "mobile",
          isActive: true,
          streamUrl: "http://192.168.1.20:8080/video",
        },
        {
          id: "cam-2",
          name: "WiFi CCTV Camera",
          type: "ip",
          isActive: false,
          streamUrl: null,
        },
      ],
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    }
  );
}

export async function OPTIONS() {
  return NextResponse.json(
    {},
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    }
  );
}
