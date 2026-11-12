import type { Page } from "playwright";

/**
 * Dismiss common TikTok popups / banners that appear on page load
 * (GDPR, cookie consent, TikTok Shop promo, login nag, etc.).
 *
 * Safe to call multiple times — each handler silently skips when the
 * element is not visible.  Runs best after `domcontentloaded`.
 */
export async function dismissTikTokPopups(page: Page): Promise<void> {
  await Promise.allSettled([
    dismissGdprBanner(page),
    dismissTikTokShopBanner(page),
    dismissCookieConsent(page),
    dismissGenericBottomBanner(page),
    dismissUnsavedDraftBanner(page),
  ]);
}

/**
 * "A video you were editing wasn't saved. Continue editing?"  [Discard] [Continue]
 *
 * TikTok Studio shows this when a previous editing session ended without
 * posting — which happens every time a run is interrupted (crash, the 50MB
 * attach failure, or stopping the AdsPower browser mid-upload). Left alone the
 * banner keeps Studio in a half-restored state and the upload button sits
 * spinning, so no new file can be attached.
 *
 * Always chooses Discard: "Continue" would reload the PREVIOUS video and
 * caption, so an automated run would post the wrong content. The draft being
 * discarded is the wreckage of an earlier failed run, never anything a person
 * authored here.
 *
 * Returns true when a banner was found and dismissed.
 */
export async function dismissUnsavedDraftBanner(page: Page): Promise<boolean> {
  const bannerText = /wasn.{0,3}t saved|continue editing\?/i;

  // Scope to the banner so we never click a "Discard" belonging to something else.
  const banner = page
    .locator("div, section, aside")
    .filter({ hasText: bannerText })
    .last();

  if (!(await banner.isVisible({ timeout: 2500 }).catch(() => false))) return false;

  const discardCandidates = [
    banner.getByRole("button", { name: /^\s*discard\s*$/i }).first(),
    banner.locator("button").filter({ hasText: /^\s*discard\s*$/i }).first(),
    page.getByRole("button", { name: /^\s*discard\s*$/i }).first(),
  ];

  for (const btn of discardCandidates) {
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(900);
      // Confirm it is gone; some builds ask to confirm the discard.
      if (!(await banner.isVisible({ timeout: 1200 }).catch(() => false))) return true;
      const confirm = page
        .getByRole("button", { name: /^\s*(discard|confirm|yes|ok)\s*$/i })
        .first();
      if (await confirm.isVisible({ timeout: 1200 }).catch(() => false)) {
        await confirm.click({ force: true }).catch(() => {});
        await page.waitForTimeout(700);
      }
      return true;
    }
  }
  return false;
}

/** GDPR / EEA data-transfer banner – "Got it" button (top bar). */
async function dismissGdprBanner(page: Page): Promise<void> {
  const selectors = [
    page.getByRole("button", { name: /^got it$/i }).first(),
    page.locator("button").filter({ hasText: /^got it$/i }).first(),
    page.locator('[class*="banner" i] button, [class*="notice" i] button')
      .filter({ hasText: /got it/i })
      .first(),
  ];
  for (const btn of selectors) {
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
      return;
    }
  }
}

/** "TikTok Shop is now available on web!" – close (×) button. */
async function dismissTikTokShopBanner(page: Page): Promise<void> {
  const container = page
    .locator("div, aside, section")
    .filter({ hasText: /tiktok shop/i })
    .first();
  if (!(await container.isVisible({ timeout: 2000 }).catch(() => false))) return;

  const closeBtn = container.locator(
    'button[aria-label*="close" i], button[aria-label*="dismiss" i], [class*="close" i], [class*="Close" i]'
  ).first();
  if (await closeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await closeBtn.click({ force: true }).catch(() => {});
    return;
  }

  const svgClose = container.locator("svg").first();
  const parent = svgClose.locator("..");
  if (
    (await parent.evaluate((el) => el.tagName.toLowerCase()).catch(() => "")) === "button" ||
    (await parent.evaluate((el) => el.getAttribute("role")).catch(() => "")) === "button"
  ) {
    await parent.click({ force: true }).catch(() => {});
    return;
  }

  const xBtn = container.locator("button, [role='button']")
    .filter({ hasText: /^[×✕xX]$/ })
    .first();
  if (await xBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await xBtn.click({ force: true }).catch(() => {});
  }
}

/** Generic cookie / consent banners (Accept All / Accept cookies / Allow all). */
async function dismissCookieConsent(page: Page): Promise<void> {
  const patterns = [
    page.getByRole("button", { name: /accept all|allow all|accept cookies/i }).first(),
    page.locator('[class*="cookie" i] button, [id*="cookie" i] button, [class*="consent" i] button')
      .filter({ hasText: /accept|allow|agree|ok/i })
      .first(),
  ];
  for (const btn of patterns) {
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
      return;
    }
  }
}

/** Bottom-sheet promos / app install banners — close anything with a dismiss button. */
async function dismissGenericBottomBanner(page: Page): Promise<void> {
  const bottomBanner = page.locator(
    '[class*="bottom-banner" i], [class*="BottomBanner" i], [class*="app-banner" i], [class*="AppBanner" i]'
  ).first();
  if (!(await bottomBanner.isVisible({ timeout: 1500 }).catch(() => false))) return;

  const close = bottomBanner.locator(
    'button[aria-label*="close" i], button[aria-label*="dismiss" i], [class*="close" i]'
  ).first();
  if (await close.isVisible({ timeout: 1000 }).catch(() => false)) {
    await close.click({ force: true }).catch(() => {});
  }
}
