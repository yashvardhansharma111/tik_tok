/**
 * GoLogin-based TikTok login + session capture.
 *
 * Attaches Playwright to an already-running GoLogin profile via CDP,
 * waits for the user to complete login manually, then extracts cookies +
 * storageState and upserts into MongoDB.
 *
 * Prerequisites:
 *   1. GoLogin profile running with --remote-debugging-port=9222
 *      (or set GOLOGIN_CDP_ENDPOINT env var to a different URL)
 *   2. Env vars:
 *        MONGODB_URI                  (required)
 *        MONGODB_DB                   (optional, default "tiktok_automation")
 *        GOLOGIN_ACCOUNTS_COLLECTION  (optional, default "accounts")
 *        GOLOGIN_CDP_ENDPOINT         (optional, default "http://localhost:9222")
 *        PROXY_HOST, PROXY_PORT       (required for CLI or default baseProxy)
 *        PROXY_BASE_USERNAME          (required for CLI or default baseProxy)
 *        PROXY_BASE_PASSWORD          (required for CLI or default baseProxy)
 *
 * Library usage:
 *   import { loginAndCaptureSession } from "./automation/loginAndCaptureSession";
 *   const doc = await loginAndCaptureSession("acc_001");
 *
 * CLI usage:
 *   npx tsx automation/loginAndCaptureSession.ts <accountId> [tiktokUsername]
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import mongoose from "mongoose";

// Mongoose's raw collection returns mongodb.Collection but importing the type from
// mongoose's transitive `mongodb` dep is brittle. Alias it via ReturnType.
type MongoCollection = ReturnType<mongoose.Connection["collection"]>;

// ---------- config ----------

const CDP_ENDPOINT = process.env.GOLOGIN_CDP_ENDPOINT || "http://localhost:9222";
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "";
const DB_NAME = process.env.MONGODB_DB || "tiktok_automation";
const COLLECTION_NAME = process.env.GOLOGIN_ACCOUNTS_COLLECTION || "gologin_accounts";

const TIKTOK_LOGIN_URL = "https://www.tiktok.com/login";
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for manual login + captcha
const POLL_INTERVAL_MS = 1500;
const POST_LOGIN_SETTLE_MS = 2500;
const DEFAULT_RETRIES = 2;

// Presence of ANY of these cookies indicates a logged-in TikTok session.
// NOTE: tt_csrf_token is NOT included — TikTok sets it on every page load
// (including /login) so it would cause false "already logged in" detection.
const TIKTOK_AUTH_COOKIES = [
  "sessionid",
  "sessionid_ss",
  "sid_tt",
  "uid_tt",
];

// ---------- types ----------

export type Proxy = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export type BaseProxy = {
  host: string;
  port: number;
  baseUsername: string;
  basePassword: string;
};

export type SessionCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
};

export type SessionPayload = {
  cookies: SessionCookie[];
  storageState: Record<string, unknown>;
};

export type AccountDoc = {
  accountId: string;
  username: string;
  proxy: Proxy;
  session: SessionPayload;
  status: "active" | "expired";
  lastCapturedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type LoginAndCaptureOptions = {
  tiktokUsername?: string;   // if omitted, extracted from logged-in page
  baseProxy?: BaseProxy;     // if omitted, read from PROXY_* env vars
  loginTimeoutMs?: number;
  retries?: number;
  /** If true, reject when a session already exists for this accountId. Default false (overwrites with warning). */
  force?: boolean;
  /** Skip proxy country verification via ipinfo. Default false (runs the check). */
  skipCountryCheck?: boolean;
};

// ---------- logging ----------

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string, extra?: Record<string, unknown>) {
  if (extra) console.log(`[gologin-capture ${ts()}] ${msg}`, extra);
  else console.log(`[gologin-capture ${ts()}] ${msg}`);
}

function warn(msg: string, extra?: Record<string, unknown>) {
  if (extra) console.warn(`[gologin-capture ${ts()}] WARN ${msg}`, extra);
  else console.warn(`[gologin-capture ${ts()}] WARN ${msg}`);
}

// ---------- proxy ----------

/**
 * Build the sticky per-account proxy username/password.
 *
 * The final username is: <base>[_country-us]_session-<accountId>
 *
 * `_country-us` is appended ONLY when the base username doesn't already contain
 * a country/region marker. Supported pre-existing markers:
 *   - _country-<cc>   (iProyal style)
 *   - _area-<CC>      (Smart Proxy style, e.g. smart-xxx_area-US)
 *   - -country-<cc>   (dash variant)
 *
 * This lets the same function work across providers without double-tagging.
 */
