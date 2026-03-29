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

const REGION_FALLBACK_SEARCHES = ["trending", "viral sound"] as const;

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
  fs.mkdirSync(debugDir, { recursive: true });

  const flow = (step: string) => console.log(`[FLOW] ${step}`);
  const debug = (msg: string) => {
    if (flowDebugOn()) console.log(`[DEBUG] ${msg}`);
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
  if (flowDebugOn()) await ctx.shot(page, fileName);
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

async function waitForSoundResultsInRoot(page: Page, panelRoot: PwLocator, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
      out.push({ loc: el, text });
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
    .map((c) => ({ ...c, score: scoreSoundMatch(musicQuery, c.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function runSearchInPanel(page: Page, searchInput: PwLocator, term: string, ctx: FlowContext): Promise<void> {
  await searchInput.click({ force: true }).catch(() => {});
  await searchInput.fill("");
  await searchInput.fill(term);
  await searchInput.press("Enter");
  await page.keyboard.press("Enter").catch(() => {});
  const short = term.length > 70 ? `${term.slice(0, 70)}…` : term;
  ctx.flow(`[music] search: "${short}"`);
  const typedValue = await searchInput.inputValue().catch(() => "");
  ctx.flow(`[music] search input value now: "${(typedValue || "").slice(0, 80)}"`);
  await page.waitForTimeout(450);
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
  ctx: FlowContext
): Promise<{ loc: PwLocator; text: string } | null> {
  if (workingPanel.mode !== "search") return null;
  const short = cached.label.length > 64 ? `${cached.label.slice(0, 64)}…` : cached.label;
  ctx.flow(`[music] cache hit — quick search: "${short}"`);
  await runSearchInPanel(page, workingPanel.searchInput, cached.label, ctx);
  try {
    await waitForSoundResultsInRoot(page, workingPanel.panelRoot, 12000);
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
  ctx: FlowContext
): Promise<{ loc: PwLocator; text: string } | null> {
  const q = musicQuery.trim();
  const searchTerms = [q, ...REGION_FALLBACK_SEARCHES.filter((t) => t.toLowerCase() !== q.toLowerCase())];

  let wp = workingPanel;

  for (let si = 0; si < searchTerms.length; si++) {
    const term = searchTerms[si];
    try {
      if (wp.mode === "search") {
        await runSearchInPanel(page, wp.searchInput, term, ctx);
        if (flowDebugOn() && si === 0) await musicDebugShot(ctx, page, "step-music-search.png");
        await waitForSoundResultsInRoot(page, wp.panelRoot, 24000);
      } else {
        if (si > 0) {
          ctx.flow("[music] cannot run fallback search on pure list panel");
          break;
        }
        await waitForSoundResultsInRoot(page, wp.panelRoot, 20000);
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
    const plusGlobal = page
      .locator('button:has([data-icon="PlusBold"]), button:has([data-testid="PlusBold"])')
      .first();
    if ((await plusGlobal.isVisible().catch(() => false)) && !(await plusGlobal.isDisabled().catch(() => true))) {
      await plusGlobal.click({ force: true }).catch(() => {});
      ctx.flow("[music] apply: clicked Plus button (global)");
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

/**
 * Fast path for current TikTok Studio sound UI:
 * search -> click first Plus button -> click Save.
 * This bypasses brittle row selectors when results are visible but not role=listbox/option.
 */
async function tryQuickAddAndSaveAfterSearch(
  page: Page,
  panelRoot: PwLocator,
  ctx: FlowContext,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const plusInPanel = panelRoot
      .locator('button:has([data-icon="PlusBold"]), button:has([data-testid="PlusBold"])')
      .first();
    if ((await plusInPanel.isVisible().catch(() => false)) && !(await plusInPanel.isDisabled().catch(() => true))) {
      await plusInPanel.click({ force: true }).catch(() => {});
      ctx.flow("[music] quick add: clicked first Plus in panel");
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

  let workingPanel = await coerceListPanelToSearch(page, panel, ctx);

  // Preferred fast path for the current UI shape user shared.
  if (workingPanel.mode === "search") {
    await runSearchInPanel(page, workingPanel.searchInput, q, ctx);
    const quickApplied = await tryQuickAddAndSaveAfterSearch(page, workingPanel.panelRoot, ctx, 12000);
    if (quickApplied) {
      const okQuick = await verifySoundAppliedStrict(page, q, ctx);
      ctx.flow(`[music] quick add verify: ${okQuick ? "applied" : "not confirmed"}`);
      if (okQuick) {
        setCachedSound(accountUsername, q, q);
        return { ok: true, soundLabel: q };
      }
    }
    ctx.flow("[music] quick add path did not finalize, falling back to scored selection");
  }

  const cached = getCachedSound(accountUsername, q);
  let pick: { loc: PwLocator; text: string } | null = null;
  let usedCache = false;
  if (cached) {
    pick = await trySelectCachedSound(page, workingPanel, cached, ctx);
    usedCache = pick != null;
  }
  if (!pick) {
    pick = await pickBestSoundFromPanel(page, workingPanel, q, ctx);
  }
  if (!pick) throw new Error("No sound row selected");
  ctx.flow(`[music] selecting row: "${pick.text.slice(0, 120)}"`);

  await pick.loc.scrollIntoViewIfNeeded().catch(() => {});
  await pick.loc.click({ force: true });
  ctx.flow("[music] row clicked");
  await musicDebugShot(ctx, page, "step-music-selected.png");

  const appliedBtn = await clickApplySoundIfPresent(page, ctx, 22000);
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

  const soundBudgetMs = Number(process.env.TIKTOK_SOUND_FLOW_MS || 40000);

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

    await humanPause(page, 3500, 5500);

    const postNow = page.locator(TIKTOK_STUDIO_SELECTORS.postNowConfirm).first();
    if (await postNow.isVisible().catch(() => false)) {
      ctx.flow('confirm modal: "Post now"');
      await humanPause(page, 1500, 2800);
      await postNow.click({ force: true });
      await humanPause(page, 2500, 4200);
    }

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
    ctx.flow(`error: ${e instanceof Error ? e.message : "Upload failed"}`);
    return { success: false, error: e instanceof Error ? e.message : "Upload failed", soundUsed };
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
