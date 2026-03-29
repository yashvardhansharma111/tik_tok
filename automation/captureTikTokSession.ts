import { launchChromium } from "@/lib/playwrightLaunch";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type ProxyConfig = { server: string; username?: string; password?: string };

function buildProxy(proxy?: string): ProxyConfig | undefined {
  const raw = (proxy && proxy.trim()) || "";
  if (raw) {
    try {
      // Support http://user:pass@host:port
      const u = new URL(raw);
      const server = `${u.protocol}//${u.host}`;
      const username = u.username ? decodeURIComponent(u.username) : undefined;
      const password = u.password ? decodeURIComponent(u.password) : undefined;
      if (username || password) return { server, username, password };
      return { server: raw };
    } catch {
      // Treat as plain server string
      return { server: raw };
    }
  }

  const server = process.env.PROXY_SERVER?.trim();
  const username = process.env.PROXY_USERNAME?.trim();
  const password = process.env.PROXY_PASSWORD?.trim();
  if (!server) return undefined;
  if (username && password) return { server, username, password };
  return { server };
}

/**
 * Opens a headed browser on TikTok login. Complete login in the window; when you leave
 * the login flow (e.g. land on For You / home), storage state is captured.
 */
export async function captureTikTokStorageState(proxy?: string): Promise<string> {
  const browser = await launchChromium("interactive");
  try {
    const resolvedProxy = buildProxy(proxy);
    const context = await browser.newContext({
      userAgent: UA,
      ...(resolvedProxy ? { proxy: resolvedProxy } : {}),
    });
    const page = await context.newPage();
    await page.goto("https://www.tiktok.com/login", { waitUntil: "domcontentloaded", timeout: 90_000 });

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
    const state = await context.storageState();
    return JSON.stringify(state);
  } finally {
    await browser.close().catch(() => {});
  }
}
