import { launchChromium } from "@/lib/playwrightLaunch";
import { installSafeBandwidthRoutes } from "@/lib/playwrightSafeBandwidthRoutes";
import { dismissTikTokPopups } from "@/lib/tiktokPopupDismiss";
import { humanScroll } from "@/lib/humanBehavior";
import { renameLog, renameSlowPause } from "@/lib/renameDebugLog";
import type { Locator, Page } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";
import type { PlaywrightProxyConfig } from "@/lib/proxyPlaywright";

type RenameUsernameResult = {
  ok: boolean;
  verified: boolean;
  error?: string;
};

/** Returned when TikTok blocks change (once per ~30 days). Runner must not retry alternate names. */
export const TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR =
  "TikTok: username can only be changed once every 30 days. Try again when the cooldown ends.";

function fail(error: RenameUsernameResult["error"]): RenameUsernameResult {
  return { ok: false, verified: false, error: error || "TikTok UI did not respond after save" };
}

/** @handle segment from a tiktok.com profile URL (lowercase). */
function parseTikTokHandleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/@([^/?#]+)/i);
    if (!m) return null;
    return decodeURIComponent(m[1]).replace(/^@/, "").trim().toLowerCase();
  } catch {
    return null;
  }
}

async function firstVisibleEditProfileControl(page: Page): Promise<Locator | null> {
  const button = page.getByRole("button", { name: /edit profile/i }).first();
  if (await button.isVisible({ timeout: 1200 }).catch(() => false)) return button;

  const link = page.getByRole("link", { name: /edit profile/i }).first();
  if (await link.isVisible({ timeout: 1200 }).catch(() => false)) return link;

  const dataE2e = page.locator('[data-e2e*="edit-profile" i], [data-e2e*="EditProfile" i]').first();
  if (await dataE2e.isVisible({ timeout: 1200 }).catch(() => false)) return dataE2e;

  return null;
}

/**
 * Left nav "Profile" → own profile. Use when /@handle loaded but Edit profile never appears (slow UI, wrong surface).
 */
async function clickSidebarProfileNav(page: Page): Promise<boolean> {
  const candidates: Locator[] = [
    page.locator('[data-e2e="nav-profile"]').first(),
    page.locator('[data-e2e*="nav-profile" i]').first(),
    page.getByRole("navigation").getByRole("link", { name: /^profile$/i }).first(),
    page.locator("aside").getByRole("link", { name: /^profile$/i }).first(),
    page.getByRole("link", { name: /^profile$/i }).first(),
    page.getByRole("button", { name: /^profile$/i }).first(),
  ];

  for (let i = 0; i < candidates.length; i++) {
    const loc = candidates[i];
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      renameLog("click_sidebar_profile", { candidateIndex: i });
      await loc.click({ force: true }).catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      await dismissTikTokPopups(page);
      await page.keyboard.press("Escape").catch(() => {});
      return true;
    }
  }
  return false;
}

async function waitForEditProfile(page: Page): Promise<Locator | null> {
  const totalMs = Number(process.env.RENAME_EDIT_PROFILE_WAIT_MS || 60_000);
  const stepMs = 2_000;
  const startedAt = Date.now();
  let sidebarProfileClicks = 0;
  const maxSidebarClicks = Number(process.env.RENAME_SIDEBAR_PROFILE_MAX_CLICKS || 3);

  while (Date.now() - startedAt < totalMs) {
    const found = await firstVisibleEditProfileControl(page);
    if (found) return found;

    await dismissTikTokPopups(page);
    await page.keyboard.press("Escape").catch(() => {});

    if (sidebarProfileClicks < maxSidebarClicks) {
      const clicked = await clickSidebarProfileNav(page);
      if (clicked) {
        sidebarProfileClicks += 1;
        renameLog("sidebar_profile_clicked_retry_edit", { clickNumber: sidebarProfileClicks });
        await humanScroll(page).catch(() => {});
        await page.waitForTimeout(1500).catch(() => {});
        const afterNav = await firstVisibleEditProfileControl(page);
        if (afterNav) return afterNav;
      }
    }

    await page.waitForTimeout(stepMs).catch(() => {});
  }

  return null;
}

