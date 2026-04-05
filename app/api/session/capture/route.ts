import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import mongoose from "mongoose";
import { getCurrentUser } from "@/lib/currentUser";
import { countAccountsForUser, userHasAccountAccess } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import { captureTikTokStorageState } from "@/automation/captureTikTokSession";

export const maxDuration = 300;

function parseTruthy(v: string | undefined): boolean {
  if (v === undefined || v === "") return false;
  const s = v.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  /** Opt-out only: set DISABLE_INTERACTIVE_SESSION_CAPTURE=true to block Playwright capture API-wide. */
  if (parseTruthy(process.env.DISABLE_INTERACTIVE_SESSION_CAPTURE)) {
    return NextResponse.json(
      {
        error:
          "Interactive session capture is disabled (DISABLE_INTERACTIVE_SESSION_CAPTURE). Use Import session or re-enable capture in .env.",
        code: "CAPTURE_DISABLED",
      },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const proxy = typeof body.proxy === "string" ? body.proxy.trim() : "";
  if (!username && !accountId) {
    return NextResponse.json({ error: "username or accountId is required" }, { status: 400 });
  }

  try {
    await connectDB();
    const ownerId = (user as { _id: unknown })._id as mongoose.Types.ObjectId;
    const isAdmin = (user as { role?: string }).role === "admin";

    if (accountId) {
      const doc = await AccountModel.findById(accountId).lean();
      if (!doc) {
        return NextResponse.json({ error: "Account not found" }, { status: 404 });
      }
      if (!isAdmin && !userHasAccountAccess(doc as { ownerId?: unknown; ownerIds?: unknown }, ownerId)) {
        return NextResponse.json({ error: "Not your account" }, { status: 403 });
      }
    } else if (username) {
      const doc = await AccountModel.findOne({ username }).lean();
      if (doc) {
        if (!isAdmin && !userHasAccountAccess(doc as { ownerId?: unknown; ownerIds?: unknown }, ownerId)) {
          return NextResponse.json(
            { error: "This TikTok username is linked to other users. Ask an admin to add you as a co-owner." },
            { status: 403 }
          );
        }
      } else {
        const u = await UserModel.findById(ownerId).select({ maxLinkedAccounts: 1 }).lean();
        const max = (u as { maxLinkedAccounts?: number | null } | null)?.maxLinkedAccounts ?? null;
        const count = await countAccountsForUser(AccountModel, ownerId);
        if (max != null && count >= max) {
          return NextResponse.json(
            {
              error: `Account limit reached (${max}). Remove an account or ask an admin to raise your limit.`,
            },
            { status: 403 }
          );
        }
      }
    }

    const sessionJson = await captureTikTokStorageState(proxy || undefined);
    const filter = accountId ? { _id: accountId } : { username };
    const update: Record<string, unknown> = {
      $set: {
        ...(username ? { username } : {}),
        session: sessionJson,
        proxy: proxy || undefined,
        status: "active",
      },
      $addToSet: { ownerIds: ownerId },
      $setOnInsert: { ownerId },
    };

    const account = await AccountModel.findOneAndUpdate(filter, update, {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    }).lean();

    return NextResponse.json({
      ok: true,
      id: String((account as { _id: unknown })._id),
      username: (account as { username: string }).username,
      hasSession: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Capture failed";
    console.error("[SessionCapture] failed", e);
    const hintBase =
      "A browser window should open. Log in fully, then navigate to For You or your profile. Keep the window open until capture completes.";
    const hintNetwork =
      /ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/i.test(
        msg
      )
        ? " Network blocked TikTok (common in India). Set PROXY_SERVER + PROXY_USERNAME + PROXY_PASSWORD in .env, or pass proxy in the Capture form."
        : "";

    return NextResponse.json(
      {
        error: msg,
        hint: `${hintBase}${hintNetwork}`,
      },
      { status: 500 }
    );
  }
}
