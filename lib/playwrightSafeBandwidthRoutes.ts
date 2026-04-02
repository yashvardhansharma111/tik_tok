import type { BrowserContext } from "playwright";

/**
 * Optional request filtering to trim proxy egress without blocking TikTok core CDNs
 * (ttwstatic / effectcdn / music APIs stay allowed).
 *
 * Set `TIKTOK_BLOCK_NON_ESSENTIAL=0` to disable entirely if Studio misbehaves.
 * Set `TIKTOK_BLOCK_STUDIO_IMAGES=0` to keep loading images while still blocking fonts + trackers.
 */
export async function installSafeBandwidthRoutes(context: BrowserContext): Promise<void> {
  const disabled =
    process.env.TIKTOK_BLOCK_NON_ESSENTIAL === "0" || process.env.TIKTOK_BLOCK_NON_ESSENTIAL === "false";
  if (disabled) return;

  const blockImages =
    process.env.TIKTOK_BLOCK_STUDIO_IMAGES !== "0" && process.env.TIKTOK_BLOCK_STUDIO_IMAGES !== "false";

  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const rt = req.resourceType();

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
        u.includes("music&")
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

    if (rt === "beacon") {
      await route.abort();
      return;
    }

    await route.continue();
  });
}
