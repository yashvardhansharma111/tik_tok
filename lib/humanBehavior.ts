import type { Locator, Page } from "playwright";

/**
 * Global multiplier for upload-flow pauses (`HUMAN_TIMING_SCALE`).
 * Default ~0.22 — raise (e.g. 0.4–0.7) if Studio mis-clicks.
 */
export function getHumanTimingScale(): number {
  const raw = process.env.HUMAN_TIMING_SCALE;
  if (raw === undefined || raw === "") return 0.7;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.7;
  return Math.min(2, Math.max(0.12, n));
}

/** Music picker delays (`TIKTOK_MUSIC_TIMING_SCALE`). */
export function getMusicTimingScale(): number {
  const raw = process.env.TIKTOK_MUSIC_TIMING_SCALE;
  if (raw === undefined || raw === "") return 0.55;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.55;
  return Math.min(1.5, Math.max(0.08, n));
}

export function scaledMusicRand(minMs: number, maxMs: number): number {
  const s = getMusicTimingScale();
  return humanRand(Math.round(minMs * s), Math.round(maxMs * s));
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
 * Pause between actions (default base 0.9–1.6s before scale; override HUMAN_PAUSE_MIN_MS / MAX_MS).
 */
export async function humanPause(page: Page, minOverride?: number, maxOverride?: number): Promise<number> {
  const scale = getHumanTimingScale();
  const baseLo = minOverride ?? Number(process.env.HUMAN_PAUSE_MIN_MS || 420);
  const baseHi = maxOverride ?? Number(process.env.HUMAN_PAUSE_MAX_MS || 780);
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
  await page.waitForTimeout(scaledHumanRand(220, 480));
  const up = humanRand(Math.round(40 * s), Math.round(180 * s));
  await page.evaluate((dy) => window.scrollBy(0, dy), -up).catch(() => {});
  await page.waitForTimeout(scaledHumanRand(160, 420));
}

/**
 * Caption: per-character typing by default (human-like). Set `TIKTOK_CAPTION_TYPE_HUMAN=0` to use instant fill().
 */
export async function typeTextLikeHuman(page: Page, locator: Locator, text: string): Promise<void> {
  if (process.env.TIKTOK_CAPTION_TYPE_HUMAN === "0") {
    await locator.fill("").catch(() => {});
    await page.waitForTimeout(20);
    await locator.fill(text).catch(async () => {
      await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
      await locator.press("Backspace").catch(() => {});
      for (const ch of text) {
        await locator.type(ch, { delay: 0 });
        await page.waitForTimeout(humanRand(30, 70));
      }
    });
    return;
  }
  const scale = getHumanTimingScale();
  const minD = Math.max(20, Math.round(Number(process.env.TIKTOK_CAPTION_CHAR_DELAY_MIN_MS || 45) * scale));
  const maxD = Math.max(minD, Math.round(Number(process.env.TIKTOK_CAPTION_CHAR_DELAY_MAX_MS || 95) * scale));
  for (const ch of text) {
    await locator.type(ch, { delay: 0 });
    await page.waitForTimeout(humanRand(minD, maxD));
  }
  return;
}
