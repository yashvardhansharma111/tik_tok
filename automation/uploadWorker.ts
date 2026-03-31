import { launchChromium } from "@/lib/playwrightLaunch";
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
import { humanPause, humanRand, humanScroll, typeTextLikeHuman } from "@/lib/humanBehavior";

const TIKTOK_UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload?lang=en";

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

function createFlowContext(username: string): FlowContext {
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

async function waitForFileInput(page: Page, ctx: FlowContext, timeoutMs: number): Promise<boolean> {
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
    await page.waitForTimeout(humanRand(2200, 3400));
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
      await page.waitForTimeout(400);
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

    await page.waitForTimeout(400);
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
    await page.waitForTimeout(350);
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
  await page.waitForTimeout(humanRand(700, 1200));
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

  await page.waitForTimeout(humanRand(220, 520));
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
  await page.waitForTimeout(humanRand(700, 1200));
  return true;
}

const ROW_SKIP_LABEL = /^(close|cancel|back)$/i;

async function harvestSoundCandidates(panelRoot: PwLocator): Promise<{ loc: PwLocator; text: string }[]> {
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

  return out.slice(0, 8);
}

function rankTopFiveScored(
  raw: { loc: PwLocator; text: string }[],
  musicQuery: string
): { loc: PwLocator; text: string; score: number }[] {
  return raw
    .filter((c) => !isBadSoundLabel(c.text))
    .map((c, index) => ({ ...c, index, score: scoreSoundMatch(musicQuery, c.text) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, 5);
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
  await page.waitForTimeout(humanRand(180, 320));

  const isLongOrIdLike = term.length >= 26 || /\d{8,}/.test(term) || (term.includes("-") && /\d/.test(term));
  if (isLongOrIdLike) {
    const short = term.length > 70 ? `${term.slice(0, 70)}…` : term;
    ctx.flow(`[music] search (fast fill): "${short}"`);
    await searchInput.fill(term).catch(async () => {
      // Some Studio builds block fill(); fall back to typing quickly.
      await searchInput.type(term, { delay: humanRand(5, 18) });
    });
    await page.waitForTimeout(humanRand(450, 850));
    await searchInput.press("Enter").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(humanRand(900, 1500));
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(humanRand(220, 420));
    await page.keyboard.press("Escape").catch(() => {});
    await panelRoot.click({ force: true }).catch(() => {});
    return;
  }

  let typed = "";
  const normalizedTarget = normalizeMusicText(term);
  for (let i = 0; i < term.length; i++) {
    throwIfAborted(signal);
    const ch = term[i];
    // TikTok suggestions/results can be flaky if we type too fast.
    await searchInput.type(ch, { delay: humanRand(25, 70) });
    typed += ch;
    await page.waitForTimeout(humanRand(220, 420));

    const trimmed = typed.trim();
    if (trimmed.length < 6) continue;
    const shouldProbe = /\s/.test(ch) || i === term.length - 1 || i % 4 === 3;
    if (!shouldProbe) continue;

    await page.waitForTimeout(humanRand(260, 520));
    const clickedSuggestion = await tryClickMatchingSuggestion(page, searchInput, panelRoot, term, trimmed, ctx);
    if (clickedSuggestion) {
      // Submit to ensure results load and suggestion dropdown collapses.
      await searchInput.press("Enter").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      ctx.flow("[music] search: pressed Enter after suggestion click");
      await page.waitForTimeout(humanRand(650, 1100));
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(humanRand(220, 420));
      await page.keyboard.press("Escape").catch(() => {});
      await panelRoot.click({ force: true }).catch(() => {});
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
  // Give TikTok a moment to populate results after the full query is present.
  await page.waitForTimeout(humanRand(1600, 2600));
  await page.waitForTimeout(humanRand(700, 1200));
  // Always submit the query with Enter to collapse the suggestions dropdown.
  await searchInput.press("Enter").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  ctx.flow("[music] search: pressed Enter");
  await page.waitForTimeout(humanRand(650, 1100));

  // If still no visible results and no explicit "no results" message, press Enter again.
  if (!(await panelHasVisibleSoundResults(panelRoot)) && !(await panelShowsNoResults(panelRoot))) {
    await searchInput.press("Enter").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    ctx.flow("[music] search: pressed Enter fallback");
    await page.waitForTimeout(humanRand(900, 1500));
  }

  // Suggestions dropdown can overlay the results list (and Plus buttons) — dismiss it.
  await page.keyboard.press("Escape").catch(() => {});
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
  const deadline = Date.now() + timeoutMs;
  ctx.flow("[music] wait: preview / stable composer before opening sound");
  while (Date.now() < deadline) {
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
      return;
    }
    if (!busy && captionOk) {
      ctx.flow("[music] ready: caption + no busy copy (soft)");
      return;
    }
    await page.waitForTimeout(900);
  }
  ctx.flow("[music] preview wait timed out — opening sound anyway");
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
  const raw = await harvestSoundCandidates(workingPanel.panelRoot);
  if (raw.length === 0) return null;
  const cl = cached.label.toLowerCase();
  const prefer = raw.find(
    (r) =>
      r.text.toLowerCase().includes(cl) ||
      (cl.length > 6 && cl.includes(r.text.toLowerCase().slice(0, Math.min(40, r.text.length))))
  );
  if (prefer) return { loc: prefer.loc, text: prefer.text };
  const ranked = rankTopFiveScored(raw, cached.label);
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
    const raw = await harvestSoundCandidates(wp.panelRoot);
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
      const raw = await harvestSoundCandidates(wp.panelRoot);
      if (noResults || raw.length === 0) {
        ctx.flow("[music] primary search failed → switching to fallback");
        primaryFailed = true;
      } else {
        const ranked = rankTopFiveScored(raw, q);
        if (ranked.length === 0) {
          ctx.flow("[music] primary search failed → switching to fallback");
          primaryFailed = true;
        } else {
          ctx.flow(
            `[music] top matches (scored vs user query): ${ranked
              .map((r) => `${r.score.toFixed(0)}:"${r.text.slice(0, 36)}"`)
              .join(" · ")}`
          );
          if (ranked[0].score >= MUSIC_PRIMARY_MIN_SCORE) {
            console.log("[MUSIC] Selecting best match:", ranked[0].text.slice(0, 100));
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

      const raw = await harvestSoundCandidates(wp.panelRoot);
      if (raw.length === 0) {
        ctx.flow(`[music] no candidate rows (term index ${si})`);
        continue;
      }

      const ranked = rankTopFiveScored(raw, q);
      if (ranked.length === 0) {
        ctx.flow(`[music] all candidates filtered as bad sounds (term index ${si})`);
        continue;
      }
      ctx.flow(
        `[music] top matches (scored vs user query): ${ranked.map((r) => `${r.score.toFixed(0)}:"${r.text.slice(0, 36)}"`).join(" · ")}`
      );

      if (si === 0) {
        if (ranked[0].score >= MUSIC_PRIMARY_MIN_SCORE) {
          console.log("[MUSIC] Selecting best match:", ranked[0].text.slice(0, 100));
          return { loc: ranked[0].loc, text: ranked[0].text };
        }
        ctx.flow(`[music] weak primary (best ${ranked[0].score.toFixed(0)} < ${MUSIC_PRIMARY_MIN_SCORE}) → trending / viral`);
        continue;
      }

      console.log("[MUSIC] Selecting best after region fallback:", ranked[0].text.slice(0, 100));
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
  ctx.flow("[music] apply: looking for Use/Confirm/Done button");

  while (Date.now() < deadline) {
    const plusInDialog = frontDialog
      .locator('button:has([data-icon="PlusBold"]), button:has([data-testid="PlusBold"])')
      .first();
    if ((await plusInDialog.isVisible().catch(() => false)) && !(await plusInDialog.isDisabled().catch(() => true))) {
      await plusInDialog.click({ force: true }).catch(() => {});
      ctx.flow("[music] apply: clicked Plus button (dialog)");
      await page.waitForTimeout(250);
    }

    const saveInDialog = frontDialog.getByRole("button", { name: /^save$/i }).first();
    if ((await saveInDialog.isVisible().catch(() => false)) && !(await saveInDialog.isDisabled().catch(() => true))) {
      await saveInDialog.click({ force: true }).catch(() => {});
      ctx.flow("[music] apply: clicked Save button (dialog)");
      return true;
    }
    const saveGlobal = page.getByRole("button", { name: /^save$/i }).first();
    if ((await saveGlobal.isVisible().catch(() => false)) && !(await saveGlobal.isDisabled().catch(() => true))) {
      await saveGlobal.click({ force: true }).catch(() => {});
      ctx.flow("[music] apply: clicked Save button (global)");
      return true;
    }

    for (const re of patterns) {
      const scoped = frontDialog.getByRole("button", { name: re }).first();
      if ((await scoped.isVisible().catch(() => false)) && !(await scoped.isDisabled().catch(() => true))) {
        ctx.debug(`[music] apply (in dialog) ${re.source}`);
        await scoped.click({ force: true });
        ctx.flow(`[music] apply: clicked dialog button /${re.source}/i`);
        return true;
      }
      const btn = page.getByRole("button", { name: re }).first();
      if ((await btn.isVisible().catch(() => false)) && !(await btn.isDisabled().catch(() => true))) {
        ctx.debug(`[music] apply (global) ${re.source}`);
        await btn.click({ force: true });
        ctx.flow(`[music] apply: clicked global button /${re.source}/i`);
        return true;
      }
    }
    await page.waitForTimeout(300);
  }
  ctx.flow("[music] apply: no explicit button found before timeout");
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
        await page.waitForTimeout(1200);
        return true;
      }
      const btnGlobal = page.getByRole("button", { name: re }).first();
      if ((await btnGlobal.isVisible().catch(() => false)) && !(await btnGlobal.isDisabled().catch(() => true))) {
        ctx.flow(`[post] confirm: clicking global button /${re.source}/i`);
        await btnGlobal.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1200);
        return true;
      }
    }
    await page.waitForTimeout(350);
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
  // TikTok often renders rows / Plus buttons a bit after the query is set.
  await page.waitForTimeout(humanRand(900, 1700));
  const raw = await harvestSoundCandidates(panelRoot);
  const ranked = rankTopFiveScored(raw, musicQuery);
  if (ranked.length === 0) {
    ctx.flow("[music] quick add: no usable candidates");
    return false;
  }

  const best = ranked[0];
  ctx.flow(`[music] quick add candidate: ${best.score.toFixed(0)}:"${best.text.slice(0, 72)}"`);
  if (best.score < MUSIC_QUICK_ADD_MIN_SCORE) {
    ctx.flow(`[music] quick add skipped: weak match (${best.score.toFixed(0)} < ${MUSIC_QUICK_ADD_MIN_SCORE})`);
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const plusInPanel = best.loc
      .locator(
        'button:has([data-icon="PlusBold"]), button:has([data-testid="PlusBold"]), xpath=ancestor-or-self::*[.//button[*[@data-icon="PlusBold" or @data-testid="PlusBold"]]][1]//button[*[@data-icon="PlusBold" or @data-testid="PlusBold"]]'
      )
      .first();
    if ((await plusInPanel.isVisible().catch(() => false)) && !(await plusInPanel.isDisabled().catch(() => true))) {
      await plusInPanel.click({ force: true }).catch(() => {});
      ctx.flow("[music] quick add: clicked Plus on best-matching row");
      await page.waitForTimeout(250);

      const saveInPanel = panelRoot.getByRole("button", { name: /^save$/i }).first();
      if ((await saveInPanel.isVisible().catch(() => false)) && !(await saveInPanel.isDisabled().catch(() => true))) {
        await saveInPanel.click({ force: true }).catch(() => {});
        ctx.flow("[music] quick add: clicked Save in panel");
        return true;
      }

      const saveGlobal = page.getByRole("button", { name: /^save$/i }).first();
      if ((await saveGlobal.isVisible().catch(() => false)) && !(await saveGlobal.isDisabled().catch(() => true))) {
        await saveGlobal.click({ force: true }).catch(() => {});
        ctx.flow("[music] quick add: clicked Save globally");
        return true;
      }
    }

    await page.waitForTimeout(250);
  }

  ctx.flow("[music] quick add: Plus/Save not found in time");
  return false;
}

async function tryQuickAddAndSaveRelaxedAfterSearch(
  page: Page,
  panelRoot: PwLocator,
  ctx: FlowContext,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ ok: boolean; pickedText?: string }> {
  await page.waitForTimeout(humanRand(900, 1700));
  await page.keyboard.press("Escape").catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const plusBtns = panelRoot.locator('button:has([data-icon="PlusBold"]), button:has([data-testid="PlusBold"])');
    const n = await plusBtns.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 14); i++) {
      const plus = plusBtns.nth(i);
      const visible = await plus.isVisible().catch(() => false);
      if (!visible) continue;
      const disabled = await plus.isDisabled().catch(() => true);
      if (disabled) continue;

      const row = plus.locator(
        'xpath=ancestor-or-self::*[self::li or self::tr or self::div][.//button[*[@data-icon="PlusBold" or @data-testid="PlusBold"]]][1]'
      );
      const pickedText = ((await row.first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();

      await plus.click({ force: true }).catch(() => {});
      ctx.flow("[music] quick add relaxed: clicked Plus");
      await page.waitForTimeout(250);

      const saveInPanel = panelRoot.getByRole("button", { name: /^save$/i }).first();
      if ((await saveInPanel.isVisible().catch(() => false)) && !(await saveInPanel.isDisabled().catch(() => true))) {
        await saveInPanel.click({ force: true }).catch(() => {});
        ctx.flow("[music] quick add relaxed: clicked Save in panel");
        return { ok: true, pickedText: pickedText || undefined };
      }

      const saveGlobal = page.getByRole("button", { name: /^save$/i }).first();
      if ((await saveGlobal.isVisible().catch(() => false)) && !(await saveGlobal.isDisabled().catch(() => true))) {
        await saveGlobal.click({ force: true }).catch(() => {});
        ctx.flow("[music] quick add relaxed: clicked Save globally");
        return { ok: true, pickedText: pickedText || undefined };
      }
    }

    await page.waitForTimeout(250);
  }

  ctx.flow("[music] quick add relaxed: Plus/Save not found in time");
  return { ok: false };
}

async function executeOneSoundAttempt(
  page: Page,
  musicQuery: string,
  ctx: FlowContext,
  accountUsername: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; soundLabel?: string }> {
  const q = musicQuery.trim();
  await dismissStopCopyrightDialog(page, ctx, "before-open-sound");

  const openBtn = await findAddSoundButton(page, ctx);
  if (!openBtn) throw new Error("Add sound control not found");

  console.log("[MUSIC] Opening sound panel");
  await openBtn.click({ force: true });
  ctx.flow("[music] open: clicked sound control");
  await dismissStopCopyrightDialog(page, ctx, "after-open-sound-click");
  await musicDebugShot(ctx, page, "step-music-open.png");

  let panel = await waitForSoundPanelReady(page, ctx, 35000, signal);
  if (!panel && !signal?.aborted) {
    ctx.flow("[music] open: first wait failed, retry opening panel once");
    await page.waitForTimeout(900);
    await openBtn.click({ force: true }).catch(() => {});
    await musicDebugShot(ctx, page, "step-music-open-retry.png");
    panel = await waitForSoundPanelReady(page, ctx, 20000, signal);
  }
  if (!panel) {
    if (signal?.aborted) throw new Error("SOUND_FLOW_TIMEOUT");
    throw new Error("Sound panel not ready");
  }

  const workingPanel = await coerceListPanelToSearch(page, panel, ctx);

  // Preferred fast path for the current UI shape user shared.
  if (workingPanel.mode === "search") {
    await runSearchInPanel(page, workingPanel.searchInput, workingPanel.panelRoot, q, ctx, signal);

    // Always try the relaxed Plus/Save path first for the primary query.
    // This prevents premature fallback when results exist but scoring/rows are flaky.
    const relaxedPrimary = await tryQuickAddAndSaveRelaxedAfterSearch(
      page,
      workingPanel.panelRoot,
      ctx,
      14000,
      signal
    );
    if (relaxedPrimary.ok) {
      const okRelaxedPrimary = await verifySoundAppliedStrict(page, q, ctx, relaxedPrimary.pickedText);
      ctx.flow(`[music] primary selected: ${relaxedPrimary.pickedText || "(unknown)"}`);
      if (okRelaxedPrimary) {
        setCachedSound(accountUsername, q, relaxedPrimary.pickedText || q);
        return { ok: true, soundLabel: relaxedPrimary.pickedText || q };
      }
    }

    const quickApplied = await tryQuickAddAndSaveAfterSearch(page, workingPanel.panelRoot, q, ctx, 12000);
    if (quickApplied) {
      const okQuick = await verifySoundAppliedStrict(page, q, ctx);
      ctx.flow(`[music] quick add verify: ${okQuick ? "applied" : "not confirmed"}`);
      if (okQuick) {
        setCachedSound(accountUsername, q, q);
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

    for (const keyword of shuffledFallbackKeywords.slice(0, 5)) {
      throwIfAborted(signal);
      ctx.flow(`[music] trying fallback: ${keyword}`);
      await runSearchInPanel(page, workingPanel.searchInput, workingPanel.panelRoot, keyword, ctx, signal);
      const relaxed = await tryQuickAddAndSaveRelaxedAfterSearch(page, workingPanel.panelRoot, ctx, 14000, signal);
      if (relaxed.ok) {
        const okRelaxed = await verifySoundAppliedStrict(page, keyword, ctx, relaxed.pickedText);
        ctx.flow(`[music] fallback selected: ${relaxed.pickedText || "(unknown)"}`);
        if (okRelaxed) {
          setCachedSound(accountUsername, q, relaxed.pickedText || keyword);
          return { ok: true, soundLabel: relaxed.pickedText || keyword };
        }
      }
    }

    ctx.flow("[music] quick add path did not finalize, falling back to scored selection");
  }

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
  ctx.flow(`[music] selecting row: "${pick.text.slice(0, 120)}"`);

  await pick.loc.scrollIntoViewIfNeeded().catch(() => {});
  await pick.loc.click({ force: true });
  ctx.flow("[music] row clicked");

  // Let TikTok update the row state before trying to click +/apply.
  await page.waitForTimeout(humanRand(650, 1200));

  // Some TikTok Studio variants require clicking the row's Plus button instead of the row itself.
  // Try it opportunistically before looking for global/dialog apply buttons.
  const plusInRow = pick.loc
    .locator(
      'button:has([data-icon="PlusBold"]), button:has([data-testid="PlusBold"]), [role="button"]:has([data-icon="PlusBold"]), [role="button"]:has([data-testid="PlusBold"])'
    )
    .first();
  const plusVisible = await plusInRow.isVisible().catch(() => false);
  const plusDisabled = await plusInRow.isDisabled().catch(() => true);
  ctx.flow(`[music] row plus: visible=${plusVisible} disabled=${plusDisabled}`);
  if (plusVisible && !plusDisabled) {
    await page.waitForTimeout(humanRand(650, 1200));
    await plusInRow.click({ force: true }).catch(() => {});
    ctx.flow("[music] row plus clicked");
    await page.waitForTimeout(250);
  }

  await musicDebugShot(ctx, page, "step-music-selected.png");

  await page.waitForTimeout(500);
  const appliedBtn = await clickApplySoundIfPresent(page, ctx, 10000);
  if (!appliedBtn) {
    ctx.flow("[music] no explicit apply button — may be single-step");
  }

  const ok = await verifySoundAppliedStrict(page, q, ctx, pick.text);
  ctx.flow(`[music] verify result: ${ok ? "applied" : "not confirmed"}`);
  if (ok) {
    setCachedSound(accountUsername, q, pick.text);
    ctx.flow(`[music] cached selected sound for query "${q.slice(0, 60)}"`);
    return { ok: true, soundLabel: pick.text };
  }
  if (usedCache) {
    invalidateCachedSound(accountUsername, q);
    ctx.flow("[music] invalidated stale cache entry");
  }
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
  ctx.flow(`[music] requested query: "${q.slice(0, 80)}"`);
  await dismissStopCopyrightDialog(page, ctx, "before-sound-flow");
  await dismissAutomaticContentChecksOfferDialog(page, ctx, "before-sound-flow");

  const baseSoundBudgetMs = Number(process.env.TIKTOK_SOUND_FLOW_MS || 40000);
  const soundBudgetMs = q.toLowerCase() === "trending" ? baseSoundBudgetMs : Math.max(baseSoundBudgetMs, 70000);

  try {
    await waitForVideoPreviewStableBeforeSound(page, ctx, 90000);

    if (flowDebugOn()) {
      ctx.debug("[music] selector probe before open");
      await logMusicRelatedControls(page, ctx);
      await logModals(page, ctx);
    }

    const label = await withSoundFlowTimeout(soundBudgetMs, async (signal) => {
      let r = await executeOneSoundAttempt(page, q, ctx, accountUsername, signal);
      const musicRetry = process.env.TIKTOK_MUSIC_RETRY === "1";
      if (!r.ok && musicRetry) {
        ctx.flow("[music] verification failed — retry once (TIKTOK_MUSIC_RETRY=1)");
        await dismissOpenSoundUi(page, ctx);
        await humanPause(page, 1800, 3200);
        r = await executeOneSoundAttempt(page, q, ctx, accountUsername, signal);
      }
      if (r.ok && r.soundLabel) {
        console.log("[MUSIC] Sound applied:", r.soundLabel);
        ctx.flow(`[music] final applied sound: "${r.soundLabel.slice(0, 120)}"`);
        if (flowDebugOn()) {
          await musicDebugShot(ctx, page, "step-music-verified.png");
          ctx.debug("[music] probe after success");
          await logMusicRelatedControls(page, ctx);
        }
        return r.soundLabel;
      }
      throw new Error("Sound not verified after retry");
    });
    return label;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
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
  while (Date.now() - start < timeoutMs) {
    await dismissStopCopyrightDialog(page, ctx, "wait-post-button");
    const candidate = page.locator(TIKTOK_STUDIO_SELECTORS.postButton).first();
    const visible = await candidate.isVisible().catch(() => false);
    const disabled = await candidate.isDisabled().catch(() => true);
    ctx.debug(`post poll: visible=${visible} disabled=${disabled}`);
    if (visible && !disabled) {
      ctx.flow("Post button active");
      return candidate;
    }
    await page.waitForTimeout(2000);
  }
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
  maxMsPerPattern = 60000,
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

      await page.waitForTimeout(humanRand(2200, 3800));
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

export type TikTokUploadRunResult = {
  success: boolean;
  error?: string;
  /** TikTok sound row label when automation applied a sound. */
  soundUsed?: string;
};

export async function runUploadWithSession(
  username: string,
  sessionJson: string,
  videoPath: string,
  caption: string,
  proxy?: PlaywrightProxyConfig | string,
  browser?: import("playwright").Browser,
  musicQuery?: string
): Promise<TikTokUploadRunResult> {
  const ctx = createFlowContext(username);
  let soundUsed: string | undefined;
  const tmpFile = path.join(os.tmpdir(), `tiktok-${username.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, sessionJson, "utf-8");

  let localBrowser: import("playwright").Browser | undefined;
  let context: import("playwright").BrowserContext | undefined;
  try {
    if (browser) {
      localBrowser = undefined;
    } else {
      localBrowser = await launchChromium("automation");
    }
    const activeBrowser = browser || localBrowser!;
    const userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    const resolvedProxy: PlaywrightProxyConfig | undefined =
      typeof proxy === "string"
        ? proxy.trim()
          ? { server: proxy.trim() }
          : undefined
        : proxy?.server
          ? proxy
          : undefined;

    context = await activeBrowser.newContext({
      storageState: tmpFile,
      userAgent,
      ...(resolvedProxy ? { proxy: resolvedProxy } : {}),
    });
    const page = await context.newPage();

    ctx.flow(`navigate → ${TIKTOK_UPLOAD_URL}`);
    await page.goto(TIKTOK_UPLOAD_URL, { waitUntil: "commit", timeout: 90000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    ctx.flow("navigation committed + domcontentloaded (best-effort)");

    if (await isTikTokSessionLoggedOut(page)) {
      await ctx.shot(page, "session-expired-or-logged-out.png");
      return {
        success: false,
        error:
          "SESSION_EXPIRED: TikTok session missing or expired. Re-import storageState JSON on Accounts (local capture or browser export).",
        soundUsed: undefined,
      };
    }

    ctx.flow("human: pause + scroll after load");
    await humanPause(page);
    await humanScroll(page);

    const inputOk = await waitForFileInput(page, ctx, 90000);
    if (!inputOk) {
      await ctx.shot(page, "step-1-open-page-failed-no-input.png");
      return { success: false, error: "Upload file input not found", soundUsed: undefined };
    }

    await logCoreElements(page, ctx);
    await logModals(page, ctx);
    await ctx.shot(page, "step-1-open-page.png");

    ctx.flow("human: pause before choosing file");
    await humanPause(page);
    await humanScroll(page);

    ctx.flow("video upload: setInputFiles on file input");
    const fileInput = page.locator(TIKTOK_STUDIO_SELECTORS.uploadFileInput).first();
    await fileInput.setInputFiles(videoPath);
    ctx.flow("setInputFiles dispatched");

    for (let i = 0; i < 5; i++) {
      await dismissAutomaticContentChecksOfferDialog(page, ctx, `post-set-input-${i}`);
      await dismissStopCopyrightDialog(page, ctx, `post-set-input-${i}`);
      await page.waitForTimeout(humanRand(650, 1200));
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
      ctx.flow("caption: focus and type (human-like)");
      await humanPause(page);
      await humanScroll(page);
      await captionBox.click({ force: true });
      await page.waitForTimeout(humanRand(400, 900));
      await captionBox.fill("");
      await typeTextLikeHuman(page, captionBox, caption);
      ctx.flow("caption filled");
      await humanPause(page);
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

    ctx.flow("toggles: Music copyright + Content check lite → off");
    await humanPause(page);
    await turnOffCopyrightAndContentCheckToggles(page, 70000, ctx);

    await logMusicRelatedControls(page, ctx);
    await humanPause(page);
    await humanScroll(page);
    const postBtn = await waitForPostButtonEnabled(page, ctx, 180000);
    if (!postBtn) {
      await ctx.shot(page, "step-4-post-never-enabled.png");
      return { success: false, error: "Post button not active", soundUsed };
    }

    ctx.flow("toggles: final pass before Post");
    await humanPause(page);
    await turnOffCopyrightAndContentCheckToggles(page, 25000, ctx);

    await ctx.shot(page, "step-4-before-post.png");
    await ctx.pauseIfDebug(page, "before clicking Post");

    await humanPause(page);
    await postBtn.click({ force: true });
    ctx.flow("Post clicked");

    // Some Studio variants show a confirmation dialog (Continue/Post/Post now/etc).
    await clickPostConfirmDialogsIfPresent(page, ctx, 12000);

    await humanPause(page, 3500, 5500);

    const postNow = page.locator(TIKTOK_STUDIO_SELECTORS.postNowConfirm).first();
    if (await postNow.isVisible().catch(() => false)) {
      ctx.flow('confirm modal: "Post now"');
      await humanPause(page, 1500, 2800);
      await postNow.click({ force: true });
      await humanPause(page, 2500, 4200);
    }

    // Re-check late confirmations.
    await clickPostConfirmDialogsIfPresent(page, ctx, 8000);

    if (await detectPostRejectedByTikTok(page, ctx)) {
      await ctx.shot(page, "step-post-rejected-modal.png");
      return {
        success: false,
        error: "TikTok blocked post (Community Guidelines / suspicious activity)",
        soundUsed,
      };
    }

    await humanPause(page, 5000, 8000);

    if (await detectPostRejectedByTikTok(page, ctx)) {
      await ctx.shot(page, "step-post-rejected-modal-late.png");
      return {
        success: false,
        error: "TikTok blocked post (Community Guidelines / suspicious activity)",
        soundUsed,
      };
    }

    await ctx.shot(page, "step-5-after-post.png");
    ctx.flow("flow complete");
    return { success: true, soundUsed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    if (isClosedTargetError(e)) {
      ctx.flow("error: page/context/browser closed");
      return { success: false, error: "BROWSER_CLOSED", soundUsed };
    }
    ctx.flow(`error: ${msg}`);
    return { success: false, error: msg, soundUsed };
  } finally {
    try {
      if (context) await context.close();
    } catch {}
    try {
      if (localBrowser) await localBrowser.close();
    } catch {}
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}
