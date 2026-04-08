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
        await renameSlowPause(page, "after_set_username_confirm_click");
        return true;
      }
      renameLog("confirm_modal_visible_retry", {});
      await page.waitForTimeout(stepMs).catch(() => {});
      if (await clickSetUsernameConfirmViaPageDom(page)) {
        renameLog("clicked_confirm_set_username_modal");
        await renameSlowPause(page, "after_set_username_confirm_click");
        return true;
      }
      await page.waitForTimeout(stepMs).catch(() => {});
      continue;
    }

    if (!sawModal && (await clickSetUsernameConfirmViaPageDom(page))) {
      renameLog("clicked_confirm_dom_without_dialog_locator");
      await renameSlowPause(page, "after_set_username_confirm_click");
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

  await renameSlowPause(page, "verify_before_profile_nav");
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(target)}`;
  renameLog("verify_step_2_goto_profile", { profileUrl });
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await renameSlowPause(page, "verify_after_profile_nav");
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

/**
 * Profile → Edit profile → Username → Save (TikTok web).
 * Logs heavily; uses slow pauses (RENAME_PAUSE_MIN_MS / RENAME_PAUSE_MAX_MS).
 * Success only after verification navigation — never "silent success".
 */
export async function renameTikTokUsername(opts: {
  sessionJson: string;
  currentUsername: string;
  newUsername: string;
  proxy?: PlaywrightProxyConfig;
}): Promise<RenameUsernameResult> {
  const handle = opts.currentUsername.replace(/^@/, "").trim();
  const next = opts.newUsername.replace(/^@/, "").trim().toLowerCase();

  renameLog("job_start", {
    currentUsernameFromDb: handle,
    targetNewUsername: next,
    proxyServer: opts.proxy?.server ? "(set)" : "(none)",
  });
  console.info(`[rename] OLD @${handle} → target NEW @${next} (TikTok profile → edit username)`);

  if (!next || next.length < 2) {
    renameLog("abort_invalid_target", { next });
    return fail("TikTok UI did not respond after save");
  }

  if (next === handle.toLowerCase()) {
    renameLog("abort_same_as_current", { handle, next });
    return fail("TikTok UI did not respond after save");
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `tiktok-user-${handle.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`
  );
  fs.writeFileSync(tmpFile, opts.sessionJson, "utf-8");
  renameLog("session_tmp_written", { tmpFile: tmpFile.slice(-80) });

  const browser = await launchChromium("automation");
  renameLog("browser_launched", { headless: process.env.PLAYWRIGHT_HEADLESS || "false" });

  try {
    const context = await browser.newContext({
      storageState: tmpFile,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ...(opts.proxy?.server ? { proxy: opts.proxy } : {}),
    });
    await installSafeBandwidthRoutes(context);
    const page = await context.newPage();

    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
    renameLog("navigate_old_profile", { profileUrl });
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await dismissTikTokPopups(page);

    const urlAfterNav = parseTikTokHandleFromUrl(page.url());
    if (urlAfterNav === next) {
      renameLog("tiktok_url_already_shows_target_handle", {
        target: next,
        url: page.url(),
        dbHandle: handle,
        note: "TikTok already on desired @handle (e.g. prior attempt succeeded on TikTok); skip edit flow",
      });
      return { ok: true, verified: true };
    }

    await renameSlowPause(page, "after_initial_goto");
    await humanScroll(page);
    await renameSlowPause(page, "after_scroll_on_profile");
    await maybeScreenshot(page, "01-profile-loaded");

    const editProfile = await waitForEditProfile(page);
    if (!editProfile) {
      await maybeScreenshot(page, "02-no-edit-profile");
      renameLog("fail_edit_profile_missing", { url: page.url() });
      return fail("Edit profile not found (not logged into this account)");
    }

    renameLog("click_edit_profile");
    await editProfile.click({ force: true });
    await renameSlowPause(page, "after_edit_profile_click");
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
        await renameSlowPause(page, "after_username_row_click");
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
      return fail("TikTok UI did not respond after save");
    }

    const valueBefore = (await input.inputValue().catch(() => "")) || "(empty)";
    renameLog("username_field_before_fill", { valueBefore, willType: next });

    await input.click({ force: true });
    await renameSlowPause(page, "after_input_focus");
    await input.fill("");
    await renameSlowPause(page, "after_clear");

    const charDelay = Number(process.env.RENAME_USERNAME_CHAR_DELAY_MS || 120);
    for (const ch of next) {
      await input.type(ch, { delay: charDelay });
    }
    renameLog("username_field_after_type", { typed: next });

    const valueAfterType = (await input.inputValue().catch(() => "")) || "";
    renameLog("username_input_value_check", { valueAfterType, matchesTarget: valueAfterType.toLowerCase() === next });

    await renameSlowPause(page, "before_save_click");
    await maybeScreenshot(page, "05-filled-username");

    const saveBtn = page.getByRole("button", { name: /^save$/i }).first();
    if (!(await saveBtn.isVisible({ timeout: 12_000 }).catch(() => false))) {
      await maybeScreenshot(page, "06-no-save-button");
      return fail("Save button not visible");
    }

    renameLog("click_save");
    await saveBtn.click({ force: true });
    const afterSaveMs = Number(process.env.RENAME_AFTER_SAVE_TO_MODAL_MS || 800);
    await page.waitForTimeout(afterSaveMs).catch(() => {});
    renameLog("after_save_short_wait_before_modal", { ms: afterSaveMs });

    const issueEarly = await detectUsernameTakenOrError(page);
    if (issueEarly === "cooldown") {
      renameLog("result_30_day_cooldown_after_save", { oldHandle: handle, attemptedNew: next });
      console.warn(
        `[rename] BLOCKED 30-day cooldown — OLD @${handle} unchanged; TikTok rejected NEW @${next} (change limit)`
      );
      return fail(TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR);
    }
    if (issueEarly === "taken") {
      renameLog("result_taken_early");
      return fail("Username not available");
    }
    if (issueEarly === "error") {
      renameLog("result_invalid_early");
      return fail("TikTok UI did not respond after save");
    }

    const confirmed = await confirmSetUsernameDialogIfPresent(page);
    await maybeScreenshot(page, "07-after-save-and-confirm");

    const issue = await detectUsernameTakenOrError(page);
    if (issue === "cooldown") {
      renameLog("result_30_day_cooldown_after_confirm_modal", { oldHandle: handle, attemptedNew: next });
      console.warn(
        `[rename] BLOCKED 30-day cooldown — OLD @${handle} unchanged; TikTok rejected NEW @${next} (change limit)`
      );
      return fail(TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR);
    }
    if (issue === "taken") {
      renameLog("result_taken");
      return fail("Username not available");
    }
    if (issue === "error") {
      renameLog("result_invalid");
      return fail("TikTok UI did not respond after save");
    }

    await renameSlowPause(page, "before_second_error_scan");
    const issue2 = await detectUsernameTakenOrError(page);
    if (issue2 === "cooldown") {
      renameLog("result_30_day_cooldown_second_scan", { oldHandle: handle, attemptedNew: next });
      console.warn(
        `[rename] BLOCKED 30-day cooldown — OLD @${handle} unchanged; TikTok rejected NEW @${next} (change limit)`
      );
      return fail(TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR);
    }
    if (issue2 === "taken") {
      renameLog("result_taken_second_scan");
      return fail("Username not available");
    }
    if (issue2 === "error") {
      return fail("TikTok UI did not respond after save");
    }

    if (!confirmed) {
      renameLog("set_username_confirm_modal_absent_probe");
      await page.waitForTimeout(2500);
      const lateIssue = await detectUsernameTakenOrError(page);
      if (lateIssue === "cooldown") {
        renameLog("result_30_day_cooldown_after_modal_absent", { oldHandle: handle, attemptedNew: next });
        console.warn(
          `[rename] BLOCKED 30-day cooldown — OLD @${handle} unchanged; TikTok rejected NEW @${next} (change limit)`
        );
        return fail(TIKTOK_USERNAME_30_DAY_COOLDOWN_ERROR);
      }
      if (lateIssue === "taken") {
        renameLog("result_taken_after_modal_absent");
        return fail("Username not available");
      }
      if (lateIssue === "error") {
        return fail("TikTok UI did not respond after save");
      }

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
        return { ok: true, verified: true };
      }

      const late2 = await detectUsernameTakenOrError(page);
      if (late2 === "taken") {
        return fail("Username not available");
      }
      if (/does not exist|unavailable|belongs to another user/i.test(verificationNoModal.detail)) {
        renameLog("result_taken_inferred_from_verify", { detail: verificationNoModal.detail });
        return fail("Username not available");
      }
      return fail("TikTok UI did not respond after save");
    }

    renameLog("no_error_modal_proceed_verify", { url: page.url() });
    const verification = await verifyNewUsernameOnTikTok(page, next, { confirmModalWasClicked: true });

    if (!verification.ok) {
      renameLog("FAIL_not_verified", { detail: verification.detail });
      await maybeScreenshot(page, "08-verify-failed");
      return fail("Verification failed: username not updated on profile");
    }

    renameLog("SUCCESS_verified", {
      detail: verification.detail,
      targetUsername: next,
      oldUsername: handle,
      message: `TikTok username applied: OLD @${handle} → NEW @${next}`,
    });
    console.info(`[rename] SUCCESS — OLD @${handle} → NEW @${next} (verified on TikTok; update app DB next)`);
    return { ok: true, verified: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    renameLog("exception", { message: msg });
    if (/timeout/i.test(msg)) {
      return fail("Page load timeout");
    }
    return fail("TikTok UI did not respond after save");
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
