/**
 * Rename a TikTok @handle through the account's AdsPower profile.
 *
 * The standalone path (`renameTikTokUsername` with `sessionJson`) launches a
 * throwaway Playwright Chromium and replays stored cookies into it. That gives
 * TikTok a browser whose fingerprint — UA, canvas, WebGL, fonts, timezone —
 * does not match the one the session was created under, on one of the most
 * scrutinised actions an account can take. Uploads were already moved onto
 * AdsPower for exactly this reason; renames had been left behind.
 *
 * This runs the same rename flow inside the real AdsPower profile, so the
 * fingerprint and proxy match the login. It also sidesteps a second problem:
 * AdsPower-captured accounts keep only a placeholder session on the legacy
 * `accounts` document, so the standalone path was replaying zero cookies and
 * arriving logged out.
 */

import { chromium, type Browser } from "playwright";
import { startAdsPowerBrowser, stopAdsPowerBrowser } from "./adspowerCapture";
import { renameTikTokUsername, type RenameMultiResult } from "./renameTikTokUsername";
import { dismissTikTokPopups } from "@/lib/tiktokPopupDismiss";

export type AdsPowerRenameOptions = {
  adspowerProfileId: string;
  currentUsername: string;
  newUsername: string;
  fallbackCandidates?: string[];
};

function ts(): string {
  return new Date().toISOString();
}
function log(msg: string, extra?: Record<string, unknown>) {
  if (extra) console.log(`[adspower-rename ${ts()}] ${msg}`, extra);
  else console.log(`[adspower-rename ${ts()}] ${msg}`);
}

export async function renameViaAdsPower(
  opts: AdsPowerRenameOptions
): Promise<RenameMultiResult> {
  const { adspowerProfileId, currentUsername, newUsername, fallbackCandidates } = opts;
  let browser: Browser | undefined;

  try {
    log("starting AdsPower browser", { adspowerProfileId, currentUsername });
    const { wsUrl } = await startAdsPowerBrowser(adspowerProfileId);

    browser = await chromium.connectOverCDP(wsUrl);
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error("AdsPower browser has no contexts after start");
    }
    const context = contexts[0];

    // Fresh tab: leftover tabs carry stale profile/edit state that blocks clicks.
    for (const p of context.pages()) {
      await p.close().catch(() => {});
    }
    const page = await context.newPage();
    // TikTok's edit-profile dialog is unusable at mobile widths.
    await page.setViewportSize({ width: 1366, height: 768 });
    await dismissTikTokPopups(page).catch(() => {});

    log("running rename inside the AdsPower profile");
    return await renameTikTokUsername({
      currentUsername,
      newUsername,
      fallbackCandidates,
      existingPage: page,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("rename error", { error: msg });
    return { ok: false, verified: false, error: msg, triedUnavailable: [] };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // disconnecting CDP does not close AdsPower
      }
    }
    log("stopping AdsPower browser", { adspowerProfileId });
    await stopAdsPowerBrowser(adspowerProfileId).catch(() => {});
  }
}
