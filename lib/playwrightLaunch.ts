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
 * - PLAYWRIGHT_USE_HEADLESS_SHELL — set `true` to use Playwright’s smaller `chromium-headless-shell` binary
 *   (default is **false**: we use full Chromium + `--headless`, which is more reliable in Docker/Linux production).
 *
 * Production Linux/Docker: install OS deps once — `npx playwright install-deps chromium` (or use a base image
 * that includes Chromium’s shared libraries). Set PLAYWRIGHT_DOCKER=true.
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

/**
 * Production VPS / Docker / AlmaLinux: required by many hosts (root, small `/dev/shm`, no user namespaces).
 * Equivalent to:
 *   chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] })
 * We also prepend automation + any PLAYWRIGHT_CHROMIUM_ARGS.
 */
const LINUX_SERVER_LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] as const;

/** Less Chrome background traffic (updates, sync) — not TikTok page weight; set `TIKTOK_CHROMIUM_LEAN_AUTOMATION=0` to disable. */
const LEAN_AUTOMATION_CHROMIUM_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-first-run",
] as const;

function buildDefaultArgs(purpose?: PlaywrightPurpose): string[] {
  const base = ["--disable-blink-features=AutomationControlled"];
  const linux = useLinuxStyleSandboxArgs() ? [...LINUX_SERVER_LAUNCH_ARGS] : [];
  const extra =
    process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  let out = [...linux, ...base, ...extra];
  const leanOff =
    process.env.TIKTOK_CHROMIUM_LEAN_AUTOMATION === "0" || process.env.TIKTOK_CHROMIUM_LEAN_AUTOMATION === "false";
  if (purpose === "automation" && !leanOff) {
    out = [...out, ...LEAN_AUTOMATION_CHROMIUM_ARGS];
  }
  return out;
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

export function getChromiumLaunchOptions(purpose?: PlaywrightPurpose, proxy?: { server: string; username?: string; password?: string }): LaunchOptions {
  const headless = resolveHeadless();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || undefined;
  const envChannel = process.env.PLAYWRIGHT_CHANNEL?.trim() as LaunchOptions["channel"] | undefined;
  // Bundled Chromium required: real Chrome (channel:'chrome') blocks Playwright's CDP proxy-auth injection
  // causing ERR_PROXY_AUTH_UNSUPPORTED on every 407 challenge. Bundled Chromium allows it.
  // Override with PLAYWRIGHT_CHANNEL env (e.g. PLAYWRIGHT_CHANNEL=chrome) only if proxy-less.
  const channel: LaunchOptions['channel'] | undefined = envChannel ?? 'chromium';

  const linuxish = useLinuxStyleSandboxArgs();
  const opts: LaunchOptions = {
    // headless follows resolveHeadless(); on Linux VPS without DISPLAY this is typically true — pairs with LINUX_SERVER_LAUNCH_ARGS.
    headless,
    args: buildDefaultArgs(purpose),
    ...(linuxish ? { chromiumSandbox: false } : {}),
    ...(executablePath ? { executablePath } : {}),
    ...(channel ? { channel } : {}),
    ...(proxy?.server ? { proxy } : {}),
  };

  return opts;
}

export async function launchChromium(purpose: PlaywrightPurpose = "automation", proxy?: { server: string; username?: string; password?: string }): Promise<Browser> {
  const opts = getChromiumLaunchOptions(purpose, proxy);
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

  const hintLinuxDeps = () => {
    if (process.platform !== "linux") return;
    console.error(
      "[Playwright] Linux: install Chromium OS libraries (fixes libnspr4.so / libnss3 errors). Run on the server:\n" +
        "  npx playwright install-deps chromium\n" +
        "Or Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2\n" +
        "Docker: use `FROM mcr.microsoft.com/playwright:v1.xx.x-jammy` or run install-deps in your image. " +
        "Unset PLAYWRIGHT_USE_HEADLESS_SHELL unless you have full deps — full `chromium` bundle is used by default for automation on Linux."
    );
  };

  try {
    return await launchOnce();
  } catch (first) {
    const msg = first instanceof Error ? first.message : String(first);
    if (/libnspr4|libnss3|loading shared libraries|cannot open shared object file|exitCode=127/i.test(msg)) {
      hintLinuxDeps();
      throw first;
    }
    const retryable =
      /closed|ENOENT|spawn|browser has been closed|Target page|Executable doesn't exist/i.test(msg);
    if (!retryable) throw first;
    console.warn("[Playwright] Launch failed, retrying once:", msg);
    await new Promise((r) => setTimeout(r, 400));
    try {
      return await launchOnce();
    } catch (second) {
      const msg2 = second instanceof Error ? second.message : String(second);
      if (/libnspr4|libnss3|loading shared libraries|cannot open shared object file|exitCode=127/i.test(msg2)) {
        hintLinuxDeps();
      }
      throw second;
    }
  }
}
