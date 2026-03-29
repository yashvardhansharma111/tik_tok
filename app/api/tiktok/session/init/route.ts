import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/currentUser";

/**
 * Optional: legacy/telemetry. Connect TikTok modal no longer calls this — session is local-only until import.
 * Browsers do not expose tiktok.com cookies to your app; use Accounts → Import session JSON.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const source = typeof body.source === "string" ? body.source : "unknown";
  const popupClosed = Boolean(body.popupClosed);

  console.log("[tiktok/session/init]", { userId: String((user as { _id: unknown })._id), source, popupClosed });

  return NextResponse.json({
    ok: true,
    /** True only if you later add TikTok OAuth / official redirect with a code — not possible from raw popup alone. */
    sessionReceived: false,
    message:
      "Browser security prevents this site from reading TikTok cookies. To connect automation, paste Playwright storageState JSON under Accounts → Import session (export from your logged-in browser or use local capture).",
  });
}
