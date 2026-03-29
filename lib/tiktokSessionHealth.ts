import type { Page } from "playwright";

function skipHealthCheck(): boolean {
  const v = process.env.SKIP_TIKTOK_SESSION_HEALTH_CHECK;
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

/**
 * Best-effort detection after navigating to TikTok (e.g. Studio upload URL).
 * TikTok changes UI often; false negatives are avoided when upload UI is already visible.
 */
export async function isTikTokSessionLoggedOut(page: Page): Promise<boolean> {
  if (skipHealthCheck()) return false;

  const url = page.url();
  if (/tiktok\.com\/(login|signup)(\/|\?|$)/i.test(url)) return true;

  await page.waitForTimeout(600);

  const fileInput = page.locator('input[type="file"]');
  const uploadVisible = await fileInput.first().isVisible().catch(() => false);
  if (uploadVisible) return false;

  const profileHint = page.locator('[data-e2e="nav-profile"], [data-e2e="profile-icon"], a[href^="/@"]').first();
  if (await profileHint.isVisible().catch(() => false)) return false;

  const loginLink = page.getByRole("link", { name: /^log in$/i }).first();
  const loginBtn = page.getByRole("button", { name: /^log in$/i }).first();
  if (await loginLink.isVisible().catch(() => false)) return true;
  if (await loginBtn.isVisible().catch(() => false)) return true;

  const headingLogin = page.getByRole("heading", { name: /log in to tiktok/i });
  if (await headingLogin.isVisible().catch(() => false)) return true;

  return false;
}
