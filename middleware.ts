import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const PUBLIC_PATHS = ["/login", "/signup"];

async function verify(request: NextRequest) {
  const token = request.cookies.get("auth_token")?.value;
  if (!token) return null;
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET || "");
    const { payload } = await jwtVerify(token, secret);
    return payload as { role?: string; email?: string; userId?: string };
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) return NextResponse.next();

  const isApi = pathname.startsWith("/api/");
  const isAuthApi = pathname.startsWith("/api/auth/");
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p);

  const user = await verify(request);

  if (!user && !isPublic && !isAuthApi) {
    if (isApi) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (user && isPublic) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    if (!user || user.role !== "admin") {
      if (isApi) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/(.*)"],
};
