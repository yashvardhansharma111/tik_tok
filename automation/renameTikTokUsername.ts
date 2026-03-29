import { launchChromium } from "@/lib/playwrightLaunch";
import { humanScroll } from "@/lib/humanBehavior";
import { renameLog, renameSlowPause } from "@/lib/renameDebugLog";
import fs from "fs";
import os from "os";
import path from "path";
import type { PlaywrightProxyConfig } from "@/lib/proxyPlaywright";

function scanRootForUsernameIssue(text: string): "taken" | "error" | null {
  const t = text.toLowerCase();
  if (/invalid username|characters not allowed|only letters|special characters/i.test(t)) return "error";
  if (
    /username.*(taken|unavailable|not available|in use|already)/i.test(t) ||
    /not available\./i.test(t) ||
    /try (a |another )?different/i.test(t) ||
    /choose (a |another )?username/i.test(t) ||
    /already exists/i.test(t)
  ) {
    return "taken";
  }
  return null;
}

/**
 * After Save on the username field, TikTok shows: "Set your username?" / "once every 30 days" with Cancel / Confirm.
 * We must click Confirm to apply the change.
 */
async function confirmSetUsernameDialogIfPresent(page: import("playwright").Page): Promise<boolean> {
  const dialog = page
    .locator('[role="dialog"]')
    .filter({ hasText: /set your username|change your username once every 30 days/i })
    .first();

  if (!(await dialog.isVisible({ timeout: 8000 }).catch(() => false))) {
    renameLog("set_username_confirm_modal_absent");
    return false;
  }

  renameLog("set_username_confirm_modal_visible");

  let confirmBtn = dialog.getByRole("button", { name: /^confirm$/i }).first();
  if (!(await confirmBtn.isVisible({ timeout: 4000 }).catch(() => false))) {
    confirmBtn = dialog.locator("button").filter({ hasText: /^confirm$/i }).first();
  }

  if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirmBtn.click({ force: true });
    renameLog("clicked_confirm_set_username_modal");
    await renameSlowPause(page, "after_set_username_confirm_click");
    return true;
  }

  const globalConfirm = page.getByRole("button", { name: /^confirm$/i }).first();
  if (await globalConfirm.isVisible({ timeout: 2500 }).catch(() => false)) {
    await globalConfirm.click({ force: true });
    renameLog("clicked_confirm_set_username_global_fallback");
    await renameSlowPause(page, "after_set_username_confirm_click_fallback");
    return true;
  }

  renameLog("set_username_confirm_modal_visible_but_confirm_not_found");
  return false;
}