export function buildStickyProxy(baseProxy: BaseProxy, accountId: string): Proxy {
  if (!baseProxy.baseUsername || !baseProxy.basePassword) {
    throw new Error("buildStickyProxy: baseProxy.baseUsername and basePassword are required");
  }
  if (!baseProxy.host || !baseProxy.port) {
    throw new Error("buildStickyProxy: baseProxy.host and port are required");
  }
  if (!accountId?.trim()) {
    throw new Error("buildStickyProxy: accountId is required");
  }

  const base = baseProxy.baseUsername;
  const hasCountryMarker = /[_-](country|area)-[a-zA-Z]{2}(?:[_-]|$)/.test(base);
  const countrySegment = hasCountryMarker ? "" : "_country-us";

  return {
    host: baseProxy.host,
    port: baseProxy.port,
    username: `${base}${countrySegment}_session-${accountId.trim()}`,
    password: baseProxy.basePassword,
  };
}

export function readBaseProxyFromEnv(): BaseProxy {
  const host = (process.env.PROXY_HOST || "").trim();
  const portStr = (process.env.PROXY_PORT || "").trim();
  const baseUsername = (process.env.PROXY_BASE_USERNAME || process.env.PROXY_USERNAME || "").trim();
  const basePassword = (process.env.PROXY_BASE_PASSWORD || process.env.PROXY_PASSWORD || "").trim();

  if (!host || !portStr || !baseUsername || !basePassword) {
    throw new Error(
      "Missing proxy env vars: set PROXY_HOST, PROXY_PORT, PROXY_BASE_USERNAME, PROXY_BASE_PASSWORD"
    );
  }
  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PROXY_PORT: ${portStr}`);
  }
  return { host, port, baseUsername, basePassword };
}

// ---------- mongo ----------

let _mongoReady = false;

async function ensureMongoConnected(): Promise<void> {
  if (_mongoReady && mongoose.connection.readyState === 1) return;
  if (!MONGO_URI) {
    throw new Error("MONGODB_URI env var not set");
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
  }
  _mongoReady = true;
}

export async function getAccountsCollection(): Promise<MongoCollection> {
  await ensureMongoConnected();
  return mongoose.connection.collection(COLLECTION_NAME);
}

export async function saveAccountSession(doc: AccountDoc, force = false): Promise<void> {
  const col = await getAccountsCollection();
  const now = new Date();

  // Issue 2: warn on overwrite. If force=true, reject rather than silently overwriting.
  const existing = await col.findOne({ accountId: doc.accountId });
  if (existing) {
    const prevUsername = (existing as any).username;
    const prevCapturedAt = (existing as any).lastCapturedAt || (existing as any).updatedAt;
    if (force) {
      throw new Error(
        `Session already exists for accountId=${doc.accountId} (user: ${prevUsername}, captured: ${prevCapturedAt}). ` +
        `Pass force=false to overwrite.`
      );
    }
    warn("overwriting existing session", {
      accountId: doc.accountId,
      previousUsername: prevUsername,
      previousCapturedAt: prevCapturedAt,
      newUsername: doc.username,
    });
  }

  const result = await col.updateOne(
    { accountId: doc.accountId },
    {
      $set: {
        username: doc.username,
        proxy: doc.proxy,
        session: doc.session,
        // Issue 4: health flags
        status: "active",
        lastCapturedAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        accountId: doc.accountId,
        createdAt: now,
      },
    },
    { upsert: true }
  );
  log("mongo upsert", {
    accountId: doc.accountId,
    upserted: (result.upsertedCount ?? 0) > 0,
    modified: (result.modifiedCount ?? 0) > 0,
    matched: result.matchedCount ?? 0,
    overwrote: !!existing,
  });
}

export async function findAccount(accountId: string): Promise<AccountDoc | null> {
  const col = await getAccountsCollection();
  const doc = await col.findOne({ accountId });
  return (doc as unknown as AccountDoc) ?? null;
}

export async function closeMongo(): Promise<void> {
  if (_mongoReady || mongoose.connection.readyState !== 0) {
    try { await mongoose.disconnect(); } catch {}
    _mongoReady = false;
  }
}

// ---------- cdp connect ----------

async function connectToGoLogin(): Promise<{ browser: Browser; context: BrowserContext }> {
  log("connecting to GoLogin via CDP", { endpoint: CDP_ENDPOINT });
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot connect to GoLogin at ${CDP_ENDPOINT}. ` +
      `Ensure the profile is running with --remote-debugging-port=9222. ` +
      `Underlying error: ${msg}`
    );
  }

  const contexts = browser.contexts();
  if (contexts.length === 0) {
    try { await browser.close(); } catch {}
    throw new Error(
      "GoLogin browser exposed no contexts via CDP. Open at least one tab in the profile and retry."
    );
  }

  const context = contexts[0];
  log("cdp connected", { contexts: contexts.length, pages: context.pages().length });
  return { browser, context };
}

