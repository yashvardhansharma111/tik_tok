/**
 * Upload a TikTok video through an AdsPower browser profile.
 *
 * Unlike the standalone Playwright path (runUploadWithSession), this:
 *   - Starts the account's AdsPower profile via the Local API
 *   - Connects Playwright via CDP to the AdsPower browser
 *   - Uses the profile's native cookies (no storageState file import)
 *   - Uses the profile's native proxy (no Playwright proxy config)
 *   - Reuses the same fingerprint that was active during login
 *   - Stops the profile when done
 *
 * This ensures login fingerprint === upload fingerprint, which is the
 * strongest anti-detection guarantee we can provide.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  startAdsPowerBrowser,
  stopAdsPowerBrowser,
} from "./adspowerCapture";
import {
  createFlowContext,
  gotoTikTokUploadWithRetries,
  waitForFileInput,
  runStudioUploadPipeline,
  TIKTOK_UPLOAD_URL,
  type TikTokUploadRunResult,
} from "./uploadWorker";
import { isTikTokSessionLoggedOut } from "@/lib/tiktokSessionHealth";
import { dismissTikTokPopups } from "@/lib/tiktokPopupDismiss";

// ---------- types ----------

export type AdsPowerUploadOptions = {
  adspowerProfileId: string;
  username: string;
  videoPath: string;
  caption: string;
  musicQuery?: string;
};

export type AdsPowerUploadResult = {
  success: boolean;
  error?: string;
  soundUsed?: string;
  sessionExpired?: boolean;
};

// ---------- logging ----------

function ts(): string {
  return new Date().toISOString();
}

function log(msg: string, extra?: Record<string, unknown>) {
  if (extra) console.log(`[adspower-upload ${ts()}] ${msg}`, extra);
  else console.log(`[adspower-upload ${ts()}] ${msg}`);
}

function warn(msg: string, extra?: Record<string, unknown>) {
  if (extra) console.warn(`[adspower-upload ${ts()}] WARN ${msg}`, extra);
  else console.warn(`[adspower-upload ${ts()}] WARN ${msg}`);
}

// ---------- main upload function ----------

/**
 * Upload a video through an AdsPower profile. The profile must already exist
 * and have been logged into TikTok (cookies persist in the profile).
 *
 * Flow:
 *   1. Start AdsPower profile → get CDP WebSocket URL
 *   2. Connect Playwright via CDP
 *   3. Navigate to TikTok Studio Upload
 *   4. Check if still logged in (session might have expired)
 *   5. Run the standard upload pipeline (same as standalone Playwright)
 *   6. Return result
 *   7. Stop AdsPower profile (always, even on error)
 */
export async function uploadViaAdsPower(
  opts: AdsPowerUploadOptions
): Promise<AdsPowerUploadResult> {
  const { adspowerProfileId, username, videoPath, caption, musicQuery } = opts;
  const ctx = createFlowContext(username);

  let browser: Browser | undefined;

  try {
    // Step 1: start browser
    log("starting AdsPower browser", { adspowerProfileId, username });
    const { wsUrl } = await startAdsPowerBrowser(adspowerProfileId);

    // Step 2: connect Playwright via CDP
    log("connecting Playwright via CDP");
    browser = await chromium.connectOverCDP(wsUrl);

    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error("AdsPower browser has no contexts after start");
    }
    const context = contexts[0];

    // Use existing page or create new
    const existingPages = context.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();

    // Step 3: navigate to TikTok Studio
    log("navigating to TikTok Studio");
    const tGoto = Date.now();
    await gotoTikTokUploadWithRetries(page, ctx, TIKTOK_UPLOAD_URL);
    const gotoMs = Date.now() - tGoto;
    log("navigation complete", { gotoMs });

    await page.waitForLoadState("domcontentloaded").catch(() => {});

    // Step 4: check if still logged in
    const loggedOut = await isTikTokSessionLoggedOut(page);
    if (loggedOut) {
      warn("session expired — TikTok redirected to login", { username });
      return {
        success: false,
        error: "SESSION_EXPIRED: TikTok session no longer valid. Re-login required.",
        sessionExpired: true,
      };
    }

    // Dismiss any popups and wait for file input
    await dismissTikTokPopups(page);
    const inputOk = await waitForFileInput(page, ctx, 90_000);
    if (!inputOk) {
      await ctx.shot(page, "adspower-no-file-input.png");
      return {
        success: false,
        error: "Upload file input not found on TikTok Studio",
      };
    }

    // Step 5: run the standard upload pipeline
    log("starting upload pipeline", { videoPath, captionLen: caption.length });
    const result = await runStudioUploadPipeline(
      page,
      ctx,
      videoPath,
      caption,
      musicQuery,
      username
    );

    log(result.success ? "upload success" : "upload failed", {
      success: result.success,
      error: result.error,
      soundUsed: result.soundUsed,
    });

    return {
      success: result.success,
      error: result.error,
      soundUsed: result.soundUsed,
      sessionExpired: false,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn("upload error", { error: msg });

    const isSessionErr =
      /SESSION_EXPIRED|login.*redirect|tiktok\.com\/login/i.test(msg);

    return {
      success: false,
      error: msg,
      sessionExpired: isSessionErr,
    };
  } finally {
    // Disconnect Playwright (doesn't close AdsPower)
    if (browser) {
      try { await browser.close(); } catch {}
    }

    // Stop AdsPower browser
    log("stopping AdsPower browser", { adspowerProfileId });
    await stopAdsPowerBrowser(adspowerProfileId).catch(() => {});
  }
}
