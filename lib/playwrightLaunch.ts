import { chromium, type Browser, type LaunchOptions } from "playwright";

/**
 * Central launch config so Chromium works on Windows, macOS, and Linux (including Docker/Ubuntu).
 *
 * macOS: Playwright’s bundled Chromium (arm64 or x64) runs locally with a normal desktop session.
 *   Install browsers once: `npx playwright install chromium`. For interactive session capture, leave
 *   PLAYWRIGHT_HEADLESS unset or set `false` so a real window opens. If launch fails, try
 *   PLAYWRIGHT_CHANNEL=chrome to use installed Google Chrome instead of bundled Chromium.
 *
 * Env:
 * - PLAYWRIGHT_HEADLESS — `true` / `1` / `yes` = headless. `false` / `0` = headed (visible browser).
 *   Unset: headed on a normal Windows/macOS desktop; headless when CI=1/true (no GUI); headless on
 *   Linux with no DISPLAY/WAYLAND_DISPLAY (servers/containers). Override anytime with this variable.
 * - PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH — optional path to chrome/chromium binary.
 * - PLAYWRIGHT_CHANNEL — e.g. `chrome` to use installed Chrome instead of bundled Chromium.
 * - PLAYWRIGHT_CHROMIUM_ARGS — space-separated extra flags (appended after defaults).
 * - PLAYWRIGHT_DOCKER — set `true` to always add --no-sandbox etc. (even on non-Linux).
 *
 * Linux server without monitor: run the app under Xvfb so headed mode still works for TikTok:
 *   sudo apt install xvfb && xvfb-run -a npm run start
 * Or set PLAYWRIGHT_HEADLESS=true and import sessions via pasted JSON on Accounts.
 */

export type PlaywrightPurpose = "interactive" | "automation";

function parseTruthy(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

function useLinuxStyleSandboxArgs(): boolean {
  if (parseTruthy(process.env.PLAYWRIGHT_DOCKER)) return true;
  return process.platform === "linux";
}

function buildDefaultArgs(): string[] {
  const base = ["--disable-blink-features=AutomationControlled"];
  const linux = useLinuxStyleSandboxArgs()
    ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    : [];
  const extra =
    process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  return [...linux, ...base, ...extra];
}

function resolveHeadless(): boolean {
  const h = parseTruthy(process.env.PLAYWRIGHT_HEADLESS);
  if (h === true) return true;
  if (h === false) return false;
  // GitHub Actions, GitLab, etc.: no display for a real browser window (all platforms).
  if (parseTruthy(process.env.CI)) {
    return true;
  }
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY?.trim() &&
    !process.env.WAYLAND_DISPLAY?.trim()
  ) {
    return true;
  }
  return false;
}

export function getChromiumLaunchOptions(_purpose?: PlaywrightPurpose): LaunchOptions {
  const headless = resolveHeadless();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
  const channel = process.env.PLAYWRIGHT_CHANNEL?.trim() as LaunchOptions["channel"] | undefined;

  const linuxish = useLinuxStyleSandboxArgs();
  const opts: LaunchOptions = {
    headless,
    args: buildDefaultArgs(),
    ...(linuxish ? { chromiumSandbox: false } : {}),
    ...(executablePath ? { executablePath } : {}),
    ...(channel ? { channel } : {}),
  };

  return opts;
}

export async function launchChromium(purpose: PlaywrightPurpose = "automation"): Promise<Browser> {
  const opts = getChromiumLaunchOptions(purpose);
  if (purpose === "interactive" && opts.headless) {
    console.warn(
      "[Playwright] PLAYWRIGHT_HEADLESS is enabled: TikTok login in this window often fails. Use a visible browser (unset PLAYWRIGHT_HEADLESS or set PLAYWRIGHT_HEADLESS=false), or paste storageState JSON on Accounts."
    );
  }
  if (process.platform === "linux" && !process.env.DISPLAY?.trim() && !process.env.WAYLAND_DISPLAY?.trim() && opts.headless === false) {
    console.warn(
      "[Playwright] Headed launch on Linux with no DISPLAY. Session capture will fail unless you use SSH -X, a desktop, or: sudo apt install xvfb && xvfb-run -a <your command>. " +
        "Alternatively use headless + paste storageState JSON on Accounts."
    );
  }

  const launchOnce = () => chromium.launch(opts);
  try {
    return await launchOnce();
  } catch (first) {
    const msg = first instanceof Error ? first.message : String(first);
    const retryable =
      /closed|ENOENT|spawn|browser has been closed|Target page|Executable doesn't exist/i.test(msg);
    if (!retryable) throw first;
    console.warn("[Playwright] Launch failed, retrying once:", msg);
    await new Promise((r) => setTimeout(r, 400));
    return launchOnce();
  }
}