// ---------- login detection ----------

/**
 * Detects whether the TikTok session on this page is logged in.
 * Returns true if either:
 *   - the URL path indicates a logged-in area (/foryou, /tiktokstudio, /@username, /feed, /following, root)
 *   - OR a TikTok auth cookie (sessionid, sessionid_ss, sid_tt, uid_tt, tt_csrf_token) is present
 */
export async function detectLoginSuccess(page: Page): Promise<boolean> {
  let url = "";
  try {
    url = page.url();
  } catch {
    return false;
  }

  // URL-based signals
  if (/tiktok\.com\/(foryou|feed|following|tiktokstudio)/i.test(url)) return true;
  if (/tiktok\.com\/@[^/?#]+/i.test(url)) return true;
  if (/^https?:\/\/(www\.)?tiktok\.com\/?(\?|$)/i.test(url)) return true;

  // Cookie-based signal
  try {
    const cookies = await page.context().cookies("https://www.tiktok.com");
    const names = new Set(cookies.map((c) => c.name));
    for (const name of TIKTOK_AUTH_COOKIES) {
      if (names.has(name)) return true;
    }
  } catch {
    // ignore
  }

  return false;
}

export async function waitForManualLogin(page: Page, timeoutMs: number): Promise<void> {
  log("waiting for manual login -- complete it in the GoLogin window", { timeoutMs });
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";

  while (Date.now() < deadline) {
    if (await detectLoginSuccess(page)) {
      log("login detected", { url: safeUrl(page) });
      await page.waitForTimeout(POST_LOGIN_SETTLE_MS);
      return;
    }
    const current = safeUrl(page);
    if (current && current !== lastUrl) {
      log("page url changed", { url: current });
      lastUrl = current;
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Login not completed within ${Math.round(timeoutMs / 1000)}s. ` +
    `Complete login manually in the GoLogin window, then re-run.`
  );
}

function safeUrl(page: Page): string {
  try { return page.url(); } catch { return ""; }
}

// ---------- tiktok username extraction ----------

export async function extractTikTokUsername(page: Page): Promise<string | null> {
  // Try URL first (/@username)
  const url = safeUrl(page);
  const urlMatch = url.match(/tiktok\.com\/@([^/?#]+)/i);
  if (urlMatch) return urlMatch[1];

  // Try profile link in DOM
  try {
    const href = await page.locator('a[href^="/@"]').first().getAttribute("href", { timeout: 3000 });
    if (href) {
      const m = href.match(/^\/@([^/?#]+)/);
      if (m) return m[1];
    }
  } catch {
    // ignore
  }

  // Try data-e2e selectors
  try {
    const el = page.locator('[data-e2e="nav-profile"], [data-e2e="profile-username"]').first();
    const text = await el.textContent({ timeout: 2000 });
    if (text) {
      const cleaned = text.replace(/^@/, "").trim();
      if (cleaned) return cleaned;
    }
  } catch {
    // ignore
  }

  return null;
}

// ---------- proxy country verification (Issue 3) ----------

/**
 * Extract the expected country code from the proxy username. Matches:
 *   _country-us_ / -country-us- / ... (iProyal style)
 *   _area-US_    / -area-US-    / ... (Smart Proxy style)
 * Returns "CC" uppercase, or null if no country segment is present.
 */
export function extractExpectedCountry(proxyUsername: string): string | null {
  const m = proxyUsername.match(/[_-](?:country|area)-([a-zA-Z]{2})(?:[_-]|$)/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Run inside the logged-in page via page.evaluate(fetch(...)). Because the fetch
 * runs in the browser context, it goes through the same proxy the browser uses.
 * Returns the detected country code and exit IP, or null on failure.
 */
export async function verifyProxyCountryInPage(
  page: Page
): Promise<{ country: string | null; ip: string | null }> {
  try {
    // Use ipinfo.io — reliable, returns { country: "US", ip: "..." }.
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch("https://ipinfo.io/json", { method: "GET" });
        if (!res.ok) return null;
        const j = (await res.json()) as { country?: string; ip?: string };
        return { country: j.country || null, ip: j.ip || null };
      } catch {
        return null;
      }
    });
    if (!result) return { country: null, ip: null };
    return { country: result.country, ip: result.ip };
  } catch {
    return { country: null, ip: null };
  }
}

// ---------- session extraction ----------

export async function extractSession(context: BrowserContext): Promise<SessionPayload> {
  const allCookies = await context.cookies();
  const tiktokCookies = allCookies.filter((c) => (c.domain || "").includes("tiktok.com"));

  // storageState includes cookies + origin-scoped localStorage
  const storageState = (await context.storageState()) as unknown as Record<string, unknown>;

  log("extracted session", {
    totalCookies: allCookies.length,
    tiktokCookies: tiktokCookies.length,
  });

  return { cookies: tiktokCookies as SessionCookie[], storageState };
}

// ---------- main entry ----------

/**
 * Attach to a running GoLogin profile, wait for manual TikTok login,
 * capture the session, and persist to MongoDB.
 *
 * @param accountId Logical account identifier (used as the sticky-session key and mongo key)
 * @param options   Optional overrides (tiktokUsername, baseProxy, timeouts, retries)
 * @returns         The saved AccountDoc
 */
export async function loginAndCaptureSession(
  accountId: string,
  options: LoginAndCaptureOptions = {}
): Promise<AccountDoc> {
  if (!accountId?.trim()) throw new Error("accountId is required");

  const baseProxy = options.baseProxy ?? readBaseProxyFromEnv();
  const proxy = buildStickyProxy(baseProxy, accountId);
  const retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  const loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  log("starting", {
    accountId,
    proxyHost: `${proxy.host}:${proxy.port}`,
    proxyUsername: proxy.username,
    retries,
    loginTimeoutMs,
  });

  let lastErr: Error | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    log("attempt", { attempt, total: retries });
    let browser: Browser | undefined;

    try {
      const conn = await connectToGoLogin();
      browser = conn.browser;
      const context = conn.context;

      // Use the currently-focused tab if available, else open a new one
      const existingPages = context.pages();
      const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();

      log("navigating to tiktok login");
      try {
        await page.goto(TIKTOK_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } catch (navErr) {
        // Maybe proxy blocked this nav, or the user is already logged in and redirected.
        warn("initial navigation warning (continuing)", {
          error: (navErr as Error).message,
          url: safeUrl(page),
        });
      }

      // If already logged in (stale session), short-circuit the wait
      if (await detectLoginSuccess(page)) {
        log("already logged in -- skipping manual wait");
      } else {
        await waitForManualLogin(page, loginTimeoutMs);
      }

      // ----- Issue 3: proxy country check (fails the capture on mismatch) -----
      const skipCountryCheck =
        options.skipCountryCheck === true ||
        process.env.GOLOGIN_SKIP_COUNTRY_CHECK === "1" ||
        process.env.GOLOGIN_SKIP_COUNTRY_CHECK === "true";

      if (!skipCountryCheck) {
        const expectedCountry = extractExpectedCountry(proxy.username);
        if (expectedCountry) {
          const { country: actualCountry, ip } = await verifyProxyCountryInPage(page);
          if (!actualCountry) {
            warn("could not verify proxy country (ipinfo unreachable) -- continuing", {
              expectedCountry,
            });
          } else if (actualCountry.toUpperCase() !== expectedCountry) {
            throw new Error(
              `Proxy country mismatch: expected ${expectedCountry}, actual ${actualCountry} (ip: ${ip}). ` +
              `The GoLogin profile is not routing through the expected proxy. ` +
              `Fix the profile's proxy setting or set GOLOGIN_SKIP_COUNTRY_CHECK=1 to bypass.`
            );
          } else {
            log("proxy country verified", { country: actualCountry, ip });
          }
        } else {
          warn("proxy username has no _country- segment, skipping country check", {
            proxyUsername: proxy.username,
          });
        }
      }

      // Extract session
      const session = await extractSession(context);
      if (session.cookies.length === 0) {
        throw new Error("session extraction produced zero tiktok.com cookies");
      }

      // Resolve tiktok username (from page)
      const extractedUsername = await extractTikTokUsername(page);
      let tiktokUsername = options.tiktokUsername?.trim() || "";

      // ----- Issue 1: profile mismatch detection -----
      // If caller provided an expected username AND we extracted one from the page,
      // they must match. Otherwise we attached to the wrong GoLogin profile.
      if (tiktokUsername && extractedUsername) {
        const expected = tiktokUsername.toLowerCase().replace(/^@/, "");
        const actual = extractedUsername.toLowerCase().replace(/^@/, "");
        if (expected !== actual) {
          throw new Error(
            `Wrong GoLogin profile attached: expected TikTok user "${tiktokUsername}", ` +
            `but the logged-in account is "${extractedUsername}". ` +
            `Close the wrong profile and run the correct one with --remote-debugging-port=9222.`
          );
        }
        log("username match verified", { tiktokUsername });
      }

      if (!tiktokUsername) {
        if (extractedUsername) {
          tiktokUsername = extractedUsername;
          log("extracted tiktok username", { tiktokUsername });
        } else {
          warn("could not extract tiktok username from page; falling back to accountId");
          tiktokUsername = accountId;
        }
      }

      const now = new Date();
      const doc: AccountDoc = {
        accountId,
        username: tiktokUsername,
        proxy,
        session,
        status: "active",
        lastCapturedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      await saveAccountSession(doc, options.force === true);

      log("success", {
        accountId,
        tiktokUsername,
        cookieCount: session.cookies.length,
      });
      return doc;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      warn("attempt failed", { attempt, error: lastErr.message });
      if (attempt >= retries) break;
      log("retrying in 2s");
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      // Disconnect the CDP reference without killing the underlying GoLogin process.
      // For CDP connections, browser.close() disconnects Playwright but leaves the target browser running.
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  }

  throw lastErr ?? new Error("loginAndCaptureSession failed for an unknown reason");
}

