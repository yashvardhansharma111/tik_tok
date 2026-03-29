/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";

/** Always 200: `{ user: null }` when not signed in (no 401 spam in DevTools). TikTok accounts in Mongo are a separate shared pool. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ user: null });
  }
  await connectDB();
  return NextResponse.json({
    user: {
      email: (user as any).email,
      role: (user as any).role,
      status: (user as any).status,
      emailVerified: (user as any).emailVerified,
    },
  });
}
