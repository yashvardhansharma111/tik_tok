import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { userHasAccountAccess } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { loginAndCaptureSession } from "@/automation/loginAndCaptureSession";

// Manual login can take up to 10 minutes (captcha, 2FA, etc.)
// Vercel caps this at 300s — for longer waits, host locally or deploy with a server runtime.
export const maxDuration = 300;

/**
 * POST /api/gologin/capture
 *
 * Body: { accountId: string }  — MongoDB _id of an existing Account doc
 *
 * Preconditions:
 *   - GoLogin profile for this account is already running with --remote-debugging-port=9222
 *     (or the port configured in GOLOGIN_CDP_ENDPOINT)
 *
 * Flow:
 *   1. Auth check (JWT cookie)
 *   2. Look up the legacy Account doc to get username + verify ownership
 *   3. Call loginAndCaptureSession(accountId, { tiktokUsername })
 *      - attaches via CDP
 *      - opens TikTok login
 *      - waits for manual login
 *      - saves to gologin_accounts collection
 *   4. Return captured summary
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }
  if (!mongoose.Types.ObjectId.isValid(accountId)) {
    return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  }

  try {
    await connectDB();

    const ownerId = (user as { _id: unknown })._id as mongoose.Types.ObjectId;
    const isAdmin = (user as { role?: string }).role === "admin";

    const legacyAccount = await AccountModel.findById(accountId).lean();
    if (!legacyAccount) {
      return NextResponse.json(
        { error: "Account not found. Create it via Capture or Import first." },
        { status: 404 }
      );
    }
    if (!isAdmin && !userHasAccountAccess(legacyAccount as { ownerId?: unknown; ownerIds?: unknown }, ownerId)) {
      return NextResponse.json({ error: "Not your account" }, { status: 403 });
    }

    const tiktokUsername = (legacyAccount as { username?: string }).username || "";
    if (!tiktokUsername) {
      return NextResponse.json({ error: "Account has no username" }, { status: 400 });
    }

    // Issue 5: backend rate limit — 30s cooldown per account.
    // Prevents button-spam + duplicate concurrent captures across browser tabs.
    const cooldownMs = Math.max(0, Number(process.env.GOLOGIN_CAPTURE_COOLDOWN_MS || 30_000));
    if (cooldownMs > 0) {
      const collectionName = process.env.GOLOGIN_ACCOUNTS_COLLECTION || "gologin_accounts";
      const existing = await mongoose.connection
        .collection(collectionName)
        .findOne({ accountId });
      const lastCapturedAt = (existing as { lastCapturedAt?: Date } | null)?.lastCapturedAt;
      if (lastCapturedAt) {
        const ageMs = Date.now() - new Date(lastCapturedAt).getTime();
        if (ageMs < cooldownMs) {
          const remainSec = Math.ceil((cooldownMs - ageMs) / 1000);
          return NextResponse.json(
            {
              error: `Please wait ${remainSec}s before re-capturing this account`,
              hint: "A capture was run very recently. The upload runner only needs one fresh session.",
            },
            { status: 429 }
          );
        }
      }
    }

    // Run the full capture. This blocks until the user completes login or hits timeout.
    // All proxy / session / mongo logic lives in the automation module — this route
    // is just a thin HTTP shell around it.
    const doc = await loginAndCaptureSession(accountId, {
      tiktokUsername,
    });

    return NextResponse.json({
      ok: true,
      accountId: doc.accountId,
      username: doc.username,
      proxyHost: `${doc.proxy.host}:${doc.proxy.port}`,
      proxyUsername: doc.proxy.username,
      cookieCount: doc.session.cookies.length,
      capturedAt: doc.updatedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Capture failed";
    console.error("[gologin/capture] failed", e);

    // Build a targeted hint based on the error signature
    let hint =
      "Ensure your GoLogin profile is running with --remote-debugging-port=9222 before clicking capture. " +
      "Complete login manually in the GoLogin window when TikTok opens.";
    if (/Cannot connect to GoLogin/i.test(msg) || /ECONNREFUSED/i.test(msg)) {
      hint =
        "GoLogin is not reachable on the configured CDP port. Start your profile with remote debugging enabled, " +
        "or set GOLOGIN_CDP_ENDPOINT in .env if you use a different port.";
    } else if (/no contexts/i.test(msg)) {
      hint = "GoLogin exposed no browser contexts. Open at least one tab in the profile and retry.";
    } else if (/Login not completed/i.test(msg)) {
      hint = "Login window timed out. Increase GOLOGIN_LOGIN_TIMEOUT_MS or try again.";
    } else if (/MONGODB_URI/i.test(msg)) {
      hint = "MongoDB is not configured. Set MONGODB_URI in .env.";
    } else if (/PROXY_/i.test(msg)) {
      hint = "Proxy env vars missing. Set PROXY_HOST, PROXY_PORT, PROXY_BASE_USERNAME, PROXY_BASE_PASSWORD in .env.";
    }

    return NextResponse.json({ error: msg, hint }, { status: 500 });
  }
}
