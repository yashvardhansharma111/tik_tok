import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/db";
import { getCurrentUser } from "@/lib/currentUser";
import { userHasAccountAccess } from "@/lib/accountAccess";
import { AccountModel } from "@/lib/models/Account";
import {
  buildStickyProxy,
  saveAccountSession,
  type AccountDoc,
  type SessionCookie,
} from "@/automation/loginAndCaptureSession";

/**
 * POST /api/gologin/import
 *
 * Body: { accountId: string, cookiesJson: string }
 *
 * Parses Cookie-Editor JSON export (captured from a GoLogin profile after manual
 * TikTok login), converts to Playwright storageState format, and upserts into
 * gologin_accounts — same target collection the CDP-based capture writes to.
 *
 * The sticky proxy is recomputed from the accountId so it exactly matches
 * what the user pasted into GoLogin when they ran /api/gologin/new-placeholder.
 */

/**
 * Parse Cookie-Editor JSON export format into Playwright cookie shape.
 *
 * Cookie-Editor format (per cookie):
 *   { domain, name, value, path, expirationDate, httpOnly, secure,
 *     sameSite: "no_restriction"|"lax"|"strict"|"unspecified", session: bool }
 *
 * Gotchas this parser handles:
 *   - `sameSite: "None"` REQUIRES `secure: true` in modern Chromium; otherwise
 *     Playwright silently drops the cookie. If we see None + !secure, we
 *     upgrade secure to true (matches real browser behavior).
 *   - Cookies without `domain` are invalid for Playwright storageState and
 *     are dropped (with a warning).
 *   - Cookies without a `name` are skipped.
 *   - `expirationDate` is Unix epoch SECONDS (from chrome.cookies API).
 *     Playwright uses the same — we Math.floor to int. session:true → -1.
 */
type ParseResult = {
  cookies: SessionCookie[];
  dropped: { reason: string; name: string }[];
};

