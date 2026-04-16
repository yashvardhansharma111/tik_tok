import { launchChromium } from "@/lib/playwrightLaunch";
import { installSafeBandwidthRoutes } from "@/lib/playwrightSafeBandwidthRoutes";
import { dismissTikTokPopups } from "@/lib/tiktokPopupDismiss";
import {
  discardUploadContext,
  makeUploadContextPoolKey,
  offerUploadContext,
  takeUploadContext,
} from "@/lib/uploadContextPool";
import { attachProxyTrafficLog } from "@/lib/playwrightProxyTrafficLog";
import { isTikTokSessionLoggedOut } from "@/lib/tiktokSessionHealth";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getCachedSound,
  invalidateCachedSound,
  setCachedSound,
  type CachedSoundEntry,
} from "@/lib/soundCache";
import {
  getHumanTimingScale,
  getMusicTimingScale,
  humanPause,
  humanScroll,
  scaledHumanRand,
  scaledMusicRand,
  typeTextLikeHuman,
} from "@/lib/humanBehavior";

export const TIKTOK_UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?from=webapp";

/**
 * Selector strategies used by this worker (update when TikTok Studio DOM changes).
 * Sound/music: see `tryAddSoundToVideo` + `TIKTOK_MUSIC_FLOW_SELECTORS` when `musicQuery` is set;
 * early flow still runs `logMusicRelatedControls` for diagnostics.
 */
export const TIKTOK_STUDIO_SELECTORS = {
  uploadFileInput: 'input[type="file"]',
  captionEditor: '[contenteditable="true"]',
  postButton: 'button[data-e2e="post_video_button"]',
  postNowConfirm: 'button:has-text("Post now")',
  modal: '[role="dialog"]',
  showMoreButton: 'role=button[name=/show more/i]',
  copyrightSwitchByLabel: 'role=switch[name=/music copyright/i]',
  contentCheckSwitchByLabel: 'role=switch[name=/content check lite/i]',
} as const;

/** Documented selector strategy for optional sound picker (`tryAddSoundToVideo`). */
export const TIKTOK_MUSIC_FLOW_SELECTORS = {
  openAddSound_tiktokStudioButton:
    'locator(\'button[data-button-name="sounds"], button[data-default-left-menu="MusicPanel"]\').first()',
  openAddSound_primary: 'getByRole("button", { name: /add sound/i })',
  openAddSound_secondary: 'getByRole("button", { name: /sound/i })',
  openAddSound_fallback: 'locator(\'button, a, [role="button"]\').filter({ hasText: /sound/i }).first()',
  panel_modal: '[role="dialog"]',
  panel_sidebar: 'aside, [role="complementary"]',
  panel_drawer: '[class*="Drawer" i], [class*="drawer" i], [class*="SidePanel" i]',
  search_inputs:
    'input[placeholder*="Search" i], input[placeholder*="search" i], input[type="search"], [role="dialog"] input[type="text"]',
  sound_result_row: '[data-e2e*="sound"]',
  sound_result_option: '[role="option"]',
  apply_buttons: 'getByRole("button", { name: /use this sound|use sound|confirm|done/i })',
} as const;

/** Broad Plus-button selector covering TikTok's evolving icon attributes. */
const PLUS_BTN_CSS = [
  'button:has([data-icon="PlusBold"])',
  'button:has([data-testid="PlusBold"])',
  'button:has([data-icon="Plus"])',
  'button:has([data-testid="Plus"])',
  'button:has([data-icon="AddOutlined"])',
  '[role="button"]:has([data-icon="PlusBold"])',
  '[role="button"]:has([data-icon="Plus"])',
  'button[data-icon-only="true"]',
].join(", ");

/** Fallback selectors when the primary PLUS_BTN_CSS doesn't match. */
const PLUS_BTN_FALLBACK_CSS = [
  'button[aria-label*="add" i]',
  'button[aria-label*="plus" i]',
  'button[title*="add" i]',
].join(", ");

/** Min score to accept a match on the user's primary search (else try region fallbacks). */
const MUSIC_PRIMARY_MIN_SCORE = 12;
const MUSIC_QUICK_ADD_MIN_SCORE = 18;
const MUSIC_SUGGESTION_CLICK_MIN_SCORE = 18;

const REGION_FALLBACK_SEARCHES = ["trending", "viral sound"] as const;

const FALLBACK_SOUND_KEYWORDS = [
  "viral",
  "trending",
  "trending sound",
  "popular",
  "fyp",
  "viral sound",
  "trend",
  "tiktok viral",
  "popular music",
];

/** Row labels we never select (TikTok junk / rights / unavailable). */
export function isBadSoundLabel(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("copyright")) return true;
  if (t.includes("not available")) return true;
  if (t.includes("private")) return true;
  if (/original\s+sound\s*-/i.test(text)) return true;
  return false;
}

function withSoundFlowTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, rej) => {
    id = setTimeout(() => {
      ac.abort();
      rej(new Error("SOUND_FLOW_TIMEOUT"));
    }, ms);
  });
  return Promise.race([fn(ac.signal), timeoutP]).finally(() => {
    if (id !== undefined) clearTimeout(id);
  }) as Promise<T>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const v = value.trim().replace(/\s+/g, " ");
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function normalizeMusicText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isLowQualitySuggestion(text: string): boolean {
  return /\b(lyrics?|lyric video|cover|edit|sped up|slowed|instrumental|karaoke|8d|reverb|remix)\b/i.test(text);
}

function scoreSuggestionCandidate(musicQuery: string, suggestionText: string): number {
  let score = scoreSoundMatch(musicQuery, suggestionText);
  const normalizedQuery = normalizeMusicText(musicQuery);
  const normalizedSuggestion = normalizeMusicText(suggestionText);

  if (normalizedSuggestion === normalizedQuery) score += 140;
  else if (normalizedSuggestion.startsWith(normalizedQuery)) score += 60;
  else if (normalizedSuggestion.includes(normalizedQuery)) score += 40;

  if (isLowQualitySuggestion(suggestionText)) score -= 45;
  if (/\b(video|live|harry potter|dragon age|letra)\b/i.test(suggestionText)) score -= 25;

  return score;
}

function isClosedTargetError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Target page, context or browser has been closed|has been closed/i.test(msg);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("SOUND_FLOW_TIMEOUT");
}

function suggestionContainsDesiredMusic(musicQuery: string, suggestionText: string): boolean {
  const query = normalizeMusicText(musicQuery);
  const suggestion = normalizeMusicText(suggestionText);
  if (!query || !suggestion) return false;

  if (suggestion.includes(query)) return true;

  const queryTokens = tokenizeForSoundMatch(query).filter((t) => t.length >= 3);
  const suggestionTokens = tokenizeForSoundMatch(suggestion);
  if (queryTokens.length === 0 || suggestionTokens.length === 0) return false;

  const overlap = queryTokens.filter((qt) => suggestionTokens.some((st) => st.includes(qt) || qt.includes(st))).length;
  const minNeeded = Math.max(2, Math.ceil(queryTokens.length * 0.6));
  return overlap >= minNeeded;
}

function buildMusicSearchTerms(musicQuery: string): string[] {
  const q = musicQuery.trim().replace(/\s+/g, " ");
  if (!q) return [];

  const cleaned = q
    .replace(/\((feat|ft|featuring)[^)]+\)/gi, " ")
    .replace(/\[(official|audio|video|lyrics?)[^\]]*\]/gi, " ")
    .replace(/\b(official|audio|video|lyrics?|feat\.?|ft\.?|featuring)\b/gi, " ")
    .replace(/[|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const splitParts = cleaned
    .split(/\s+[-–—:]\s+|\s+\|\s+|\s+by\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);

  const tokens = tokenizeForSoundMatch(cleaned);
  const firstFour = tokens.slice(0, 4).join(" ");
  const lastFour = tokens.slice(-4).join(" ");

  return uniqueNonEmpty([
    q,
    cleaned,
    ...splitParts,
    splitParts.length >= 2 ? `${splitParts[0]} ${splitParts[1]}` : "",
    firstFour,
    lastFour,
    ...REGION_FALLBACK_SEARCHES,
  ]);
}

/** Substrings / labels to locate sound-related controls (detection only — not clicked). */
export const MUSIC_UI_TEXT_PATTERNS = [
  "Add sound",
  "Sounds",
  "Music",
  "Select sound",
  "Trending sounds",
] as const;

function envTruthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

function screenshotsOn(): boolean {
  const off = process.env.TIKTOK_UPLOAD_SCREENSHOTS;
  return !off || (!envTruthy(off) && off !== "0" && off !== "false");
}

function flowDebugOn(): boolean {
  return envTruthy(process.env.TIKTOK_UPLOAD_FLOW_DEBUG);
}

type Page = import("playwright").Page;

type FlowContext = {
  runId: string;
  debugDir: string;
  flow: (step: string) => void;
  debug: (msg: string) => void;
  shot: (page: Page, fileName: string) => Promise<void>;
  pauseIfDebug: (page: Page, reason: string) => Promise<void>;
};

type BrowserContext = import("playwright").BrowserContext;

/**
 * Mask Playwright/automation signals so TikTok serves normal content
 * (full sound catalog, no restricted features).
 */
async function applyStealthScripts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // @ts-expect-error — chrome runtime stub
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params: PermissionDescriptor) =>
      params.name === "notifications"
        ? Promise.resolve({ state: "denied", onchange: null } as PermissionStatus)
        : origQuery(params);
  });
}

/**
 * Structured timing: (1) area+phase (2) duration (3) why + knobs — always logged to console + flow.log.
 */
function flowTiming(ctx: FlowContext, area: "music" | "post", phase: string, ms: number, reason: string, knobs?: string): void {
  const sec = (ms / 1000).toFixed(2);
  const tail = knobs && knobs.length > 0 ? ` | knobs=${knobs}` : "";
  ctx.flow(`[timing][${area}] ${phase} | ${sec}s | reason=${reason}${tail}`);
}