// ---------- CLI ----------

async function cli() {
  const [, , accountIdArg, tiktokUsernameArg] = process.argv;

  if (!accountIdArg) {
    console.error("Usage: npx tsx automation/loginAndCaptureSession.ts <accountId> [tiktokUsername]");
    console.error("");
    console.error("Required env:");
    console.error("  MONGODB_URI");
    console.error("  PROXY_HOST, PROXY_PORT, PROXY_BASE_USERNAME, PROXY_BASE_PASSWORD");
    console.error("Optional env:");
    console.error("  MONGODB_DB (default: tiktok_automation)");
    console.error("  GOLOGIN_ACCOUNTS_COLLECTION (default: accounts)");
    console.error("  GOLOGIN_CDP_ENDPOINT (default: http://localhost:9222)");
    process.exit(1);
  }

  const shutdown = async () => {
    try { await closeMongo(); } catch {}
  };
  process.on("SIGINT", async () => {
    console.warn("\n[gologin-capture] SIGINT -- shutting down");
    await shutdown();
    process.exit(130);
  });

  try {
    const doc = await loginAndCaptureSession(accountIdArg, {
      tiktokUsername: tiktokUsernameArg,
    });
    console.log("");
    console.log("SUCCESS");
    console.log("  accountId      :", doc.accountId);
    console.log("  tiktokUsername :", doc.username);
    console.log("  proxy          :", `${doc.proxy.host}:${doc.proxy.port}`);
    console.log("  proxyUsername  :", doc.proxy.username);
    console.log("  cookies        :", doc.session.cookies.length);
    console.log("  storageState   :", Object.keys(doc.session.storageState).join(", ") || "(empty)");
    await shutdown();
    process.exit(0);
  } catch (e) {
    console.error("");
    console.error("FAILED:", e instanceof Error ? e.message : e);
    await shutdown();
    process.exit(1);
  }
}

// Run CLI only when file is executed directly (not when imported)
const invokedPath = process.argv[1] || "";
if (invokedPath.endsWith("loginAndCaptureSession.ts") || invokedPath.endsWith("loginAndCaptureSession.js")) {
  cli();
}
