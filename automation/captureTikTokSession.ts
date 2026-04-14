import { launchChromium } from "@/lib/playwrightLaunch";
import { installSafeBandwidthRoutes } from "@/lib/playwrightSafeBandwidthRoutes";
import { dismissTikTokPopups } from "@/lib/tiktokPopupDismiss";
import { buildStickyProxyForAccount, type PlaywrightProxyConfig } from "@/lib/proxyPlaywright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

/**
 * Parse an inline proxy URL (e.g. http://user:pass@host:port) into a PlaywrightProxyConfig.
 * Only used when the account has a per-account proxy URL override.
 */
function parseInlineProxyUrl(raw: string): PlaywrightProxyConfig | undefined {
  if (!raw.trim()) return undefined;
  try {
    const u = new URL(raw);
    const server = `${u.protocol}//${u.host}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    if (username || password) return { server, username, password };
    return { server: raw };
  } catch {
    return { server: raw };
  }
}

/**
 * Opens a headed browser on TikTok login. Complete login in the window; when you leave
 * the login flow (e.g. land on For You / home), storage state is captured.
 *
 * @param accountId   MongoDB _id -- used for 1:1 proxy session mapping
 * @param username    TikTok username -- fallback if accountId unavailable
 * @param proxy       Optional per-account proxy URL override
 */
export async function captureTikTokStorageState(
  proxy?: string,
  accountId?: string,
  username?: string
): Promise<string> {
  // Resolve proxy BEFORE launching -- proxy must be at browser-launch level for IPRoyal auth.
  let resolvedProxy: PlaywrightProxyConfig | undefined;

  if (proxy && proxy.trim()) {
    resolvedProxy = parseInlineProxyUrl(proxy);
  } else if (accountId || username) {
    resolvedProxy = buildStickyProxyForAccount(
      username || "unknown",
      undefined,
      1,
      accountId
    );
  } else {
    const server = process.env.PROXY_SERVER?.trim();
    const proxyUser = process.env.PROXY_USERNAME?.trim();
    const proxyPass = process.env.PROXY_PASSWORD?.trim();
    if (server && proxyUser && proxyPass) {
      resolvedProxy = { server, username: proxyUser, password: proxyPass };
    } else if (server) {
      resolvedProxy = { server };
    }
  }

  const browser = await launchChromium("interactive", resolvedProxy);
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1366, height: 768 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await installSafeBandwidthRoutes(context);
    const page = await context.newPage();
    await page.goto("https://www.tiktok.com/login", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await dismissTikTokPopups(page);

    await page.waitForURL(
      (url) => {
        const h = url.hostname;
        const p = url.pathname;
        if (!h.includes("tiktok.com")) return false;
        if (p.includes("/login")) return false;
        return p.includes("/foryou") || p.startsWith("/@") || p === "/" || p.includes("/following");
      },
      { timeout: 300_000, waitUntil: "domcontentloaded" }
    );

    await page.waitForTimeout(2500);
    await dismissTikTokPopups(page);
    const state = await context.storageState();
    return JSON.stringify(state);
  } finally {
    await browser.close().catch(() => {});
  }
}