async function detectUsernameTakenOrError(page: import("playwright").Page): Promise<"taken" | "error" | null> {
  for (const sel of ['[role="dialog"]', '[role="alert"]', '[data-e2e*="modal" i]']) {
    const root = page.locator(sel).first();
    if (await root.isVisible({ timeout: 800 }).catch(() => false)) {
      const text = (await root.innerText().catch(() => "")).slice(0, 8000);
      const hit = scanRootForUsernameIssue(text);
      if (hit) {
        renameLog("detected_issue_in_modal", { sel, hit, textPreview: text.slice(0, 280) });
        return hit;
      }
    }
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

/**
 * Do not report success unless we see the new @handle on a real profile view.
 */
async function verifyNewUsernameOnTikTok(
  page: import("playwright").Page,
  expectedHandle: string
): Promise<{ ok: boolean; detail: string }> {
  const target = expectedHandle.replace(/^@/, "").trim().toLowerCase();
  renameLog("verify_step_1_check_current_url", { url: page.url(), expectedHandle: target });

  const u0 = page.url().toLowerCase();
  if (u0.includes(`/@${target}`) || u0.includes("/@" + encodeURIComponent(target))) {
    return { ok: true, detail: "Current URL already shows /@handle after save" };
  }

  await renameSlowPause(page, "verify_before_profile_nav");
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(target)}`;
  renameLog("verify_step_2_goto_profile", { profileUrl });
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await renameSlowPause(page, "verify_after_profile_nav");
  await maybeScreenshot(page, "after-verify-goto");

  const finalUrl = page.url().toLowerCase();
  renameLog("verify_step_3_url_after_goto", { finalUrl });

  if (finalUrl.includes(`@${target}`) || finalUrl.includes("%40" + target)) {
    return { ok: true, detail: "Browser URL matches new handle" };
  }

  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 5000);
  const bodyLower = body.toLowerCase();
  renameLog("verify_step_4_body_snippet", { snippet: body.slice(0, 500) });

  if (/couldn't find|could not find|page isn't available|user not found|no results|doesn't exist/i.test(body)) {
    return { ok: false, detail: "TikTok page indicates this @handle does not exist or is unavailable" };
  }

  if (bodyLower.includes("@" + target) && !/couldn't find/i.test(body)) {
    return { ok: true, detail: "Page text includes @" + target };
  }

  return {
    ok: false,
    detail: "Could not verify: URL and body do not clearly show the new handle (UI may differ)",
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
}): Promise<{ ok: boolean; taken?: boolean; error?: string; verified?: boolean }> {
  const handle = opts.currentUsername.replace(/^@/, "").trim();
  const next = opts.newUsername.replace(/^@/, "").trim().toLowerCase();

  renameLog("job_start", {
    currentUsernameFromDb: handle,
    targetNewUsername: next,
    proxyServer: opts.proxy?.server ? "(set)" : "(none)",
  });

  if (!next || next.length < 2) {
    renameLog("abort_invalid_target", { next });
    return { ok: false, error: "Empty or invalid new username" };
  }

  if (next === handle.toLowerCase()) {
    renameLog("abort_same_as_current", { handle, next });
    return { ok: false, error: "New username is the same as current username" };
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
    const page = await context.newPage();

    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}`;
    renameLog("navigate_old_profile", { profileUrl });
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await renameSlowPause(page, "after_initial_goto");
    await humanScroll(page);
    await renameSlowPause(page, "after_scroll_on_profile");
    await maybeScreenshot(page, "01-profile-loaded");

    let editProfile = page.getByRole("button", { name: /edit profile/i }).first();
    if (!(await editProfile.isVisible({ timeout: 8000 }).catch(() => false))) {
      editProfile = page.getByRole("link", { name: /edit profile/i }).first();
    }

    if (!(await editProfile.isVisible({ timeout: 20_000 }).catch(() => false))) {
      await maybeScreenshot(page, "02-no-edit-profile");
      renameLog("fail_edit_profile_missing", { url: page.url() });
      return {
        ok: false,
        error:
          "Edit profile not found (must be logged in as this account). URL: " + profileUrl + " current: " + page.url(),
      };
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
      return {
        ok: false,
        error:
          "Could not find username field after Edit profile. See automation/renameTikTokUsername.ts and RENAME_SCREENSHOT_DIR.",
      };
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
      return { ok: false, error: "Save button not visible after entering username" };
    }

    renameLog("click_save");
    await saveBtn.click({ force: true });
    await renameSlowPause(page, "after_save_click_first_wait");

    await confirmSetUsernameDialogIfPresent(page);
    await maybeScreenshot(page, "07-after-save-and-confirm");

    const issue = await detectUsernameTakenOrError(page);
    if (issue === "taken") {
      renameLog("result_taken");
      return { ok: false, taken: true, error: "Username not available on TikTok (detected in UI)", verified: false };
    }
    if (issue === "error") {
      renameLog("result_invalid");
      return { ok: false, error: "TikTok reported an error for this username", verified: false };
    }

    await renameSlowPause(page, "before_second_error_scan");
    const issue2 = await detectUsernameTakenOrError(page);
    if (issue2 === "taken") {
      renameLog("result_taken_second_scan");
      return { ok: false, taken: true, error: "Username not available (second scan)", verified: false };
    }
    if (issue2 === "error") {
      return { ok: false, error: "TikTok error (second scan)", verified: false };
    }

    renameLog("no_error_modal_proceed_verify", { url: page.url() });
    const verification = await verifyNewUsernameOnTikTok(page, next);

    if (!verification.ok) {
      renameLog("FAIL_not_verified", { detail: verification.detail });
      await maybeScreenshot(page, "08-verify-failed");
      return {
        ok: false,
        error: `Rename not verified on TikTok: ${verification.detail}`,
        verified: false,
      };
    }

    renameLog("SUCCESS_verified", { detail: verification.detail, targetUsername: next });
    return { ok: true, verified: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    renameLog("exception", { message: msg });
    return { ok: false, error: msg };
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