export function createFlowContext(username: string): FlowContext {
  const safe = username.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const runId = `${Date.now()}-${safe}`;
  const debugDir = path.join(process.cwd(), "storage", "debug", runId);
  const flowLogFile = path.join(debugDir, "flow.log");
  fs.mkdirSync(debugDir, { recursive: true });

  const appendLog = (line: string) => {
    try {
      fs.appendFileSync(flowLogFile, `${new Date().toISOString()} ${line}\n`, "utf-8");
    } catch {}
  };

  const flow = (step: string) => {
    const line = `[FLOW] ${step}`;
    console.log(line);
    appendLog(line);
  };
  const debug = (msg: string) => {
    const line = `[DEBUG] ${msg}`;
    if (flowDebugOn()) console.log(line);
    appendLog(line);
  };

  const shot = async (page: Page, fileName: string) => {
    if (!screenshotsOn()) return;
    const target = path.join(debugDir, fileName);
    try {
      await page.screenshot({ path: target, fullPage: true });
      flow(`screenshot → ${path.relative(process.cwd(), target)}`);
    } catch (e) {
      flow(`screenshot failed (${fileName}): ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const pauseIfDebug = async (page: Page, reason: string) => {
    if (!flowDebugOn()) return;
    flow(`PAUSE (${reason}) — resume in Playwright Inspector (TIKTOK_UPLOAD_FLOW_DEBUG=1)`);
    await page.pause();
  };

  flow(`debug folder: ${debugDir} (screenshots=${screenshotsOn()}, flowDebug=${flowDebugOn()})`);
  return { runId, debugDir, flow, debug, shot, pauseIfDebug };
}

/** Proxy/residential tunnels often fail once; these are worth retrying. */
function isTransientProxyNavigationError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|ERR_SSL_PROTOCOL_ERROR|ERR_ADDRESS_UNREACHABLE|ECONNRESET|ETIMEDOUT/i.test(
    msg
  );
}

/**
 * First navigation to Studio — retries on flaky proxy tunnels (`net::ERR_TUNNEL_CONNECTION_FAILED`, etc.).
 * Env: `UPLOAD_GOTO_RETRIES` (default 3), `UPLOAD_GOTO_RETRY_DELAY_MS` (default 5000).
 */
export async function gotoTikTokUploadWithRetries(page: Page, ctx: FlowContext, url: string): Promise<void> {
  const max = Math.max(1, Math.min(6, Number(process.env.UPLOAD_GOTO_RETRIES || 3)));
  const delayMs = Math.max(300, Number(process.env.UPLOAD_GOTO_RETRY_DELAY_MS || 3200));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 90000 });
      if (attempt > 1) ctx.flow(`navigation OK on attempt ${attempt}/${max}`);
      return;
    } catch (e) {
      lastErr = e;
      const retryable = attempt < max && isTransientProxyNavigationError(e);
      const detail = e instanceof Error ? e.message : String(e);
      ctx.flow(
        retryable
          ? `navigate attempt ${attempt}/${max} failed (${detail}) — retrying in ${delayMs}ms`
          : `navigate attempt ${attempt}/${max} failed (${detail})`
      );
      if (!retryable) throw e;
      await page.waitForTimeout(delayMs);
    }
  }
  throw lastErr;
}

async function describeFirstVisible(loc: import("playwright").Locator, ctx: FlowContext): Promise<string> {
  const n = await loc.count();
  if (n === 0) return "(none)";
  for (let i = 0; i < Math.min(n, 8); i++) {
    const el = loc.nth(i);
    const vis = await el.isVisible().catch(() => false);
    if (!vis) continue;
    const tag = await el.evaluate((node) => node.nodeName.toLowerCase()).catch(() => "?");
    const e2e = await el.getAttribute("data-e2e").catch(() => null);
    const aria = await el.getAttribute("aria-label").catch(() => null);
    const id = await el.getAttribute("id").catch(() => null);
    const cls = ((await el.getAttribute("class")) || "").slice(0, 120);
    const txt = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 80);
    return `[#${i}] <${tag}> data-e2e=${e2e ?? "—"} aria-label=${aria ?? "—"} id=${id ?? "—"} class="${cls}" text="${txt}"`;
  }
  return "(matches but none visible)";
}

async function logModals(page: Page, ctx: FlowContext): Promise<void> {
  const dialogs = page.locator(TIKTOK_STUDIO_SELECTORS.modal);
  const count = await dialogs.count();
  ctx.flow(`modals [role=dialog] count=${count}`);
  for (let i = 0; i < count; i++) {
    const d = dialogs.nth(i);
    const vis = await d.isVisible().catch(() => false);
    ctx.debug(`modal[${i}] visible=${vis} ${await describeFirstVisible(d, ctx)}`);
  }
}

async function logMusicRelatedControls(page: Page, ctx: FlowContext): Promise<void> {
  ctx.flow("scanning sound/music-related controls (detection only, no clicks)");
  for (const label of MUSIC_UI_TEXT_PATTERNS) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const asButton = page.getByRole("button", { name: re });
    const asLink = page.getByRole("link", { name: re });
    const btnCount = await asButton.count();
    const linkCount = await asLink.count();
    ctx.flow(
      `music text "${label}": role=button matches=${btnCount}, role=link matches=${linkCount}`
    );
    if (btnCount > 0) {
      ctx.debug(`  button first: ${await describeFirstVisible(asButton, ctx)}`);
    }
    if (linkCount > 0) {
      ctx.debug(`  link first: ${await describeFirstVisible(asLink, ctx)}`);
    }
    const loose = page.locator(`button, a, [role="button"]`).filter({ hasText: re });
    const looseCount = await loose.count();
    if (looseCount > 0) {
      ctx.debug(`  loose button/link filter: count=${looseCount} first=${await describeFirstVisible(loose, ctx)}`);
    }
  }
}

async function logCoreElements(page: Page, ctx: FlowContext): Promise<void> {
  const fileIn = page.locator(TIKTOK_STUDIO_SELECTORS.uploadFileInput);
  const cap = page.locator(TIKTOK_STUDIO_SELECTORS.captionEditor);
  const post = page.locator(TIKTOK_STUDIO_SELECTORS.postButton);

  const fCount = await fileIn.count();
  const cCount = await cap.count();
  const pCount = await post.count();

  ctx.flow(
    `elements: file input count=${fCount}, caption [contenteditable] count=${cCount}, post[data-e2e] count=${pCount}`
  );

  const fVis = fCount > 0 && (await fileIn.first().isVisible().catch(() => false));
  const cVis = cCount > 0 && (await cap.first().isVisible().catch(() => false));
  const pVis = pCount > 0 && (await post.first().isVisible().catch(() => false));
  ctx.flow(`visibility: fileInput=${fVis}, caption=${cVis}, post=${pVis}`);

  if (!fVis && fCount > 0) ctx.flow("file input present but not visible (expected if hidden for styling)");
  if (cCount === 0) ctx.flow("caption editor not found in DOM yet");
  if (pCount === 0) ctx.flow("post button [data-e2e=post_video_button] not found in DOM yet");

  ctx.debug(`file input: ${await describeFirstVisible(fileIn, ctx)}`);
  ctx.debug(`caption: ${await describeFirstVisible(cap, ctx)}`);
  ctx.debug(`post: ${await describeFirstVisible(post, ctx)}`);
}

export async function waitForFileInput(page: Page, ctx: FlowContext, timeoutMs: number): Promise<boolean> {
  ctx.flow(`wait: file input attached (${TIKTOK_STUDIO_SELECTORS.uploadFileInput})`);
  try {
    await page.locator(TIKTOK_STUDIO_SELECTORS.uploadFileInput).first().waitFor({ state: "attached", timeout: timeoutMs });
    ctx.flow("file input attached");
    return true;
  } catch {
    ctx.flow("file input NOT attached within timeout");
    return false;
  }
}

/** Wait until caption editor appears (proxy for upload UI ready after file picked). */
async function waitForCaptionEditorVisible(
  page: Page,
  ctx: FlowContext,
  timeoutMs: number
): Promise<import("playwright").Locator | null> {
  ctx.flow(`wait: caption editor visible (${TIKTOK_STUDIO_SELECTORS.captionEditor})`);
  const cap = page.locator(TIKTOK_STUDIO_SELECTORS.captionEditor).first();
  const start = Date.now();
  let spin = 0;
  while (Date.now() - start < timeoutMs) {
    await dismissAutomaticContentChecksOfferDialog(page, ctx, "wait-caption");
    await dismissStopCopyrightDialog(page, ctx, "wait-caption");
    if (await cap.isVisible().catch(() => false)) {
      ctx.flow("caption editor visible (upload UI likely ready)");
      await dismissAutomaticContentChecksOfferDialog(page, ctx, "after-caption-visible");
      return cap;
    }
    spin += 1;
    if (spin % 3 === 0) {
      ctx.flow("human: scroll while waiting for caption editor");
      await humanScroll(page);
      await humanPause(page);
    }
    await page.waitForTimeout(scaledHumanRand(380, 680));
  }
  ctx.flow("caption editor NOT visible within timeout");
  return null;
}

/** Poll processing / progress text if present (best-effort, locale-dependent). */
async function logUploadProgressHints(page: Page, ctx: FlowContext): Promise<void> {
  const hints = [
    /upload/i,
    /processing/i,
    /preparing/i,
    /progress/i,
    /checking/i,
  ];
  for (const re of hints) {
    const el = page.getByText(re).first();
    if (await el.isVisible().catch(() => false)) {
      const t = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
      ctx.flow(`upload/progress hint visible: /${re.source}/ → "${t}"`);
    }
  }
}

async function musicDebugShot(ctx: FlowContext, page: Page, fileName: string): Promise<void> {
  await ctx.shot(page, fileName);
}

/**
 * TikTok sometimes shows: "Stop copyright checking? Your current progress won't be saved."
 * We must click Cancel to keep the upload flow alive.
 */
async function dismissStopCopyrightDialog(page: Page, ctx: FlowContext, stage: string): Promise<boolean> {
  const byDialog = page
    .locator('[role="dialog"]')
    .filter({ hasText: /stop copyright checking|current progress won.?t be saved/i })
    .first();
  const byText = page.getByText(/stop copyright checking|current progress won.?t be saved/i).first();
  const visible =
    (await byDialog.isVisible({ timeout: 250 }).catch(() => false)) ||
    (await byText.isVisible({ timeout: 250 }).catch(() => false));
  if (!visible) return false;

  ctx.flow(`[guard] stop-copyright dialog detected (${stage})`);
  const cancelInDialog = byDialog.getByRole("button", { name: /cancel|keep|continue/i }).first();
  if (await cancelInDialog.isVisible({ timeout: 1200 }).catch(() => false)) {
    await cancelInDialog.click({ force: true }).catch(() => {});
    ctx.flow(`[guard] stop-copyright dialog dismissed via Cancel (${stage})`);
    await page.waitForTimeout(250);
    return true;
  }

  const cancelGlobal = page.getByRole("button", { name: /cancel|keep|continue/i }).first();
  if (await cancelGlobal.isVisible({ timeout: 1200 }).catch(() => false)) {
    await cancelGlobal.click({ force: true }).catch(() => {});
    ctx.flow(`[guard] stop-copyright dialog dismissed via global Cancel (${stage})`);
    await page.waitForTimeout(250);
    return true;
  }

  ctx.flow(`[guard] stop-copyright dialog visible but Cancel not found (${stage})`);
  return false;
}

/**
 * While the video is still uploading, TikTok Studio may show:
 * "Turn on automatic content checks?" (Music copyright check / Content check lite toggles in the modal).
 * Click **Cancel** so the flow can continue to the Description field and later steps.
 */
async function dismissAutomaticContentChecksOfferDialog(
  page: Page,
  ctx: FlowContext,
  stage: string
): Promise<boolean> {
  const offerPatterns = [
    /Turn on automatic content checks/i,
    /automatic content checks\?/i,
    /automatically check your video for copyright/i,
    /Profile\s*>\s*Settings/i,
  ];

  let dialog: import("playwright").Locator | null = null;
  for (const p of offerPatterns) {
    const d = page.locator('[role="dialog"]').filter({ hasText: p }).first();
    if (await d.isVisible({ timeout: 250 }).catch(() => false)) {
      dialog = d;
      break;
    }
  }

  if (!dialog || !(await dialog.isVisible({ timeout: 150 }).catch(() => false))) {
    return false;
  }

  ctx.flow(`[guard] automatic content checks offer dialog (${stage})`);

  const cancelPrimary = dialog.getByRole("button", { name: /^cancel$/i }).first();
  if (await cancelPrimary.isVisible({ timeout: 2000 }).catch(() => false)) {
    await cancelPrimary.click({ force: true }).catch(() => {});
    ctx.flow(`[guard] dismissed content-checks offer via Cancel (${stage})`);
    await page.waitForTimeout(450);
    return true;
  }

  const cancelLoose = dialog.locator("button").filter({ hasText: /^cancel$/i }).first();
  if (await cancelLoose.isVisible({ timeout: 800 }).catch(() => false)) {
    await cancelLoose.click({ force: true }).catch(() => {});
    ctx.flow(`[guard] dismissed content-checks offer via button[Cancel] (${stage})`);
    await page.waitForTimeout(450);
    return true;
  }

  ctx.flow(`[guard] content-checks offer dialog visible but Cancel not found (${stage})`);
  return false;
}

/** TikTok may show "Post not created" / Community Guidelines after Post — treat as failure (no success loop). */
async function detectPostRejectedByTikTok(page: Page, ctx: FlowContext): Promise<boolean> {
  const dialog = page
    .locator('[role="dialog"]')
    .filter({
      hasText: /Post not created|Community Guidelines|suspicious activity|Spam and Deceptive|violated our|appeal within/i,
    })
    .first();
  const v = await dialog.isVisible({ timeout: 6000 }).catch(() => false);
  if (v) ctx.flow("detected: TikTok rejected post (modal)");
  return v;
}

function tokenizeForSoundMatch(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s\-–—,|]+/)
    .map((t) => t.replace(/[^\w\u00C0-\u024F']/g, ""))
    .filter((t) => t.length > 1);
}

/** Score how well a result row matches the user's `musicQuery` (higher = better). Exported for tests. */
export function scoreSoundMatch(musicQuery: string, label: string): number {
  const q = musicQuery.trim().toLowerCase();
  const l = label.trim().toLowerCase().replace(/\s+/g, " ");
  if (!l) return 0;
  let score = 0;
  if (l === q) score += 120;
  if (q.length > 2 && l.startsWith(q)) score += 220;
  if (q.length > 2 && l.includes(` ${q} `)) score += 140;
  if (q.length > 2 && l.includes(q)) score += 55;
  if (l.length > 3 && q.includes(l)) score += 35;
  const qTokens = tokenizeForSoundMatch(musicQuery);
  const lTokens = new Set(tokenizeForSoundMatch(label));
  for (const t of qTokens) {
    if (t.length < 2) continue;
    let hit = false;
    for (const lt of lTokens) {
      if (lt.includes(t) || t.includes(lt)) {
        hit = true;
        break;
      }
    }
    if (hit) score += 18;
  }
  score += Math.min(l.length / 25, 4);
  return score;
}

/** Short human-readable hints for logs (mirrors `scoreSoundMatch` rules). */
export function explainSoundMatch(musicQuery: string, label: string): string {
  const q = musicQuery.trim().toLowerCase();
  const l = label.trim().toLowerCase().replace(/\s+/g, " ");
  if (!l) return "empty label";
  const parts: string[] = [];
  if (l === q) parts.push("exact match");
  if (q.length > 2 && l.startsWith(q)) parts.push("label starts with query");
  if (q.length > 2 && l.includes(` ${q} `)) parts.push("whole-word query in label");
  if (q.length > 2 && l.includes(q)) parts.push("substring hit");
  if (l.length > 3 && q.includes(l)) parts.push("query contains label");
  const qTokens = tokenizeForSoundMatch(musicQuery);
  const lTokens = new Set(tokenizeForSoundMatch(label));
  let tokenHits = 0;
  for (const t of qTokens) {
    if (t.length < 2) continue;
    let hit = false;
    for (const lt of lTokens) {
      if (lt.includes(t) || t.includes(lt)) {
        hit = true;
        break;
      }
    }
    if (hit) tokenHits += 1;
  }
  if (tokenHits) parts.push(`${tokenHits} token overlap(s)`);
  if (parts.length === 0) parts.push("length / weak match bonus only");
  return parts.join("; ");
}

type PwLocator = import("playwright").Locator;

/** True if node lies in the smallest ancestor of Post that also contains the caption (upload column, not left rail). */
async function isInsideUploadEditorShellForLocator(loc: PwLocator): Promise<boolean> {
  return loc
    .evaluate((el) => {
      const post = document.querySelector('[data-e2e="post_video_button"]') as HTMLElement | null;
      const cap = document.querySelector('[contenteditable="true"]') as HTMLElement | null;
      if (!post || !cap) return false;

      let shell: HTMLElement | null = post;
      for (let i = 0; i < 24 && shell; i++) {
        if (shell.contains(cap) && shell.contains(post)) break;
        shell = shell.parentElement;
      }
      if (!shell) return false;
      return shell.contains(el);
    })
    .catch(() => false);
}

/** Left-rail "Sounds" (MusicPanel) is not the upload picker. Controls inside the upload shell are allowed even if labeled "Sounds". */
async function isExcludedStudioNavSoundControl(loc: PwLocator): Promise<boolean> {
  const leftMenu = ((await loc.getAttribute("data-default-left-menu")) || "").trim();
  if (/musicpanel/i.test(leftMenu)) return true;

  if (await isInsideUploadEditorShellForLocator(loc)) return false;

  const btnName = ((await loc.getAttribute("data-button-name")) || "").trim().toLowerCase();
  const inNav = await loc
    .evaluate((el) => {
      const n = el.closest(
        'nav,[data-e2e*="nav" i],[class*="SideNav" i],[class*="side-nav" i],[class*="NavMenu" i],[class*="LeftNav" i]'
      );
      return !!n;
    })
    .catch(() => false);
  const raw = ((await loc.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  if (inNav && (btnName === "sounds" || /^sounds?$/i.test(raw))) return true;
  if (!inNav && btnName === "sounds" && /^sounds?$/i.test(raw)) return true;
  return false;
}

async function uploadComposerRoot(page: Page): Promise<PwLocator> {
  const main = page.locator("main").first();
  if (await main.isVisible().catch(() => false)) return main;
  return page.locator("body");
}

async function findAddSoundByComposerText(page: Page, ctx: FlowContext): Promise<PwLocator | null> {
  const composer = await uploadComposerRoot(page);
  const patterns = [/add sound/i, /add a sound/i, /choose sound/i, /select sound/i, /select a sound/i];
  for (const re of patterns) {
    const hit = composer.getByText(re, { exact: false }).first();
    if (!(await hit.isVisible().catch(() => false))) continue;
    if (await isExcludedStudioNavSoundControl(hit)) continue;
    const asBtn = hit.locator('xpath=ancestor-or-self::button[1]').first();
    if (await asBtn.isVisible().catch(() => false) && !(await isExcludedStudioNavSoundControl(asBtn))) {
      ctx.flow(`[music] open control: composer text → button ancestor (${re.source})`);
      return asBtn;
    }
    const roleBtn = hit.locator('xpath=ancestor-or-self::*[@role="button"][1]').first();
    if (await roleBtn.isVisible().catch(() => false) && !(await isExcludedStudioNavSoundControl(roleBtn))) {
      ctx.flow(`[music] open control: composer text → role=button (${re.source})`);
      return roleBtn;
    }
    const tabRow = hit
      .locator(
        'xpath=ancestor-or-self::*[self::div or self::span][@tabindex="0" or contains(@class,"cursor-pointer")][1]'
      )
      .first();
    if (await tabRow.isVisible().catch(() => false) && !(await isExcludedStudioNavSoundControl(tabRow))) {
      ctx.flow(`[music] open control: composer text → focusable row (${re.source})`);
      return tabRow;
    }
  }
  return null;
}

async function findAddSoundButton(page: Page, ctx: FlowContext): Promise<PwLocator | null> {
  const exactStudioSounds = page
    .locator('button[data-default-left-menu="MusicPanel"][data-button-name="sounds"]')
    .first();
  if (await exactStudioSounds.isVisible({ timeout: 1200 }).catch(() => false)) {
    ctx.flow('[music] open control chosen: exact MusicPanel "Sounds" button');
    return exactStudioSounds;
  }

  const composer = await uploadComposerRoot(page);

  const pools: { label: string; loc: PwLocator }[] = [
    {
      label: "composer role=button add/use/select",
      loc: composer.getByRole("button", { name: /add sound|use sound|select sound|add music|choose sound/i }),
    },
    {
      label: "page role=button add/use/select",
      loc: page.getByRole("button", { name: /add sound|use sound|select sound|add music|choose sound/i }),
    },
    {
      label: "composer sound attrs (no MusicPanel)",
      loc: composer.locator(
        'button[data-e2e*="sound" i], button[aria-label*="sound" i], [role="button"][aria-label*="sound" i]'
      ),
    },
    {
      label: "composer role=button /sound/ (last resort in main)",
      loc: composer.getByRole("button", { name: /sound|music/i }),
    },
    {
      label: "main loose sound-ish (div/tab/button)",
      loc: page
        .locator("main")
        .locator('button, [role="button"], div[tabindex="0"], a')
        .filter({ hasText: /sounds?|add\s*sound|music/i }),
    },
  ];

  const candidates: { score: number; loc: PwLocator; desc: string }[] = [];

  for (const pool of pools) {
    const n = await pool.loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 12); i++) {
      const el = pool.loc.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      if (await isExcludedStudioNavSoundControl(el)) continue;

      const txt = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const aria = ((await el.getAttribute("aria-label").catch(() => null)) || "").trim();
      const e2e = ((await el.getAttribute("data-e2e").catch(() => null)) || "").trim();
      const btnName = ((await el.getAttribute("data-button-name").catch(() => null)) || "").trim();
      const leftMenu = ((await el.getAttribute("data-default-left-menu").catch(() => null)) || "").trim();
      const label = `${txt} ${aria}`.toLowerCase();
      const inUploadShell = await isInsideUploadEditorShellForLocator(el);

      let score = 0;
      if (/add sound|use sound|select sound|add music|choose sound/.test(label)) score += 120;
      if (/^sounds?$/.test((txt || aria).toLowerCase())) score += inUploadShell ? 55 : -80;
      if (/musicpanel/i.test(leftMenu)) score -= 200;
      if (e2e.toLowerCase().includes("sound")) score += 35;
      if (btnName.toLowerCase() === "sounds") score += inUploadShell ? 45 : -60;
      if (inUploadShell) score += 25;

      const desc = `${pool.label} txt="${txt.slice(0, 40)}" aria="${aria.slice(0, 40)}" data-e2e="${e2e}" data-button-name="${btnName}" left-menu="${leftMenu}" inShell=${inUploadShell} score=${score}`;
      candidates.push({ score, loc: el, desc });
    }
  }

  const byText = await findAddSoundByComposerText(page, ctx);
  if (byText) {
    candidates.push({
      score: 95,
      loc: byText,
      desc: 'composer label walk-up score=95',
    });
  }

  const viable = candidates.filter((c) => c.score >= 20);
  if (!viable.length) {
    ctx.flow(
      `[music] open control: no safe composer target (would be studio sidebar "Sounds"). candidates=${candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .map((c) => c.desc)
        .join(" || ") || "(none)"}`
    );
    return null;
  }

  viable.sort((a, b) => b.score - a.score);
  ctx.flow(`[music] open control candidates: ${viable.slice(0, 3).map((c) => c.desc).join(" || ")}`);
  const chosen = viable[0];
  ctx.flow(`[music] open control chosen: ${chosen.desc}`);
  return chosen.loc;
}

/** Modal → sidebar/drawer → main → TikTok non-aria overlays that still contain search + rows. */
async function resolveSoundPanelRoot(page: Page, ctx: FlowContext): Promise<PwLocator | null> {
  const candidates: PwLocator[] = [
    page.locator('[role="dialog"]:visible').last(),
    page.locator('[role="dialog"]:visible').first(),
    page.locator("aside:visible").first(),
    page.locator(TIKTOK_MUSIC_FLOW_SELECTORS.panel_drawer).first(),
    page.locator("main").first(),
  ];

  for (const root of candidates) {
    const visible = await root.isVisible().catch(() => false);
    if (!visible) continue;

    const hasSearch = await root
      .locator('input[placeholder*="Search" i], input[placeholder*="search" i], input[type="search"]')
      .first()
      .isVisible()
      .catch(() => false);
    const hasTextInput = await root.locator("input[type='text']").first().isVisible().catch(() => false);
    const hasSound = await root.locator('[data-e2e*="sound"]').first().isVisible().catch(() => false);
    const hasOption = await root.getByRole("option").first().isVisible().catch(() => false);
    const hasListBtn = await root.locator('[role="listbox"] button, [role="grid"] button').first().isVisible().catch(() => false);

    if (hasSearch || hasTextInput || hasSound || hasOption || hasListBtn) {
      ctx.debug(
        `[music] panel root hit (${[hasSearch && "search", hasSound && "e2e", hasOption && "opt"].filter(Boolean).join(",") || "inputs/list"})`
      );
      return root;
    }
  }

  const modalShell = page
    .locator(
      'div[class*="modal" i], div[class*="Modal" i], div[class*="Drawer" i], div[class*="drawer" i], div[class*="Panel" i], div[class*="popover" i], div[class*="Popup" i]'
    )
    .filter({
      has: page.locator('input[placeholder*="Search" i], input[placeholder*="search" i], input[type="search"]'),
    })
    .first();
  if (await modalShell.isVisible({ timeout: 400 }).catch(() => false)) {
    ctx.flow("[music] panel root: modal/drawer shell (fallback, has search input)");
    return modalShell;
  }

  const searchFirst = page
    .locator('input[type="search"]:visible, input[placeholder*="Search" i]:visible, input[placeholder*="search" i]:visible')
    .first();
  if (await searchFirst.isVisible({ timeout: 400 }).catch(() => false)) {
    const ancestorXpaths = [
      "xpath=ancestor::div[contains(@class,'Modal') or contains(@class,'modal')][1]",
      "xpath=ancestor::div[contains(@class,'Drawer') or contains(@class,'drawer')][1]",
      "xpath=ancestor::div[contains(@class,'Panel') or contains(@class,'panel')][1]",
      "xpath=ancestor::aside[1]",
    ];
    for (const xp of ancestorXpaths) {
      const host = searchFirst.locator(xp).first();
      if (!(await host.isVisible().catch(() => false))) continue;
      const hasRow =
        (await host.locator('[data-e2e*="sound"]').count().catch(() => 0)) > 0 ||
        (await host.getByRole("option").count().catch(() => 0)) > 0;
      if (hasRow) {
        ctx.flow("[music] panel root: search ancestor with rows (fallback)");
        return host;
      }
    }
  }

  return null;
}

type SoundPanelReady =
  | { mode: "search"; searchInput: PwLocator; panelRoot: PwLocator }
  | { mode: "list"; panelRoot: PwLocator };

async function waitForSoundPanelReady(
  page: Page,
  ctx: FlowContext,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SoundPanelReady | null> {
  const deadline = Date.now() + timeoutMs;
  let lastDiagTs = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      ctx.flow("[music] panel wait: aborted (sound budget)");
      return null;
    }
    const panelRoot = await resolveSoundPanelRoot(page, ctx);
    if (!panelRoot) {
      const now = Date.now();
      if (now - lastDiagTs > 2500) {
        const dialogs = await page.locator('[role="dialog"]:visible').count().catch(() => 0);
        const asides = await page.locator("aside:visible").count().catch(() => 0);
        const drawers = await page.locator(TIKTOK_MUSIC_FLOW_SELECTORS.panel_drawer).count().catch(() => 0);
        const searchInputs = await page
          .locator('input[placeholder*="Search" i], input[placeholder*="search" i], input[type="search"]')
          .count()
          .catch(() => 0);
        const soundE2e = await page.locator('[data-e2e*="sound"]').count().catch(() => 0);
        const options = await page.getByRole("option").count().catch(() => 0);
        ctx.flow(
          `[music] panel wait: no root yet (dialogs=${dialogs}, asides=${asides}, drawers=${drawers}, searchInputs=${searchInputs}, soundE2E=${soundE2e}, options=${options})`
        );
        lastDiagTs = now;
      }
      await page.waitForTimeout(220);
      continue;
    }

    const searchInPanel = panelRoot
      .locator('input[placeholder*="Search" i], input[placeholder*="search" i], input[type="search"]')
      .first();
    if (await searchInPanel.isVisible().catch(() => false)) {
      ctx.flow("[music] panel: search (flexible layout)");
      return { mode: "search", searchInput: searchInPanel, panelRoot };
    }

    const textInPanel = panelRoot.locator("input[type='text'], input[type='search']").first();
    if (await textInPanel.isVisible().catch(() => false)) {
      ctx.flow("[music] panel: text/search input in root");
      return { mode: "search", searchInput: textInPanel, panelRoot };
    }

    const soundRows = panelRoot.locator('[data-e2e*="sound"]');
    if ((await soundRows.count()) > 0 && (await soundRows.first().isVisible().catch(() => false))) {
      ctx.flow("[music] panel: list-first (sound rows)");
      return { mode: "list", panelRoot };
    }

    const opt = panelRoot.getByRole("option").first();
    if (await opt.isVisible().catch(() => false)) {
      ctx.flow("[music] panel: list-first (options)");
      return { mode: "list", panelRoot };
    }

    await page.waitForTimeout(220);
  }
  ctx.flow("[music] panel wait timeout");
  return null;
}

async function coerceListPanelToSearch(
  page: Page,
  panel: SoundPanelReady,
  ctx: FlowContext
): Promise<SoundPanelReady> {
  if (panel.mode === "search") return panel;
  const inp = panel.panelRoot
    .locator('input[placeholder*="Search" i], input[placeholder*="search" i], input[type="search"], input[type="text"]')
    .first();
  if (await inp.isVisible({ timeout: 3000 }).catch(() => false)) {
    ctx.flow("[music] list panel exposes search — enabling fallback searches");
    return { mode: "search", searchInput: inp, panelRoot: panel.panelRoot };
  }
  return panel;
}

async function waitForSoundResultsInRoot(
  page: Page,
  panelRoot: PwLocator,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const e2e = panelRoot.locator('[data-e2e*="sound"]');
    if ((await e2e.count()) > 0 && (await e2e.first().isVisible().catch(() => false))) return;
    const opt = panelRoot.getByRole("option").first();
    if (await opt.isVisible().catch(() => false)) return;
    const row = panelRoot.locator('[role="listbox"] button, [role="grid"] button').first();
    if (await row.isVisible().catch(() => false)) return;
    await page.waitForTimeout(220);
  }
  throw new Error("Sound results not visible in time");
}

async function panelShowsNoResults(panelRoot: PwLocator): Promise<boolean> {
  const noResults = panelRoot
    .locator("text=/no results|no sounds found|no songs found|couldn't find|not available/i")
    .first();
  return noResults.isVisible().catch(() => false);
}

async function isNoSoundResults(panelRoot: PwLocator): Promise<boolean> {
  if (await panelShowsNoResults(panelRoot)) return true;
  const raw = await harvestSoundCandidates(panelRoot).catch(() => [] as { loc: PwLocator; text: string }[]);
  return raw.length === 0;
}

async function panelHasVisibleSoundResults(panelRoot: PwLocator): Promise<boolean> {
  const e2e = panelRoot.locator('[data-e2e*="sound"]').first();
  if (await e2e.isVisible().catch(() => false)) return true;
  const opt = panelRoot.getByRole("option").first();
  if (await opt.isVisible().catch(() => false)) return true;
  const row = panelRoot.locator('[role="listbox"] button, [role="grid"] button').first();
  return row.isVisible().catch(() => false);
}

function isStaticSuggestionTab(text: string): boolean {
  return /^(favorites|unlimited|for you|recommended|trending)$/i.test(text.trim());
}

async function resolveSuggestionRoots(searchInput: PwLocator, panelRoot: PwLocator): Promise<PwLocator[]> {
  const roots: PwLocator[] = [];
  const candidates = [
    searchInput.page().locator('.Dropdown__content:visible .MusicPanelSugList__wrap').last(),
    searchInput.page().locator('.Dropdown__content:visible').last(),
    searchInput.page().locator('.MusicPanelSugList__wrap:visible').last(),
    searchInput.locator(
      'xpath=ancestor::*[self::div or self::section][1]/following-sibling::*[1]'
    ).first(),
    searchInput.locator(
      'xpath=ancestor::*[self::div or self::section][2]/following-sibling::*[1]'
    ).first(),
    searchInput.locator(
      'xpath=ancestor::*[self::div or self::section][1]/parent::*'
    ).first(),
    panelRoot.locator('[role="listbox"]').first(),
    panelRoot.locator('ul, [class*="suggest" i], [class*="auto" i], [class*="dropdown" i]').first(),
    panelRoot,
  ];

  for (const root of candidates) {
    if (!(await root.isVisible().catch(() => false))) continue;
    roots.push(root);
  }

  return roots;
}

async function harvestSearchSuggestions(
  searchInput: PwLocator,
  panelRoot: PwLocator
): Promise<{ loc: PwLocator; text: string }[]> {
  const out: { loc: PwLocator; text: string }[] = [];
  const seen = new Set<string>();

  const tryHarvest = async (rows: PwLocator) => {
    const n = await rows.count();
    for (let i = 0; i < Math.min(n, 20); i++) {
      const el = rows.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const line = text.split("\n")[0]?.trim() || text;
      if (line.length < 4 || line.length > 120) continue;
      if (ROW_SKIP_LABEL.test(line)) continue;
      if (isBadSoundLabel(line)) continue;
      if (isStaticSuggestionTab(line)) continue;
      const role = ((await el.getAttribute("role").catch(() => null)) || "").trim().toLowerCase();
      if (role === "tab") continue;
      const ariaSelected = ((await el.getAttribute("aria-selected").catch(() => null)) || "").trim().toLowerCase();
      if (ariaSelected === "true" && isStaticSuggestionTab(line)) continue;
      const key = normalizeMusicText(line);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ loc: el, text: line });
      if (out.length >= 8) return;
    }
  };

  const roots = await resolveSuggestionRoots(searchInput, panelRoot);
  for (const root of roots) {
    await tryHarvest(root.locator('.MusicPanelSugList__item'));
    if (out.length >= 5) break;
    await tryHarvest(root.locator('[role="option"]'));
    if (out.length >= 5) break;
    await tryHarvest(
      root.locator(
        'li, a, button, [role="button"], [data-e2e*="search" i], [class*="suggest" i] > *'
      )
    );
    if (out.length >= 5) break;
  }
  return out.slice(0, 8);
}

