import type { Locator, Page } from "playwright";

/** Global multiplier for upload-flow pauses (`HUMAN_TIMING_SCALE`, default 0.72). */
export function getHumanTimingScale(): number {
  const raw = process.env.HUMAN_TIMING_SCALE;
  if (raw === undefined || raw === "") return 0.72;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.72;
  return Math.min(2, Math.max(0.2, n));
}

/** Inclusive random integer in [min, max]. */
export function humanRand(minMs: number, maxMs: number): number {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Same as `humanRand` but scaled by `getHumanTimingScale()` (used in upload automation). */
export function scaledHumanRand(minMs: number, maxMs: number): number {
  const s = getHumanTimingScale();
  return humanRand(Math.round(minMs * s), Math.round(maxMs * s));
}

/**
 * Pause like a human between actions (default 2–3.5s, override with HUMAN_PAUSE_MIN_MS / HUMAN_PAUSE_MAX_MS).
 * Bounds are multiplied by `HUMAN_TIMING_SCALE` (default 0.72).
 */
export async function humanPause(page: Page, minOverride?: number, maxOverride?: number): Promise<number> {
  const scale = getHumanTimingScale();
  const baseLo = minOverride ?? Number(process.env.HUMAN_PAUSE_MIN_MS || 2000);
  const baseHi = maxOverride ?? Number(process.env.HUMAN_PAUSE_MAX_MS || 3500);
  const lo = Math.round(Math.min(baseLo, baseHi) * scale);
  const hi = Math.round(Math.max(baseLo, baseHi) * scale);
  const ms = humanRand(lo, hi);
  await page.waitForTimeout(ms);
  return ms;
}

/** Small scroll down then partial scroll up (viewport). */
export async function humanScroll(page: Page): Promise<void> {
  const s = getHumanTimingScale();
  const down = humanRand(Math.round(100 * s), Math.round(320 * s));
  await page.evaluate((dy) => window.scrollBy(0, dy), down).catch(() => {});
  await page.waitForTimeout(scaledHumanRand(450, 950));
  const up = humanRand(Math.round(40 * s), Math.round(180 * s));
  await page.evaluate((dy) => window.scrollBy(0, dy), -up).catch(() => {});
  await page.waitForTimeout(scaledHumanRand(280, 700));
}

/** Type one character at a time with random gaps (TikTOK_CAPTION_CHAR_DELAY_MIN_MS / MAX_MS). */
export async function typeTextLikeHuman(page: Page, locator: Locator, text: string): Promise<void> {
  const scale = getHumanTimingScale();
  const minD = Math.max(15, Math.round(Number(process.env.TIKTOK_CAPTION_CHAR_DELAY_MIN_MS || 70) * scale));
  const maxD = Math.max(minD, Math.round(Number(process.env.TIKTOK_CAPTION_CHAR_DELAY_MAX_MS || 160) * scale));
  for (const ch of text) {
    await locator.type(ch, { delay: 0 });
    await page.waitForTimeout(humanRand(minD, maxD));
  }
}
