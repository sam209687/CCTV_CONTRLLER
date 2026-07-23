import { generateSessionToken, verifyPassword } from "@/lib/auth";
import { getUserByEmail } from "@/lib/database";
import { NextRequest, NextResponse } from "next/server";

/* ---------- CORS helper ---------- */
function applyCors(req: NextRequest, res: NextResponse) {
  const origin = req.headers.get("origin");

  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
  }

  res.headers.set(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,DELETE,OPTIONS"
  );
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.headers.set("Access-Control-Allow-Credentials", "true");

  return res;
}

/* ---------- Preflight ---------- */
export async function OPTIONS(req: NextRequest) {
  return applyCors(req, new NextResponse(null, { status: 204 }));
}

/* ---------- Login ---------- */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return applyCors(
        request,
        NextResponse.json(
          { error: "Email and password are required" },
          { status: 400 }
        )
      );
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return applyCors(
        request,
        NextResponse.json(
          { error: "Invalid email or password" },
          { status: 401 }
        )
      );
    }

    const isValidPassword = await verifyPassword(password, user.password);
    if (!isValidPassword) {
      return applyCors(
        request,
        NextResponse.json(
          { error: "Invalid email or password" },
          { status: 401 }
        )
      );
    }

    const sessionToken = generateSessionToken();
    const { password: _, ...userWithoutPassword } = user;

    return applyCors(
      request,
      NextResponse.json({
        success: true,
        message: "Login successful",
        user: userWithoutPassword,
        token: sessionToken,
      })
    );
  } catch (error) {
    console.error("Login error:", error);

    return applyCors(
      request,
      NextResponse.json(
        {
          error: "Login failed",
          details: error instanceof Error ? error.message : String(error),
        },
        { status: 500 }
      )
    );
  }
}