function parseCookieEditorJson(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Invalid JSON — paste the output from Cookie-Editor's Export → JSON"
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Expected a JSON array of cookies (Cookie-Editor format)");
  }

  const cookies: SessionCookie[] = [];
  const dropped: { reason: string; name: string }[] = [];

  for (const rawCookie of parsed) {
    if (!rawCookie || typeof rawCookie !== "object") continue;
    const c = rawCookie as Record<string, unknown>;

    const name = typeof c.name === "string" ? c.name : "";
    const value = typeof c.value === "string" ? c.value : "";
    if (!name) {
      dropped.push({ reason: "no name", name: "(unnamed)" });
      continue;
    }

    const domain = typeof c.domain === "string" ? c.domain : "";
    if (!domain) {
      dropped.push({ reason: "no domain", name });
      continue;
    }

    // sameSite mapping (Cookie-Editor uses "no_restriction" for None)
    let sameSite: "Strict" | "Lax" | "None" = "Lax";
    const ss = String(c.sameSite || "").toLowerCase();
    if (ss === "no_restriction" || ss === "none") sameSite = "None";
    else if (ss === "strict") sameSite = "Strict";
    else if (ss === "lax") sameSite = "Lax";

    // expires: float seconds → int seconds; session cookies → -1
    let expires: number;
    if (c.session === true || c.expirationDate == null) {
      expires = -1;
    } else {
      const n = Math.floor(Number(c.expirationDate));
      expires = Number.isFinite(n) ? n : -1;
    }

    // sameSite:None + !secure is invalid in modern Chromium (silent drop).
    // The cookie WAS secure when the browser received it — Cookie-Editor's
    // export sometimes misses the flag. Upgrade to secure to preserve it.
    let secure = Boolean(c.secure);
    if (sameSite === "None" && !secure) {
      secure = true;
    }

    cookies.push({
      name,
      value,
      domain,
      path: typeof c.path === "string" ? c.path : "/",
      expires,
      httpOnly: Boolean(c.httpOnly),
      secure,
      sameSite,
    });
  }
  return { cookies, dropped };
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const cookiesJson = typeof body.cookiesJson === "string" ? body.cookiesJson : "";

  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }
  if (!mongoose.Types.ObjectId.isValid(accountId)) {
    return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  }
  if (!cookiesJson.trim()) {
    return NextResponse.json({ error: "cookiesJson is required" }, { status: 400 });
  }

  try {
    await connectDB();
    const ownerId = (user as { _id: unknown })._id as mongoose.Types.ObjectId;
    const isAdmin = (user as { role?: string }).role === "admin";

    // Verify the placeholder account exists and belongs to the user
    const legacyAccount = await AccountModel.findById(accountId).lean();
    if (!legacyAccount) {
      return NextResponse.json(
        {
          error:
            "Account not found. Click 'Generate GoLogin proxy' first to create a placeholder.",
        },
        { status: 404 }
      );
    }
    if (
      !isAdmin &&
      !userHasAccountAccess(
        legacyAccount as { ownerId?: unknown; ownerIds?: unknown },
        ownerId
      )
    ) {
      return NextResponse.json({ error: "Not your account" }, { status: 403 });
    }

    const tiktokUsername = (legacyAccount as { username?: string }).username || "";
    if (!tiktokUsername) {
      return NextResponse.json({ error: "Account has no username" }, { status: 400 });
    }

    // Parse cookies
    let parseResult: ParseResult;
    try {
      parseResult = parseCookieEditorJson(cookiesJson);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Parse failed" },
        { status: 400 }
      );
    }

    const { cookies: allCookies, dropped } = parseResult;
    if (dropped.length > 0) {
      console.warn("[gologin/import] dropped cookies during parse", { dropped });
    }

    const tiktokCookies = allCookies.filter((c) =>
      (c.domain || "").includes("tiktok.com")
    );
    if (tiktokCookies.length === 0) {
      return NextResponse.json(
        {
          error:
            "No tiktok.com cookies in the pasted JSON. Open tiktok.com, log in, then re-export from Cookie-Editor.",
        },
        { status: 400 }
      );
    }

    // Log exactly what's being saved, so we can debug session-not-recognized issues.
    // For each auth cookie, show the full flag set — that's where most issues hide.
    const authCookieSummary = tiktokCookies
      .filter((c) => ["sessionid", "sessionid_ss", "sid_tt", "uid_tt", "tt_csrf_token"].includes(c.name))
      .map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        expires: c.expires,
        valueLen: (c.value || "").length,
      }));
    console.log("[gologin/import] auth cookies being saved", {
      accountId,
      totalCount: tiktokCookies.length,
      authCookies: authCookieSummary,
    });

    // Validate presence of at least one auth cookie
    const names = new Set(tiktokCookies.map((c) => c.name));
    const authCookies = ["sessionid", "sessionid_ss", "sid_tt", "uid_tt"];
    const hasAuth = authCookies.some((n) => names.has(n));
    if (!hasAuth) {
      return NextResponse.json(
        {
          error:
            "Pasted cookies don't include TikTok auth cookies (sessionid / sid_tt). Log in first, then re-export.",
          hint: "You must be logged in to tiktok.com in the GoLogin window before clicking Cookie-Editor → Export.",
        },
        { status: 400 }
      );
    }

    // Build sticky proxy from env (same formula as new-placeholder)
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
            "Proxy env vars missing. Set PROXY_HOST, PROXY_PORT, PROXY_BASE_USERNAME, PROXY_BASE_PASSWORD.",
        },
        { status: 500 }
      );
    }
    const port = Number(portStr);
    if (!Number.isFinite(port) || port <= 0) {
      return NextResponse.json({ error: `Invalid PROXY_PORT: ${portStr}` }, { status: 500 });
    }
    const proxy = buildStickyProxy({ host, port, baseUsername, basePassword }, accountId);

    // Build AccountDoc shape (uses cookies-only storageState — localStorage not
    // required for TikTok auth to work)
    const now = new Date();
    const doc: AccountDoc = {
      accountId,
      username: tiktokUsername,
      proxy,
      session: {
        cookies: tiktokCookies,
        storageState: {
          cookies: tiktokCookies,
          origins: [],
        },
      },
      status: "active",
      lastCapturedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await saveAccountSession(doc);

    // Ensure the legacy Account placeholder reports hasSession:true in /api/accounts
    // (the aggregation checks for a non-empty `session` string). If the placeholder
    // was created with session:"" before today's fix, upgrade it to a valid empty
    // storageState stub so the upload selector enables this account. Never overwrite
    // an already-populated legacy session (that would be a real captured session).
    const legacySession = (legacyAccount as { session?: string }).session || "";
    if (!legacySession.trim()) {
      await AccountModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(accountId) },
        {
          $set: {
            session: '{"cookies":[],"origins":[]}',
            status: "active",
            updatedAt: new Date(),
          },
        }
      );
    }

    return NextResponse.json({
      ok: true,
      accountId,
      username: tiktokUsername,
      cookieCount: tiktokCookies.length,
      proxyHost: `${proxy.host}:${proxy.port}`,
      proxyUsername: proxy.username,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Import failed";
    console.error("[gologin/import] failed", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
