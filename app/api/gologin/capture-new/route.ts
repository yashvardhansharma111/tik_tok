import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { countAccountsForUser, userHasAccountAccess } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import { loginAndCaptureSession } from "@/automation/loginAndCaptureSession";

// Manual login can take up to 10 minutes
export const maxDuration = 300;

/**
 * POST /api/gologin/capture-new
 *
 * Create a brand-new TikTok account via GoLogin. Unlike /api/gologin/capture
 * (which requires an existing accountId), this endpoint creates the legacy
 * Account placeholder on the fly and then runs the GoLogin capture against
 * its new _id.
 *
 * Body: { username: string }
 *
 * Preconditions:
 *   - GoLogin profile for this account is already running with --remote-debugging-port=9222
 *
 * Flow:
 *   1. Auth check
 *   2. Check if username already exists in the legacy Account collection:
 *        - If yes and user owns it: use that _id (re-capture)
 *        - If yes and user doesn't own it: 403
 *        - If no: check account limit, create a minimal placeholder, use new _id
 *   3. Call loginAndCaptureSession(_id, { tiktokUsername: username })
 *   4. Return the captured summary (including the new accountId)
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";

  if (!username) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }

  try {
    await connectDB();

    const ownerId = (user as { _id: unknown })._id as mongoose.Types.ObjectId;
    const isAdmin = (user as { role?: string }).role === "admin";

    // Step 1: find-or-create the legacy Account placeholder
    const existing = await AccountModel.findOne({ username }).lean();
    let accountId: string;

    if (existing) {
      if (!isAdmin && !userHasAccountAccess(
        existing as { ownerId?: unknown; ownerIds?: unknown },
        ownerId
      )) {
        return NextResponse.json(
          { error: "This TikTok username is linked to other users. Ask an admin to add you as a co-owner." },
          { status: 403 }
        );
      }
      accountId = String((existing as { _id: unknown })._id);
    } else {
      // Enforce user-level account limit before creating anything
      const u = await UserModel.findById(ownerId).select({ maxLinkedAccounts: 1 }).lean();
      const max = (u as { maxLinkedAccounts?: number | null } | null)?.maxLinkedAccounts ?? null;
      const count = await countAccountsForUser(AccountModel, ownerId);
      if (max != null && count >= max) {
        return NextResponse.json(
          { error: `Account limit reached (${max}). Remove an account or ask an admin to raise your limit.` },
          { status: 403 }
        );
      }

      // Create a minimal placeholder in the legacy collection via the raw collection
      // (bypassing mongoose validation). Stub session = valid empty Playwright
      // storageState JSON so /api/accounts reports hasSession:true and the upload
      // selector enables this account. Real session lives in gologin_accounts.
      const now = new Date();
      const insertRes = await AccountModel.collection.insertOne({
        username,
        ownerId,
        ownerIds: [ownerId],
        session: '{"cookies":[],"origins":[]}',
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      accountId = String(insertRes.insertedId);
    }

    // Step 2: rate limit check (same as /api/gologin/capture)
    const cooldownMs = Math.max(0, Number(process.env.GOLOGIN_CAPTURE_COOLDOWN_MS || 30_000));
    if (cooldownMs > 0) {
      const collectionName = process.env.GOLOGIN_ACCOUNTS_COLLECTION || "gologin_accounts";
      const existingGoLogin = await mongoose.connection
        .collection(collectionName)
        .findOne({ accountId });
      const lastCapturedAt = (existingGoLogin as { lastCapturedAt?: Date } | null)?.lastCapturedAt;
      if (lastCapturedAt) {
        const ageMs = Date.now() - new Date(lastCapturedAt).getTime();
        if (ageMs < cooldownMs) {
          const remainSec = Math.ceil((cooldownMs - ageMs) / 1000);
          return NextResponse.json(
            {
              error: `Please wait ${remainSec}s before re-capturing this account`,
              hint: "A capture was run very recently for this username.",
            },
            { status: 429 }
          );
        }
      }
    }

    // Step 3: run the GoLogin capture
    const doc = await loginAndCaptureSession(accountId, {
      tiktokUsername: username,
    });

    return NextResponse.json({
      ok: true,
      accountId: doc.accountId,
      username: doc.username,
      proxyHost: `${doc.proxy.host}:${doc.proxy.port}`,
      proxyUsername: doc.proxy.username,
      cookieCount: doc.session.cookies.length,
      capturedAt: doc.updatedAt,
      created: !existing,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Capture failed";
    console.error("[gologin/capture-new] failed", e);

    let hint =
      "Ensure your GoLogin profile for this account is running with --remote-debugging-port=9222 before clicking. " +
      "Complete login manually in the GoLogin window when TikTok opens.";
    if (/Cannot connect to GoLogin/i.test(msg) || /ECONNREFUSED/i.test(msg)) {
      hint =
        "GoLogin is not reachable on the configured CDP port. Start your profile with remote debugging enabled, " +
        "or set GOLOGIN_CDP_ENDPOINT in .env if you use a different port.";
    } else if (/no contexts/i.test(msg)) {
      hint = "GoLogin exposed no browser contexts. Open at least one tab in the profile and retry.";
    } else if (/Login not completed/i.test(msg)) {
      hint = "Login window timed out. Complete login faster, or increase the timeout.";
    } else if (/Wrong GoLogin profile/i.test(msg)) {
      hint = "The GoLogin profile you have open belongs to a different TikTok account. Close it and open the correct profile.";
    } else if (/Proxy country mismatch/i.test(msg)) {
      hint = "GoLogin is routing through the wrong country. Fix the profile's proxy setting or set GOLOGIN_SKIP_COUNTRY_CHECK=1 in .env.";
    } else if (/MONGODB_URI/i.test(msg)) {
      hint = "MongoDB is not configured. Set MONGODB_URI in .env.";
    } else if (/PROXY_/i.test(msg)) {
      hint = "Proxy env vars missing. Set PROXY_HOST, PROXY_PORT, PROXY_BASE_USERNAME, PROXY_BASE_PASSWORD in .env.";
    }

    return NextResponse.json({ error: msg, hint }, { status: 500 });
  }
}
