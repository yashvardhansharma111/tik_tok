/**
 * AdsPower-based TikTok login + session capture.
 *
 * Fully automated flow using AdsPower's Local API:
 *   1. Creates an AdsPower profile with the account's sticky proxy
 *   2. Starts the browser, gets a CDP WebSocket URL
 *   3. Connects Playwright, opens TikTok login
 *   4. Waits for manual login (user handles captcha)
 *   5. Captures session via native context.storageState() (no extensions needed)
 *   6. Saves to MongoDB (same gologin_accounts collection the upload runner reads)
 *   7. Stops the browser
 *
 * Env:
 *   ADSPOWER_API_URL  (default http://127.0.0.1:50325)
 *   PROXY_HOST, PROXY_PORT, PROXY_BASE_USERNAME, PROXY_BASE_PASSWORD
 *   MONGODB_URI, MONGODB_DB
 *   GOLOGIN_ACCOUNTS_COLLECTION (default gologin_accounts)
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  buildStickyProxy,
  readBaseProxyFromEnv,
  detectLoginSuccess,
  waitForManualLogin,
  extractTikTokUsername,
  extractSession,
  extractExpectedCountry,
  verifyProxyCountryInPage,
  saveAccountSession,
  findAccount,
  type AccountDoc,
  type Proxy,
  type SessionPayload,
} from "./loginAndCaptureSession";

// ---------- config ----------

const ADSPOWER_BASE = () => (process.env.ADSPOWER_API_URL || "http://127.0.0.1:50325").replace(/\/+$/, "");
const TIKTOK_LOGIN_URL = "https://www.tiktok.com/login";
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RETRIES = 2;

// ---------- logging ----------

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string, extra?: Record<string, unknown>) {
  if (extra) console.log(`[adspower-capture ${ts()}] ${msg}`, extra);
  else console.log(`[adspower-capture ${ts()}] ${msg}`);
}

function warn(msg: string, extra?: Record<string, unknown>) {
  if (extra) console.warn(`[adspower-capture ${ts()}] WARN ${msg}`, extra);
  else console.warn(`[adspower-capture ${ts()}] WARN ${msg}`);
}

// ---------- AdsPower Local API client ----------

type AdsPowerCreateResult = {
  profileId: string;
  serialNumber: string;
};

type AdsPowerStartResult = {
  wsUrl: string;
  debugPort: string;
};

async function adspowerFetch(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${ADSPOWER_BASE()}${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`AdsPower API ${path} returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { code: number; msg: string; data?: unknown };
  if (body.code !== 0) {
    throw new Error(`AdsPower API ${path}: ${body.msg} (code ${body.code})`);
  }
  return body.data;
}

/**
 * Create a new AdsPower browser profile with the given proxy config.
 * Returns the profile ID and serial number.
 */
export async function createAdsPowerProfile(
  proxy: Proxy,
  profileName?: string
): Promise<AdsPowerCreateResult> {
  log("creating AdsPower profile", { profileName, proxyHost: `${proxy.host}:${proxy.port}` });

  const data = (await adspowerFetch("/api/v1/user/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      group_id: "0",
      name: profileName || undefined,
      user_proxy_config: {
        proxy_soft: "other",
        proxy_type: "http",
        proxy_host: proxy.host,
        proxy_port: String(proxy.port),
        proxy_user: proxy.username,
        proxy_password: proxy.password,
      },
    }),
  })) as { id: string; serial_number: string };

  log("profile created", { profileId: data.id, serialNumber: data.serial_number });
  return { profileId: data.id, serialNumber: data.serial_number };
}

/**
 * Update an existing AdsPower profile's proxy config.
 */
export async function updateAdsPowerProxy(
  profileId: string,
  proxy: Proxy
): Promise<void> {
  log("updating AdsPower profile proxy", { profileId });
  await adspowerFetch("/api/v1/user/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: profileId,
      user_proxy_config: {
        proxy_soft: "other",
        proxy_type: "http",
        proxy_host: proxy.host,
        proxy_port: String(proxy.port),
        proxy_user: proxy.username,
        proxy_password: proxy.password,
      },
    }),
  });
}

