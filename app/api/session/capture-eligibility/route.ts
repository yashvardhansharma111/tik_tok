import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";

function parseTruthy(v: string | undefined): boolean {
  if (v === undefined || v === "") return false;
  const s = v.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

/**
 * Playwright capture runs on the same machine as the Next.js server (opens Chromium, saves session to DB).
 * Disabled only when DISABLE_INTERACTIVE_SESSION_CAPTURE=true.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const interactiveAllowed = !parseTruthy(process.env.DISABLE_INTERACTIVE_SESSION_CAPTURE);

  return NextResponse.json({ interactiveAllowed });
}
