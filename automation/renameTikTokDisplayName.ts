import { launchChromium } from "@/lib/playwrightLaunch";
import { installSafeBandwidthRoutes } from "@/lib/playwrightSafeBandwidthRoutes";
import { dismissTikTokPopups } from "@/lib/tiktokPopupDismiss";
import fs from "fs";
import os from "os";
import path from "path";
import type { PlaywrightProxyConfig } from "@/lib/proxyPlaywright";

/**
 * Best-effort: TikTok settings → profile name / nickname. DOM changes often.
 */
export async function renameTikTokDisplayName(opts: {
  sessionJson: string;
  accountUsername: string;
  newDisplayName: string;
  proxy?: PlaywrightProxyConfig;
}): Promise<{ ok: boolean; error?: string }> {
  const tmpFile = path.join(
    os.tmpdir(),
    `tiktok-rename-${opts.accountUsername.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`
  );
  fs.writeFileSync(tmpFile, opts.sessionJson, "utf-8");

  const browser = await launchChromium("automation", opts.proxy?.server ? opts.proxy : undefined);

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

    await page.goto("https://www.tiktok.com/setting", {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await dismissTikTokPopups(page);

    const name = opts.newDisplayName.trim().slice(0, 30);
    if (!name) return { ok: false, error: "Empty display name" };

    // Try common patterns for “Name” / “Nickname” in settings.
    const candidates = [
      page.getByRole("textbox", { name: /^(name|nickname|display name)/i }),
      page.locator('input[placeholder*="name" i]'),
      page.getByPlaceholder(/name|nickname/i),
    ];

    let filled = false;
    for (const loc of candidates) {
      const el = loc.first();
      if (await el.isVisible({ timeout: 4000 }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        await el.fill("");
        await el.fill(name);
        filled = true;
        break;
      }
    }

    if (!filled) {
      return {
        ok: false,
        error:
          "Could not find profile name field on TikTok settings (UI may have changed). Try updating selectors in automation/renameTikTokDisplayName.ts",
      };
    }

    const saveBtn = page.getByRole("button", { name: /^save$/i }).first();
    if (await saveBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await saveBtn.click({ force: true });
    }

    await page.waitForTimeout(2000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await browser.close().catch(() => {});
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  }
}
