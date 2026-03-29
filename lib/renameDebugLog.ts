import type { Page } from "playwright";
import { humanRand } from "@/lib/humanBehavior";

/**
 * Verbose logging for TikTok username rename (server console).
 * Set RENAME_DEBUG=0 to silence.
 */
export function renameLog(step: string, detail?: Record<string, unknown>): void {
  if (process.env.RENAME_DEBUG === "0") return;
  const ts = new Date().toISOString();
  const line = detail
    ? `[RENAME ${ts}] ${step} ${JSON.stringify(detail)}`
    : `[RENAME ${ts}] ${step}`;
  console.log(line);
}

/** Slower pauses for rename flow only (ms). Defaults are intentionally long so you can watch the browser. */
export function renamePauseMsRange(): { min: number; max: number } {
  return {
    min: Number(process.env.RENAME_PAUSE_MIN_MS || 8000),
    max: Number(process.env.RENAME_PAUSE_MAX_MS || 18000),
  };
}

export async function renameSlowPause(page: Page, label: string): Promise<number> {
  const { min, max } = renamePauseMsRange();
  const ms = humanRand(min, max);
  renameLog(`slow_pause`, { label, ms, minConfigured: min, maxConfigured: max });
  await page.waitForTimeout(ms);
  return ms;
}
