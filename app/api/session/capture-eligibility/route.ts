import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";

function parseTruthy(v: string | undefined): boolean {
  if (v === undefined || v === "") return false;
  const s = v.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

/**
 * Interactive Playwright capture should run on a dev machine with a display — not on a headless VPS.
 * Override production block with ALLOW_INTERACTIVE_SESSION_CAPTURE=true (e.g. xvfb on server).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const interactiveAllowed =
    process.env.NODE_ENV !== "production" || parseTruthy(process.env.ALLOW_INTERACTIVE_SESSION_CAPTURE);

  return NextResponse.json({ interactiveAllowed });
}
