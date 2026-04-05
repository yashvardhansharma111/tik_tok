import type { BrowserContext } from "playwright";

/**
 * Optional request filtering to trim proxy egress without blocking TikTok core CDNs
 * (ttwstatic / effectcdn / music APIs stay allowed).
 *
 * Set `TIKTOK_BLOCK_NON_ESSENTIAL=0` to disable entirely if Studio misbehaves.
 * Set `TIKTOK_BLOCK_STUDIO_IMAGES=0` to keep loading images while still blocking fonts + trackers.
 * Set `TIKTOK_PROXY_SAVINGS_MODE=0` to disable extra safe cuts (source maps, manifest, extra ad hosts).
 */
export async function installSafeBandwidthRoutes(context: BrowserContext): Promise<void> {
  const disabled =
    process.env.TIKTOK_BLOCK_NON_ESSENTIAL === "0" || process.env.TIKTOK_BLOCK_NON_ESSENTIAL === "false";
  if (disabled) return;

  const blockImages =
    process.env.TIKTOK_BLOCK_STUDIO_IMAGES !== "0" && process.env.TIKTOK_BLOCK_STUDIO_IMAGES !== "false";

  const savingsMode =
    process.env.TIKTOK_PROXY_SAVINGS_MODE !== "0" && process.env.TIKTOK_PROXY_SAVINGS_MODE !== "false";

  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const rt = req.resourceType();

    if (savingsMode) {
      try {
        if (new URL(url).pathname.toLowerCase().endsWith(".map")) {
          await route.abort();
          return;
        }
      } catch {
        // ignore
      }
      if (rt === "manifest" || rt === "texttrack") {
        await route.abort();
        return;
      }
    }

    if (rt === "font") {
      await route.abort();
      return;
    }

    if (blockImages && rt === "image") {
      const u = url.toLowerCase();
      if (
        u.includes("ies-music") ||
        u.includes("music-sg") ||
        u.includes("sf16-ies-music") ||
        u.includes("/music") ||
        u.includes("music?") ||
        u.includes("music&") ||
        (u.includes("tiktokcdn.com") &&
          (u.includes("music") || u.includes("sound") || u.includes("cover") || u.includes("album")))
      ) {
        await route.continue();
        return;
      }
      await route.abort();
      return;
    }

    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      await route.continue();
      return;
    }

    if (
      host.includes("google-analytics") ||
      host.includes("googletagmanager") ||
      host.includes("doubleclick") ||
      host.includes("facebook.net") ||
      host.includes("scorecardresearch") ||
      host.includes("hotjar.com") ||
      host.includes("fullstory.com")
    ) {
      await route.abort();
      return;
    }

    if (savingsMode) {
      if (
        host.includes("googleadservices.com") ||
        host.includes("googlesyndication.com") ||
        host === "adservice.google.com" ||
        host.endsWith(".adservice.google.com") ||
        host.includes("ads.linkedin.com") ||
        host.includes("amazon-adsystem.com") ||
        host.includes("taboola.com") ||
        host.includes("outbrain.com") ||
        host.includes("chartbeat.com") ||
        host.includes("newrelic.com") ||
        host.includes("nr-data.net") ||
        host.includes("moatads.com")
      ) {
        await route.abort();
        return;
      }
    }

    if (rt === "beacon") {
      await route.abort();
      return;
    }

    await route.continue();
  });
}
