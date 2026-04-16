import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { countAccountsForUser, userHasAccountAccess } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import { captureViaAdsPower } from "@/automation/adspowerCapture";

// Manual login can take up to 10 minutes
export const maxDuration = 300;

/**
 * POST /api/adspower/capture
 *
 * Body: { username: string }
 *
 * One-click flow:
 *   1. Find-or-create legacy Account placeholder (for ownership + _id)
 *   2. Create AdsPower profile with sticky proxy (or reuse existing)
 *   3. Start AdsPower browser
 *   4. Connect Playwright via CDP
 *   5. Open TikTok login, wait for manual login
 *   6. Capture session natively via context.storageState()
 *   7. Save to MongoDB (adspower_accounts)
 *   8. Stop AdsPower browser
 *   9. Return summary
 *
 * The user only needs to complete the TikTok login manually. Everything else
 * is fully automated — no copy-paste, no extensions, no debugging ports.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  // Optional: pass an existing accountId to re-capture (instead of creating new)
  const existingAccountId = typeof body.accountId === "string" ? body.accountId.trim() : "";

  if (!username && !existingAccountId) {
    return NextResponse.json({ error: "username or accountId is required" }, { status: 400 });
  }

  try {
    await connectDB();
    const ownerId = (user as { _id: unknown })._id as mongoose.Types.ObjectId;
    const isAdmin = (user as { role?: string }).role === "admin";

    let accountId: string;
    let tiktokUsername = username;

    if (existingAccountId) {
      // Re-capture existing account
      if (!mongoose.Types.ObjectId.isValid(existingAccountId)) {
        return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
      }
      const existing = await AccountModel.findById(existingAccountId).lean();
      if (!existing) {
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
      if (!isAdmin && !userHasAccountAccess(
        existing as { ownerId?: unknown; ownerIds?: unknown }, ownerId
      )) {
        return NextResponse.json({ error: "Not your account" }, { status: 403 });
      }
      accountId = existingAccountId;
      tiktokUsername = tiktokUsername || (existing as { username?: string }).username || "";
    } else {
      // Find-or-create by username
      const existing = await AccountModel.findOne({ username }).lean();

      if (existing) {
        if (!isAdmin && !userHasAccountAccess(
          existing as { ownerId?: unknown; ownerIds?: unknown }, ownerId
        )) {
          return NextResponse.json(
            { error: "This username is linked to other users. Ask an admin." },
            { status: 403 }
          );
        }
        accountId = String((existing as { _id: unknown })._id);
      } else {
        // Account limit check
        const u = await UserModel.findById(ownerId).select({ maxLinkedAccounts: 1 }).lean();
        const max = (u as { maxLinkedAccounts?: number | null } | null)?.maxLinkedAccounts ?? null;
        const count = await countAccountsForUser(AccountModel, ownerId);
        if (max != null && count >= max) {
          return NextResponse.json(
            { error: `Account limit reached (${max}).` },
            { status: 403 }
          );
        }

        // Create placeholder (bypass mongoose validation — session:"" is empty)
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
    }

    if (!tiktokUsername) {
      return NextResponse.json({ error: "Could not determine username" }, { status: 400 });
    }

    // Rate limit: 30s cooldown per account
    const cooldownMs = Math.max(0, Number(process.env.CAPTURE_COOLDOWN_MS || 30_000));
    if (cooldownMs > 0) {
      const collectionName = process.env.ADSPOWER_ACCOUNTS_COLLECTION || "adspower_accounts";
      const existingCapture = await mongoose.connection
        .collection(collectionName)
        .findOne({ accountId });
      const lastCapturedAt = (existingCapture as { lastCapturedAt?: Date } | null)?.lastCapturedAt;
      if (lastCapturedAt) {
        const ageMs = Date.now() - new Date(lastCapturedAt).getTime();
        if (ageMs < cooldownMs) {
          const remainSec = Math.ceil((cooldownMs - ageMs) / 1000);
          return NextResponse.json(
            { error: `Please wait ${remainSec}s before re-capturing this account.` },
            { status: 429 }
          );
        }
      }
    }

    // Run the full capture
    const doc = await captureViaAdsPower(accountId, {
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
      adspowerProfileId: doc.adspowerProfileId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Capture failed";
    console.error("[adspower/capture] failed", e);

    let hint =
      "Ensure AdsPower desktop is running. Complete the TikTok login manually in the browser that opens.";
    if (/AdsPower API/i.test(msg) || /ECONNREFUSED/i.test(msg) || /fetch failed/i.test(msg)) {
      hint = "AdsPower desktop is not running or not reachable. Open the AdsPower app and try again.";
    } else if (/no contexts/i.test(msg)) {
      hint = "AdsPower browser started but has no contexts. Try again.";
    } else if (/Login not completed/i.test(msg)) {
      hint = "Login timed out. Complete the TikTok login faster, or try again.";
    } else if (/Username mismatch/i.test(msg)) {
      hint = "You logged into the wrong TikTok account in the AdsPower window.";
    } else if (/Proxy country mismatch/i.test(msg)) {
      hint = "The proxy isn't routing through the expected country. Check proxy settings.";
    } else if (/PROXY_/i.test(msg)) {
      hint = "Proxy env vars missing. Set PROXY_HOST, PROXY_PORT, PROXY_BASE_USERNAME, PROXY_BASE_PASSWORD.";
    }

    return NextResponse.json({ error: msg, hint }, { status: 500 });
  }
}