async function clickSuggestionFromDom(
  page: Page,
  musicQuery: string,
  typedSoFar: string,
  ctx: FlowContext
): Promise<boolean> {
  const normalizedQuery = normalizeMusicText(musicQuery);
  const typed = normalizeMusicText(typedSoFar);

  const domSuggestions = await page
    .evaluate(({ query, typedValue }) => {
      const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
      const isVisible = (el: Element) => {
        const node = el as HTMLElement;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const nodes = Array.from(document.querySelectorAll(".Dropdown__content .MusicPanelSugList__item"));
      const visibleNodes = nodes.filter((el) => isVisible(el));
      const rows = visibleNodes
        .map((el, index) => ({
          index,
          text: normalize((el.textContent || "").replace(/\s+/g, " ")),
        }))
        .filter((row) => row.text.length > 0);

      const lowQuality = (text: string) =>
        /\b(lyrics?|lyric video|cover|edit|sped up|slowed|instrumental|karaoke|8d|reverb|remix|video|live|letra)\b/i.test(text);

      const scored = rows
        .map((row) => {
          let score = 0;
          if (row.text === query) score += 300;
          else if (row.text.startsWith(query)) score += 180;
          else if (row.text.includes(query)) score += 120;
          if (typedValue && row.text.includes(typedValue)) score += 40;
          if (lowQuality(row.text)) score -= 60;
          return { ...row, score };
        })
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (!best || best.score < 80) {
        return {
          clicked: false,
          suggestions: scored.slice(0, 5).map((s) => s.text),
        };
      }

      const target = visibleNodes[best.index] as HTMLElement | undefined;
      if (!target) {
        return {
          clicked: false,
          suggestions: scored.slice(0, 5).map((s) => s.text),
        };
      }

      target.click();
      return {
        clicked: true,
        text: best.text,
        suggestions: scored.slice(0, 5).map((s) => s.text),
      };
    }, { query: normalizedQuery, typedValue: typed })
    .catch(() => ({ clicked: false as const, suggestions: [] as string[] }));

  if (!domSuggestions.clicked) {
    if (domSuggestions.suggestions.length === 0) {
      ctx.flow(`[music] suggestions: none visible for "${typedSoFar.slice(0, 40)}"`);
    } else {
      ctx.flow(
        `[music] dom suggestions: ${domSuggestions.suggestions
          .slice(0, 3)
          .map((s) => `"${s.slice(0, 40)}"`)
          .join(" · ")}`
      );
    }
    return false;
  }

  ctx.flow(`[music] suggestion clicked via DOM: "${(domSuggestions.text || "").slice(0, 80)}"`);
  await musicDebugShot(ctx, page, "step-music-suggestion-clicked.png");
  await page.waitForTimeout(scaledMusicRand(280, 480));
  return true;
}

async function tryClickMatchingSuggestion(
  page: Page,
  searchInput: PwLocator,
  panelRoot: PwLocator,
  musicQuery: string,
  typedSoFar: string,
  ctx: FlowContext
): Promise<boolean> {
  const domClicked = await clickSuggestionFromDom(page, musicQuery, typedSoFar, ctx);
  if (domClicked) return true;

  const suggestions = await harvestSearchSuggestions(searchInput, panelRoot);
  if (suggestions.length === 0) {
    ctx.flow(`[music] suggestions: none visible for "${typedSoFar.slice(0, 40)}"`);
    return false;
  }

  const typed = normalizeMusicText(typedSoFar);
  const ranked = suggestions
    .map((s) => ({ ...s, score: scoreSuggestionCandidate(musicQuery, s.text) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  ctx.flow(
    `[music] suggestions(raw): ${suggestions
      .slice(0, 6)
      .map((s) => `"${s.text.slice(0, 40)}"`)
      .join(" · ")}`
  );
  ctx.flow(
    `[music] suggestions: ${ranked
      .slice(0, 3)
      .map((s) => `${s.score.toFixed(0)}:"${s.text.slice(0, 40)}"`)
      .join(" · ")}`
  );

  const bestNorm = normalizeMusicText(best.text);
  const containsDesired = suggestionContainsDesiredMusic(musicQuery, best.text);
  const variantPenalty = isLowQualitySuggestion(best.text);
  const goodEnough =
    typed.length >= Math.max(5, Math.floor(normalizeMusicText(musicQuery).length * 0.28)) &&
    (
      containsDesired ||
      (
        best.score >= MUSIC_SUGGESTION_CLICK_MIN_SCORE &&
        !variantPenalty &&
        (bestNorm.includes(typed) || bestNorm.startsWith(typed) || typed.includes(bestNorm))
      )
    );

  if (!goodEnough) {
    ctx.flow(
      `[music] suggestion skipped: best="${best.text.slice(0, 80)}" containsDesired=${containsDesired} variantPenalty=${variantPenalty} typed="${typed.slice(0, 40)}"`
    );
    return false;
  }

  await page.waitForTimeout(scaledMusicRand(100, 220));
let clickable = best.loc.locator(
  'button, [role="button"]'
).first();

if (!(await clickable.count())) {
  clickable = best.loc; // fallback
}
  await clickable.scrollIntoViewIfNeeded().catch(() => {});

try {
  await clickable.click({ force: true });
} catch {
  const box = await clickable.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.click(
      box.x + box.width / 2,
      box.y + box.height / 2
    ).catch(() => {});
  }
}

  ctx.flow(`[music] suggestion clicked: "${best.text.slice(0, 80)}"`);
  const afterClickValue = await searchInput.inputValue().catch(() => "");
  ctx.flow(`[music] suggestion click -> input value now: "${(afterClickValue || "").slice(0, 80)}"`);
  await musicDebugShot(ctx, page, "step-music-suggestion-clicked.png");

  // TikTok autocomplete can replace the input with something unrelated after a
  // suggestion click.  If that happened, overwrite the input with the original query
  // so the subsequent Enter searches for the right thing.
  const afterNorm = normalizeMusicText(afterClickValue || "");
  const queryNorm = normalizeMusicText(musicQuery);
  const bestNormAfter = normalizeMusicText(best.text);
  if (
    afterNorm &&
    afterNorm !== queryNorm &&
    afterNorm !== bestNormAfter &&
    !afterNorm.includes(queryNorm) &&
    !queryNorm.includes(afterNorm)
  ) {
    ctx.flow(`[music] suggestion replaced input with unrelated value — restoring original query`);
    await searchInput.click({ force: true }).catch(() => {});
    const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
    await searchInput.press(selectAll).catch(() => {});
    await searchInput.press("Backspace").catch(() => {});
    await page.waitForTimeout(scaledMusicRand(60, 120));
    await searchInput.fill(musicQuery).catch(async () => {
      await searchInput.type(musicQuery, { delay: scaledMusicRand(4, 12) });
    });
    await page.waitForTimeout(scaledMusicRand(200, 400));
  }

  await page.waitForTimeout(scaledMusicRand(700, 1200));
  return true;
}

const ROW_SKIP_LABEL = /^(close|cancel|back)$/i;

async function harvestSoundCandidates(
  panelRoot: PwLocator,
  ctx?: FlowContext
): Promise<{ loc: PwLocator; text: string }[]> {
  const out: { loc: PwLocator; text: string }[] = [];
  const seen = new Set<string>();

  const tryHarvest = async (rows: PwLocator) => {
    const n = await rows.count();
    for (let i = 0; i < Math.min(n, 24); i++) {
      const el = rows.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const text = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      const line = text.split("\n")[0]?.trim() || text;
      if (line.length < 2 || text.length > 240) continue;
      if (ROW_SKIP_LABEL.test(line)) continue;
      if (isBadSoundLabel(text)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      // IMPORTANT: keep the *row root* as the candidate locator.
      // Clicking a global "+" elsewhere can add the wrong sound (often the 3rd row).
      out.push({
        loc: el,
        text,
      });
      if (out.length >= 8) return;
    }
  };

  await tryHarvest(panelRoot.locator('[data-e2e*="sound"]'));
  if (out.length < 5) await tryHarvest(panelRoot.getByRole("option"));
  if (out.length < 5) {
    await tryHarvest(panelRoot.locator('[role="listbox"] button, [role="grid"] button, [role="listbox"] a'));
  }

  const sliced = out.slice(0, 8);
  if (ctx) {
    if (sliced.length === 0) {
      ctx.flow("[music][audio] harvested rows: none (no visible sound/option rows in panel)");
    } else {
      const lines = sliced.map((o, i) => {
        const t = o.text.replace(/\s+/g, " ").trim();
        const short = t.length > 90 ? `${t.slice(0, 90)}…` : t;
        return `#${i + 1} "${short}"`;
      });
      ctx.flow(`[music][audio] harvested ${sliced.length} visible row(s): ${lines.join(" | ")}`);
    }
  }
  return sliced;
}

function rankTopFiveScored(
  raw: { loc: PwLocator; text: string }[],
  musicQuery: string,
  ctx?: FlowContext
): { loc: PwLocator; text: string; score: number; index: number }[] {
  const ranked = raw
    .filter((c) => !isBadSoundLabel(c.text))
    .map((c, index) => ({ ...c, index, score: scoreSoundMatch(musicQuery, c.text) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, 5);

  if (ctx && ranked.length > 0) {
    const qShort = musicQuery.trim().slice(0, 80);
    const rows = ranked.map((r, rank) => {
      const lbl = r.text.replace(/\s+/g, " ").trim();
      const short = lbl.length > 70 ? `${lbl.slice(0, 70)}…` : lbl;
      const why = explainSoundMatch(musicQuery, r.text);
      return `#${rank + 1} score=${r.score.toFixed(0)} listPos=${r.index + 1} "${short}" (${why})`;
    });
    ctx.flow(`[music][audio] ranked vs query "${qShort}" (top ${ranked.length}): ${rows.join(" || ")}`);
    const best = ranked[0];
    const second = ranked[1];
    const tieNote =
      second && second.score === best.score
        ? `tie on score ${best.score.toFixed(0)} — picked earlier list row (listPos ${best.index + 1} before ${second.index + 1})`
        : `winner: highest score ${best.score.toFixed(0)}`;
    ctx.flow(`[music][audio] pick: ${tieNote}`);
  }

  return ranked;
}

async function runSearchInPanel(
  page: Page,
  searchInput: PwLocator,
  panelRoot: PwLocator,
  term: string,
  ctx: FlowContext,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  await searchInput.click({ force: true }).catch(() => {});
  const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await searchInput.press(selectAll).catch(() => {});
  await searchInput.press("Backspace").catch(() => {});
  await page.waitForTimeout(scaledMusicRand(90, 180));

  const isLongOrIdLike = term.length >= 26 || /\d{8,}/.test(term) || (term.includes("-") && /\d/.test(term));
  if (isLongOrIdLike) {
    const short = term.length > 70 ? `${term.slice(0, 70)}…` : term;
    ctx.flow(`[music] search (fast fill): "${short}"`);
    await searchInput.fill(term).catch(async () => {
      // Some Studio builds block fill(); fall back to typing quickly.
      await searchInput.type(term, { delay: scaledMusicRand(2, 8) });
    });
    await page.waitForTimeout(scaledMusicRand(180, 380));
    await searchInput.press("Enter").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(scaledMusicRand(320, 580));
    // Click panel body to dismiss suggestion dropdown (Escape would close the panel)
    await panelRoot.click({ position: { x: 10, y: 10 }, force: true }).catch(() => {});
    return;
  }

  let typed = "";
  const normalizedTarget = normalizeMusicText(term);
  for (let i = 0; i < term.length; i++) {
    throwIfAborted(signal);
    const ch = term[i];
    await searchInput.type(ch, { delay: scaledMusicRand(55, 110) });
    typed += ch;
    await page.waitForTimeout(scaledMusicRand(80, 160));

    const trimmed = typed.trim();
    if (trimmed.length < 6) continue;
    const shouldProbe = /\s/.test(ch) || i === term.length - 1 || i % 4 === 3;
    if (!shouldProbe) continue;

    await page.waitForTimeout(scaledMusicRand(110, 240));
    const clickedSuggestion = await tryClickMatchingSuggestion(page, searchInput, panelRoot, term, trimmed, ctx);
    if (clickedSuggestion) {
      // Submit to ensure results load and suggestion dropdown collapses.
      await searchInput.press("Enter").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      ctx.flow("[music] search: pressed Enter after suggestion click");
      await page.waitForTimeout(scaledMusicRand(260, 480));
      await panelRoot.click({ position: { x: 10, y: 10 }, force: true }).catch(() => {});
      return;
    }

    const inputValue = normalizeMusicText(await searchInput.inputValue().catch(() => ""));
    if (inputValue && inputValue === normalizedTarget && (await panelHasVisibleSoundResults(panelRoot))) {
      ctx.flow("[music] exact query reached with visible results");
      return;
    }
  }

  const short = term.length > 70 ? `${term.slice(0, 70)}…` : term;
  ctx.flow(`[music] search: "${short}"`);
  const typedValue = await searchInput.inputValue().catch(() => "");
  ctx.flow(`[music] search input value now: "${(typedValue || "").slice(0, 80)}"`);
  await page.waitForTimeout(scaledMusicRand(380, 650));
  await page.waitForTimeout(scaledMusicRand(240, 420));
  // Always submit the query with Enter to collapse the suggestions dropdown.
  await searchInput.press("Enter").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  ctx.flow("[music] search: pressed Enter");
  await page.waitForTimeout(scaledMusicRand(280, 480));

  // If still no visible results and no explicit "no results" message, press Enter again.
  if (!(await panelHasVisibleSoundResults(panelRoot)) && !(await panelShowsNoResults(panelRoot))) {
    await searchInput.press("Enter").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    ctx.flow("[music] search: pressed Enter fallback");
    await page.waitForTimeout(scaledMusicRand(380, 650));
  }

  // Dismiss suggestions dropdown by clicking the panel body (Escape would close the entire panel).
  await panelRoot.click({ position: { x: 10, y: 10 }, force: true }).catch(() => {});
  await page.waitForTimeout(200);
}

async function isSoundPickerUiOpen(page: Page): Promise<boolean> {
  const dialogs = page.locator('[role="dialog"]:visible');
  const n = await dialogs.count();
  for (let i = 0; i < n; i++) {
    const t = ((await dialogs.nth(i).innerText().catch(() => "")) || "").slice(0, 500);
    if (/sound|music|trending|search sounds|recommended sounds/i.test(t)) return true;
  }
  const aside = page.locator("aside:visible").filter({ hasText: /sound|search|trending|music/i }).first();
  if (await aside.isVisible().catch(() => false)) return true;
  const drawer = page
    .locator(TIKTOK_MUSIC_FLOW_SELECTORS.panel_drawer)
    .filter({ hasText: /sound|search|trending|music/i })
    .first();
  if (await drawer.isVisible().catch(() => false)) return true;
  return false;
}

async function waitForSoundPickersClosed(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isSoundPickerUiOpen(page))) return true;
    await page.waitForTimeout(350);
  }
  return false;
}

/**
 * After the sound picker closes, TikTok shows the applied sound title
 * near the "Sounds" button or in a label/row in the composer.
 */
async function readAppliedSoundFromComposer(page: Page): Promise<string | null> {
  // TikTok usually shows the sound name near the Sounds button or in a marquee/label
  const candidates = [
    page.locator('[data-e2e*="sound" i] + *, [data-e2e*="sound" i] ~ *').first(),
    page.locator('[class*="sound-name" i], [class*="SoundName" i], [class*="music-name" i]').first(),
    page.locator('[class*="marquee" i]').first(),
    page.getByText(/^♫/).first(),
    page.locator('[data-e2e*="music" i]').first(),
  ];
  for (const loc of candidates) {
    const text = ((await loc.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (text && text.length > 2 && text.length < 200 && !/^(sounds?|music|add sound|select)$/i.test(text)) {
      return text;
    }
  }
  // Fallback: look for any text near the Sounds button
  const soundsBtn = page.getByRole("button", { name: /^sounds$/i }).first();
  if (await soundsBtn.isVisible().catch(() => false)) {
    const sibling = soundsBtn.locator("xpath=following-sibling::*[1]").first();
    const txt = ((await sibling.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (txt && txt.length > 2 && txt.length < 200) return txt;
  }
  return null;
}

async function verifySoundAppliedStrict(
  page: Page,
  musicQuery: string,
  ctx: FlowContext,
  selectedRowText?: string
): Promise<boolean> {
  const closedOk = await waitForSoundPickersClosed(page, 20000);
  if (!closedOk) {
    ctx.flow("[music] verify: sound picker UI still open");
    return false;
  }

  const tryToken = async (tok: string): Promise<boolean> => {
    if (tok.length < 2) return false;
    const hit = page.getByText(new RegExp(escapeRegExp(tok.slice(0, 72)), "i")).first();
    return hit.isVisible({ timeout: 6000 }).catch(() => false);
  };

  const queryTokens = tokenizeForSoundMatch(musicQuery);
  const rowTokens = selectedRowText ? tokenizeForSoundMatch(selectedRowText).slice(0, 4) : [];
  const ordered = [...queryTokens, ...rowTokens, musicQuery.trim().slice(0, 40)].filter(Boolean);

  for (const tok of ordered) {
    if (await tryToken(tok)) {
      ctx.debug(`[music] verify: matched token "${tok.slice(0, 40)}"`);
      return true;
    }
  }

  const alt = page.getByText(/original sound|sound\s*:/i).first();
  if (await alt.isVisible({ timeout: 5000 }).catch(() => false)) {
    ctx.debug("[music] verify: generic sound label");
    return true;
  }

  const qLow = musicQuery.trim().toLowerCase();
  if ((REGION_FALLBACK_SEARCHES as readonly string[]).includes(qLow)) {
    ctx.flow("[music] verify: picker closed (generic region query — no title required)");
    return true;
  }

  ctx.flow("[music] verify: picker closed but no sound title matched");
  return false;
}

async function dismissOpenSoundUi(page: Page, ctx: FlowContext): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(450);
  await page.keyboard.press("Escape").catch(() => {});
  const x = page.getByRole("button", { name: /close|cancel/i }).first();
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) {
    await x.click({ force: true }).catch(() => {});
  }
  await page.waitForTimeout(500);
}

async function waitForVideoPreviewStableBeforeSound(page: Page, ctx: FlowContext, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  const deadline = Date.now() + timeoutMs;
  const pollMs = Math.max(250, Number(process.env.TIKTOK_MUSIC_PREVIEW_POLL_MS || 380));
  let polls = 0;
  let exit: "media_ready" | "caption_soft" | "timeout" = "timeout";
  ctx.flow("[music] wait: preview / stable composer before opening sound");
  while (Date.now() < deadline) {
    polls += 1;
    const vidOk = await page.locator("video").first().isVisible().catch(() => false);
    const canvasOk = await page.locator("canvas").first().isVisible().catch(() => false);
    const busy = await page
      .getByText(/uploading|processing video|preparing your video|please wait/i)
      .first()
      .isVisible()
      .catch(() => false);
    const captionOk = await page.locator('[contenteditable="true"]').first().isVisible().catch(() => false);
    if (!busy && captionOk && (vidOk || canvasOk)) {
      ctx.flow("[music] ready: media + caption, no busy copy");
      exit = "media_ready";
      break;
    }
    if (!busy && captionOk) {
      ctx.flow("[music] ready: caption + no busy copy (soft)");
      exit = "caption_soft";
      break;
    }
    await page.waitForTimeout(pollMs);
  }
  if (exit === "timeout") {
    ctx.flow("[music] preview wait timed out — opening sound anyway");
  }
  const ms = Date.now() - t0;
  flowTiming(
    ctx,
    "music",
    "music_preview_wait",
    ms,
    exit === "timeout"
      ? `hit cap waiting for video/canvas + caption (still polling each ~${pollMs}ms)`
      : exit === "media_ready"
        ? "video or canvas visible with caption and no busy copy"
        : "caption visible, no busy copy (soft gate)",
    `polls=${polls} TIKTOK_MUSIC_PREVIEW_POLL_MS=${pollMs} capMs=${timeoutMs} HUMAN_TIMING_SCALE=${getHumanTimingScale()}`
  );
}

async function trySelectCachedSound(
  page: Page,
  workingPanel: SoundPanelReady,
  cached: CachedSoundEntry,
  ctx: FlowContext,
  signal?: AbortSignal
): Promise<{ loc: PwLocator; text: string } | null> {
  if (workingPanel.mode !== "search") return null;
  const short = cached.label.length > 64 ? `${cached.label.slice(0, 64)}…` : cached.label;
  ctx.flow(`[music] cache hit — quick search: "${short}"`);
  await runSearchInPanel(page, workingPanel.searchInput, workingPanel.panelRoot, cached.label, ctx, signal);
  try {
    await waitForSoundResultsInRoot(page, workingPanel.panelRoot, 12000, signal);
  } catch {
    return null;
  }
  const raw = await harvestSoundCandidates(workingPanel.panelRoot, ctx);
  if (raw.length === 0) return null;
  const cl = cached.label.toLowerCase();
  const prefer = raw.find(
    (r) =>
      r.text.toLowerCase().includes(cl) ||
      (cl.length > 6 && cl.includes(r.text.toLowerCase().slice(0, Math.min(40, r.text.length))))
  );
  if (prefer) {
    ctx.flow(
      `[music][audio] cache path: picked row whose text overlaps cached label (no re-rank): "${prefer.text.replace(/\s+/g, " ").slice(0, 80)}"`
    );
    return { loc: prefer.loc, text: prefer.text };
  }
  const ranked = rankTopFiveScored(raw, cached.label, ctx);
  if (ranked.length === 0) return null;
  if (ranked[0].score >= MUSIC_PRIMARY_MIN_SCORE) return { loc: ranked[0].loc, text: ranked[0].text };
  return null;
}

async function pickBestSoundFromPanel(
  page: Page,
  workingPanel: SoundPanelReady,
  musicQuery: string,
  ctx: FlowContext,
  signal?: AbortSignal
): Promise<{ loc: PwLocator; text: string } | null> {
  const q = musicQuery.trim();
  const searchTerms = buildMusicSearchTerms(q);

  const wp = workingPanel;

  const shuffledFallbackKeywords = (() => {
    const arr = [...FALLBACK_SOUND_KEYWORDS];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  })();

  const pickRelaxedFromPanel = async (): Promise<{ loc: PwLocator; text: string } | null> => {
    const raw = await harvestSoundCandidates(wp.panelRoot, ctx);
    for (const c of raw) {
      throwIfAborted(signal);
      const t = (c.text || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (/original\s+sound/i.test(t)) continue;
      if (isBadSoundLabel(t)) continue;
      const visible = await c.loc.isVisible().catch(() => false);
      if (!visible) continue;
      return { loc: c.loc, text: t };
    }
    return null;
  };

  let primaryFailed = false;
  if (searchTerms.length > 0) {
    throwIfAborted(signal);
    const term = searchTerms[0];
    try {
      if (wp.mode === "search") {
        const currentValue = normalizeMusicText(await wp.searchInput.inputValue().catch(() => ""));
        const desired = normalizeMusicText(term);
        const alreadySearched =
          currentValue && currentValue === desired && ((await panelHasVisibleSoundResults(wp.panelRoot)) || (await panelShowsNoResults(wp.panelRoot)));

        if (!alreadySearched) {
          await runSearchInPanel(page, wp.searchInput, wp.panelRoot, term, ctx, signal);
          if (flowDebugOn()) await musicDebugShot(ctx, page, "step-music-search.png");
          try {
            await waitForSoundResultsInRoot(page, wp.panelRoot, 20000, signal);
          } catch {
            // continue; we may have a visible "No results" or rows that harvest can still find.
          }
        } else {
          ctx.flow("[music] primary search already in input — skipping retype");
        }
      } else {
        await waitForSoundResultsInRoot(page, wp.panelRoot, 16000, signal);
      }

      const noResults = await isNoSoundResults(wp.panelRoot);
      const raw = await harvestSoundCandidates(wp.panelRoot, ctx);
      if (noResults || raw.length === 0) {
        ctx.flow("[music] primary search failed → switching to fallback");
        primaryFailed = true;
      } else {
        const ranked = rankTopFiveScored(raw, q, ctx);
        if (ranked.length === 0) {
          ctx.flow("[music] primary search failed → switching to fallback");
          primaryFailed = true;
        } else {
          if (ranked[0].score >= MUSIC_PRIMARY_MIN_SCORE) {
            ctx.flow(
              `[music][audio] primary search: score ${ranked[0].score.toFixed(0)} ≥ ${MUSIC_PRIMARY_MIN_SCORE} — using this row`
            );
            return { loc: ranked[0].loc, text: ranked[0].text };
          }
          ctx.flow("[music] primary search failed → switching to fallback");
          primaryFailed = true;
        }
      }
    } catch (e) {
      if (signal?.aborted || (e instanceof Error && e.message === "SOUND_FLOW_TIMEOUT")) {
        return null;
      }
      if (isClosedTargetError(e)) {
        ctx.flow("[music] search wave stopped: page/context closed");
        return null;
      }
      ctx.flow(`[music] primary search error: ${e instanceof Error ? e.message : String(e)}`);
      ctx.flow("[music] primary search failed → switching to fallback");
      primaryFailed = true;
    }
  }

  if (primaryFailed) {
    if (wp.mode !== "search") {
      const relaxed = await pickRelaxedFromPanel().catch(() => null);
      if (relaxed) {
        ctx.flow(`[music] fallback selected: ${relaxed.text}`);
        return relaxed;
      }
      return null;
    }

    const attempts = shuffledFallbackKeywords.slice(0, 5);
    for (const keyword of attempts) {
      throwIfAborted(signal);
      ctx.flow(`[music] trying fallback: ${keyword}`);
      try {
        await runSearchInPanel(page, wp.searchInput, wp.panelRoot, keyword, ctx, signal);
        try {
          await waitForSoundResultsInRoot(page, wp.panelRoot, 14000, signal);
        } catch {
          // proceed to harvest; UI may still render candidates without tripping our row visibility checks.
        }
        if (await isNoSoundResults(wp.panelRoot)) continue;
        const relaxed = await pickRelaxedFromPanel().catch(() => null);
        if (relaxed) {
          ctx.flow(`[music] fallback selected: ${relaxed.text}`);
          return relaxed;
        }
      } catch (e) {
        if (signal?.aborted || (e instanceof Error && e.message === "SOUND_FLOW_TIMEOUT")) {
          return null;
        }
        if (isClosedTargetError(e)) {
          ctx.flow("[music] search wave stopped: page/context closed");
          return null;
        }
        ctx.flow(`[music] fallback search error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  for (let si = 0; si < searchTerms.length; si++) {
    throwIfAborted(signal);
    const term = searchTerms[si];
    try {
      if (si === 0) continue;
      if (wp.mode === "search") {
        await runSearchInPanel(page, wp.searchInput, wp.panelRoot, term, ctx, signal);
        if (flowDebugOn() && si === 0) await musicDebugShot(ctx, page, "step-music-search.png");
        await waitForSoundResultsInRoot(page, wp.panelRoot, 24000, signal);
      } else {
        if (si > 0) {
          ctx.flow("[music] cannot run fallback search on pure list panel");
          break;
        }
        await waitForSoundResultsInRoot(page, wp.panelRoot, 20000, signal);
      }

      const raw = await harvestSoundCandidates(wp.panelRoot, ctx);
      if (raw.length === 0) {
        ctx.flow(`[music] no candidate rows (term index ${si})`);
        continue;
      }

      const ranked = rankTopFiveScored(raw, q, ctx);
      if (ranked.length === 0) {
        ctx.flow(`[music] all candidates filtered as bad sounds (term index ${si})`);
        continue;
      }

      if (si === 0) {
        if (ranked[0].score >= MUSIC_PRIMARY_MIN_SCORE) {
          ctx.flow(`[music][audio] term index ${si}: best score ${ranked[0].score.toFixed(0)} ≥ ${MUSIC_PRIMARY_MIN_SCORE} — selecting`);
          return { loc: ranked[0].loc, text: ranked[0].text };
        }
        ctx.flow(`[music] weak primary (best ${ranked[0].score.toFixed(0)} < ${MUSIC_PRIMARY_MIN_SCORE}) → trending / viral`);
        continue;
      }

      ctx.flow(`[music][audio] fallback term index ${si}: selecting best-scored row after extra search`);
      return { loc: ranked[0].loc, text: ranked[0].text };
    } catch (e) {
      if (isClosedTargetError(e)) {
        ctx.flow("[music] search wave stopped: page/context closed");
        break;
      }
      ctx.flow(`[music] search wave error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return null;
}

async function clickApplySoundIfPresent(page: Page, ctx: FlowContext, timeoutMs: number): Promise<boolean> {
  const patterns = [/use this sound/i, /use sound/i, /^confirm$/i, /^done$/i, /confirm/i, /done/i];
  const deadline = Date.now() + timeoutMs;
  const frontDialog = page.locator('[role="dialog"]:visible').last();
  ctx.flow(
    "[music][audio] apply pass: poll for Save / Use sound / Confirm / Done / dialog PlusBold (after row selection)"
  );

  while (Date.now() < deadline) {
    const plusInDialog = frontDialog
      .locator(PLUS_BTN_CSS)
      .first();
    if ((await plusInDialog.isVisible().catch(() => false)) && !(await plusInDialog.isDisabled().catch(() => true))) {
      await plusInDialog.click({ force: true }).catch(() => {});
      ctx.flow(
        "[music][audio] clicked: PlusBold in front visible dialog — TikTok sometimes needs this before Save/Use"
      );
      await page.waitForTimeout(120);
    }

    const saveInDialog = frontDialog.getByRole("button", { name: /^save$/i }).first();
    if ((await saveInDialog.isVisible().catch(() => false)) && !(await saveInDialog.isDisabled().catch(() => true))) {
      await saveInDialog.click({ force: true }).catch(() => {});
      ctx.flow("[music][audio] clicked: Save in front dialog — confirms sound choice in modal");
      return true;
    }
    const saveGlobal = page.getByRole("button", { name: /^save$/i }).first();
    if ((await saveGlobal.isVisible().catch(() => false)) && !(await saveGlobal.isDisabled().catch(() => true))) {
      await saveGlobal.click({ force: true }).catch(() => {});
      ctx.flow("[music][audio] clicked: Save (first global) — modal may be detached from dialog locator");
      return true;
    }

    for (const re of patterns) {
      const scoped = frontDialog.getByRole("button", { name: re }).first();
      if ((await scoped.isVisible().catch(() => false)) && !(await scoped.isDisabled().catch(() => true))) {
        ctx.debug(`[music] apply (in dialog) ${re.source}`);
        await scoped.click({ force: true });
        ctx.flow(
          `[music][audio] clicked: dialog role=button name≈/${re.source}/i — primary apply action for this build`
        );
        return true;
      }
      const btn = page.getByRole("button", { name: re }).first();
      if ((await btn.isVisible().catch(() => false)) && !(await btn.isDisabled().catch(() => true))) {
        ctx.debug(`[music] apply (global) ${re.source}`);
        await btn.click({ force: true });
        ctx.flow(
          `[music][audio] clicked: global role=button name≈/${re.source}/i — fallback when not scoped to dialog`
        );
        return true;
      }
    }
    await page.waitForTimeout(180);
  }
  ctx.flow("[music][audio] apply: no Save/Use/Confirm/PlusBold matched within timeout — one-step UI or manual");
  return false;
}

async function clickPostConfirmDialogsIfPresent(page: Page, ctx: FlowContext, timeoutMs: number): Promise<boolean> {
  const patterns = [/^continue$/i, /continue/i, /^post now$/i, /^post$/i, /post now/i, /^confirm$/i, /^done$/i, /done/i];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frontDialog = page.locator('[role="dialog"]:visible').last();
    for (const re of patterns) {
      const btnInDialog = frontDialog.getByRole("button", { name: re }).first();
      if ((await btnInDialog.isVisible().catch(() => false)) && !(await btnInDialog.isDisabled().catch(() => true))) {
        ctx.flow(`[post] confirm: clicking dialog button /${re.source}/i`);
        await btnInDialog.click({ force: true }).catch(() => {});
        await page.waitForTimeout(380);
        return true;
      }
      const btnGlobal = page.getByRole("button", { name: re }).first();
      if ((await btnGlobal.isVisible().catch(() => false)) && !(await btnGlobal.isDisabled().catch(() => true))) {
        ctx.flow(`[post] confirm: clicking global button /${re.source}/i`);
        await btnGlobal.click({ force: true }).catch(() => {});
        await page.waitForTimeout(380);
        return true;
      }
    }
    await page.waitForTimeout(220);
  }
  return false;
}

/**
 * Fast path for current TikTok Studio sound UI:
 * search -> click first Plus button -> click Save.
 * This bypasses brittle row selectors when results are visible but not role=listbox/option.
 */
async function tryQuickAddAndSaveAfterSearch(
  page: Page,
  panelRoot: PwLocator,
  musicQuery: string,
  ctx: FlowContext,
  timeoutMs: number
): Promise<boolean> {
  await page.waitForTimeout(scaledMusicRand(280, 520));
  const raw = await harvestSoundCandidates(panelRoot, ctx);
  const ranked = rankTopFiveScored(raw, musicQuery, ctx);
  if (ranked.length === 0) {
    ctx.flow("[music] quick add: no usable candidates");
    return false;
  }

  const best = ranked[0];
  if (best.score < MUSIC_QUICK_ADD_MIN_SCORE) {
    ctx.flow(
      `[music][audio] quick-add skipped: best score ${best.score.toFixed(0)} < ${MUSIC_QUICK_ADD_MIN_SCORE}`
    );
    return false;
  }

  ctx.flow(
    `[music][audio] quick-add: PlusBold on best row (rank #1) then Save — "${best.text.replace(/\s+/g, " ").slice(0, 80)}"`
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let plusInPanel = best.loc.locator(PLUS_BTN_CSS).first();
    if (!(await plusInPanel.isVisible().catch(() => false))) {
      plusInPanel = best.loc.locator(PLUS_BTN_FALLBACK_CSS).first();
    }
    if ((await plusInPanel.isVisible().catch(() => false)) && !(await plusInPanel.isDisabled().catch(() => true))) {
      await plusInPanel.click({ force: true }).catch(() => {});
      ctx.flow(
        "[music][audio] quick-add: clicked Plus inside best row locator — adds that sound"
      );
      await page.waitForTimeout(120);

      const saveInPanel = panelRoot.getByRole("button", { name: /^save$/i }).first();
      if ((await saveInPanel.isVisible().catch(() => false)) && !(await saveInPanel.isDisabled().catch(() => true))) {
        await saveInPanel.click({ force: true }).catch(() => {});
        ctx.flow("[music][audio] quick-add: clicked Save in sound panel");
        return true;
      }

      const saveGlobal = page.getByRole("button", { name: /^save$/i }).first();
      if ((await saveGlobal.isVisible().catch(() => false)) && !(await saveGlobal.isDisabled().catch(() => true))) {
        await saveGlobal.click({ force: true }).catch(() => {});
        ctx.flow("[music][audio] quick-add: clicked Save (global role=button)");
        return true;
      }
    }

    await page.waitForTimeout(120);
  }

  ctx.flow("[music][audio] quick-add: PlusBold on best row or Save not found in time");
  return false;
}

async function tryQuickAddAndSaveRelaxedAfterSearch(
  page: Page,
  panelRoot: PwLocator,
  ctx: FlowContext,
  timeoutMs: number,
  signal?: AbortSignal,
  musicQuery?: string
): Promise<{ ok: boolean; pickedText?: string }> {
  // Wait for search results to render after Enter was pressed
  await page.waitForTimeout(scaledMusicRand(600, 1200));
  const queryNorm = normalizeMusicText(musicQuery || "");
  const queryCompact = queryNorm.replace(/[\s&+,·\-]+/g, ""); // "richthekid zeddy will" → "richthekidzeddywill"
  const queryTokens = queryNorm.split(/[\s&+,]+/).filter((t) => t.length >= 2);
  const deadline = Date.now() + timeoutMs;

  let loggedWaiting = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);

    // Strategy 1: find sound rows by data-e2e, then locate a clickable button inside each
    const soundRows = panelRoot.locator('[data-e2e*="sound"], [role="option"], li');
    const rowCount = await soundRows.count().catch(() => 0);

    // Strategy 2 (fallback): find Plus buttons directly
    let plusBtns = panelRoot.locator(PLUS_BTN_CSS);
    let plusCount = await plusBtns.count().catch(() => 0);
    if (plusCount === 0) {
      plusBtns = panelRoot.locator(PLUS_BTN_FALLBACK_CSS);
      plusCount = await plusBtns.count().catch(() => 0);
    }

    if (rowCount === 0 && plusCount === 0) {
      if (!loggedWaiting) {
        ctx.flow("[music][audio] relaxed quick-add: waiting for search results...");
        loggedWaiting = true;
      }
      await page.waitForTimeout(250);
      continue;
    }

    type ScoredRow = { index: number; btn: PwLocator; text: string; score: number };
    const rows: ScoredRow[] = [];

    // Try row-first approach (more reliable)
    if (rowCount > 0) {
      for (let i = 0; i < Math.min(rowCount, 14); i++) {
        const row = soundRows.nth(i);
        if (!(await row.isVisible().catch(() => false))) continue;
        const rowText = ((await row.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (!rowText || rowText.length < 3) continue;

        // Find any button inside the row (Plus, Add, etc.)
        let btn = row.locator(PLUS_BTN_CSS).first();
        if (!(await btn.isVisible().catch(() => false))) {
          btn = row.locator('button, [role="button"]').last();
        }
        if (!(await btn.isVisible().catch(() => false))) continue;
        if (await btn.isDisabled().catch(() => true)) continue;

        const rowNorm = normalizeMusicText(rowText);
        const rowCompact = rowNorm.replace(/[\s&+,·\-]+/g, "");
        let score = 0;
        if (queryNorm && rowNorm) {
          if (rowNorm.includes(queryNorm) || queryNorm.includes(rowNorm)) score = 100;
          else if (rowCompact.includes(queryCompact) || queryCompact.includes(rowCompact)) score = 95;
          else {
            for (const tok of queryTokens) {
              if (rowNorm.includes(tok) || rowCompact.includes(tok)) score += Math.round(100 / queryTokens.length);
            }
          }
        }
        rows.push({ index: i, btn, text: rowText, score });
      }
    }

    // Fallback: use Plus-button-first approach if row-first yielded nothing
    if (rows.length === 0 && plusCount > 0) {
      for (let i = 0; i < Math.min(plusCount, 14); i++) {
        const plus = plusBtns.nth(i);
        if (!(await plus.isVisible().catch(() => false))) continue;
        if (await plus.isDisabled().catch(() => true)) continue;

        let rowText = "";
        for (const depth of ["xpath=..", "xpath=../..", "xpath=../../..", "xpath=../../../.."]) {
          const parent = plus.locator(depth).first();
          const tag = ((await parent.evaluate((el) => el.tagName).catch(() => "")) || "").toLowerCase();
          const txt = ((await parent.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
          if (txt && txt.length > 3 && txt.length < 300) rowText = txt;
          if (tag === "li" || tag === "tr" || (tag === "div" && rowText)) break;
        }

        const rowNorm = normalizeMusicText(rowText);
        const rowCompact = rowNorm.replace(/[\s&+,·\-]+/g, "");
        let score = 0;
        if (queryNorm && rowNorm) {
          if (rowNorm.includes(queryNorm) || queryNorm.includes(rowNorm)) score = 100;
          else if (rowCompact.includes(queryCompact) || queryCompact.includes(rowCompact)) score = 95;
          else {
            for (const tok of queryTokens) {
              if (rowNorm.includes(tok) || rowCompact.includes(tok)) score += Math.round(100 / queryTokens.length);
            }
          }
        }
        rows.push({ index: i, btn: plus, text: rowText, score });
      }
    }

    if (rows.length === 0) { await page.waitForTimeout(200); continue; }

    rows.sort((a, b) => b.score - a.score);
    ctx.flow(
      `[music][audio] relaxed quick-add: ${rows.length} rows scored — ` +
      rows.slice(0, 5).map((r) => `#${r.index + 1}(${r.score}): "${r.text.slice(0, 50)}"`).join(" | ")
    );

    const pick = rows[0];
    if (queryNorm && pick.score < 30 && rows.length > 1) {
      ctx.flow(`[music][audio] relaxed quick-add: best match score ${pick.score} is low — picking anyway (no better option)`);
    }

    await pick.btn.click({ force: true }).catch(() => {});
    ctx.flow(
      `[music][audio] relaxed quick-add: clicked row #${pick.index + 1} (score ${pick.score}); "${pick.text.slice(0, 120)}${pick.text.length > 120 ? "…" : ""}"`
    );
    await page.waitForTimeout(200);

    const saveInPanel = panelRoot.getByRole("button", { name: /^save$/i }).first();
    if ((await saveInPanel.isVisible().catch(() => false)) && !(await saveInPanel.isDisabled().catch(() => true))) {
      await saveInPanel.click({ force: true }).catch(() => {});
      ctx.flow(`[music] SELECTED song #${pick.index + 1} of ${rows.length} results — "${pick.text.slice(0, 150)}" (match score: ${pick.score}/100)`);
      return { ok: true, pickedText: pick.text || undefined };
    }

    const saveGlobal = page.getByRole("button", { name: /^save$/i }).first();
    if ((await saveGlobal.isVisible().catch(() => false)) && !(await saveGlobal.isDisabled().catch(() => true))) {
      await saveGlobal.click({ force: true }).catch(() => {});
      ctx.flow(`[music] SELECTED song #${pick.index + 1} of ${rows.length} results — "${pick.text.slice(0, 150)}" (match score: ${pick.score}/100)`);
      return { ok: true, pickedText: pick.text || undefined };
    }

    // No Save button appeared — the Plus click might have been enough (one-step add)
    await page.waitForTimeout(500);
    ctx.flow(`[music] SELECTED song #${pick.index + 1} of ${rows.length} results — "${pick.text.slice(0, 150)}" (match score: ${pick.score}/100) [no Save needed]`);
    return { ok: true, pickedText: pick.text || undefined };
  }

  ctx.flow("[music][audio] relaxed quick-add: no sound rows or Plus+Save combo found in time");
  return { ok: false };
}

async function executeOneSoundAttempt(
  page: Page,
  musicQuery: string,
  ctx: FlowContext,
  accountUsername: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; soundLabel?: string }> {
  const tAttempt = Date.now();
  const q = musicQuery.trim();
  await dismissStopCopyrightDialog(page, ctx, "before-open-sound");

  const openBtn = await findAddSoundButton(page, ctx);
  if (!openBtn) throw new Error("Add sound control not found");

  ctx.flow("[music][audio] opening sound panel: clicking Add sound control from composer (see earlier [music] open lines)");
  const tPanel = Date.now();
  await openBtn.click({ force: true });
  ctx.flow("[music] open: clicked sound control");
  await dismissStopCopyrightDialog(page, ctx, "after-open-sound-click");
  await musicDebugShot(ctx, page, "step-music-open.png");

  let panel = await waitForSoundPanelReady(page, ctx, 35000, signal);
  if (!panel && !signal?.aborted) {
    ctx.flow("[music] open: first wait failed, retry opening panel once");
    await page.waitForTimeout(380);
    await openBtn.click({ force: true }).catch(() => {});
    await musicDebugShot(ctx, page, "step-music-open-retry.png");
    panel = await waitForSoundPanelReady(page, ctx, 20000, signal);
  }
  if (!panel) {
    if (signal?.aborted) throw new Error("SOUND_FLOW_TIMEOUT");
    throw new Error("Sound panel not ready");
  }

  const workingPanel = await coerceListPanelToSearch(page, panel, ctx);
  flowTiming(
    ctx,
    "music",
    "music_panel_open",
    Date.now() - tPanel,
    "click Add sound → waitForSoundPanelReady (polls ~220ms) + coerceListPanelToSearch",
    `TIKTOK_MUSIC_TIMING_SCALE=${getMusicTimingScale()}`
  );

  // Preferred fast path for the current UI shape user shared.
  if (workingPanel.mode === "search") {
    const tSearch = Date.now();
    await runSearchInPanel(page, workingPanel.searchInput, workingPanel.panelRoot, q, ctx, signal);
    flowTiming(
      ctx,
      "music",
      "music_search_type_primary",
      Date.now() - tSearch,
      "typed/filled search query + suggestion probes + Enter; delays use scaledMusicRand",
      `queryLen=${q.length} TIKTOK_MUSIC_TIMING_SCALE=${getMusicTimingScale()}`
    );

    // Always try the relaxed Plus/Save path first for the primary query.
    // This prevents premature fallback when results exist but scoring/rows are flaky.
    const tRelaxed = Date.now();
    const relaxedPrimary = await tryQuickAddAndSaveRelaxedAfterSearch(
      page,
      workingPanel.panelRoot,
      ctx,
      14000,
      signal,
      q
    );
    flowTiming(
      ctx,
      "music",
      "music_relaxed_plus_save_primary",
      Date.now() - tRelaxed,
      relaxedPrimary.ok
        ? "Plus+Save succeeded for primary query"
        : "looped until 14000ms timeout scanning sound rows in panel",
      `timeoutBudgetMs=14000 TIKTOK_MUSIC_TIMING_SCALE=${getMusicTimingScale()}`
    );
    if (relaxedPrimary.ok) {
      const tVer = Date.now();
      const okRelaxedPrimary = await verifySoundAppliedStrict(page, q, ctx, relaxedPrimary.pickedText);
      flowTiming(
        ctx,
        "music",
        "music_verify_after_relaxed",
        Date.now() - tVer,
        okRelaxedPrimary ? "picker closed / title matched" : "sound not confirmed in composer"
      );
      // Read the actual applied sound title from the composer area
      let appliedSoundTitle = relaxedPrimary.pickedText || "";
      if (!appliedSoundTitle) {
        const soundTitle = await readAppliedSoundFromComposer(page);
        if (soundTitle) appliedSoundTitle = soundTitle;
      }
      ctx.flow(`[music] primary selected: ${appliedSoundTitle || "(unknown)"}`);
      if (okRelaxedPrimary) {
        setCachedSound(accountUsername, q, appliedSoundTitle || q);
        flowTiming(
          ctx,
          "music",
          "music_execute_one_attempt_total",
          Date.now() - tAttempt,
          "success via relaxed Plus/Save path",
          `TIKTOK_MUSIC_TIMING_SCALE=${getMusicTimingScale()}`
        );
        return { ok: true, soundLabel: appliedSoundTitle || q };
      }
    }

    const tQuick = Date.now();
    const quickApplied = await tryQuickAddAndSaveAfterSearch(page, workingPanel.panelRoot, q, ctx, 12000);
    flowTiming(
      ctx,
      "music",
      "music_quick_add_ranked",
      Date.now() - tQuick,
      quickApplied ? "best-scored row Plus+Save" : "no Plus/Save within 12000ms or score below threshold",
      `MUSIC_QUICK_ADD_MIN_SCORE=${MUSIC_QUICK_ADD_MIN_SCORE}`
    );
    if (quickApplied) {
      const okQuick = await verifySoundAppliedStrict(page, q, ctx);
      ctx.flow(`[music] quick add verify: ${okQuick ? "applied" : "not confirmed"}`);
      if (okQuick) {
        setCachedSound(accountUsername, q, q);
        flowTiming(
          ctx,
          "music",
          "music_execute_one_attempt_total",
          Date.now() - tAttempt,
          "success via ranked quick-add path"
        );
        return { ok: true, soundLabel: q };
      }
    }

    const shuffledFallbackKeywords = (() => {
      const arr = [...FALLBACK_SOUND_KEYWORDS];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    })();

    const tFallback = Date.now();
    for (const keyword of shuffledFallbackKeywords.slice(0, 5)) {
      throwIfAborted(signal);
      ctx.flow(`[music] trying fallback: ${keyword}`);
      await runSearchInPanel(page, workingPanel.searchInput, workingPanel.panelRoot, keyword, ctx, signal);
      const relaxed = await tryQuickAddAndSaveRelaxedAfterSearch(page, workingPanel.panelRoot, ctx, 14000, signal, keyword);
      if (relaxed.ok) {
        const okRelaxed = await verifySoundAppliedStrict(page, keyword, ctx, relaxed.pickedText);
        ctx.flow(`[music] fallback selected: ${relaxed.pickedText || "(unknown)"}`);
        if (okRelaxed) {
          setCachedSound(accountUsername, q, relaxed.pickedText || keyword);
          flowTiming(
            ctx,
            "music",
            "music_fallback_keywords_loop",
            Date.now() - tFallback,
            `success on keyword "${keyword}"`,
            "up to 5 keywords × (search + relaxed 14s)"
          );
          flowTiming(
            ctx,
            "music",
            "music_execute_one_attempt_total",
            Date.now() - tAttempt,
            "success via fallback keyword search"
          );
          return { ok: true, soundLabel: relaxed.pickedText || keyword };
        }
      }
    }
    flowTiming(
      ctx,
      "music",
      "music_fallback_keywords_loop",
      Date.now() - tFallback,
      "no fallback keyword produced a verified sound",
      "up to 5 keywords"
    );

    ctx.flow("[music] quick add path did not finalize, falling back to scored selection");
  }

  const tScored = Date.now();
  const cached = getCachedSound(accountUsername, q);
  let pick: { loc: PwLocator; text: string } | null = null;
  let usedCache = false;
  if (cached) {
    pick = await trySelectCachedSound(page, workingPanel, cached, ctx, signal);
    usedCache = pick != null;
  }
  if (!pick) {
    pick = await pickBestSoundFromPanel(page, workingPanel, q, ctx, signal);
  }
  if (!pick) throw new Error("No sound row selected");
  ctx.flow(
    `[music][audio] scored flow: activating row "${pick.text.replace(/\s+/g, " ").slice(0, 120)}" (click row root first)`
  );

  await pick.loc.scrollIntoViewIfNeeded().catch(() => {});
  await pick.loc.click({ force: true });
  ctx.flow("[music][audio] clicked: sound row root (data-e2e sound row or option) — selects/highlight row");

  await page.waitForTimeout(scaledMusicRand(240, 420));

  // Some TikTok Studio variants require clicking the row's Plus button instead of the row itself.
  // Try it opportunistically before looking for global/dialog apply buttons.
  let plusInRow = pick.loc.locator(PLUS_BTN_CSS).first();
  if (!(await plusInRow.isVisible().catch(() => false))) {
    plusInRow = pick.loc.locator(PLUS_BTN_FALLBACK_CSS).first();
  }
  const plusVisible = await plusInRow.isVisible().catch(() => false);
  const plusDisabled = await plusInRow.isDisabled().catch(() => true);
  ctx.flow(
    `[music][audio] in-row Plus: visible=${plusVisible} disabled=${plusDisabled}`
  );
  if (plusVisible && !plusDisabled) {
    await page.waitForTimeout(scaledMusicRand(240, 420));
    await plusInRow.click({ force: true }).catch(() => {});
    ctx.flow("[music][audio] clicked: Plus inside same row locator — adds audio from that row");
    await page.waitForTimeout(250);
  }

  await musicDebugShot(ctx, page, "step-music-selected.png");

  await page.waitForTimeout(220);
  const tApply = Date.now();
  const appliedBtn = await clickApplySoundIfPresent(page, ctx, 10000);
  flowTiming(
    ctx,
    "music",
    "music_click_apply_sound_poll",
    Date.now() - tApply,
    appliedBtn ? "Save/Use/Confirm clicked" : "no matching button within 10000ms (180ms poll)",
    "clickApplySoundIfPresent"
  );
  if (!appliedBtn) {
    ctx.flow("[music][audio] no explicit Save/Use after row — TikTok may apply on row+Plus only");
  }

  const ok = await verifySoundAppliedStrict(page, q, ctx, pick.text);
  ctx.flow(`[music] verify result: ${ok ? "applied" : "not confirmed"}`);
  flowTiming(
    ctx,
    "music",
    "music_pick_rank_click_apply_total",
    Date.now() - tScored,
    ok ? "scored pick + row clicks + apply + verify OK" : "scored path finished without verify",
    `usedCache=${usedCache}`
  );
  if (ok) {
    setCachedSound(accountUsername, q, pick.text);
    ctx.flow(`[music] cached selected sound for query "${q.slice(0, 60)}"`);
    flowTiming(
      ctx,
      "music",
      "music_execute_one_attempt_total",
      Date.now() - tAttempt,
      "success via scored row + apply"
    );
    return { ok: true, soundLabel: pick.text };
  }
  if (usedCache) {
    invalidateCachedSound(accountUsername, q);
    ctx.flow("[music] invalidated stale cache entry");
  }
  flowTiming(ctx, "music", "music_execute_one_attempt_total", Date.now() - tAttempt, "attempt ended without verified sound");
  return { ok: false };
}

/**
 * Optional sound selection. Returns applied sound label for DB logging, or undefined.
 * Budget: `TIKTOK_SOUND_FLOW_MS` (default 40s) applies after preview wait — does not include preview stall.
 */
async function tryAddSoundToVideo(
  page: Page,
  musicQuery: string,
  ctx: FlowContext,
  accountUsername: string
): Promise<string | undefined> {
  const q = musicQuery.trim();
  if (!q) return undefined;
  const tMusicPipeline = Date.now();
  ctx.flow(`[music] requested query: "${q.slice(0, 80)}"`);
  await dismissStopCopyrightDialog(page, ctx, "before-sound-flow");
  await dismissAutomaticContentChecksOfferDialog(page, ctx, "before-sound-flow");

  const baseSoundBudgetMs = Number(process.env.TIKTOK_SOUND_FLOW_MS || 32000);
  const soundBudgetMs = q.toLowerCase() === "trending" ? baseSoundBudgetMs : Math.max(baseSoundBudgetMs, 52000);
  const previewCapMs = Math.min(120000, Math.max(25000, Number(process.env.TIKTOK_MUSIC_PREVIEW_WAIT_MS || 52000)));
  let soundFlowBudgetStartedAt: number | undefined;

  try {
    ctx.flow(
      `[timing][music] config | n/a | reason=active knobs for this run | TIKTOK_SOUND_FLOW_MS=${baseSoundBudgetMs} effectiveSoundBudgetMs=${soundBudgetMs} TIKTOK_MUSIC_PREVIEW_WAIT_MS_cap=${previewCapMs} TIKTOK_MUSIC_TIMING_SCALE=${getMusicTimingScale()} HUMAN_TIMING_SCALE=${getHumanTimingScale()}`
    );

    await waitForVideoPreviewStableBeforeSound(page, ctx, previewCapMs);

    if (flowDebugOn()) {
      ctx.debug("[music] selector probe before open");
      await logMusicRelatedControls(page, ctx);
      await logModals(page, ctx);
    }

    soundFlowBudgetStartedAt = Date.now();
    const label = await withSoundFlowTimeout(soundBudgetMs, async (signal) => {
      let r = await executeOneSoundAttempt(page, q, ctx, accountUsername, signal);
      const musicRetry = process.env.TIKTOK_MUSIC_RETRY === "1";
      if (!r.ok && musicRetry) {
        ctx.flow("[music] verification failed — retry once (TIKTOK_MUSIC_RETRY=1)");
        await dismissOpenSoundUi(page, ctx);
        await humanPause(page, 280, 520);
        r = await executeOneSoundAttempt(page, q, ctx, accountUsername, signal);
      }
      if (r.ok && r.soundLabel) {
        ctx.flow(`[music][audio] verified applied sound title/row: "${r.soundLabel.slice(0, 120)}"`);
        if (flowDebugOn()) {
          await musicDebugShot(ctx, page, "step-music-verified.png");
          ctx.debug("[music] probe after success");
          await logMusicRelatedControls(page, ctx);
        }
        return r.soundLabel;
      }
      throw new Error("Sound not verified after retry");
    });
    flowTiming(
      ctx,
      "music",
      "music_sound_flow_budgeted",
      Date.now() - soundFlowBudgetStartedAt,
      "withSoundFlowTimeout block finished (panel→search→apply→verify; may include TIKTOK_MUSIC_RETRY second attempt)",
      `budgetMs=${soundBudgetMs} TIKTOK_MUSIC_RETRY=${process.env.TIKTOK_MUSIC_RETRY === "1" ? "1" : "0"}`
    );
    flowTiming(
      ctx,
      "music",
      "music_tryAddSoundToVideo_total",
      Date.now() - tMusicPipeline,
      "full music step: config + preview wait + budgeted sound flow (what users perceive as ‘music’ time)",
      `effectiveSoundBudgetMs=${soundBudgetMs}`
    );
    return label;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (soundFlowBudgetStartedAt != null) {
      flowTiming(
        ctx,
        "music",
        "music_sound_flow_budgeted",
        Date.now() - soundFlowBudgetStartedAt,
        msg === "SOUND_FLOW_TIMEOUT"
          ? `aborted: hit TIKTOK_SOUND_FLOW_MS budget (${soundBudgetMs}ms)`
          : `ended with error: ${msg.slice(0, 120)}`,
        `budgetMs=${soundBudgetMs}`
      );
    }
    if (isClosedTargetError(e)) {
      ctx.flow("[music] aborted: page/context closed");
      throw e;
    }
    if (msg === "SOUND_FLOW_TIMEOUT") {
      console.warn("[MUSIC] Aborted: sound flow exceeded budget (ms):", soundBudgetMs);
      ctx.flow(`[music] aborted: sound flow > ${soundBudgetMs}ms`);
    } else {
      console.warn("[MUSIC] Failed, continuing without sound", msg);
    }
    await dismissOpenSoundUi(page, ctx).catch(() => {});
    flowTiming(
      ctx,
      "music",
      "music_tryAddSoundToVideo_total",
      Date.now() - tMusicPipeline,
      "music step ended without verified sound (see prior [timing][music] lines)"
    );
    return undefined;
  }
}

async function waitForPostButtonEnabled(
  page: Page,
  ctx: FlowContext,
  timeoutMs: number
): Promise<import("playwright").Locator | null> {
  ctx.flow("wait: Post button visible and enabled");
  const start = Date.now();
  const pollMs = Math.max(280, Number(process.env.UPLOAD_POST_POLL_MS || 480));
  let polls = 0;
  while (Date.now() - start < timeoutMs) {
    polls += 1;
    await dismissStopCopyrightDialog(page, ctx, "wait-post-button");
    const candidate = page.locator(TIKTOK_STUDIO_SELECTORS.postButton).first();
    const visible = await candidate.isVisible().catch(() => false);
    const disabled = await candidate.isDisabled().catch(() => true);
    ctx.debug(`post poll: visible=${visible} disabled=${disabled}`);
    if (visible && !disabled) {
      ctx.flow("Post button active");
      const elapsed = Date.now() - start;
      flowTiming(
        ctx,
        "post",
        "post_wait_button_enabled",
        elapsed,
        "Post button became visible and enabled (TikTok finishes processing / checks)",
        `polls=${polls} pollMs=${pollMs} timeoutCapMs=${timeoutMs} UPLOAD_POST_BUTTON_TIMEOUT_MS env may cap this HUMAN_TIMING_SCALE=${getHumanTimingScale()}`
      );
      return candidate;
    }
    await page.waitForTimeout(pollMs);
  }
  const elapsed = Date.now() - start;
  flowTiming(
    ctx,
    "post",
    "post_wait_button_enabled",
    elapsed,
    "timeout — button stayed hidden or disabled (video still processing, toggles, or Studio blocked)",
    `polls=${polls} pollMs=${pollMs} timeoutCapMs=${timeoutMs}`
  );
  ctx.flow("Post button did not become active in time");
  return null;
}

function isToggleOn(el: import("playwright").Locator): Promise<boolean> {
  return (async () => {
    const aria = await el.getAttribute("aria-checked");
    if (aria === "true") return true;
    if (aria === "false") return false;
    const state = await el.getAttribute("data-state");
    if (state === "checked") return true;
    if (state === "unchecked") return false;
    const cls = (await el.getAttribute("class")) || "";
    if (/\bchecked\b|is-checked|switch-checked/i.test(cls)) return true;
    return false;
  })();
}

/**
 * Uncheck Music copyright check + Content check lite before Post (TikTok Studio).
 * @param maxMsPerPattern — time to wait for each toggle to become clickable (checks can block UI briefly).
 */
async function turnOffCopyrightAndContentCheckToggles(
  page: import("playwright").Page,
  maxMsPerPattern = 42000,
  ctx?: FlowContext
): Promise<void> {
  const log = ctx?.flow ?? ((s: string) => console.log(`[FLOW] ${s}`));
  const guard = async (stage: string) => {
    const fakeCtx = ctx ?? {
      flow: log,
      debug: () => {},
      runId: "",
      debugDir: "",
      shot: async () => {},
      pauseIfDebug: async () => {},
    };
    await dismissStopCopyrightDialog(page, fakeCtx as FlowContext, stage);
    await dismissAutomaticContentChecksOfferDialog(page, fakeCtx as FlowContext, stage);
  };

  log("toggles: expand Show more if present");
  await guard("toggles-start");
  const showMore = page.getByRole("button", { name: /show more/i });
  if (await showMore.isVisible({ timeout: 4000 }).catch(() => false)) {
    await showMore.click({ force: true }).catch(() => {});
    await page.waitForTimeout(600);
  }

  const labelPatterns = [/music copyright/i, /content check lite/i];

  for (const pattern of labelPatterns) {
    const patternEnd = Date.now() + maxMsPerPattern;
    let switchedOff = false;
    while (Date.now() < patternEnd) {
      await guard(`toggles-loop-${pattern}`);
      let toggle: import("playwright").Locator | null = null;

      const byRole = page.getByRole("switch", { name: pattern });
      if ((await byRole.count()) > 0 && (await byRole.first().isVisible().catch(() => false))) {
        toggle = byRole.first();
      }

      if (!toggle) {
        const textEl = page.getByText(pattern, { exact: false }).first();
        if (await textEl.isVisible({ timeout: 1500 }).catch(() => false)) {
          // Resolve nearest block around the label and search for TikTok switch markup.
          const block = textEl.locator(
            'xpath=ancestor::*[self::div or self::section][.//div[contains(@class,"Switch__content")] or .//*[@role="switch"]][1]'
          );
          const switchContent = block.locator('div[class*="Switch__content"][data-state]').first();
          if (await switchContent.isVisible().catch(() => false)) {
            toggle = switchContent;
          } else {
            const inner = block.locator('[role="switch"]').first();
            if (await inner.isVisible().catch(() => false)) toggle = inner;
          }
        }
      }

      if (toggle) {
        await toggle.scrollIntoViewIfNeeded().catch(() => {});
        const disabled = await toggle.isDisabled().catch(() => true);
        if (!disabled) {
          const before = await isToggleOn(toggle);
          if (before) {
            await toggle.click({ force: true });
            await page.waitForTimeout(500);
            await guard(`toggles-after-click-${pattern}`);
            const after = await isToggleOn(toggle);
            if (!after) {
              switchedOff = true;
              log(`toggles: turned off ${pattern}`);
            } else {
              // Fallback: some switches need the hidden role=switch input click / keyboard.
              const nearInput = toggle.locator('xpath=.//input[@role="switch"] | following::input[@role="switch"][1]').first();
              if (await nearInput.isVisible().catch(() => false)) {
                await nearInput.click({ force: true }).catch(() => {});
                await nearInput.press(" ").catch(() => {});
                await page.waitForTimeout(350);
              }
              if (!(await isToggleOn(toggle))) {
                switchedOff = true;
                log(`toggles: turned off ${pattern} (input fallback)`);
              }
            }
          } else {
            switchedOff = true;
            log(`toggles: already off ${pattern}`);
          }
          if (switchedOff) break;
        }
      }

      await page.waitForTimeout(scaledHumanRand(420, 780));
    }
    if (!switchedOff) {
      log(`toggles: failed to turn off ${pattern}`);
    }
  }
}

type PlaywrightProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

export type TikTokUploadSessionHandle = {
  page: Page;
  context: import("playwright").BrowserContext;
  poolKey: string;
  username: string;
};

export type RunUploadSessionOptions = {
  /** Continue on the same page/context from a previous successful upload in this chain. */
  reuse?: TikTokUploadSessionHandle;
  /**
   * When true, on success keep the browser context open and return `sessionHandle`.
   * Caller must call `poolSessionHandleAfterUploadChain` when done or `discardUploadSessionHandle` on failure.
   */
  holdSessionForChain?: boolean;
};

export type TikTokUploadRunResult = {
  success: boolean;
  error?: string;
  /** TikTok sound row label when automation applied a sound. */
  soundUsed?: string;
  sessionHandle?: TikTokUploadSessionHandle;
};

/** After the last chained upload succeeded — return context to the pool (closes the tab first). */
export async function poolSessionHandleAfterUploadChain(handle: TikTokUploadSessionHandle): Promise<void> {
  await handle.page.close().catch(() => {});
  offerUploadContext(handle.poolKey, handle.context);
}

/** Drop a chained session on error (does not pool). */
export async function discardUploadSessionHandle(handle: TikTokUploadSessionHandle): Promise<void> {
  discardUploadContext(handle.poolKey);
  await handle.page.close().catch(() => {});
  await handle.context.close().catch(() => {});
}

/**
 * Upload → caption → sound → toggles → Post (assumes upload UI is ready with file input available).
 */
export async function runStudioUploadPipeline(
  page: Page,
  ctx: FlowContext,
  videoPath: string,
  caption: string,
  musicQuery: string | undefined,
  username: string
): Promise<TikTokUploadRunResult> {
  let soundUsed: string | undefined;

  ctx.flow("human: brief pause before choosing file");
  await humanPause(page, 120, 280);
  await humanScroll(page);

  ctx.flow("video upload: setInputFiles on file input");
  const fileInput = page.locator(TIKTOK_STUDIO_SELECTORS.uploadFileInput).first();
  await fileInput.setInputFiles(videoPath);
  ctx.flow("setInputFiles dispatched");

  const settleLoops = Math.max(2, Math.min(5, Number(process.env.UPLOAD_AFTER_FILE_SETTLE_LOOPS || 3)));
  for (let i = 0; i < settleLoops; i++) {
    await dismissAutomaticContentChecksOfferDialog(page, ctx, `post-set-input-${i}`);
    await dismissStopCopyrightDialog(page, ctx, `post-set-input-${i}`);
    await page.waitForTimeout(scaledHumanRand(220, 420));
  }

  await logUploadProgressHints(page, ctx);
  await ctx.shot(page, "step-2a-after-set-input.png");

  const captionBox = await waitForCaptionEditorVisible(page, ctx, 120000);
  await dismissAutomaticContentChecksOfferDialog(page, ctx, "before-caption-type");
  await logUploadProgressHints(page, ctx);
  await logMusicRelatedControls(page, ctx);
  await logModals(page, ctx);
  await ctx.shot(page, "step-2-uploaded.png");

  await ctx.pauseIfDebug(page, "after upload completes (caption area visible)");

  if (captionBox && (await captionBox.isVisible().catch(() => false))) {
    ctx.flow(`caption: ${process.env.TIKTOK_CAPTION_TYPE_HUMAN === "0" ? "fill (fast mode)" : "typing human-like"}`);
    await page.waitForTimeout(scaledHumanRand(80, 180));
    await humanScroll(page);
    await captionBox.click({ force: true });
    await page.waitForTimeout(scaledHumanRand(120, 240));
    await typeTextLikeHuman(page, captionBox, caption);
    ctx.flow("caption filled");
    await page.waitForTimeout(scaledHumanRand(60, 140));
  } else {
    ctx.flow("caption: editor missing — skip fill (failure likely)");
  }

  await logMusicRelatedControls(page, ctx);
  await logCoreElements(page, ctx);
  await ctx.shot(page, "step-3-caption.png");

  await ctx.pauseIfDebug(page, "after caption filled");
  await humanScroll(page);

  const effectiveMusicQuery = musicQuery?.trim() || "trending";
  if (effectiveMusicQuery) {
    if (musicQuery?.trim()) {
      ctx.flow(`music: musicQuery set → try sound picker (${effectiveMusicQuery.slice(0, 60)}…)`);
    } else {
      ctx.flow(`music: no musicQuery provided — using default (${effectiveMusicQuery})`);
    }
    soundUsed = await tryAddSoundToVideo(page, effectiveMusicQuery, ctx, username);
  } else {
    ctx.flow("music: no musicQuery — skip sound selection");
  }

  const tPostPhase = Date.now();
  const postPollMs = Math.max(280, Number(process.env.UPLOAD_POST_POLL_MS || 480));
  const postBtnTimeoutCap = Math.min(240000, Number(process.env.UPLOAD_POST_BUTTON_TIMEOUT_MS || 120000));
  ctx.flow(
    `[timing][post] config | n/a | reason=active knobs for post phase | UPLOAD_POST_POLL_MS=${postPollMs} UPLOAD_POST_BUTTON_TIMEOUT_MS_cap=${postBtnTimeoutCap} HUMAN_TIMING_SCALE=${getHumanTimingScale()}`
  );

  ctx.flow("toggles: Music copyright + Content check lite → off");
  await page.waitForTimeout(scaledHumanRand(100, 200));
  const tToggles1 = Date.now();
  await turnOffCopyrightAndContentCheckToggles(page, 32000, ctx);
  flowTiming(
    ctx,
    "post",
    "post_toggles_pass1",
    Date.now() - tToggles1,
    "turn off Music copyright + Content check lite (per-toggle loop with scaledHumanRand 420–780ms retries)",
    `maxMsPerPattern=32000 HUMAN_TIMING_SCALE=${getHumanTimingScale()}`
  );

  await logMusicRelatedControls(page, ctx);
  await page.waitForTimeout(scaledHumanRand(80, 160));
  await humanScroll(page);
  const postBtn = await waitForPostButtonEnabled(page, ctx, postBtnTimeoutCap);
  if (!postBtn) {
    flowTiming(
      ctx,
      "post",
      "post_phase_total_after_music",
      Date.now() - tPostPhase,
      "stopped early: Post button never became active",
      `see post_wait_button_enabled above`
    );
    await ctx.shot(page, "step-4-post-never-enabled.png");
    return { success: false, error: "Post button not active", soundUsed };
  }

  ctx.flow("toggles: final pass before Post");
  await page.waitForTimeout(scaledHumanRand(80, 160));
  const tToggles2 = Date.now();
  await turnOffCopyrightAndContentCheckToggles(page, 10000, ctx);
  flowTiming(
    ctx,
    "post",
    "post_toggles_pass2",
    Date.now() - tToggles2,
    "final toggle sweep before clicking Post",
    `maxMsPerPattern=10000`
  );

  await ctx.shot(page, "step-4-before-post.png");
  await ctx.pauseIfDebug(page, "before clicking Post");

  const tPostClick = Date.now();
  const prePostMs = Math.max(2000, Number(process.env.TIKTOK_PRE_POST_PAUSE_MS || 2000));
  ctx.flow(`[post] pausing ${prePostMs}ms before clicking Post`);
  await page.waitForTimeout(prePostMs);
  await postBtn.click({ force: true });
  ctx.flow("Post clicked");

  await clickPostConfirmDialogsIfPresent(page, ctx, 12000);

  await page.waitForTimeout(scaledHumanRand(220, 420));

  const postNow = page.locator(TIKTOK_STUDIO_SELECTORS.postNowConfirm).first();
  if (await postNow.isVisible().catch(() => false)) {
    ctx.flow('confirm modal: "Post now"');
    await page.waitForTimeout(scaledHumanRand(120, 240));
    await postNow.click({ force: true });
    await page.waitForTimeout(scaledHumanRand(180, 360));
  }

  await clickPostConfirmDialogsIfPresent(page, ctx, 8000);
  flowTiming(
    ctx,
    "post",
    "post_click_confirm_sequence",
    Date.now() - tPostClick,
    "Post click + confirm-dialog polls (220ms/380ms steps) + scaledHumanRand pauses + optional Post now",
    `HUMAN_TIMING_SCALE=${getHumanTimingScale()}`
  );

  if (await detectPostRejectedByTikTok(page, ctx)) {
    flowTiming(
      ctx,
      "post",
      "post_phase_total_after_music",
      Date.now() - tPostPhase,
      "TikTok rejected post (modal) after confirm sequence",
      `UPLOAD_POST_POLL_MS=${postPollMs}`
    );
    await ctx.shot(page, "step-post-rejected-modal.png");
    return {
      success: false,
      error: "TikTok blocked post (Community Guidelines / suspicious activity)",
      soundUsed,
    };
  }

  await page.waitForTimeout(scaledHumanRand(280, 520));

  if (await detectPostRejectedByTikTok(page, ctx)) {
    flowTiming(
      ctx,
      "post",
      "post_phase_total_after_music",
      Date.now() - tPostPhase,
      "TikTok rejected post (late modal)",
      `UPLOAD_POST_POLL_MS=${postPollMs}`
    );
    await ctx.shot(page, "step-post-rejected-modal-late.png");
    return {
      success: false,
      error: "TikTok blocked post (Community Guidelines / suspicious activity)",
      soundUsed,
    };
  }

  await ctx.shot(page, "step-5-after-post.png");
  flowTiming(
    ctx,
    "post",
    "post_phase_total_after_music",
    Date.now() - tPostPhase,
    "entire post leg: toggles×2 + wait for enabled Post + click + confirms (typical ~30s if TikTok keeps Post disabled for many polls)",
    `UPLOAD_POST_POLL_MS=${postPollMs}`
  );
  ctx.flow("flow complete");
  return { success: true, soundUsed };
}

export async function runUploadWithSession(
  username: string,
  sessionJson: string,
  videoPath: string,
  caption: string,
  proxy?: PlaywrightProxyConfig | string,
  browser?: import("playwright").Browser,
  musicQuery?: string,
  sessionOptions?: RunUploadSessionOptions
): Promise<TikTokUploadRunResult> {
  const ctx = createFlowContext(username);
  let soundUsed: string | undefined;
  const tmpFile = path.join(os.tmpdir(), `tiktok-${username.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`);

  let localBrowser: import("playwright").Browser | undefined;
  let context: import("playwright").BrowserContext | undefined;
  let trafficLog: ReturnType<typeof attachProxyTrafficLog> = null;
  let mainGotoMs: number | undefined;
  let outcome: TikTokUploadRunResult | undefined;
  let reuseEnabled = false;
  let poolKey = "";
  let wroteTmpSession = false;
  let contextFromPool = false;

  const holdSessionForChain = sessionOptions?.holdSessionForChain === true;
  const reuse = sessionOptions?.reuse;
  let page: Page | undefined;

  function done(r: TikTokUploadRunResult): TikTokUploadRunResult {
    outcome = r;
    return r;
  }

  try {
    const userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

    const resolvedProxy: PlaywrightProxyConfig | undefined =
      typeof proxy === "string"
        ? proxy.trim()
          ? { server: proxy.trim() }
          : undefined
        : proxy?.server
          ? proxy
          : undefined;

    // Proxy goes in browser launch (not context) — required for IPRoyal auth.
    // Always create a dedicated browser when proxy is set so each account gets its own proxy session.
    if (!browser || resolvedProxy) {
      localBrowser = await launchChromium("automation", resolvedProxy ?? undefined);
    }
    const activeBrowser = localBrowser || browser!;

    reuseEnabled =
      !!browser &&
      process.env.TIKTOK_REUSE_UPLOAD_CONTEXT !== "0" &&
      process.env.TIKTOK_REUSE_UPLOAD_CONTEXT !== "false";
    poolKey = makeUploadContextPoolKey(username, resolvedProxy);

    if (reuse) {
      context = reuse.context;
      page = reuse.page;
      contextFromPool = false;
      ctx.flow("reuse: chained upload — same page, navigate back to Studio upload");
      trafficLog = attachProxyTrafficLog(page, `tiktok-upload:${username}`);
      const tGoto = Date.now();
      await gotoTikTokUploadWithRetries(page, ctx, TIKTOK_UPLOAD_URL);
      mainGotoMs = Date.now() - tGoto;
      ctx.flow(`navigation commit timing (reuse): ${mainGotoMs}ms`);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await humanPause(page, 600, 1400);
      await humanScroll(page);
      const inputOkReuse = await waitForFileInput(page, ctx, 90000);
      if (!inputOkReuse) {
        await ctx.shot(page, "reuse-open-page-failed-no-input.png");
        return done({ success: false, error: "Upload file input not found", soundUsed: undefined });
      }
      await logCoreElements(page, ctx);
      await logModals(page, ctx);
      await ctx.shot(page, "step-1-reuse-upload.png");
    } else {
      if (reuseEnabled) {
        const pooled = takeUploadContext(poolKey);
        if (pooled) {
          context = pooled;
          contextFromPool = true;
          ctx.flow("reusing pooled browser context (warm cache)");
          for (const p of context.pages()) {
            await p.close().catch(() => {});
          }
        }
      }

      if (!context) {
        fs.writeFileSync(tmpFile, sessionJson, "utf-8");
        wroteTmpSession = true;
        context = await activeBrowser.newContext({
          storageState: tmpFile,
          userAgent,
          locale: "en-US",
          timezoneId: "America/New_York",
          viewport: { width: 1366, height: 768 },
        });
        await applyStealthScripts(context);
        await installSafeBandwidthRoutes(context);
      }

      page = await context.newPage();
      trafficLog = attachProxyTrafficLog(page, `tiktok-upload:${username}`);

      ctx.flow(`navigate → ${TIKTOK_UPLOAD_URL}`);
      const tGoto = Date.now();
      await gotoTikTokUploadWithRetries(page, ctx, TIKTOK_UPLOAD_URL);
      mainGotoMs = Date.now() - tGoto;
      ctx.flow(`navigation commit timing: ${mainGotoMs}ms`);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      ctx.flow("navigation committed + domcontentloaded (best-effort)");

      if (await isTikTokSessionLoggedOut(page)) {
        await ctx.shot(page, "session-expired-or-logged-out.png");
        return done({
          success: false,
          error:
            "SESSION_EXPIRED: TikTok session missing or expired. Re-import storageState JSON on Accounts (local capture or browser export).",
          soundUsed: undefined,
        });
      }

      await dismissTikTokPopups(page);
      ctx.flow("human: pause + scroll after load");
      await humanPause(page);
      await humanScroll(page);

      const inputOk = await waitForFileInput(page, ctx, 90000);
      if (!inputOk) {
        await ctx.shot(page, "step-1-open-page-failed-no-input.png");
        return done({ success: false, error: "Upload file input not found", soundUsed: undefined });
      }

      await logCoreElements(page, ctx);
      await logModals(page, ctx);
      await ctx.shot(page, "step-1-open-page.png");
    }

    const pipelineResult = await runStudioUploadPipeline(page, ctx, videoPath, caption, musicQuery, username);
    soundUsed = pipelineResult.soundUsed;
    return done(pipelineResult);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    if (isClosedTargetError(e)) {
      ctx.flow("error: page/context/browser closed");
      return done({ success: false, error: "BROWSER_CLOSED", soundUsed });
    }
    ctx.flow(`error: ${msg}`);
    return done({ success: false, error: msg, soundUsed });
  } finally {
    try {
      trafficLog?.finish({
        mainGotoMs,
        mainGotoUrl: TIKTOK_UPLOAD_URL,
        browserContext: reuse
          ? "chained-reuse"
          : contextFromPool
            ? "pooled"
            : "fresh",
      });
    } catch {}
    try {
      if (outcome?.success && holdSessionForChain && context && browser && page && !outcome.error?.includes("SESSION_EXPIRED")) {
        outcome = {
          ...outcome,
          sessionHandle: { page, context, poolKey, username },
        };
        context = undefined;
      } else if (context) {
        const shouldPool =
          outcome?.success === true &&
          reuseEnabled &&
          !!browser &&
          !holdSessionForChain &&
          !outcome.error?.includes("SESSION_EXPIRED");
        if (shouldPool) {
          offerUploadContext(poolKey, context);
          context = undefined;
        } else {
          await context.close();
        }
      }
    } catch {}
    try {
      if (localBrowser) await localBrowser.close();
    } catch {}
    try {
      if (wroteTmpSession) fs.unlinkSync(tmpFile);
    } catch {}
    try {
      if (
        outcome?.success === true &&
        !envTruthy(process.env.TIKTOK_UPLOAD_KEEP_DEBUG_ON_SUCCESS)
      ) {
        fs.rmSync(ctx.debugDir, { recursive: true, force: true });
        console.log(`[FLOW] removed debug folder after success: ${path.relative(process.cwd(), ctx.debugDir)}`);
      }
    } catch {}
  }
}
