import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { countAccountsForUser, userHasAccountAccess } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import { UserModel } from "@/lib/models/User";
import { buildStickyProxy } from "@/automation/loginAndCaptureSession";

/**
 * POST /api/gologin/new-placeholder
 *
 * Body: { username: string }
 *
 * Creates (or reuses) a legacy Account placeholder for this username and returns
 * the sticky proxy credentials derived from that account's MongoDB _id.
 *
 * The user copies the returned strings into a new GoLogin profile:
 *   - Profile name:    <accountId>
 *   - Proxy host:      <proxy.host>
 *   - Proxy port:      <proxy.port>
 *   - Proxy username:  <proxy.username>  (sticky per account)
 *   - Proxy password:  <proxy.password>
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

    // Find existing or create new placeholder
    const existing = await AccountModel.findOne({ username }).lean();
    let accountId: string;

    if (existing) {
      if (
        !isAdmin &&
        !userHasAccountAccess(
          existing as { ownerId?: unknown; ownerIds?: unknown },
          ownerId
        )
      ) {
        return NextResponse.json(
          {
            error:
              "This TikTok username is linked to other users. Ask an admin to add you as a co-owner.",
          },
          { status: 403 }
        );
      }
      accountId = String((existing as { _id: unknown })._id);
    } else {
      // Enforce per-user account limit before creating anything
      const u = await UserModel.findById(ownerId).select({ maxLinkedAccounts: 1 }).lean();
      const max =
        (u as { maxLinkedAccounts?: number | null } | null)?.maxLinkedAccounts ?? null;
      const count = await countAccountsForUser(AccountModel, ownerId);
      if (max != null && count >= max) {
        return NextResponse.json(
          {
            error: `Account limit reached (${max}). Remove an account or ask an admin to raise your limit.`,
          },
          { status: 403 }
        );
      }

      // Bypass mongoose validation via the raw collection. For gologin-flow placeholders
      // the real session lives in gologin_accounts. We store a valid *empty* Playwright
      // storageState JSON here so:
      //   - the /api/accounts aggregation reports hasSession: true (upload selector enabled)
      //   - if the runner ever falls back to this record (gologin_accounts missing),
      //     Playwright accepts the empty storageState and fails cleanly with SESSION_EXPIRED
      //     instead of crashing.
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

    // Build sticky proxy from env vars (same logic as loginAndCaptureSession)
    const host = (process.env.PROXY_HOST || "").trim();
    const portStr = (process.env.PROXY_PORT || "").trim();
    const baseUsername = (
      process.env.PROXY_BASE_USERNAME || process.env.PROXY_USERNAME || ""
    ).trim();
    const basePassword = (
      process.env.PROXY_BASE_PASSWORD || process.env.PROXY_PASSWORD || ""
    ).trim();

    if (!host || !portStr || !baseUsername || !basePassword) {
      return NextResponse.json(
        {
          error:
            "Proxy env vars missing. Set PROXY_HOST, PROXY_PORT, PROXY_BASE_USERNAME, PROXY_BASE_PASSWORD in .env.",
        },
        { status: 500 }
      );
    }
    const port = Number(portStr);
    if (!Number.isFinite(port) || port <= 0) {
      return NextResponse.json({ error: `Invalid PROXY_PORT: ${portStr}` }, { status: 500 });
    }

    const proxy = buildStickyProxy({ host, port, baseUsername, basePassword }, accountId);

    return NextResponse.json({
      ok: true,
      accountId,
      username,
      created: !existing,
      proxy: {
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[gologin/new-placeholder] failed", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