/**
 * Start an AdsPower browser profile. Returns the WebSocket URL for Playwright CDP.
 */
export async function startAdsPowerBrowser(profileId: string): Promise<AdsPowerStartResult> {
  log("starting AdsPower browser", { profileId });

  const data = (await adspowerFetch(
    `/api/v1/browser/start?user_id=${encodeURIComponent(profileId)}`
  )) as {
    ws: { puppeteer: string; selenium: string };
    debug_port: string;
  };

  log("browser started", { profileId, debugPort: data.debug_port });
  return { wsUrl: data.ws.puppeteer, debugPort: data.debug_port };
}

/**
 * Stop an AdsPower browser profile. Safe to call even if not running.
 */
export async function stopAdsPowerBrowser(profileId: string): Promise<void> {
  log("stopping AdsPower browser", { profileId });
  try {
    await adspowerFetch(`/api/v1/browser/stop?user_id=${encodeURIComponent(profileId)}`);
  } catch (e) {
    // Ignore — might already be stopped
    warn("stop returned error (probably already stopped)", {
      profileId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Check if a specific AdsPower browser profile is currently running.
 */
export async function isAdsPowerBrowserRunning(profileId: string): Promise<boolean> {
  try {
    const data = (await adspowerFetch(
      `/api/v1/browser/active?user_id=${encodeURIComponent(profileId)}`
    )) as { status: string };
    return data.status === "Active";
  } catch {
    return false;
  }
}

// ---------- main capture ----------

export type AdsPowerCaptureOptions = {
  tiktokUsername?: string;
  loginTimeoutMs?: number;
  retries?: number;
  skipCountryCheck?: boolean;
};

/**
 * Full one-click AdsPower capture:
 *   1. Build sticky proxy from accountId
 *   2. Create or reuse AdsPower profile
 *   3. Start browser, connect Playwright via CDP
 *   4. Navigate to TikTok login, wait for manual login
 *   5. Verify country + username
 *   6. Capture session via context.storageState()
 *   7. Save to MongoDB
 *   8. Stop browser
 *
 * @param accountId  MongoDB _id from the legacy accounts collection
 * @param options    Optional overrides
 * @returns          The saved AccountDoc (in gologin_accounts)
 */
export async function captureViaAdsPower(
  accountId: string,
  options: AdsPowerCaptureOptions = {}
): Promise<AccountDoc & { adspowerProfileId: string }> {
  if (!accountId?.trim()) throw new Error("accountId is required");

  const baseProxy = readBaseProxyFromEnv();
  const proxy = buildStickyProxy(baseProxy, accountId);
  const retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  const loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  log("starting", {
    accountId,
    proxyHost: `${proxy.host}:${proxy.port}`,
    proxyUsername: proxy.username,
    retries,
  });

  // Check if this account already has an AdsPower profile (re-capture scenario)
  let adspowerProfileId: string | null = null;
  const existingDoc = await findAccount(accountId);
  if (existingDoc) {
    adspowerProfileId = (existingDoc as unknown as { adspowerProfileId?: string }).adspowerProfileId || null;
  }

  let lastErr: Error | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    log("attempt", { attempt, total: retries });
    let browser: Browser | undefined;
    let profileId = adspowerProfileId;

    try {
      // Step 1: create or reuse AdsPower profile
      if (!profileId) {
        const created = await createAdsPowerProfile(proxy, options.tiktokUsername || accountId);
        profileId = created.profileId;
        adspowerProfileId = profileId;
      } else {
        // Ensure the proxy is up to date on the existing profile
        await updateAdsPowerProxy(profileId, proxy);
      }

      // Step 2: start the browser
      const { wsUrl } = await startAdsPowerBrowser(profileId);

      // Step 3: connect Playwright via CDP
      log("connecting Playwright via CDP", { wsUrl: wsUrl.substring(0, 60) + "..." });
      browser = await chromium.connectOverCDP(wsUrl);

      const contexts = browser.contexts();
      if (contexts.length === 0) {
        throw new Error("AdsPower browser has no contexts after start");
      }
      const context = contexts[0];
      const existingPages = context.pages();
      const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();

      // Step 4: clear stale cookies so detectLoginSuccess doesn't mistake
      // expired/leftover TikTok cookies for a valid session.
      // AdsPower's fingerprint (canvas, webgl, etc.) persists regardless.
      try {
        await context.clearCookies();
        log("cleared stale cookies for fresh login");
      } catch (e) {
        warn("could not clear cookies (continuing)", {
          error: (e as Error).message,
        });
      }

      // Step 5: navigate to TikTok login
      log("navigating to TikTok login");
      try {
        await page.goto(TIKTOK_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } catch (navErr) {
        warn("navigation warning (continuing)", {
          error: (navErr as Error).message,
          url: safeUrl(page),
        });
      }

      // Step 6: wait for manual login — always wait, never skip
      await waitForManualLogin(page, loginTimeoutMs);

      // Step 7: country check
      const skipCountryCheck =
        options.skipCountryCheck === true ||
        process.env.GOLOGIN_SKIP_COUNTRY_CHECK === "1";

      if (!skipCountryCheck) {
        const expectedCountry = extractExpectedCountry(proxy.username);
        if (expectedCountry) {
          const { country: actualCountry, ip } = await verifyProxyCountryInPage(page);
          if (!actualCountry) {
            warn("could not verify proxy country -- continuing", { expectedCountry });
          } else if (actualCountry.toUpperCase() !== expectedCountry) {
            throw new Error(
              `Proxy country mismatch: expected ${expectedCountry}, actual ${actualCountry} (ip: ${ip})`
            );
          } else {
            log("proxy country verified", { country: actualCountry, ip });
          }
        }
      }

      // Step 8: extract session (native Playwright -- no Cookie-Editor needed)
      const session = await extractSession(context);
      if (session.cookies.length === 0) {
        throw new Error("session extraction produced zero tiktok.com cookies");
      }

      // Step 9: resolve username
      const extractedUsername = await extractTikTokUsername(page);
      let tiktokUsername = options.tiktokUsername?.trim() || "";

      if (tiktokUsername && extractedUsername) {
        const expected = tiktokUsername.toLowerCase().replace(/^@/, "");
        const actual = extractedUsername.toLowerCase().replace(/^@/, "");
        if (expected !== actual) {
          throw new Error(
            `Username mismatch: expected "${tiktokUsername}", logged-in as "${extractedUsername}"`
          );
        }
        log("username verified", { tiktokUsername });
      }

      if (!tiktokUsername) {
        if (extractedUsername) {
          tiktokUsername = extractedUsername;
          log("extracted tiktok username", { tiktokUsername });
        } else {
          warn("could not extract tiktok username -- using accountId");
          tiktokUsername = accountId;
        }
      }

      // Step 10: save to MongoDB (same collection as GoLogin flow)
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

      await saveAccountSession(doc);

      // Also store the adspowerProfileId for future re-captures
      const col = await (await import("./loginAndCaptureSession")).getAccountsCollection();
      await col.updateOne(
        { accountId },
        { $set: { adspowerProfileId: profileId } }
      );

      log("success", {
        accountId,
        tiktokUsername,
        cookieCount: session.cookies.length,
        adspowerProfileId: profileId,
      });

      // Step 11: disconnect Playwright (don't kill the browser yet)
      try { await browser.close(); } catch {}
      browser = undefined;

      // Step 12: stop the AdsPower browser
      await stopAdsPowerBrowser(profileId);

      return { ...doc, adspowerProfileId: profileId };

    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      warn("attempt failed", { attempt, error: lastErr.message });

      // Disconnect Playwright
      if (browser) {
        try { await browser.close(); } catch {}
      }

      // Stop the browser on failure too
      if (profileId) {
        await stopAdsPowerBrowser(profileId).catch(() => {});
      }

      if (attempt >= retries) break;
      log("retrying in 2s");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  throw lastErr ?? new Error("captureViaAdsPower failed");
}

// ---------- helpers ----------

function safeUrl(page: Page): string {
  try { return page.url(); } catch { return ""; }
}
