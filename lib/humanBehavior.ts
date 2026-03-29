import type { Locator, Page } from "playwright";

/** Inclusive random integer in [min, max]. */
export function humanRand(minMs: number, maxMs: number): number {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Pause like a human between actions (default 2–3.5s, override with HUMAN_PAUSE_MIN_MS / HUMAN_PAUSE_MAX_MS).
 */
export async function humanPause(page: Page, minOverride?: number, maxOverride?: number): Promise<number> {
  const lo = minOverride ?? Number(process.env.HUMAN_PAUSE_MIN_MS || 2000);
  const hi = maxOverride ?? Number(process.env.HUMAN_PAUSE_MAX_MS || 3500);
  const ms = humanRand(lo, hi);
  await page.waitForTimeout(ms);
  return ms;
}

/** Small scroll down then partial scroll up (viewport). */
export async function humanScroll(page: Page): Promise<void> {
  const down = humanRand(100, 320);
  await page.evaluate((dy) => window.scrollBy(0, dy), down).catch(() => {});
  await page.waitForTimeout(humanRand(450, 950));
  const up = humanRand(40, 180);
  await page.evaluate((dy) => window.scrollBy(0, dy), -up).catch(() => {});
  await page.waitForTimeout(humanRand(280, 700));
}

/** Type one character at a time with random gaps (TikTOK_CAPTION_CHAR_DELAY_MIN_MS / MAX_MS). */
export async function typeTextLikeHuman(page: Page, locator: Locator, text: string): Promise<void> {
  const minD = Number(process.env.TIKTOK_CAPTION_CHAR_DELAY_MIN_MS || 70);
  const maxD = Number(process.env.TIKTOK_CAPTION_CHAR_DELAY_MAX_MS || 160);
  for (const ch of text) {
    await locator.type(ch, { delay: 0 });
    await page.waitForTimeout(humanRand(minD, maxD));
  }
}