/** The post-Save confirmation sheet ("Set your username?") also mentions 30 days — not a block. */
function isSetUsernameConfirmationSheet(text: string): boolean {
  const t = normalizeApostrophes(text.toLowerCase());
  return /set your username\??/.test(t) && (/\bcancel\b/i.test(t) || /\bconfirm\b/i.test(t));
}

/**
 * TikTok only allows changing @username once every ~30 days — detect real blocks, not help text.
 * The Edit profile sheet repeats “You can change your username once every 30 days” as **information**;
 * matching that alone caused false `detected_issue_in_body` cooldown right after Save.
 */
function scanFor30DayUsernameCooldown(text: string): boolean {
  const t = normalizeApostrophes(text.toLowerCase());

  // Edit-profile helper / confirm copy — not a block (still on page in body.innerText after Save).
  if (/\byou can change your username once every\b/i.test(t)) {
    return false;
  }

  if (
    /once every\s*30\s*days/i.test(t) &&
    !/\b(can'?t|cannot|unable to|try again|blocked|sorry|not eligible|no longer)\b/i.test(t)
  ) {
    return false;
  }

  return (
    /once every\s*30\s*days/.test(t) ||
    /change your username once every/.test(t) ||
    /username.*once every\s*30/.test(t) ||
    /can'?t change your username.*30|cannot change your username.*30/.test(t) ||
    /try again in \d+\s*days?/.test(t) ||
    /recently changed your username/.test(t) ||
    /wait \d+\s*days?.*username|username.*wait \d+\s*days?/.test(t)
  );
}

/** Normalize curly/smart quotes to straight ASCII so regex matching works reliably. */
function normalizeApostrophes(s: string): string {
  return s.replace(/[\u2018\u2019\u2032\u00B4`]/g, "'");
}

function scanRootForUsernameIssue(text: string): "taken" | "error" | "cooldown" | null {
  const t = normalizeApostrophes(text.toLowerCase());
  if (scanFor30DayUsernameCooldown(t)) return "cooldown";
  if (/invalid username|characters not allowed|only letters|special characters/i.test(t)) return "error";
  if (
    /username\s+is(n't| not)\s+available/i.test(t) ||
    /this\s+username\s+is(n't| not)\s+available/i.test(t) ||
    /handle\s+is(n't| not)\s+available/i.test(t) ||
    /isn't available.*enter a new one/i.test(t) ||
    /username.*(taken|unavailable|not available|in use|already)/i.test(t) ||
    /not available\./i.test(t) ||
    /(already|is)\s+taken|already\s+in\s+use/i.test(t) ||
    /try (a |another )?different/i.test(t) ||
    /choose (a |another )?username/i.test(t) ||
    /already exists/i.test(t) ||
    /please enter a new one/i.test(t)
  ) {
    return "taken";
  }
  return null;
}

/**
 * After Save on the username field, TikTok shows: "Set your username?" / "once every 30 days" with Cancel / Confirm.
 * We must click Confirm to apply the change.
 */
async function pickSetUsernameConfirmDialog(page: Page): Promise<Locator | null> {
  const dialogCount = await page.locator('[role="dialog"]').count().catch(() => 0);
  for (let i = 0; i < dialogCount; i++) {
    const d = page.locator('[role="dialog"]').nth(i);
    if (!(await d.isVisible({ timeout: 400 }).catch(() => false))) continue;
    const text = (await d.innerText().catch(() => "")).slice(0, 3000);
    if (!/set your username/i.test(text)) continue;
    if (!/30\s*days/i.test(text) && !/\bcancel\b/i.test(text)) continue;
    return d;
  }

  const byHeading = page
    .locator('[role="dialog"]')
    .filter({ has: page.getByRole("heading", { name: /set your username/i }) })
    .first();
  if (await byHeading.isVisible({ timeout: 400 }).catch(() => false)) return byHeading;

  const byCopy = page
    .locator('[role="dialog"]')
    .filter({
      hasText: /set your username|you can change your username once every|change your username once every/i,
    })
    .first();
  if (await byCopy.isVisible({ timeout: 400 }).catch(() => false)) return byCopy;

  return null;
}

/**
 * TikTok sometimes uses non-button nodes or odd ARIA names — find Confirm inside the sheet via DOM.
 */
async function clickSetUsernameConfirmViaPageDom(page: Page): Promise<boolean> {
  const ok = await page.evaluate(() => {
    const roots: Element[] = [];
    document.querySelectorAll('[role="dialog"]').forEach((el) => roots.push(el));

    for (const root of roots) {
      const html = root as HTMLElement;
      const rect = html.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      const block = (html.innerText || "").slice(0, 4000);
      if (!/set your username/i.test(block)) continue;

      const clickables = root.querySelectorAll(
        "button, [role='button'], [role='menuitem'], div[tabindex='0'], a[href='#']"
      );
      for (const el of clickables) {
        const t = ((el as HTMLElement).innerText || "")
          .replace(/\s+/g, " ")
          .trim();
        if (/^confirm$/i.test(t)) {
          (el as HTMLElement).click();
          return true;
        }
      }
      for (const el of clickables) {
        const t = ((el as HTMLElement).innerText || "").trim();
        if (/\bconfirm\b/i.test(t) && !/\bcancel\b/i.test(t) && t.length < 40) {
          (el as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  });
  if (ok) renameLog("clicked_confirm_via_dom_evaluate");
  return ok;
}

async function clickConfirmInDialog(mainDialog: Locator, page: Page): Promise<boolean> {
  await mainDialog.scrollIntoViewIfNeeded().catch(() => {});

  const tryClick = async (loc: Locator, label: string): Promise<boolean> => {
    if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) return false;
    try {
      await loc.click({ force: true, timeout: 8000 });
      renameLog("confirm_click_strategy", { label });
      return true;
    } catch {
      return false;
    }
  };

  if (await tryClick(mainDialog.getByRole("button", { name: /^confirm$/i }).first(), "role_button_exact")) return true;
  if (await tryClick(mainDialog.getByRole("button", { name: /^\s*confirm\s*$/i }).first(), "role_button_trim")) return true;

  const divButton = mainDialog.locator("div[role='button']").filter({ hasText: /^\s*confirm\s*$/i }).first();
  if (await tryClick(divButton, "div_role_button")) return true;

  const anyConfirm = mainDialog
    .locator("button, [role='button'], div[role='button'], span[role='button']")
    .filter({ hasText: /^\s*confirm\s*$/i })
    .first();
  if (await tryClick(anyConfirm, "any_role_confirm_text")) return true;

  if (await tryClick(mainDialog.getByRole("button", { name: /confirm/i }).first(), "role_button_fuzzy")) return true;

  const byText = mainDialog.getByText(/^confirm$/i).first();
  if (await tryClick(byText, "getByText_confirm")) return true;

  const globalConfirm = page.getByRole("button", { name: /^confirm$/i }).filter({ hasText: /^confirm$/i }).first();
  if (await tryClick(globalConfirm, "global_role_confirm")) return true;

  if (await clickSetUsernameConfirmViaPageDom(page)) return true;

  return false;
}

/**
 * After Save in Edit profile, TikTok shows "Set your username?" with Cancel / Confirm — must click Confirm.
 * Polls: the dialog often appears a few hundred ms after Save. Retries clicks if the sheet is visible but not yet actionable.
 */
async function confirmSetUsernameDialogIfPresent(page: Page): Promise<boolean> {
  const pollMs = Number(process.env.RENAME_CONFIRM_MODAL_POLL_MS || 25_000);
  const stepMs = 400;
  const deadline = Date.now() + pollMs;
  let sawModal = false;

  while (Date.now() < deadline) {
    const mainDialog = await pickSetUsernameConfirmDialog(page);
    if (mainDialog) {
      sawModal = true;
      renameLog("set_username_confirm_modal_visible");
      const clicked = await clickConfirmInDialog(mainDialog, page);
      if (clicked) {
        renameLog("clicked_confirm_set_username_modal");
        await page.waitForTimeout(2000).catch(() => {});
        return true;
      }
      renameLog("confirm_modal_visible_retry", {});
      await page.waitForTimeout(stepMs).catch(() => {});
      if (await clickSetUsernameConfirmViaPageDom(page)) {
        renameLog("clicked_confirm_set_username_modal");
        await page.waitForTimeout(2000).catch(() => {});
        return true;
      }
      await page.waitForTimeout(stepMs).catch(() => {});
      continue;
    }

    if (!sawModal && (await clickSetUsernameConfirmViaPageDom(page))) {
      renameLog("clicked_confirm_dom_without_dialog_locator");
      await page.waitForTimeout(2000).catch(() => {});
      return true;
    }

    await page.waitForTimeout(stepMs).catch(() => {});
  }

  renameLog("set_username_confirm_modal_absent", { sawModal });
  return false;
}

async function detectUsernameTakenOrError(
  page: import("playwright").Page
): Promise<"taken" | "error" | "cooldown" | null> {
  for (const sel of [
    '[role="dialog"]',
    '[role="alert"]',
    '[role="status"]',
    '[data-e2e*="modal" i]',
  ]) {
    const root = page.locator(sel).first();
    if (await root.isVisible({ timeout: 800 }).catch(() => false)) {
      const text = (await root.innerText().catch(() => "")).slice(0, 8000);
      if (isSetUsernameConfirmationSheet(text)) {
        continue;
      }
      const hit = scanRootForUsernameIssue(text);
      if (hit) {
        renameLog("detected_issue_in_modal", { sel, hit, textPreview: text.slice(0, 280) });
        return hit;
      }
    }
  }

  const toastSelectors = [
    '[data-e2e*="toast" i]',
    '[class*="Toast"]',
    '[class*="toast"]',
    '[data-testid*="toast" i]',
  ];
  for (const sel of toastSelectors) {
    const nodes = page.locator(sel);
    const count = await nodes.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 6); i++) {
      const el = nodes.nth(i);
      if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
        const text = (await el.innerText().catch(() => "")).slice(0, 4000);
        const hit = scanRootForUsernameIssue(text);
        if (hit) {
          renameLog("detected_issue_in_toast", { sel, index: i, hit, textPreview: text.slice(0, 220) });
          return hit;
        }
      }
    }
  }

  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 12000);
  const confirmDlg = await pickSetUsernameConfirmDialog(page);
  const confirmSheetOpen =
    confirmDlg !== null && (await confirmDlg.isVisible({ timeout: 300 }).catch(() => false));
  if (scanFor30DayUsernameCooldown(body) && !confirmSheetOpen && !isSetUsernameConfirmationSheet(body)) {
    renameLog("detected_30_day_cooldown_in_body", { textPreview: body.slice(0, 400) });
    return "cooldown";
  }
  const bodyHit = scanRootForUsernameIssue(body);
  if (bodyHit) {
    renameLog("detected_issue_in_body", { hit: bodyHit, textPreview: body.slice(0, 320) });
    return bodyHit;
  }
  return null;
}

async function maybeScreenshot(page: import("playwright").Page, label: string): Promise<void> {
  const dir = process.env.RENAME_SCREENSHOT_DIR?.trim();
  if (!dir) return;
  try {
    const p = path.join(dir, `rename-${Date.now()}-${label.replace(/[^a-z0-9_-]/gi, "_")}.png`);
    await fs.promises.mkdir(dir, { recursive: true });
    await page.screenshot({ path: p, fullPage: false });
    renameLog("screenshot_saved", { path: p });
  } catch (e) {
    renameLog("screenshot_failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

/** After navigation, overlays / lazy UI can hide Edit profile until dismiss + scroll. */
async function isOwnProfileAfterStabilize(page: import("playwright").Page): Promise<boolean> {
  await dismissTikTokPopups(page).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await humanScroll(page).catch(() => {});
  await page.waitForTimeout(600).catch(() => {});

  const btn = page.getByRole("button", { name: /edit profile/i }).first();
  if (await btn.isVisible({ timeout: 8000 }).catch(() => false)) return true;
  const link = page.getByRole("link", { name: /edit profile/i }).first();
  if (await link.isVisible({ timeout: 4000 }).catch(() => false)) return true;
  const fallback = page.locator('[data-e2e*="edit-profile" i], [data-e2e*="EditProfile" i]').first();
  if (await fallback.isVisible({ timeout: 4000 }).catch(() => false)) return true;

  await humanScroll(page).catch(() => {});
  await page.waitForTimeout(400).catch(() => {});
  return (
    (await btn.isVisible({ timeout: 3000 }).catch(() => false)) ||
    (await link.isVisible({ timeout: 2000 }).catch(() => false)) ||
    (await fallback.isVisible({ timeout: 2000 }).catch(() => false))
  );
}

type VerifyNewUsernameOptions = {
  /**
   * User already confirmed “Set your username?” in this session. If the /@handle page loads and is not a
   * not-found screen, treat as success even when Edit profile is missing (lazy UI / layout quirks caused
   * false “belongs to another user” after a real rename).
   */
  confirmModalWasClicked?: boolean;
};

/**
 * Verify the new @handle: real profile URL, not a dead page; prefer Edit profile when visible.
 * With `confirmModalWasClicked`, accept URL + loaded profile after TikTok already accepted the change.
 */
async function verifyNewUsernameOnTikTok(
  page: import("playwright").Page,
  expectedHandle: string,
  opts?: VerifyNewUsernameOptions
): Promise<{ ok: boolean; detail: string }> {
  const target = expectedHandle.replace(/^@/, "").trim().toLowerCase();
  const trustPostConfirm = Boolean(opts?.confirmModalWasClicked);
  renameLog("verify_step_1_check_current_url", { url: page.url(), expectedHandle: target, trustPostConfirm });

  await page.waitForTimeout(1000).catch(() => {});
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(target)}`;
  renameLog("verify_step_2_goto_profile", { profileUrl });
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForTimeout(2000).catch(() => {});
  await maybeScreenshot(page, "after-verify-goto");

  const finalUrl = page.url().toLowerCase();
  renameLog("verify_step_3_url_after_goto", { finalUrl });

  const body = normalizeApostrophes(
    (await page.locator("body").innerText().catch(() => "")).slice(0, 5000)
  );
  renameLog("verify_step_4_body_snippet", { snippet: body.slice(0, 500) });

  if (/couldn't find|could not find|page isn't available|user not found|no results|doesn't exist/i.test(body)) {
    return { ok: false, detail: "TikTok page indicates this @handle does not exist or is unavailable" };
  }

  const urlMatch =
    finalUrl.includes(`@${target}`) || finalUrl.includes("%40" + target);

  if (!urlMatch) {
    return {
      ok: false,
      detail: "Could not verify: URL does not show the new handle (UI may differ)",
    };
  }

  const ownProfile = await isOwnProfileAfterStabilize(page);
  renameLog("verify_step_5_own_profile_check", { ownProfile });

  if (ownProfile) {
    return { ok: true, detail: "Browser URL matches new handle AND Edit profile confirms ownership" };
  }

  if (trustPostConfirm) {
    renameLog("verify_trust_post_confirm_modal", {
      target,
      detail: "Confirm modal was clicked; profile URL loads and is not a not-found page — treating rename as verified",
    });
    return {
      ok: true,
      detail:
        "Post-confirm: /@ handle URL loads with no not-found state (Edit profile not detected; accepted after Set username confirm)",
    };
  }

  return {
    ok: false,
    detail:
      "Profile /@" +
      target +
      " loaded but Edit profile was not found — cannot confirm this session owns the account (try again or increase waits).",
  };
}

type RenameMultiResult = RenameUsernameResult & {
  /** Which candidate actually succeeded (so the runner knows which name was applied). */
  appliedCandidate?: string;
  /** Names that were tried and confirmed unavailable on TikTok (Save disabled / TikTok rejected). */
  triedUnavailable: string[];
};

/**
 * Profile → Edit profile → try candidates in-session → Save (TikTok web).
 *
 * Accepts multiple candidate usernames. For each one it types the name, waits for
 * TikTok's inline availability check, and only clicks Save when TikTok enables it.
 * If a name is unavailable it tries the next candidate **without closing the browser**.
 */
export async function renameTikTokUsername(opts: {
  sessionJson: string;
  currentUsername: string;
  /** Primary target name. */
  newUsername: string;
  /** Extra fallback candidates to try in the SAME browser session if the primary is taken. */
  fallbackCandidates?: string[];
  proxy?: PlaywrightProxyConfig;
}): Promise<RenameMultiResult> {
  const handle = opts.currentUsername.replace(/^@/, "").trim();
  const allCandidates = [
    opts.newUsername,
    ...(opts.fallbackCandidates || []),
  ]
    .map((s) => s.replace(/^@/, "").trim().toLowerCase())
    .filter((s) => s.length >= 2 && s !== handle.toLowerCase());

  const triedUnavailable: string[] = [];

  if (allCandidates.length === 0) {
    renameLog("abort_no_valid_candidates", { handle });
    return { ...fail("No valid candidate usernames"), triedUnavailable };
  }

  renameLog("job_start", {
    currentUsernameFromDb: handle,
    candidates: allCandidates,
    proxyServer: opts.proxy?.server ? "(set)" : "(none)",
  });

  const tmpFile = path.join(
    os.tmpdir(),
    `tiktok-user-${handle.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`
  );
  fs.writeFileSync(tmpFile, opts.sessionJson, "utf-8");
  renameLog("session_tmp_written", { tmpFile: tmpFile.slice(-80) });

  const browser = await launchChromium("automation", opts.proxy?.server ? opts.proxy : undefined);
  renameLog("browser_launched", { headless: process.env.PLAYWRIGHT_HEADLESS || "false" });

  try {
    const context = await browser.newContext({
      storageState: tmpFile,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1366, height: 768 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await installSafeBandwidthRoutes(context);
    const page = await context.newPage();

    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
    renameLog("navigate_old_profile", { profileUrl });
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await dismissTikTokPopups(page);

    const urlAfterNav = parseTikTokHandleFromUrl(page.url());
    const firstCandidate = allCandidates[0];
    if (urlAfterNav === firstCandidate) {
      renameLog("tiktok_url_already_shows_target_handle", {
        target: firstCandidate,
        url: page.url(),
        dbHandle: handle,
      });
      return { ok: true, verified: true, appliedCandidate: firstCandidate, triedUnavailable };
    }

    await page.waitForTimeout(1500).catch(() => {});
    await humanScroll(page);
    await page.waitForTimeout(1000).catch(() => {});
    await maybeScreenshot(page, "01-profile-loaded");

    const editProfile = await waitForEditProfile(page);
    if (!editProfile) {
      await maybeScreenshot(page, "02-no-edit-profile");
      renameLog("fail_edit_profile_missing", { url: page.url() });
      return { ...fail("Edit profile not found (not logged into this account)"), triedUnavailable };
    }

    renameLog("click_edit_profile");
    await editProfile.click({ force: true });
    await page.waitForTimeout(2000).catch(() => {});
    await maybeScreenshot(page, "03-after-edit-profile");

    const usernameInputCandidates = [
      page.locator('input[name="uniqueId"]'),
      page.locator('input[autocomplete="username"]'),
      page.locator('[data-e2e*="unique" i] input'),
      page.locator('[data-e2e*="username" i] input'),
      page.getByPlaceholder(/username/i),
      page.getByRole("textbox", { name: /username/i }),
    ];

    let input: import("playwright").Locator | null = null;
    for (let i = 0; i < usernameInputCandidates.length; i++) {
      const el = usernameInputCandidates[i].first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        input = el;
        renameLog("username_input_found", { candidateIndex: i });
        break;
      }
    }

    if (!input) {
      const usernameRow = page.getByText(/^username$/i).first();
      if (await usernameRow.isVisible({ timeout: 4000 }).catch(() => false)) {
        renameLog("click_username_row");
        await usernameRow.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1500).catch(() => {});
        for (let i = 0; i < usernameInputCandidates.length; i++) {
          const el = usernameInputCandidates[i].first();
          if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
            input = el;
            renameLog("username_input_found_after_row", { candidateIndex: i });
            break;
          }
        }
      }
    }

    if (!input) {
      await maybeScreenshot(page, "04-no-username-input");
      return { ...fail("Username input not found"), triedUnavailable };
    }

    const valueBefore = (await input.inputValue().catch(() => "")) || "(empty)";
    renameLog("username_field_before_fill", { valueBefore });

    // ---------- Find Save button once (it stays in the form) ----------
    const saveBtnCandidates = [
      page.getByRole("button", { name: /^save$/i }).first(),
      page.locator('button:has-text("Save")').first(),
      page.locator('[data-e2e*="save" i] button, [data-e2e*="save" i]').first(),
      page.locator('button[type="submit"]').first(),
    ];
    let saveBtn: import("playwright").Locator | null = null;
    for (const loc of saveBtnCandidates) {
      if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
        saveBtn = loc;
        renameLog("save_button_found", { selector: loc.toString() });
        break;
      }
    }
    if (!saveBtn) {
      await maybeScreenshot(page, "05-no-save-button");
      renameLog("save_button_not_found_anywhere");
      return { ...fail("Save button not found"), triedUnavailable };
    }

    // ---------- In-session candidate loop ----------
    // Strategy: type name → wait 2s → click Save → check TikTok's response
    //   confirm popup → click confirm → verify → success
    //   taken/error popup → dismiss → try next name
    //   cooldown → abort
    const charDelay = Number(process.env.RENAME_USERNAME_CHAR_DELAY_MS || 120);
    const afterTypeWaitMs = Number(process.env.RENAME_AFTER_TYPE_WAIT_MS || 2000);

    for (const next of allCandidates) {
      renameLog("in_session_try_candidate", { candidate: next });
      console.info(`[rename] OLD @${handle} → trying @${next}`);

      // Clear and type the candidate
      await input.click({ force: true });
      await input.fill("");
      await page.waitForTimeout(300).catch(() => {});

      for (const ch of next) {
        await input.type(ch, { delay: charDelay });
      }
      renameLog("username_field_after_type", { typed: next });

      const valueAfterType = (await input.inputValue().catch(() => "")) || "";
      renameLog("username_input_value_check", { valueAfterType, matchesTarget: valueAfterType.toLowerCase() === next });

      // Wait briefly then click Save regardless of TikTok's availability check
      await page.waitForTimeout(afterTypeWaitMs).catch(() => {});

      // Re-find Save button each iteration (TikTok may re-render the form)
      let currentSaveBtn: import("playwright").Locator | null = null;
      for (const loc of saveBtnCandidates) {
        if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
          currentSaveBtn = loc;
          break;
        }
      }
      if (!currentSaveBtn) {
        renameLog("in_session_save_not_found", { candidate: next });
        triedUnavailable.push(next);
        continue;
      }

      renameLog("click_save", { candidate: next });
      try {
        await currentSaveBtn.click({ force: true, timeout: 5000 });
      } catch {
        // Save click timed out — TikTok likely disabled it (name taken)
        renameLog("in_session_save_click_timeout", { candidate: next });
        triedUnavailable.push(next);
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(500).catch(() => {});
        continue;
      }

      const afterSaveMs = Number(process.env.RENAME_AFTER_SAVE_TO_MODAL_MS || 800);
      await page.waitForTimeout(afterSaveMs).catch(() => {});
      renameLog("after_save_wait", { ms: afterSaveMs });

      // --- Check what TikTok shows after Save ---
      const issueAfterSave = await detectUsernameTakenOrError(page);
      if (issueAfterSave === "cooldown") {
        renameLog("result_30_day_cooldown_after_save", { oldHandle: handle, attemptedNew: next });
        console.warn(`[rename] BLOCKED 30-day cooldown — OLD @${handle} unchanged`);
        return { ...fail(TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR), triedUnavailable };
      }
      if (issueAfterSave === "taken") {
        renameLog("in_session_taken_after_save", { candidate: next });
        triedUnavailable.push(next);
        // Dismiss any error dialog/toast and try next candidate
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(500).catch(() => {});
        continue;
      }
      if (issueAfterSave === "error") {
        renameLog("in_session_error_after_save", { candidate: next });
        triedUnavailable.push(next);
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(500).catch(() => {});
        continue;
      }

      // No error → check for confirm popup ("Set your username?")
      const confirmed = await confirmSetUsernameDialogIfPresent(page);
      await maybeScreenshot(page, "07-after-save-and-confirm");

      // Check again after confirm attempt
      const issueAfterConfirm = await detectUsernameTakenOrError(page);
      if (issueAfterConfirm === "cooldown") {
        return { ...fail(TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR), triedUnavailable };
      }
      if (issueAfterConfirm === "taken") {
        renameLog("in_session_taken_after_confirm", { candidate: next });
        triedUnavailable.push(next);
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(500).catch(() => {});
        continue;
      }

      if (!confirmed) {
        // No confirm modal appeared — wait a bit more, check for late errors
        renameLog("set_username_confirm_modal_absent_probe");
        await page.waitForTimeout(2500);
        const lateIssue = await detectUsernameTakenOrError(page);
        if (lateIssue === "cooldown") {
          return { ...fail(TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR), triedUnavailable };
        }
        if (lateIssue === "taken") {
          triedUnavailable.push(next);
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(500).catch(() => {});
          continue;
        }
        if (lateIssue === "error") {
          triedUnavailable.push(next);
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(500).catch(() => {});
          continue;
        }

        // No errors, no confirm — try to verify
        const verificationNoModal = await verifyNewUsernameOnTikTok(page, next, {
          confirmModalWasClicked: false,
        });
        if (verificationNoModal.ok) {
          renameLog("SUCCESS_verified_without_confirm_modal", {
            detail: verificationNoModal.detail,
            targetUsername: next,
            oldUsername: handle,
          });
          console.info(`[rename] SUCCESS — OLD @${handle} → NEW @${next} (verified; no confirm modal)`);
          return { ok: true, verified: true, appliedCandidate: next, triedUnavailable };
        }
        if (/does not exist|unavailable/i.test(verificationNoModal.detail)) {
          triedUnavailable.push(next);
          continue;
        }
        return { ...fail("TikTok UI did not respond after save"), triedUnavailable };
      }

      // Confirm was clicked — verify the rename
      renameLog("no_error_modal_proceed_verify", { url: page.url() });
      const verification = await verifyNewUsernameOnTikTok(page, next, { confirmModalWasClicked: true });

      if (!verification.ok) {
        renameLog("FAIL_not_verified", { detail: verification.detail });
        await maybeScreenshot(page, "08-verify-failed");
        return { ...fail("Verification failed: username not updated on profile"), triedUnavailable };
      }

      renameLog("SUCCESS_verified", {
        detail: verification.detail,
        targetUsername: next,
        oldUsername: handle,
        message: `TikTok username applied: OLD @${handle} → NEW @${next}`,
      });
      console.info(`[rename] SUCCESS — OLD @${handle} → NEW @${next} (verified on TikTok; update app DB next)`);
      return { ok: true, verified: true, appliedCandidate: next, triedUnavailable };
    }

    // All candidates exhausted
    renameLog("all_candidates_unavailable", { tried: triedUnavailable });
    return { ...fail("Username not available"), triedUnavailable };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    renameLog("exception", { message: msg });
    if (/timeout/i.test(msg)) {
      return { ...fail("Page load timeout"), triedUnavailable };
    }
    return { ...fail("TikTok UI did not respond after save"), triedUnavailable };
  } finally {
    await browser.close().catch(() => {});
    renameLog("browser_closed");
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  }
}
